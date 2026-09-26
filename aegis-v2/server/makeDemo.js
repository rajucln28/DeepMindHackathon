// Renders the scripted demo meeting with distinct TTS voices → server/demo/*.pcm (16kHz mono) + script.json.
// Used by the end-to-end test harness and by the stage "fallback demo" button.
const fs = require('fs');
const path = require('path');
const { speakOnce } = require('./gemini');

const DIR = path.join(__dirname, 'demo');
fs.mkdirSync(DIR, { recursive: true });

const LINES = [
  { id: 'r1', voice: 'Puck', style: 'frustrated', text: "कंट्रोल, मैं रमेश, फील्ड टीम से। वेस्ट ब्रिज के पास एक आदमी मलबे में फँसा है, उसे साँस लेने में दिक्कत हो रही है!" },
  { id: 'r2', voice: 'Kore', style: 'frustrated', text: "नहीं नहीं, मेरे पापा रेलवे ब्रिज के पास हैं, वेस्ट ब्रिज पर नहीं! प्लीज़ जल्दी कीजिए!", waitFor: 'done' },
  { id: 'r3', voice: 'Charon', style: '', text: "This is Arjun, dispatch. Ramesh's GPS puts him on West Bridge, and he can see the victim. The location is West Bridge." },
  { id: 'r4', voice: 'Charon', style: '', text: "Create an urgent medical response to West Bridge, critical priority.", waitFor: 'done' },
  { id: 'r5', voice: 'Charon', style: '', text: "Confirm.", waitFor: 'audio' },
  { id: 'r6', voice: 'Puck', style: 'frustrated', text: "Stop! North entrance बंद है, पेड़ गिरा है। South road से आना होगा।", waitFor: 'done' },
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
