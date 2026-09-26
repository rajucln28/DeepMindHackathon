// End-to-end harness: streams the scripted demo into a running server over WebSocket, in real time,
// and prints what AEGIS perceives, decides and says. Usage: node e2e.js [ws://localhost:3001/ws]
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const URL = process.argv[2] || 'ws://localhost:3001/ws';
const DIR = path.join(__dirname, 'demo');
const script = JSON.parse(fs.readFileSync(path.join(DIR, 'script.json')));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => `${((Date.now() - T0) / 1000).toFixed(1).padStart(5)}s`;

const ws = new WebSocket(URL);
let gotAudio = false, audioChunks = 0, lastState = null, summary = null;

ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  switch (m.type) {
    case 'events': for (const e of m.events) console.log(`${ts()} EVENT ${e.type.padEnd(22)} ${e.text}`); break;
    case 'state': lastState = m.state; console.log(`${ts()} STATE ${m.state.status} conf=${m.state.confidence} threat=${m.state.threat} temp=${m.state.temperature}`); break;
    case 'intervene': console.log(`${ts()} >>> INTERVENE (chime) "${m.text}"`); break;
    case 'audio': if (!gotAudio) console.log(`${ts()} >>> first TTS audio chunk`); gotAudio = true; audioChunks++; break;
    case 'audio_end': console.log(`${ts()} >>> TTS done (${audioChunks} chunks)`); break;
    case 'stop_audio': console.log(`${ts()} >>> STOP AUDIO (${m.reason})`); break;
    case 'verbatim': console.log(`${ts()} TRANSCRIBE ${m.id}: ${m.text}`); break;
    case 'utterance_failed': console.log(`${ts()} utterance dropped ${m.reason || ''}`); break;
    case 'summary': summary = m; break;
    case 'chime': console.log(`${ts()} chime received (${m.data.length} b64)`); break;
  }
});

async function stream(pcm) {
  const chunk = 3200; // 100ms
  for (let i = 0; i < pcm.length; i += chunk) {
    ws.send(pcm.subarray(i, i + chunk));
    await sleep(100);
  }
}
const silence = (ms) => stream(Buffer.alloc(Math.round(ms * 32)));

ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'start' }));
  await sleep(2500);
  await silence(1000);
  for (const line of script) {
    console.log(`${ts()} --- speaking ${line.id}: ${line.text}`);
    await stream(fs.readFileSync(path.join(DIR, `${line.id}.pcm`)));
    if (line.waitFor === 'audio') {
      const t = Date.now();
      while (!gotAudio && Date.now() - t < 15000) await silence(200);
      await silence(1500); // let AEGIS talk a bit, then barge in
    } else {
      await silence(1800);
    }
  }
  await silence(6000);
  ws.send(JSON.stringify({ type: 'summary' }));
  const t = Date.now();
  while (!summary && Date.now() - t < 30000) await sleep(300);
  console.log('\n=== FINAL STATE ===');
  console.log('speakers:', Object.values(lastState.speakers).map(s => `${s.id}(${s.name || '?'}, ${s.language}, ${s.tone})`).join(' | '));
  console.log('facts:'); for (const f of lastState.facts) console.log(`  ${f.id} [${f.status}] ${f.speaker}: ${f.text}`);
  console.log('contradictions:'); for (const c of lastState.contradictions) console.log(`  ${c.id} [${c.status}] ${c.explanation} → ${c.resolution || ''}`);
  console.log('\n=== SUMMARY ===\n', JSON.stringify(summary?.brief || summary, null, 2));
  ws.close();
  process.exit(0);
});
