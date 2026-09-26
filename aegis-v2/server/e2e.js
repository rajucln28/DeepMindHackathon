// End-to-end harness: streams the scripted incident into a running server over WebSocket in real time,
// simulates playback timing (so barge-in behaves like a real room) and prints what RescueRoom does.
// Usage: node e2e.js [ws://localhost:3001/ws]
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
let lastState = null, summary = null;
const speech = { id: null, playing: false, bytes: 0, rate: 24000, started: 0, done: 0 };

ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  switch (m.type) {
    case 'events': for (const e of m.events) {
      console.log(`${ts()} EVENT ${e.type.padEnd(20)} ${e.text}`);
      if (e.lines) for (const l of e.lines) console.log(`${' '.repeat(33)}→ ${l.name} [${l.language}] ${l.text}`);
    } break;
    case 'state': {
      const s = m.state, prev = lastState;
      lastState = s;
      if (!prev || prev.status !== s.status || prev.urgency !== s.urgency) console.log(`${ts()} STATE ${s.status} urgency=${s.urgency} conf=${s.confidence}`);
      for (const a of s.actions) for (const t of a.tools) if (t.status === 'done' && !t._p) {
        const was = prev?.actions.find(x => x.id === a.id)?.tools.find(x => x.name === t.name && x.startedAt === t.startedAt);
        if (!was || was.status !== 'done') console.log(`${ts()} TOOL  ${a.id} ${t.name} (${t.ms}ms) ${JSON.stringify(t.result).slice(0, 110)}`);
      }
      break;
    }
    case 'intervene': Object.assign(speech, { id: m.id, playing: true, bytes: 0, started: Date.now() }); console.log(`${ts()} >>> SPEAK [${m.kind}]`); break;
    case 'audio': if (m.id === speech.id) { speech.bytes += Buffer.from(m.data, 'base64').length; speech.rate = m.rate; } break;
    case 'audio_end': if (m.id === speech.id) {
      const durMs = speech.bytes / 2 / speech.rate * 1000;
      const left = Math.max(0, speech.started + durMs + 900 - Date.now()); // +chime
      setTimeout(() => { if (speech.id === m.id && speech.playing) { speech.playing = false; speech.done++; ws.send(JSON.stringify({ type: 'audio_done', id: m.id })); console.log(`${ts()} >>> finished speaking (${(durMs / 1000).toFixed(1)}s)`); } }, left);
    } break;
    case 'stop_audio': speech.playing = false; speech.done++; console.log(`${ts()} >>> STOP AUDIO (${m.reason})`); break;
    case 'suspect': console.log(`${ts()} FAST  ${m.text}`); break;
    case 'summary': summary = m; break;
  }
});

async function stream(pcm) {
  for (let i = 0; i < pcm.length; i += 3200) { ws.send(pcm.subarray(i, i + 3200)); await sleep(100); }
}
const silence = (ms) => stream(Buffer.alloc(Math.round(ms * 32)));

ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'start', mode: 'demo' }));
  await sleep(2500);
  await silence(1000);
  for (const line of script) {
    const doneBefore = speech.done, idBefore = speech.id;
    console.log(`${ts()} --- ${line.id}: ${line.text}`);
    await stream(fs.readFileSync(path.join(DIR, `${line.id}.pcm`)));
    const t = Date.now();
    if (line.waitFor === 'audio') {
      while (speech.id === idBefore && Date.now() - t < 20000) await silence(200);
      await silence(2500); // let it talk, then barge in
    } else if (line.waitFor === 'done') {
      while (speech.id === idBefore && Date.now() - t < 20000) await silence(200);
      while (speech.done === doneBefore && Date.now() - t < 40000) await silence(200);
      await silence(800);
    } else await silence(1800);
  }
  await silence(5000);
  ws.send(JSON.stringify({ type: 'summary' }));
  const t = Date.now();
  while (!summary && Date.now() - t < 40000) await sleep(300);
  const s = lastState;
  console.log('\n=== FINAL STATE ===');
  console.log('situation:', s.situation, '| urgency:', s.urgency);
  console.log('speakers:', Object.values(s.speakers).map(x => `${x.id}(${x.name || '?'}, ${x.role}, ${x.language})`).join(' | '));
  for (const f of s.facts) console.log(`  fact ${f.id} [${f.status}] ${f.text}`);
  for (const c of s.contradictions) console.log(`  con  ${c.id} [${c.status}] ${c.claimA} vs ${c.claimB} → ${c.resolution || ''}`);
  for (const q of s.open_questions) console.log(`  q    ${q.id} [${q.status}] ${q.text}`);
  for (const a of s.actions) console.log(`  act  ${a.id} ${a.label} → ${a.location} [${a.status}] route=${a.route} eta=${a.eta} tools=${a.tools.length}`);
  console.log('\n=== REPORT ===\n', JSON.stringify(summary?.brief || summary, null, 1).slice(0, 2500));
  ws.close();
  process.exit(0);
});
