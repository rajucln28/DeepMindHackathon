// One AEGIS session per connected browser: audio in → perception → world state → spoken intervention.
const config = require('./config');
const { Modality, LiveStream, speakStream, transcribe, wav } = require('./gemini');
const { analyzeUtterance, quickCheck, summarize } = require('./analyzer');
const W = require('./worldState');

const BYTES_PER_MS = 32; // 16kHz * 2 bytes

const CAPTION_PROMPT = `You are a silent listener. Never speak unless explicitly asked. If you must respond, respond with a single short "mm".`;

let cachedChime = null; // { pcm, rate } — "Hold on." rendered once at boot

class Session {
  constructor(send, log = console.log) {
    this.send = send;
    this.log = (m) => log(`[session] ${m}`);
    this.state = W.createState();
    this.chunks = [];
    this.totalBytes = 0;
    this.vad = { noise: 300, speechFrames: 0, silenceMs: 0, inSpeech: false, start: 0, lastSpeechAt: 0 };
    this.frameCarry = Buffer.alloc(0);
    this.queue = Promise.resolve();
    this.speaking = null;        // { id, aborted }
    this.lastInterventionAt = 0;
    this.lastInterventionText = '';
    this.startedAt = Date.now();
    this.captionBuf = '';
    this.translationBuf = '';
  }

  // ---------- lifecycle ----------
  start(mode = 'mic') {
    this.echoGuard = mode === 'mic';
    this.live = new LiveStream('live', config.MODELS.LIVE, {
      responseModalities: [Modality.AUDIO],
      systemInstruction: CAPTION_PROMPT,
      inputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
    }, (m) => {
      const t = m.serverContent?.inputTranscription?.text;
      if (t) { this.captionBuf += t; this.send({ type: 'caption', text: this.captionBuf.slice(-240) }); }
      // Live's own audio replies are intentionally discarded — it is our ears, not our mouth.
    }, this.log);

    this.translate = new LiveStream('translate', config.MODELS.TRANSLATE, {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    }, (m) => {
      const t = m.serverContent?.outputTranscription?.text;
      if (t) { this.translationBuf += t; this.send({ type: 'translation', text: this.translationBuf.slice(-240) }); }
    }, this.log);

    this.live.open();
    this.translate.open();
    this.pushState();
    if (cachedChime) this.send({ type: 'chime', rate: cachedChime.rate, data: cachedChime.pcm.toString('base64') });
  }

  stop() {
    this.live?.close();
    this.translate?.close();
    this.abortSpeech('session ended');
  }

  // ---------- audio intake ----------
  pushAudio(pcm) {
    if (this.ended) return;
    this.chunks.push(pcm);
    this.totalBytes += pcm.length;
    this.live?.sendAudio(pcm);
    // Only route to the translator while someone non-English is likely speaking would save cost; we keep it simple and always stream.
    this.translate?.sendAudio(pcm);
    this.runVad(pcm);
  }

  audioSlice(startByte, endByte) {
    const all = this.chunks.length > 1 ? Buffer.concat(this.chunks) : this.chunks[0] || Buffer.alloc(0);
    this.chunks = [all];
    return all.subarray(Math.max(0, startByte), Math.min(all.length, endByte));
  }

  runVad(pcm) {
    const V = config.VAD, v = this.vad;
    let buf = Buffer.concat([this.frameCarry, pcm]);
    const frameBytes = V.FRAME * 2;
    let offset = this.totalBytes - buf.length; // byte position of buf[0] in the session stream
    while (buf.length >= frameBytes) {
      const frame = buf.subarray(0, frameBytes);
      buf = buf.subarray(frameBytes);
      let sum = 0;
      for (let i = 0; i < frame.length; i += 2) { const x = frame.readInt16LE(i); sum += x * x; }
      const rms = Math.sqrt(sum / V.FRAME);
      // Echo guard: with a live mic, AEGIS's own voice can leak back in — demand a louder, closer voice while it talks.
      const guard = this.speaking && this.echoGuard ? 3 : 1;
      const isSpeech = rms > Math.max(V.MIN_RMS, v.noise * V.NOISE_MULT) * guard;
      if (!isSpeech) v.noise = v.noise * 0.98 + rms * 0.02;

      if (isSpeech) {
        v.speechFrames++; v.silenceMs = 0; v.lastSpeechAt = Date.now();
        if (!v.inSpeech && v.speechFrames >= V.START_FRAMES) {
          v.inSpeech = true;
          v.start = offset - (V.START_FRAMES * frameBytes) - V.PREROLL_MS * BYTES_PER_MS;
          this.onSpeechStart();
        }
      } else {
        v.speechFrames = 0;
        if (v.inSpeech) v.silenceMs += 20;
      }
      offset += frameBytes;
      if (v.inSpeech) {
        const lenMs = (offset - v.start) / BYTES_PER_MS;
        if (v.silenceMs >= V.END_SILENCE_MS || lenMs >= V.MAX_UTTERANCE_MS) {
          v.inSpeech = false;
          const end = offset - Math.min(v.silenceMs, 400) * BYTES_PER_MS;
          if ((end - v.start) / BYTES_PER_MS >= V.MIN_SPEECH_MS) this.onUtterance(v.start, end);
          v.silenceMs = 0;
        }
      }
    }
    this.frameCarry = Buffer.from(buf);
  }

  onSpeechStart() {
    this.send({ type: 'vad', speaking: true });
    // Server-side barge-in: a human talking over AEGIS stops it immediately.
    if (this.speaking && Date.now() - this.speaking.startedAt > 600) this.bargeIn('voice detected over AEGIS');
  }

  // ---------- perception + cognition ----------
  onUtterance(startByte, endByte) {
    startByte = Math.max(0, startByte);
    const pcm = this.audioSlice(startByte, endByte);
    const clip = { start: Math.round(startByte / BYTES_PER_MS), end: Math.round(endByte / BYTES_PER_MS) };
    const endedAt = Date.now();
    this.send({ type: 'vad', speaking: false });
    this.send({ type: 'utterance_pending', clip });

    // Ground truth runs in parallel and never blocks the reasoning path.
    const gt = transcribe(pcm).catch(e => { this.log(`transcribe failed ${e.message}`); return ''; });

    // Fast path: wait for Live's caption to settle (Hindi arrives in a burst at turn end),
    // then run a text-only contradiction check while the full audio analysis is still running.
    const job = { fullDone: false };
    let last = null, stableSince = Date.now();
    const poll = () => {
      const cap = this.captionBuf;
      if (cap !== last) { last = cap; stableSince = Date.now(); }
      const settled = cap.trim() && Date.now() - stableSince >= 300;
      if (!settled && Date.now() - endedAt < 2500) return setTimeout(poll, 100);
      this.captionBuf = ''; this.translationBuf = '';
      if (job.fullDone) return;
      const t0 = Date.now();
      quickCheck(cap, this.state).then(hit => {
        if (!hit || job.fullDone) return;
        this.log(`quick-check flagged ${hit.fact_id} in ${Date.now() - t0}ms (${Date.now() - endedAt}ms after speech)`);
        const fact = this.state.facts.find(f => f.id === hit.fact_id);
        this.send({ type: 'suspect', ms: Date.now() - endedAt, text: `Heard "${hit.gist}" — may conflict with: ${fact?.text || hit.fact_id}. Verifying by ear…` });
      }).catch(e => this.log(`quick-check failed ${e.message}`));
    };
    setTimeout(poll, 150);

    this.queue = this.queue.then(async () => {
      const t0 = Date.now();
      let a;
      try {
        a = await analyzeUtterance(pcm, this.state, this.lastInterventionText);
      } catch (e) {
        this.log(`analysis failed ${e.message}`);
        this.send({ type: 'utterance_failed', clip });
        return;
      }
      job.fullDone = true;
      this.log(`analysed ${clip.start}-${clip.end}ms in ${Date.now() - t0}ms: [${a.speaker_id}/${a.language}/${a.tone}] ${a.english}`);
      if (a.is_aegis_echo) { this.send({ type: 'utterance_failed', clip, reason: 'echo' }); return; }

      const { events, utterance, contradiction, resolved } = W.apply(this.state, a, clip);
      utterance.latencyMs = Date.now() - t0;
      this.send({ type: 'events', events });
      this.pushState();

      gt.then(text => {
        if (!text) return;
        utterance.verbatim = text;
        this.send({ type: 'verbatim', id: utterance.id, text });
      });

      if (resolved && this.speaking) this.abortSpeech('resolved');
      if (contradiction) this.planIntervention(contradiction, a, endedAt);
      else this.send({ type: 'suspect_clear' });
    });
  }

  // ---------- action: tone-aware intervention ----------
  planIntervention(c, a, endedAt) {
    const I = config.INTERVENTION;
    if (Date.now() - this.lastInterventionAt < I.COOLDOWN_MS) return;
    const hostile = W.HOSTILE.has(a.tone), unsure = W.UNSURE.has(a.tone);
    const policy = hostile
      ? { backoff: I.BACKOFF_ANGRY_MS, quiet: I.QUIET_ANGRY_MS, style: 'warm', label: `${a.tone} → wait for ${I.QUIET_ANGRY_MS / 1000}s of calm, soften wording, add Hindi if needed` }
      : unsure
        ? { backoff: 0, quiet: I.QUIET_DEFAULT_MS, style: 'reassuring', label: `${a.tone} → intervene immediately, ground them` }
        : { backoff: I.BACKOFF_DEFAULT_MS, quiet: I.QUIET_DEFAULT_MS, style: 'serious', label: `${a.tone} → crisp, neutral intervention` };
    const text = (a.intervention || '').trim() || `Hold on. ${c.explanation} Can someone clarify?`;
    this.lastInterventionAt = Date.now();
    this.send({ type: 'events', events: [{ type: 'TONE_POLICY', text: policy.label, at: Date.now() }] });

    // Start synthesising right away; audio is buffered until the tone policy says it is OK to speak.
    const job = { id: `i${Date.now()}`, aborted: false, released: false, buffered: [], done: false, startedAt: 0 };
    const spoken = text.replace(/^\s*(hold on|wait|excuse me)[\s.,!—–-]*/i, '') || text; // chime already says "Hold on"
    const t0 = Date.now();
    speakStream(spoken, (chunk) => {
      if (job.aborted) return;
      if (!job.buffered.length && !job.released) this.log(`tts first chunk ${Date.now() - t0}ms (pre-buffered)`);
      if (job.released) this.send({ type: 'audio', id: job.id, rate: chunk.rate, data: chunk.pcm.toString('base64') });
      else job.buffered.push(chunk);
    }, { voice: config.VOICE, style: policy.style, shouldAbort: () => job.aborted })
      .catch(e => this.log(`tts failed ${e.message}`))
      .finally(() => { job.done = true; if (job.released && !job.aborted) this.send({ type: 'audio_end', id: job.id }); });

    const deadline = endedAt + policy.backoff;
    const waitStart = Date.now();
    const go = () => {
      if (c.status !== 'OPEN') { job.aborted = true; return; }
      const quietFor = Date.now() - this.vad.lastSpeechAt;
      const waiting = Date.now() < deadline || this.vad.inSpeech || quietFor < policy.quiet;
      if (waiting && Date.now() - waitStart < I.MAX_WAIT_FOR_SILENCE_MS) return setTimeout(go, 100);
      this.intervene(c, text, job, endedAt);
    };
    go();
  }

  intervene(c, text, job, endedAt) {
    this.abortSpeech('superseded');
    job.startedAt = Date.now();
    this.speaking = job;
    this.lastInterventionText = text;
    this.state.status = 'INTERVENING';
    this.pushState();
    this.log(`intervening ${Date.now() - endedAt}ms after speech ended`);
    // Tier 1: instant pre-rendered "Hold on." on the client, zero model latency.
    this.send({ type: 'intervene', id: job.id, text, contradiction: c.id });
    this.send({ type: 'events', events: [{ type: 'INTERVENTION', text, at: Date.now(), contradiction: c.id, ms: Date.now() - endedAt }] });
    // Tier 2: flush pre-synthesised Flash TTS audio, then keep streaming.
    job.released = true;
    for (const chunk of job.buffered) this.send({ type: 'audio', id: job.id, rate: chunk.rate, data: chunk.pcm.toString('base64') });
    job.buffered = [];
    if (job.done) this.send({ type: 'audio_end', id: job.id });
  }

  abortSpeech(reason) {
    if (!this.speaking) return;
    this.speaking.aborted = true;
    this.send({ type: 'stop_audio', id: this.speaking.id, reason });
    this.speaking = null;
    W.recompute(this.state);
    this.pushState();
  }

  // Called by the client when playback ends naturally.
  speechFinished(id) {
    if (this.speaking?.id === id) { this.speaking = null; W.recompute(this.state); this.pushState(); }
  }

  bargeIn(reason) {
    if (!this.speaking) return;
    this.send({ type: 'events', events: [{ type: 'BARGE_IN', text: `Human interrupted AEGIS (${reason})`, at: Date.now() }] });
    this.abortSpeech('barge-in');
  }

  // ---------- evidence + summary ----------
  clip(startMs, endMs) {
    const pcm = this.audioSlice(startMs * BYTES_PER_MS, endMs * BYTES_PER_MS);
    return wav(pcm).toString('base64');
  }

  // Manual end: stop listening, write the brief, then AEGIS reads a short recap aloud.
  async wrapUp() {
    this.ended = true;
    this.live?.close();
    this.translate?.close();
    this.abortSpeech('wrap-up');
    this.state.status = 'WRAPPING UP';
    this.pushState();
    const brief = await this.summary();
    if (!brief) return;
    const parts = [
      `Here's where we landed. ${brief.headline}.`,
      brief.decisions?.length ? `Decided: ${brief.decisions.slice(0, 2).join('; ')}.` : '',
      brief.action_items?.length ? `Next steps: ${brief.action_items.slice(0, 2).map(a => `${a.owner} will ${a.task.replace(/^\w/, c => c.toLowerCase())}`).join('; ')}.` : '',
      brief.open_issues?.length ? `Still open: ${brief.open_issues[0]}.` : 'Nothing is left unresolved.',
    ];
    const text = parts.filter(Boolean).join(' ');
    const job = { id: `w${Date.now()}`, aborted: false, startedAt: Date.now() };
    this.speaking = job;
    this.send({ type: 'recap', id: job.id, text });
    this.send({ type: 'events', events: [{ type: 'RECAP', text, at: Date.now() }] });
    try {
      await speakStream(text, ({ pcm, rate }) => {
        if (!job.aborted) this.send({ type: 'audio', id: job.id, rate, data: pcm.toString('base64') });
      }, { voice: config.VOICE, style: 'warm', shouldAbort: () => job.aborted });
    } catch (e) { this.log(`recap tts failed ${e.message}`); }
    if (!job.aborted) this.send({ type: 'audio_end', id: job.id });
    this.state.status = 'ENDED';
    this.pushState();
  }

  async summary() {
    this.send({ type: 'summary_pending' });
    const all = this.audioSlice(0, this.totalBytes);
    let groundTruth = '';
    try { groundTruth = await transcribe(all); } catch (e) { this.log(`full transcribe failed ${e.message}`); }
    try {
      const brief = await summarize(this.state, groundTruth);
      this.send({ type: 'summary', brief, groundTruth });
      return brief;
    } catch (e) {
      this.send({ type: 'summary', error: e.message });
      return null;
    }
  }

  pushState() { this.send({ type: 'state', state: W.view(this.state) }); }
}

async function warmup(speakOnce) {
  try {
    cachedChime = await speakOnce('Hold on.', { voice: config.VOICE, style: 'serious' });
    console.log(`[boot] chime cached (${cachedChime.pcm.length} bytes @ ${cachedChime.rate}Hz)`);
  } catch (e) { console.log(`[boot] chime failed: ${e.message}`); }
}

module.exports = { Session, warmup };
