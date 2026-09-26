// One RescueRoom session per connected browser: audio in → perception → incident state → actions → spoken response.
const config = require('./config');
const { Modality, LiveStream, speakStream, transcribe, wav } = require('./gemini');
const { analyzeUtterance, quickCheck, summarize } = require('./analyzer');
const W = require('./worldState');
const tools = require('./tools');

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

    const status = (name, st) => this.send({ type: 'model_status', name, status: st });
    this.live.onStatus = status;
    this.translate.onStatus = status;
    status('live', 'connecting'); status('translate', 'connecting');
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
    if (this.speaking && Date.now() - this.speaking.startedAt > 600) this.bargeIn('voice detected over RescueRoom');
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
      this.log(`analysed ${clip.start}-${clip.end}ms in ${Date.now() - t0}ms: [${a.speaker_id}/${a.speaker_role}/${a.language}/${a.tone}/${a.urgency}] ${a.english}`);
      if (a.is_rescueroom_echo) { this.send({ type: 'utterance_failed', clip, reason: 'echo' }); return; }

      const { events, utterance, contradiction, resolved, actionRequested, confirmed, replanned } = W.apply(this.state, a, clip);
      utterance.latencyMs = Date.now() - t0;
      this.send({ type: 'events', events });
      this.pushState();

      gt.then(text => {
        if (!text) return;
        utterance.verbatim = text;
        this.send({ type: 'verbatim', id: utterance.id, text });
      });

      if (resolved && this.speaking) this.abortSpeech('resolved');
      if (!contradiction) this.send({ type: 'suspect_clear' });
      this.react({ a, endedAt, contradiction, resolved, actionRequested, confirmed, replanned });
    });
  }

  // ---------- action: tone-aware intervention ----------
  // Decide what (if anything) to say after an utterance, and kick off tools.
  react({ a, endedAt, contradiction, resolved, actionRequested, confirmed, replanned }) {
    const replies = (a.replies || []).filter(r => r.text);
    if (contradiction) {
      if (Date.now() - this.lastInterventionAt < config.INTERVENTION.COOLDOWN_MS) return;
      this.lastInterventionAt = Date.now();
      const lines = replies.length ? replies : [{ to: 'all', language: 'en', text: `I heard two versions. ${contradiction.question || contradiction.explanation}` }];
      return this.planSpeech({ kind: 'CLARIFY', lines, a, endedAt, valid: () => contradiction.status === 'OPEN', chime: true });
    }
    if (actionRequested) {
      const act = actionRequested;
      const disp = this.state.speakers[act.requestedBy];
      const openQ = this.state.open_questions.find(q => q.status === 'OPEN');
      const lines = act.status === 'BLOCKED'
        ? [{ to: act.requestedBy, language: 'en', text: `Holding ${act.label.toLowerCase()} until the location is verified. ${openQ ? openQ.text : ''}` }]
        : replies.length ? replies : [{ to: act.requestedBy, language: 'en', text: `${act.label} to ${act.location}, ${act.priority} priority. ${disp && disp.name ? disp.name + ', confirm?' : 'Confirm?'}` }];
      return this.planSpeech({ kind: 'READBACK', lines, a, endedAt, valid: () => ['AWAITING_CONFIRMATION', 'BLOCKED'].includes(act.status) });
    }
    if (confirmed) return this.dispatch(confirmed);
    if (replanned) return this.replan(replanned, a, replies);
    if (resolved) {
      const unblocked = this.state.actions.find(x => x.status === 'AWAITING_CONFIRMATION' && x.history.some(h => h.text.startsWith('Unblocked')));
      if (unblocked) {
        const lines = [{ to: unblocked.requestedBy, language: 'en', text: `Location verified: ${unblocked.location}. ${unblocked.label}, ${unblocked.priority}. Confirm?` }];
        return this.planSpeech({ kind: 'READBACK', lines, a, endedAt, valid: () => unblocked.status === 'AWAITING_CONFIRMATION' });
      }
    }
  }

  // Runs mock tools in parallel; each one visibly flips from running → done in the UI.
  async runTools(action, calls) {
    const entries = calls.map(([name, args]) => {
      const e = { name, args, status: 'running', startedAt: Date.now() };
      action.tools.push(e);
      return e;
    });
    this.pushState();
    return Promise.all(calls.map(([name, args], i) => tools.run(name, args).then(r => {
      Object.assign(entries[i], { status: 'done', result: r.result, ms: r.ms });
      this.pushState();
      return r.result;
    })));
  }

  // Non-English, non-dispatcher participants get their own line in Hindi.
  localLines(text) {
    return Object.values(this.state.speakers)
      .filter(sp => sp.language !== 'en' && sp.role !== 'dispatcher')
      .map(sp => ({ to: sp.id, language: 'hi', text: text(sp) }));
  }

  async dispatch(action) {
    const loc = action.location;
    const [where, weather, kb] = await this.runTools(action, [
      ['lookup_location', { location: loc }],
      ['get_weather', { location: loc }],
      ['knowledge_lookup', { topic: action.details || action.type }],
    ]);
    const notify = this.localLines(() => '').map(f => ['send_notification', { to: this.state.speakers[f.to].name || f.to, message: `Team dispatched to ${loc}` }]);
    const [task] = await this.runTools(action, [
      ['create_task', { type: action.type, location: loc, priority: action.priority, route: where.access }],
      ...notify,
    ]);
    Object.assign(action, { status: 'DISPATCHED', taskId: task.task_id, unit: task.assigned, eta: where.eta_min, route: where.access, weather: weather.conditions, protocol: kb.protocol });
    action.history.push({ at: Date.now(), text: `${task.task_id}: ${task.assigned} en route via ${where.access}, ETA ${where.eta_min} min` });
    this.send({ type: 'events', events: [W.mark(this.state, 'ACTION_DISPATCHED', `${task.task_id} · ${action.label} → ${loc}, ETA ${where.eta_min} min`)] });
    W.recompute(this.state);
    this.pushState();
    const disp = this.state.speakers[action.requestedBy];
    const lines = [
      { to: action.requestedBy, language: 'en', text: `Confirmed. ${task.assigned} is en route to ${loc} via the ${where.access.toLowerCase()}. ETA ${where.eta_min} minutes. ${weather.conditions} on scene.` },
      ...this.localLines(sp => `${sp.name ? sp.name + ' जी, ' : ''}मेडिकल टीम ${loc} के लिए निकल चुकी है, लगभग ${where.eta_min} मिनट में पहुँचेगी।`),
    ];
    this.planSpeech({ kind: 'STATUS', lines, a: { tone: disp ? disp.tone : 'calm' }, endedAt: Date.now(), valid: () => action.status === 'DISPATCHED' });
  }

  async replan(action, a, replies) {
    const avoid = action.constraints[action.constraints.length - 1];
    const [where] = await this.runTools(action, [['lookup_location', { location: action.location, avoid }]]);
    const route = action.pendingRoute || where.access;
    const [task] = await this.runTools(action, [
      ['create_task', { type: action.type, location: action.location, priority: action.priority, route }],
      ['send_notification', { to: action.unit || 'Medic-7', message: `REROUTE: ${avoid}. Use ${route}.` }],
    ]);
    Object.assign(action, { status: action.previousStatus === 'AWAITING_CONFIRMATION' ? 'AWAITING_CONFIRMATION' : 'DISPATCHED', route, eta: where.eta_min, taskId: task.task_id });
    action.history.push({ at: Date.now(), text: `Rerouted via ${route}, new ETA ${where.eta_min} min` });
    this.send({ type: 'events', events: [W.mark(this.state, 'ACTION_REROUTED', `${action.label} rerouted via ${route} (${avoid}) · ETA ${where.eta_min} min`)] });
    W.recompute(this.state);
    this.pushState();
    const lines = replies.length ? replies : [
      { to: action.requestedBy, language: 'en', text: `Understood: ${avoid}. Rerouting ${action.unit || 'the team'} via ${route}. New ETA ${where.eta_min} minutes.` },
      ...this.localLines(() => `समझ गया, टीम अब ${route} से आएगी।`),
    ];
    this.planSpeech({ kind: 'REPLAN', lines, a, endedAt: Date.now(), valid: () => action.status !== 'REPLANNING' });
  }

  confirmFromConsole(id) {
    const action = this.state.actions.find(x => x.id === id && x.status === 'AWAITING_CONFIRMATION');
    if (!action) return;
    W.confirmAction(this.state, action, 'Dispatcher console');
    this.send({ type: 'events', events: [W.mark(this.state, 'ACTION_CONFIRMED', `Console confirmed: ${action.label} → ${action.location}`)] });
    this.pushState();
    this.dispatch(action);
  }

  // Tone-aware speech: synthesis starts immediately, playback waits until the policy allows it.
  planSpeech({ kind, lines, a, endedAt, valid, chime = false }) {
    const I = config.INTERVENTION;
    const hostile = W.HOSTILE.has(a.tone), unsure = W.UNSURE.has(a.tone);
    const policy = hostile
      ? { backoff: I.BACKOFF_ANGRY_MS, quiet: I.QUIET_ANGRY_MS, style: 'warm', label: `${a.tone} → wait for ${I.QUIET_ANGRY_MS / 1000}s of calm, soften wording, add Hindi if needed` }
      : unsure
        ? { backoff: 0, quiet: I.QUIET_DEFAULT_MS, style: 'reassuring', label: `${a.tone} → intervene immediately, ground them` }
        : { backoff: I.BACKOFF_DEFAULT_MS, quiet: I.QUIET_DEFAULT_MS, style: 'calm', label: `${a.tone} → crisp, neutral intervention` };
    const text = lines.map(l => l.text).join(' ');
    if (kind === 'CLARIFY') this.send({ type: 'events', events: [{ type: 'TONE_POLICY', text: policy.label, at: Date.now() }] });

    // Start synthesising right away; audio is buffered until the tone policy says it is OK to speak.
    const job = { id: `i${Date.now()}`, aborted: false, released: false, buffered: [], done: false, startedAt: 0 };
    const spoken = chime ? (text.replace(/^\s*(hold on|wait|excuse me)[\s.,!—–-]*/i, '') || text) : text; // chime already says "Hold on"
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
      if (!valid()) { job.aborted = true; return; }
      const quietFor = Date.now() - this.vad.lastSpeechAt;
      const waiting = Date.now() < deadline || this.vad.inSpeech || quietFor < policy.quiet;
      if (waiting && Date.now() - waitStart < I.MAX_WAIT_FOR_SILENCE_MS) return setTimeout(go, 100);
      this.intervene({ kind, lines, text, job, endedAt, chime });
    };
    go();
  }

  intervene({ kind, lines, text, job, endedAt, chime }) {
    this.abortSpeech('superseded');
    job.startedAt = Date.now();
    this.speaking = job;
    this.lastInterventionText = text;
    this.log(`${kind} speaking ${Date.now() - endedAt}ms after trigger`);
    // Tier 1: instant pre-rendered "Hold on." on the client (clarifications only), zero model latency.
    this.send({ type: 'intervene', id: job.id, text, kind, chime });
    const ROLE = { dispatcher: 'Dispatcher', field_responder: 'Field responder', family: 'Family' };
    const lineView = lines.map(l => { const sp = this.state.speakers[l.to]; return { ...l, name: sp ? (sp.name || ROLE[sp.role] || l.to) : 'Everyone' }; });
    this.send({ type: 'events', events: [W.mark(this.state, 'INTERVENTION', text, { kind, lines: lineView, ms: Date.now() - endedAt })] });
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
    this.send({ type: 'events', events: [{ type: 'BARGE_IN', text: `Human interrupted RescueRoom (${reason})`, at: Date.now() }] });
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
    this.state.status = 'CLOSING';
    this.pushState();
    const brief = await this.summary();
    if (!brief) return;
    const parts = [
      `Incident summary. ${brief.headline}.`,
      brief.actions?.length ? `Actions: ${brief.actions.slice(0, 2).map(x => `${x.action}, ${x.status}`).join('; ')}.` : '',
      brief.open_issues?.length ? `Still open: ${brief.open_issues[0]}.` : 'No unresolved contradictions.',
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
    cachedChime = await speakOnce('Hold on.', { voice: config.VOICE, style: 'calm' });
    console.log(`[boot] chime cached (${cachedChime.pcm.length} bytes @ ${cachedChime.rate}Hz)`);
  } catch (e) { console.log(`[boot] chime failed: ${e.message}`); }
}

module.exports = { Session, warmup };
