// Renders the scripted demo meeting with distinct TTS voices → server/demo/*.pcm (16kHz mono) + script.json.
// Used by the end-to-end test harness and by the stage "fallback demo" button.
const fs = require('fs');
const path = require('path');
const { speakOnce } = require('./gemini');

const DIR = path.join(__dirname, 'demo');
fs.mkdirSync(DIR, { recursive: true });

const LINES = [
  { id: 'a1', voice: 'Charon', style: 'confident', text: "Hi everyone, Arjun from finance here. Good news: the server migration budget is approved at five hundred thousand dollars, and we go live this Friday." },
  { id: 'b1', voice: 'Kore', style: 'friendly', text: "Thanks Arjun, this is Priya from infra. With that budget my team can finish the cutover by Friday evening." },
  { id: 'c1', voice: 'Puck', style: 'frustrated', text: "नहीं नहीं, ये बिल्कुल गलत है! बजट सिर्फ़ दो लाख डॉलर का मंज़ूर हुआ है, पाँच लाख का नहीं।", waitFor: 'audio' },
  { id: 'a2', voice: 'Charon', style: 'serious', text: "Aegis, stop. I just checked the email, the extra three hundred thousand was approved this morning. So it is five hundred thousand, final." },
  { id: 'c2', voice: 'Puck', style: 'calm', text: "ठीक है, अगर ईमेल में है तो पाँच लाख ही फाइनल है।" },
];

function resample(pcm, from, to) {
  const src = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
  const n = Math.floor(src.length * to / from);
  const dst = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * from / to, j = Math.floor(x), f = x - j;
    dst[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f;
  }
  return Buffer.from(dst.buffer);
}

(async () => {
  for (const line of LINES) {
    const { pcm, rate } = await speakOnce(line.text, { voice: line.voice, style: line.style });
    const pcm16 = resample(pcm, rate, 16000);
    fs.writeFileSync(path.join(DIR, `${line.id}.pcm`), pcm16);
    console.log(`${line.id}: ${(pcm16.length / 32000).toFixed(1)}s (${line.voice})`);
  }
  fs.writeFileSync(path.join(DIR, 'script.json'), JSON.stringify(LINES.map(({ id, text, waitFor }) => ({ id, text, waitFor })), null, 2));
})();
