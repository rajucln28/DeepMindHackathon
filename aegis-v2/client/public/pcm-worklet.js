// Mic capture: resamples the context rate down to 16kHz Int16 and posts ~100ms chunks + RMS level.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.sq = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const s = ch[i] * (1 - f) + (ch[i + 1] ?? ch[i]) * f;
      const v = Math.max(-1, Math.min(1, s));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.sq += v * v;
      if (this.n === this.out.length) {
        this.port.postMessage({ pcm: this.out.buffer, rms: Math.sqrt(this.sq / this.n) }, [this.out.buffer]);
        this.out = new Int16Array(1600); this.n = 0; this.sq = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
