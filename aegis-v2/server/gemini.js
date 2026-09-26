// Thin wrappers around every Gemini model AEGIS uses.
const { GoogleGenAI, Modality } = require('@google/genai');
const config = require('./config');

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

function wav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Returns { pcm, rate } — strips a WAV header if the model sent one.
function decodeAudio(b64, mimeType = '') {
  let buf = Buffer.from(b64, 'base64');
  let rate = Number((mimeType.match(/rate=(\d+)/) || [])[1]) || 24000;
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
    rate = buf.readUInt32LE(24);
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
      if (id === 'data') { buf = buf.subarray(off + 8, off + 8 + Math.min(size, buf.length - off - 8)); break; }
      off += 8 + size;
    }
  }
  return { pcm: buf, rate };
}

// ---------- Flash TTS (streaming) ----------
// `style` is an inline audio tag (e.g. "calm", "frustrated") — the TTS model obeys it without reading it aloud.
async function speakStream(text, onPcm, { voice = 'Kore', style = 'calm', shouldAbort = () => false } = {}) {
  const stream = await ai.models.generateContentStream({
    model: config.MODELS.TTS,
    contents: [{ parts: [{ text: style ? `[${style}] ${text}` : text }] }],
    config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  });
  for await (const chunk of stream) {
    if (shouldAbort()) return false;
    for (const p of chunk.candidates?.[0]?.content?.parts || []) {
      if (p.inlineData?.data) onPcm(decodeAudio(p.inlineData.data, p.inlineData.mimeType));
    }
  }
  return true;
}

async function speakOnce(text, opts = {}) {
  const parts = [];
  let rate = 24000;
  await speakStream(text, (a) => { parts.push(a.pcm); rate = a.rate; }, opts);
  return { pcm: Buffer.concat(parts), rate };
}

// ---------- Transcribe (ground truth) ----------
async function transcribe(pcm16k) {
  const r = await ai.models.generateContent({
    model: config.MODELS.TRANSCRIBE,
    contents: [{ parts: [{ inlineData: { mimeType: 'audio/wav', data: wav(pcm16k).toString('base64') } }] }],
  });
  const parts = r.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.audioTranscription?.text || p.text || '').join(' ').trim();
}

// ---------- Flash (JSON reasoning, optionally over audio) ----------
async function flashJson(prompt, { audio, schema } = {}) {
  const parts = [];
  if (audio) parts.push({ inlineData: { mimeType: 'audio/wav', data: wav(audio).toString('base64') } });
  parts.push({ text: prompt });
  const cfg = { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } };
  if (schema) cfg.responseJsonSchema = schema;
  const r = await ai.models.generateContent({ model: config.MODELS.ANALYSIS, contents: [{ parts }], config: cfg });
  return JSON.parse(r.text);
}

// ---------- Live sessions (captions + translation) ----------
// A resilient Live session: reconnects with session resumption if the server closes it.
class LiveStream {
  constructor(name, model, config, onMessage, log) {
    Object.assign(this, { name, model, config, onMessage, log });
    this.session = null; this.handle = null; this.closed = false; this.ready = false;
  }
  async open() {
    if (this.closed) return;
    const cfg = { ...this.config, sessionResumption: this.handle ? { handle: this.handle } : {} };
    try {
      this.session = await ai.live.connect({
        model: this.model, config: cfg,
        callbacks: {
          onmessage: (m) => {
            if (m.setupComplete) { this.ready = true; this.log(`${this.name} ready`); this.onStatus?.(this.name, 'ready'); }
            if (m.sessionResumptionUpdate?.newHandle) this.handle = m.sessionResumptionUpdate.newHandle;
            if (m.goAway) this.log(`${this.name} goAway`);
            this.onMessage(m, this);
          },
          onerror: (e) => { this.log(`${this.name} error ${e.message}`); this.onStatus?.(this.name, 'error'); },
          onclose: (e) => {
            this.ready = false;
            if (this.closed) return;
            this.log(`${this.name} closed ${e?.code} ${e?.reason || ''} — reconnecting`);
            this.onStatus?.(this.name, 'reconnecting');
            setTimeout(() => this.open(), 500);
          },
        },
      });
    } catch (e) {
      this.log(`${this.name} connect failed: ${e.message}`);
      this.onStatus?.(this.name, 'error');
      if (!this.closed) setTimeout(() => this.open(), 2000);
    }
  }
  sendAudio(pcm) {
    if (!this.ready || !this.session) return;
    try { this.session.sendRealtimeInput({ audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }); } catch {}
  }
  close() { this.closed = true; try { this.session?.close(); } catch {} }
}

module.exports = { ai, Modality, wav, decodeAudio, speakStream, speakOnce, transcribe, flashJson, LiveStream };
