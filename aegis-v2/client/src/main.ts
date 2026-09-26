import './style.css';
import { Mic, Player, b64ToArrayBuffer } from './audio';

// ---------------- types (mirrors server/worldState.js) ----------------
type Speaker = { id: string; name: string; voice: string; language: string; tone: string; utterances: number; facts: number; contradictions: number };
type Fact = { id: string; text: string; speaker: string; utterance: string; status: string; settled?: boolean };
type Contradiction = {
  id: string; factA: string; factB: string; utterA: string; utterB: string; speakerA: string; speakerB: string;
  explanation: string; status: string; resolution?: string; crossLanguage?: boolean;
};
type Utterance = { id: string; speaker: string; start: number; end: number; transcript: string; english: string; language: string; tone: string; toneCue: string; verbatim: string; latencyMs?: number };
type State = {
  status: string; confidence: number; threat: string; temperature: number; languages: string[];
  speakers: Record<string, Speaker>; facts: Fact[]; contradictions: Contradiction[]; utterances: Utterance[];
};
type Ev = { type: string; text: string; at: number; speaker?: string; tone?: string; ms?: number };
type FeedItem = { kind: 'utt'; id: string; chips: Ev[] } | { kind: 'sys'; ev: Ev };

// ---------------- DOM ----------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
document.querySelector('#app')!.innerHTML = `
<header class="top">
  <div class="brand">
    <div class="logo"><svg viewBox="0 0 32 32"><path d="M16 2 4 7v8c0 7.5 5.1 13.4 12 15 6.9-1.6 12-7.5 12-15V7L16 2Z" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M10 16h3l2-5 3 10 2-5h2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div><h1>AEGIS</h1><span>Real-time meeting guardian · audio-only</span></div>
  </div>
  <div id="statusPill" class="pill">IDLE</div>
  <div class="actions">
    <button id="btnStart" class="primary">● Start listening</button>
    <button id="btnDemo" class="ghost">▶ Scripted demo</button>
    <button id="btnWrap" class="danger" disabled>■ End &amp; recap</button>
    <button id="btnSummary" class="ghost" disabled>Brief only</button>
  </div>
</header>

<section class="stage">
  <div class="orb-wrap">
    <canvas id="orb" width="280" height="280"></canvas>
    <div class="orb-label"><b id="confNum">100</b><span>confidence</span></div>
  </div>
  <div class="live">
    <div class="cap"><label><i class="dot live-dot"></i>Hearing now <em>Gemini 3.8 Live</em></label><p id="caption" class="caption muted">Waiting for audio…</p></div>
    <div class="cap"><label><i class="dot tr-dot"></i>English bridge <em>Gemini 3.5 Live Translate</em></label><p id="translation" class="caption muted">—</p></div>
    <div id="banner" class="banner hidden"><div class="eq"><i></i><i></i><i></i><i></i></div><div><small>AEGIS is speaking · Flash TTS · talk over it to interrupt</small><p id="bannerText"></p></div></div>
  </div>
  <div class="meters">
    <div class="meter"><label>Threat</label><div id="threat" class="threat GREEN">GREEN</div></div>
    <div class="meter"><label>Room temperature</label><div class="bar"><i id="tempBar"></i></div><small id="tempTxt">harmonious</small></div>
    <div class="meter"><label>Languages</label><div id="langs" class="chips"><span class="chip">—</span></div></div>
    <div class="meter"><label>Open conflicts</label><div id="openCount" class="big">0</div></div>
  </div>
</section>

<main class="grid">
  <section class="panel"><h2>Speakers <small>identified by voice</small></h2><div id="speakers" class="list"><p class="empty">No one has spoken yet.</p></div></section>
  <section class="panel feed-panel"><h2>Conversation <small>Flash hears tone · Transcribe keeps ground truth</small></h2><div id="timeline" class="feed"><p class="empty">Everything AEGIS hears and decides appears here.</p></div></section>
  <section class="panel">
    <h2>Contradictions <small>click ▶ to hear the evidence</small></h2><div id="contradictions" class="list"><p class="empty">No conflicts. Reality is consistent.</p></div>
    <h2 class="mt">World facts</h2><div id="facts" class="list"><p class="empty">No facts yet.</p></div>
  </section>
</main>
<div id="modal" class="modal hidden"><div class="sheet" id="sheet"></div></div>
`;

// ---------------- state ----------------
let ws: WebSocket | null = null;
let state: State | null = null;
const feed: FeedItem[] = [];
const seenUtt = new Set<string>();
let pendingChips: Ev[] = [];
let pending = false;
let chimePcm: { pcm: ArrayBuffer; rate: number } | null = null;
let mode: 'idle' | 'mic' | 'demo' = 'idle';
let micLevel = 0;
let loudChunks = 0;
let speakingSince = 0;
const player = new Player();
const mic = new Mic();
const clipWaiters = new Map<string, (b64: string) => void>();

const toneColor: Record<string, string> = {
  angry: '#ff4d5e', frustrated: '#ff8a3d', anxious: '#f5c542', confused: '#b18cff',
  confident: '#4da3ff', calm: '#3ddc97', neutral: '#8a93a6', excited: '#ff6fb5',
};
const speakerHue = (id: string) => ['#4da3ff', '#ff8a3d', '#3ddc97', '#b18cff', '#ff6fb5', '#f5c542'][(parseInt(id.split('_')[1]) - 1) % 6] || '#8a93a6';
const esc = (s = '') => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const nameOf = (id: string) => (state?.speakers[id]?.name) || id.replace('speaker_', 'Speaker ');
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

// ---------------- websocket ----------------
function connect(sessionMode: 'mic' | 'demo'): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { ws!.send(JSON.stringify({ type: 'start', mode: sessionMode })); resolve(); };
    ws.onerror = () => reject(new Error('Cannot reach AEGIS server'));
    ws.onclose = () => { if (mode !== 'idle') setPill('DISCONNECTED'); };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  });
}
const send = (m: object) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function onMessage(m: any) {
  switch (m.type) {
    case 'state':
      state = m.state;
      for (const u of state!.utterances) if (!seenUtt.has(u.id)) {
        seenUtt.add(u.id);
        feed.push({ kind: 'utt', id: u.id, chips: pendingChips });
        pendingChips = [];
        pending = false;
      }
      renderAll();
      break;
    case 'events':
      for (const ev of m.events as Ev[]) {
        if (['TONE_POLICY', 'INTERVENTION', 'BARGE_IN', 'RECAP'].includes(ev.type)) feed.push({ kind: 'sys', ev });
        else pendingChips.push(ev);
      }
      renderFeed();
      break;
    case 'caption': setCaption('caption', m.text); break;
    case 'translation': setCaption('translation', m.text); break;
    case 'utterance_pending': pending = true; renderFeed(); break;
    case 'suspect':
      feed.push({ kind: 'sys', ev: { type: 'SUSPECT', text: `${m.text} (${(m.ms / 1000).toFixed(1)}s after speech)`, at: Date.now() } });
      setPill('VERIFYING');
      renderFeed();
      break;
    case 'suspect_clear': if (state) setPill(state.status); break;
    case 'utterance_failed': pending = false; renderFeed(); break;
    case 'verbatim': {
      const u = state?.utterances.find((x) => x.id === m.id);
      if (u) { u.verbatim = m.text; renderFeed(); }
      break;
    }
    case 'chime': chimePcm = { pcm: b64ToArrayBuffer(m.data), rate: m.rate }; break;
    case 'intervene':
      player.begin(m.id);
      speakingSince = performance.now();
      if (chimePcm) player.enqueue(m.id, chimePcm.pcm, chimePcm.rate);
      showBanner(m.text);
      break;
    case 'recap':
      player.begin(m.id);
      speakingSince = performance.now();
      showBanner(m.text);
      break;
    case 'audio': player.enqueue(m.id, b64ToArrayBuffer(m.data), m.rate); break;
    case 'audio_end': player.end(m.id); break;
    case 'stop_audio': player.stop(); hideBanner(); break;
    case 'clip': clipWaiters.get(m.key)?.(m.data); clipWaiters.delete(m.key); break;
    case 'summary_pending': openModal(`<div class="spin"></div><p class="center">Gemini Transcribe is re-listening to the whole meeting…</p>`); break;
    case 'summary': renderSummary(m); break;
  }
}
player.onDone = (id) => { hideBanner(); send({ type: 'audio_done', id }); };

// ---------------- rendering ----------------
function setPill(s: string) { const p = $('statusPill'); p.textContent = s; p.className = `pill ${s}`; }

function setCaption(id: string, text: string) {
  const el = $(id);
  el.classList.remove('muted');
  el.textContent = text.trim() || '—';
}

function showBanner(text: string) { $('bannerText').textContent = text; $('banner').classList.remove('hidden'); }
function hideBanner() { $('banner').classList.add('hidden'); }

function renderAll() {
  if (!state) return;
  setPill(state.status);
  $('confNum').textContent = String(state.confidence);
  const t = $('threat'); t.textContent = state.threat; t.className = `threat ${state.threat}`;
  $('tempBar').style.width = `${state.temperature}%`;
  $('tempBar').style.background = state.temperature < 40 ? 'var(--red)' : state.temperature < 65 ? 'var(--amber)' : 'var(--green)';
  $('tempTxt').textContent = state.temperature < 40 ? 'heated' : state.temperature < 65 ? 'tense' : 'harmonious';
  $('langs').innerHTML = state.languages.length ? state.languages.map((l) => `<span class="chip lang">${l === 'hi' ? 'हिन्दी · HI' : 'English · EN'}</span>`).join('') : '<span class="chip">—</span>';
  $('openCount').textContent = String(state.contradictions.filter((c) => c.status === 'OPEN').length);
  renderSpeakers();
  renderFeed();
  renderContradictions();
  renderFacts();
}

function renderSpeakers() {
  const sp = Object.values(state!.speakers);
  if (!sp.length) return;
  $('speakers').innerHTML = sp.map((s) => `
    <div class="speaker" style="--c:${speakerHue(s.id)}">
      <div class="avatar">${esc((s.name || s.id.replace('speaker_', 'S'))[0].toUpperCase())}</div>
      <div class="sp-body">
        <div class="sp-top"><b>${esc(nameOf(s.id))}</b><span class="chip lang">${s.language === 'hi' ? 'HI' : s.language === 'mixed' ? 'HI+EN' : 'EN'}</span></div>
        <div class="tone" style="--t:${toneColor[s.tone] || '#8a93a6'}"><i></i>${esc(s.tone)}</div>
        <small class="voice">${esc(s.voice)}</small>
        <div class="stats"><span>${s.utterances} turns</span><span>${s.facts} facts</span><span class="${s.contradictions ? 'warn' : ''}">${s.contradictions} conflicts</span></div>
      </div>
    </div>`).join('');
}

const chipLabel: Record<string, string> = {
  SPEAKER_ENTERED: 'new voice', LANGUAGE_DETECTED: 'language', FACT_ESTABLISHED: 'fact', CONTRADICTION_DETECTED: 'contradiction',
  EMOTIONAL_SHIFT: 'tone', CONFLICT_RESOLVED: 'resolved', AGREEMENT_REACHED: 'agreement',
};

function renderFeed() {
  if (!state && !feed.length && !pending) return;
  const html = feed.map((item) => {
    if (item.kind === 'sys') {
      const e = item.ev;
      const icon = e.type === 'INTERVENTION' ? '🛡' : e.type === 'BARGE_IN' ? '✋' : e.type === 'SUSPECT' ? '⚡' : e.type === 'RECAP' ? '🗣' : '🎚';
      const title = e.type === 'INTERVENTION' ? `AEGIS spoke up${e.ms ? ` · ${(e.ms / 1000).toFixed(1)}s after the claim` : ''}`
        : e.type === 'RECAP' ? 'AEGIS closing recap'
        : e.type === 'BARGE_IN' ? 'Barge-in' : e.type === 'SUSPECT' ? 'Fast path · possible conflict in live captions' : 'Tone policy · how AEGIS will respond';
      return `<div class="sys ${e.type}"><span>${icon}</span><div><b>${title}</b><p>${esc(e.text)}</p></div></div>`;
    }
    const u = state?.utterances.find((x) => x.id === item.id);
    if (!u) return '';
    const hi = u.language !== 'en';
    return `
      <article class="utt" style="--c:${speakerHue(u.speaker)}">
        <header><b>${esc(nameOf(u.speaker))}</b>
          <span class="tone sm" style="--t:${toneColor[u.tone] || '#8a93a6'}"><i></i>${esc(u.tone)}</span>
          <span class="chip lang">${u.language.toUpperCase()}</span>
          <time>${fmt(u.start)}</time>
          ${u.latencyMs ? `<span class="lat">${(u.latencyMs / 1000).toFixed(1)}s</span>` : ''}
          <button class="play" data-s="${u.start}" data-e="${u.end}" title="Replay this audio">▶</button>
        </header>
        <p class="said ${hi ? 'deva' : ''}">${esc(u.transcript)}</p>
        ${hi ? `<p class="en">↳ ${esc(u.english)}</p>` : ''}
        ${u.toneCue ? `<p class="cue">🎙 ${esc(u.toneCue)}</p>` : ''}
        ${u.verbatim ? `<p class="gt"><span>Transcribe</span> ${esc(u.verbatim)}</p>` : ''}
        ${item.chips.filter((c) => c.type !== 'EMOTIONAL_SHIFT').length ? `<div class="evchips">${item.chips.filter((c) => c.type !== 'EMOTIONAL_SHIFT').map((c) => `<span class="ev ${c.type}" title="${esc(c.text)}">${chipLabel[c.type] || c.type}${c.type === 'FACT_ESTABLISHED' ? `: ${esc(c.text.slice(0, 60))}` : ''}</span>`).join('')}</div>` : ''}
      </article>`;
  }).join('') + (pending ? `<div class="pending"><div class="dots"><i></i><i></i><i></i></div>Flash is analysing tone, language &amp; facts…</div>` : '');
  const tl = $('timeline');
  const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
  tl.innerHTML = html || '<p class="empty">Everything AEGIS hears and decides appears here.</p>';
  if (atBottom) tl.scrollTop = tl.scrollHeight;
}

function renderContradictions() {
  const cs = state!.contradictions;
  if (!cs.length) return;
  const utt = (id: string) => state!.utterances.find((u) => u.id === id);
  $('contradictions').innerHTML = cs.slice().reverse().map((c) => {
    const a = utt(c.utterA), b = utt(c.utterB);
    return `
    <div class="con ${c.status}">
      <div class="con-top"><span class="badge">${c.status === 'OPEN' ? '⚠ OPEN' : '✓ RESOLVED'}</span>${c.crossLanguage ? '<span class="chip lang">cross-language</span>' : ''}</div>
      <p>${esc(c.explanation)}</p>
      <div class="evidence">
        ${a ? `<button class="clip" data-s="${a.start}" data-e="${a.end}" style="--c:${speakerHue(a.speaker)}">▶ ${esc(nameOf(a.speaker))} <small>${fmt(a.start)}</small></button>` : ''}
        <span class="vs">vs</span>
        ${b ? `<button class="clip" data-s="${b.start}" data-e="${b.end}" style="--c:${speakerHue(b.speaker)}">▶ ${esc(nameOf(b.speaker))} <small>${fmt(b.start)}</small></button>` : ''}
      </div>
      ${c.resolution ? `<p class="res">✓ ${esc(c.resolution)}</p>` : ''}
    </div>`;
  }).join('');
}

function renderFacts() {
  const fs = state!.facts;
  if (!fs.length) return;
  $('facts').innerHTML = fs.slice().reverse().map((f) => `
    <div class="fact ${f.status}"><span class="fs">${f.status === 'ACTIVE' ? (f.settled ? 'SETTLED' : 'ACTIVE') : f.status}</span><p>${esc(f.text)}</p><small>${esc(nameOf(f.speaker))}</small></div>`).join('');
}

// ---------------- evidence replay ----------------
document.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button.clip, button.play') as HTMLButtonElement | null;
  if (!btn) return;
  const key = `${btn.dataset.s}-${btn.dataset.e}-${Math.random()}`;
  btn.classList.add('playing');
  const b64 = await new Promise<string>((res) => { clipWaiters.set(key, res); send({ type: 'clip', key, start: Number(btn.dataset.s), end: Number(btn.dataset.e) }); });
  const buf = await player.ctx.decodeAudioData(b64ToArrayBuffer(b64));
  await player.playOnce(buf);
  btn.classList.remove('playing');
});

// ---------------- summary ----------------
function openModal(html: string) { $('sheet').innerHTML = html; $('modal').classList.remove('hidden'); }
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').classList.add('hidden'); });

function renderSummary(m: any) {
  if (m.error || !m.brief) return openModal(`<h2>Brief failed</h2><p>${esc(m.error || 'unknown')}</p>`);
  const b = m.brief;
  const list = (xs: string[]) => xs?.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="empty">None</p>';
  openModal(`
    <div class="brief">
      <small class="kicker">Meeting brief · Transcribe + Flash</small>
      <h2>${esc(b.headline)}</h2>
      <div class="cols">
        <div><h3>Decisions</h3>${list(b.decisions)}</div>
        <div><h3>Action items</h3>${b.action_items?.length ? `<ul>${b.action_items.map((a: any) => `<li><b>${esc(a.owner)}</b> — ${esc(a.task)}</li>`).join('')}</ul>` : '<p class="empty">None</p>'}</div>
        <div><h3>Resolved conflicts</h3>${list(b.resolved)}</div>
        <div><h3>Still open</h3>${list(b.open_issues)}</div>
      </div>
      <h3>Tone arc</h3><p>${esc(b.tone_arc)}</p>
      ${m.groundTruth ? `<details><summary>Ground-truth transcript (Gemini 3.5 Transcribe)</summary><p class="deva">${esc(m.groundTruth)}</p></details>` : ''}
      <button class="primary" onclick="document.getElementById('modal').classList.add('hidden')">Close</button>
    </div>`);
}
$('btnSummary').onclick = () => send({ type: 'summary' });
$('btnWrap').onclick = () => {
  if (mode === 'mic') mic.stop();
  mode = 'idle';
  $('btnWrap').setAttribute('disabled', '');
  $('btnWrap').textContent = '■ Ended';
  $('btnStart').textContent = '● Stopped';
  micLevel = 0;
  send({ type: 'wrapup' });
};

// ---------------- modes ----------------
function beginSession() {
  $('btnStart').setAttribute('disabled', '');
  $('btnDemo').setAttribute('disabled', '');
  $('btnSummary').removeAttribute('disabled');
  $('btnWrap').removeAttribute('disabled');
  setPill('LISTENING');
}

$('btnStart').onclick = async () => {
  try {
    await player.ctx.resume();
    await connect('mic');
    mic.onChunk = (pcm, rms) => {
      micLevel = rms;
      if (ws?.readyState === 1) ws.send(pcm);
      // Client-side barge-in: sustained voice while AEGIS talks cuts it off.
      if (player.playing && performance.now() - speakingSince > 700) {
        loudChunks = rms > 0.06 ? loudChunks + 1 : 0;
        if (loudChunks >= 3) { player.stop(); hideBanner(); send({ type: 'barge_in' }); loudChunks = 0; }
      }
    };
    await mic.start();
    mode = 'mic';
    beginSession();
    $('btnStart').textContent = '● Listening';
  } catch (err: any) {
    alert(`Could not start: ${err.message}`);
  }
};

// Scripted demo: plays pre-rendered voices through the speakers AND feeds them into the pipeline in real time.
$('btnDemo').onclick = async () => {
  await player.ctx.resume();
  await connect('demo');
  mode = 'demo';
  beginSession();
  $('btnDemo').textContent = '▶ Demo running';
  const script: { id: string; waitFor?: string }[] = await (await fetch('/demo/script.json')).json();
  const lines = await Promise.all(script.map(async (l) => ({ ...l, pcm: await (await fetch(`/demo/${l.id}.pcm`)).arrayBuffer() })));

  let current: Int16Array | null = null, pos = 0;
  const CH = 1600; // 100ms @16k
  const feeder = setInterval(() => {
    if (ws?.readyState !== 1) return;
    let chunk: Int16Array;
    if (current && pos < current.length) { chunk = current.slice(pos, pos + CH); pos += CH; micLevel = rmsOf(chunk); }
    else { chunk = new Int16Array(CH); micLevel = 0; }
    ws.send(chunk.buffer as ArrayBuffer);
  }, 100);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const demoOut = player.ctx.createGain();
  demoOut.gain.value = 0.9;
  demoOut.connect(player.ctx.destination);

  await sleep(2500);
  for (const line of lines) {
    const i16 = new Int16Array(line.pcm);
    current = i16; pos = 0;
    await player.playOnce(player.pcmBuffer(line.pcm, 16000), demoOut);
    current = null;
    if (line.waitFor === 'audio') {
      const t = Date.now();
      while (!player.playing && Date.now() - t < 15000) await sleep(150);
      await sleep(2200);
    } else await sleep(1800);
  }
  await sleep(4000);
  clearInterval(feeder);
  setInterval(() => ws?.readyState === 1 && ws.send(new Int16Array(CH).buffer), 100); // keep VAD clock ticking
  $('btnDemo').textContent = '✓ Demo done';
};

function rmsOf(a: Int16Array) { let s = 0; for (const v of a) s += (v / 32768) ** 2; return Math.sqrt(s / a.length); }

// ---------------- orb ----------------
const orb = $<HTMLCanvasElement>('orb');
const g = orb.getContext('2d')!;
let smooth = 0, phase = 0;
function draw() {
  const aegis = player.playing ? player.level() * 3 : 0;
  const lvl = Math.max(micLevel * 6, aegis);
  smooth += (Math.min(1, lvl) - smooth) * 0.2;
  phase += 0.02;
  const col = state?.threat === 'RED' ? '255,77,94' : state?.threat === 'YELLOW' ? '245,197,66' : '61,220,151';
  const c = player.playing ? '77,163,255' : col;
  g.clearRect(0, 0, 280, 280);
  for (let k = 3; k >= 0; k--) {
    g.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.05) {
      const wob = Math.sin(a * (3 + k) + phase * (1 + k * 0.4)) * (4 + smooth * 26) * (k + 1) / 4;
      const r = 78 + k * 12 + wob + smooth * 18;
      const x = 140 + Math.cos(a) * r, y = 140 + Math.sin(a) * r;
      a === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.strokeStyle = `rgba(${c},${0.85 - k * 0.2})`;
    g.lineWidth = k === 0 ? 2.5 : 1.2;
    g.stroke();
  }
  const grad = g.createRadialGradient(140, 140, 10, 140, 140, 90);
  grad.addColorStop(0, `rgba(${c},${0.18 + smooth * 0.3})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(140, 140, 90, 0, Math.PI * 2); g.fill();
  requestAnimationFrame(draw);
}
draw();
