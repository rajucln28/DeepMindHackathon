// Mic capture (16kHz PCM out) and a streaming playback queue that can be cut instantly for barge-in.

export class Mic {
  ctx: AudioContext | null = null;
  stream: MediaStream | null = null;
  onChunk: (pcm: ArrayBuffer, rms: number) => void = () => {};

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('/pcm-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    node.port.onmessage = (e) => this.onChunk(e.data.pcm, e.data.rms);
    src.connect(node);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = null;
  }
}

function int16ToBuffer(ctx: AudioContext, pcm: ArrayBuffer, rate: number): AudioBuffer {
  const i16 = new Int16Array(pcm);
  const buf = ctx.createBuffer(1, Math.max(1, i16.length), rate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 0x8000;
  return buf;
}

export function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Plays AEGIS's voice: chunks are scheduled back-to-back; stop() cuts everything immediately. */
export class Player {
  ctx = new AudioContext();
  gain = this.ctx.createGain();
  analyser = this.ctx.createAnalyser();
  sources = new Set<AudioBufferSourceNode>();
  nextTime = 0;
  currentId: string | null = null;
  ended = false;
  onDone: (id: string) => void = () => {};

  constructor() {
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.analyser.fftSize = 256;
  }

  get playing() { return this.sources.size > 0; }

  begin(id: string) {
    this.stop();
    this.currentId = id;
    this.ended = false;
    this.nextTime = this.ctx.currentTime + 0.02;
  }

  enqueue(id: string, pcm: ArrayBuffer, rate: number) {
    if (id !== this.currentId) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = int16ToBuffer(this.ctx, pcm, rate);
    src.connect(this.gain);
    const at = Math.max(this.ctx.currentTime + 0.01, this.nextTime);
    src.start(at);
    this.nextTime = at + src.buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.ended && this.sources.size === 0 && this.currentId === id) {
        this.currentId = null;
        this.onDone(id);
      }
    };
  }

  end(id: string) {
    if (id !== this.currentId) return;
    this.ended = true;
    if (this.sources.size === 0) { this.currentId = null; this.onDone(id); }
  }

  stop() {
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
    this.currentId = null;
  }

  /** One-off playback (evidence clips, demo lines). Resolves when finished. */
  async playOnce(buffer: AudioBuffer, dest: AudioNode = this.ctx.destination) {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return new Promise<void>((resolve) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(dest);
      src.onended = () => resolve();
      src.start();
    });
  }

  pcmBuffer(pcm: ArrayBuffer, rate: number) { return int16ToBuffer(this.ctx, pcm, rate); }

  level(): number {
    const d = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(d);
    let s = 0;
    for (const v of d) s += ((v - 128) / 128) ** 2;
    return Math.sqrt(s / d.length);
  }
}
