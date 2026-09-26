import './style.css';
import { Mic, Player, b64ToArrayBuffer } from './audio';

// ---------------- types (mirror server/worldState.js) ----------------
type Speaker = { id: string; name: string; role: string; voice: string; language: string; tone: string; intensity: number; signals?: string[]; utterances: number; facts: number; contradictions: number };
type Fact = { id: string; text: string; speaker: string; utterance: string; status: string; settled?: boolean; confidence?: number };
type Contradiction = { id: string; claimA: string; claimB: string; utterA: string; utterB: string; speakerA: string; speakerB: string; explanation: string; question?: string; status: string; resolution?: string; crossLanguage?: boolean };
type Question = { id: string; text: string; status: string; answer?: string; raisedBy: string };
type Tool = { name: string; args: any; status: string; result?: any; ms?: number; startedAt: number };
type Check = { check: string; pass: boolean; note: string };
type Action = { id: string; type: string; label: string; location: string; priority: string; status: string; requestedBy: string; confirmedBy?: string; safety: Check[]; tools: Tool[]; constraints: string[]; route: string; eta?: number; unit?: string; taskId?: string; history: { at: number; text: string }[] };
type Utterance = { id: string; speaker: string; start: number; end: number; transcript: string; english: string; language: string; tone: string; toneCue: string; signals: string[]; intensity: number; signalConfidence: number; urgency: string; verbatim: string; latencyMs?: number };
type Line = { to?: string; name: string; language: string; text: string };
type Ev = { type: string; text: string; at: number; speaker?: string; ms?: number; kind?: string; lines?: Line[] };
type State = {
  session_id: string; status: string; confidence: number; threat: string; urgency: string; situation: string; current_speaker: string | null;
  languages: string[]; speakers: Record<string, Speaker>; facts: Fact[]; contradictions: Contradiction[]; open_questions: Question[];
  actions: Action[]; utterances: Utterance[]; timeline: Ev[];
};
type FeedItem = { kind: 'utt'; id: string } | { kind: 'sys'; ev: Ev };

// ---------------- DOM ----------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ghostTiles = ['Field responder', 'Family', 'Dispatcher'].map((r) => `<div class="tile ghost"><div class="ring"><div class="av">?</div></div><b>Waiting</b><small>${r}</small></div>`).join('');

document.querySelector('#app')!.innerHTML = `
<header class="appbar">
  <div class="brand">
    <span class="gdots"><i></i><i></i><i></i><i></i></span>
    <div><h1>RescueRoom</h1><span id="incidentId">Audio-first incident coordination</span></div>
  </div>
  <span id="modeBadge" class="mode">Standby</span>
  <div class="health"><span id="hWs" class="h">Server</span><span id="hMic" class="h">Mic</span><span id="hLive" class="h">Live</span><span id="hTr" class="h">Translate</span></div>
  <div class="actions">
    <button id="btnDemo" class="tonal">▶ Demo fallback</button>
    <button id="btnStart" class="filled">🎙 Go live</button>
    <button id="btnWrap" class="outlined" disabled>End incident</button>
  </div>
</header>

<section class="hero">
  <div class="people"><div class="kicker">Participants · identified by voice</div><div id="speakers" class="tiles">${ghostTiles}</div></div>
  <div class="stage">
    <div class="orb"><canvas id="orb" width="440" height="440"></canvas><div class="orb-core"><b id="orbLabel">idle</b></div></div>
    <div class="now">
      <div class="now-top"><span id="statusPill" class="status">IDLE</span><span class="src">Gemini 3.8 Live</span></div>
      <p id="caption" class="caption muted">Waiting for audio…</p>
      <div class="bridge"><span class="src">Live Translate → EN</span><p id="translation" class="translation">—</p></div>
    </div>
  </div>
  <div id="speaking" class="voice idle">
    <div class="voice-in">
      <div class="kicker"><span class="eq"><i></i><i></i><i></i><i></i></span>RescueRoom voice <em>Flash TTS · talk over it to interrupt</em></div>
      <div id="speakLines"><p class="muted">Silent. Speaks only when it matters.</p></div>
    </div>
  </div>
</section>

<section class="pulse">
  <div id="urgency" class="urg low"><small>Urgency</small><b>LOW</b></div>
  <div class="sit"><small>Current situation</small><p id="situation">Awaiting first report.</p></div>
  <div class="conf"><div id="confRing" class="cring" style="--p:100"><b id="confNum">100</b></div><small>Confidence</small></div>
  <div class="qk"><b id="qCount">0</b><small>Open questions</small></div>
  <div class="qk"><div id="langs" class="chips"><span class="chip">—</span></div><small>Languages</small></div>
</section>

<main class="board">
  <section class="card grow-col"><h2>Conversation <small>every entry is replayable audio</small></h2><div id="timeline" class="feed"><p class="empty">Speak. RescueRoom listens continuously.</p></div></section>
  <section class="stack">
    <div class="card pri"><h2><span class="dotc red"></span>Contradictions <small>audio is the evidence</small></h2><div id="contradictions" class="list"><p class="empty">No conflicting reports.</p></div></div>
    <div class="card"><h2><span class="dotc yellow"></span>Open questions</h2><div id="questions" class="list"><p class="empty">None.</p></div></div>
    <div class="card grow"><h2><span class="dotc blue"></span>Facts</h2><div id="facts" class="list"><p class="empty">No facts yet.</p></div></div>
  </section>
  <section class="stack">
    <div class="card grow"><h2><span class="dotc green"></span>Actions <small>recommend → verify → confirm → execute</small></h2><div id="actionsList" class="list"><p class="empty">No actions requested.</p></div></div>
    <div class="card"><h2>Timeline</h2><div id="keyTimeline" class="tl"><p class="empty">—</p></div></div>
  </section>
</main>
<div id="modal" class="modal hidden"><div class="sheet" id="sheet"></div></div>
`;

// ---------------- state ----------------
let ws: WebSocket | null = null;
let state: State | null = null;
const feed: FeedItem[] = [];
const seenUtt = new Set<string>();
let pending = false;
let chimePcm: { pcm: ArrayBuffer; rate: number } | null = null;
let mode: 'idle' | 'mic' | 'demo' = 'idle';
let lastUserScroll = 0;
let micLevel = 0, loudChunks = 0, speakingSince = 0, spokenCount = 0;
const player = new Player();
const mic = new Mic();
const clipWaiters = new Map<string, (b64: string) => void>();

const roleLabel: Record<string, string> = { dispatcher: 'Dispatcher', field_responder: 'Field responder', family: 'Family', unknown: 'Participant' };
const PALETTE = ['#1a73e8', '#ea4335', '#f9ab00', '#34a853', '#a142f4', '#12b5cb'];
const speakerHue = (id: string) => PALETTE[(parseInt(id.split('_')[1]) - 1) % PALETTE.length] || '#5f6368';
const esc = (s: any = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const nameOf = (id: string) => { const sp = state?.speakers[id]; return sp?.name || (sp && sp.role !== 'unknown' ? roleLabel[sp.role] : '') || (id ? id.replace('speaker_', 'Speaker ') : '—'); };
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const langTag = (l: string) => l === 'hi' ? 'HI' : l === 'mixed' ? 'HI+EN' : 'EN';
const setHealth = (id: string, st: string) => { const el = $(id); el.className = `h ${st}`; el.title = st; };

// ---------------- websocket ----------------
function connect(sessionMode: 'mic' | 'demo'): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { setHealth('hWs', 'ready'); ws!.send(JSON.stringify({ type: 'start', mode: sessionMode })); resolve(); };
    ws.onerror = () => { setHealth('hWs', 'error'); reject(new Error('Cannot reach RescueRoom server')); };
    ws.onclose = () => { setHealth('hWs', 'error'); if (mode !== 'idle') $('statusPill').textContent = 'DISCONNECTED'; };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  });
}
const send = (m: object) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

const SYS = new Set(['TONE_POLICY', 'INTERVENTION', 'BARGE_IN', 'RECAP', 'ACTION_PROPOSED', 'ACTION_CONFIRMED', 'ACTION_DISPATCHED', 'ACTION_REROUTED', 'PLAN_CHANGED', 'CONTRADICTION_DETECTED', 'CONFLICT_RESOLVED', 'PERMISSION_DENIED']);

function onMessage(m: any) {
  switch (m.type) {
    case 'state':
      state = m.state;
      for (const u of state!.utterances) if (!seenUtt.has(u.id)) { seenUtt.add(u.id); feed.push({ kind: 'utt', id: u.id }); pending = false; }
      renderAll();
      break;
    case 'events':
      for (const ev of m.events as Ev[]) {
        if (SYS.has(ev.type)) feed.push({ kind: 'sys', ev });
        if (ev.type === 'INTERVENTION' && ev.lines) showSpeaking(ev.lines);
        if (ev.type === 'CONTRADICTION_DETECTED' || ev.type === 'PLAN_CHANGED') flash();
      }
      renderFeed();
      break;
    case 'model_status': setHealth(m.name === 'live' ? 'hLive' : 'hTr', m.status); break;
    case 'caption': setCaption('caption', m.text); break;
    case 'translation': setCaption('translation', m.text); break;
    case 'utterance_pending': pending = true; renderFeed(); break;
    case 'utterance_failed': pending = false; renderFeed(); break;
    case 'suspect':
      feed.push({ kind: 'sys', ev: { type: 'SUSPECT', text: `${m.text} (${(m.ms / 1000).toFixed(1)}s after speech)`, at: Date.now() } });
      $('statusPill').textContent = 'VERIFYING';
      renderFeed();
      break;
    case 'verbatim': {
      const u = state?.utterances.find((x) => x.id === m.id);
      if (u) { u.verbatim = m.text; renderFeed(); }
      break;
    }
    case 'chime': chimePcm = { pcm: b64ToArrayBuffer(m.data), rate: m.rate }; break;
    case 'intervene':
      player.begin(m.id);
      speakingSince = performance.now();
      if (m.chime && chimePcm) player.enqueue(m.id, chimePcm.pcm, chimePcm.rate);
      break;
    case 'recap':
      player.begin(m.id);
      speakingSince = performance.now();
      showSpeaking([{ name: 'Everyone', language: 'en', text: m.text }]);
      break;
    case 'audio': player.enqueue(m.id, b64ToArrayBuffer(m.data), m.rate); break;
    case 'audio_end': player.end(m.id); break;
    case 'stop_audio': if (player.playing) spokenCount++; player.stop(); hideSpeaking(true); break;
    case 'clip': clipWaiters.get(m.key)?.(m.data); clipWaiters.delete(m.key); break;
    case 'summary_pending': openModal(`<div class="spin"></div><p class="center">Gemini Transcribe is re-listening to the full incident audio…</p>`); break;
    case 'summary': renderReport(m); break;
  }
}
player.onDone = (id) => { spokenCount++; hideSpeaking(false); send({ type: 'audio_done', id }); };

// ---------------- rendering ----------------
function flash() { document.body.classList.remove('alert'); void document.body.offsetWidth; document.body.classList.add('alert'); }
function setCaption(id: string, text: string) { const el = $(id); el.classList.remove('muted'); el.textContent = text.trim() || '—'; }

function showSpeaking(lines: Line[]) {
  $('speaking').className = 'voice live';
  $('speakLines').innerHTML = lines.map((l) => `<div class="line"><span class="to">${esc(l.name)} <i>${langTag(l.language)}</i></span><p class="${l.language === 'hi' ? 'deva' : ''}">${esc(l.text)}</p></div>`).join('');
}
function hideSpeaking(interrupted: boolean) {
  $('speaking').className = `voice ${interrupted ? 'cut' : 'idle'}`;
  if (interrupted) $('speakLines').insertAdjacentHTML('afterbegin', '<p class="cutnote">✋ Interrupted. Stopped mid-sentence, still listening.</p>');
}

function renderAll() {
  if (!state) return;
  const s = state;
  $('incidentId').textContent = `Incident ${s.session_id}`;
  $('statusPill').textContent = s.status;
  $('statusPill').className = `status ${s.threat}`;
  const u = $('urgency'); u.className = `urg ${s.urgency}`; u.querySelector('b')!.textContent = s.urgency.toUpperCase();
  $('situation').textContent = s.situation;
  $('confNum').textContent = String(s.confidence);
  const ring = $('confRing'); ring.style.setProperty('--p', String(s.confidence)); ring.className = `cring ${s.confidence < 50 ? 'bad' : s.confidence < 75 ? 'warn' : 'ok'}`;
  $('qCount').textContent = String(s.open_questions.filter((q) => q.status === 'OPEN').length);
  $('langs').innerHTML = s.languages.length ? s.languages.map((l) => `<span class="chip">${l === 'hi' ? 'हिन्दी' : 'English'}</span>`).join('') : '<span class="chip">—</span>';
  renderSpeakers(); renderQuestions(); renderFeed(); renderContradictions(); renderFacts(); renderActions(); renderTimeline();
}

function renderSpeakers() {
  const sp = Object.values(state!.speakers);
  if (!sp.length) return;
  $('speakers').innerHTML = sp.map((s) => `
    <div class="tile ${state!.current_speaker === s.id ? 'current' : ''}" style="--c:${speakerHue(s.id)};--i:${Math.round((s.intensity || 0) * 100)}">
      <div class="ring"><div class="av">${esc((nameOf(s.id) || 'S')[0].toUpperCase())}</div></div>
      <b>${esc(nameOf(s.id))}</b>
      <small>${roleLabel[s.role] || s.role} · ${langTag(s.language)}</small>
      <span class="inten">intensity ${(s.intensity || 0).toFixed(2)}</span>
    </div>`).join('');
}

function renderQuestions() {
  const qs = state!.open_questions;
  if (!qs.length) return;
  $('questions').innerHTML = qs.slice().reverse().map((q) => `
    <div class="q ${q.status}"><span>${q.status === 'OPEN' ? '?' : '✓'}</span><div><p>${esc(q.text)}</p>${q.answer ? `<small>${esc(q.answer)}</small>` : `<small>raised by ${esc(q.raisedBy)}</small>`}</div></div>`).join('');
}

const sysMeta: Record<string, [string, string]> = {
  INTERVENTION: ['✦', 'RescueRoom spoke'], BARGE_IN: ['✋', 'Barge-in'], TONE_POLICY: ['≋', 'Signal policy'], SUSPECT: ['⚡', 'Fast path · caption check'],
  RECAP: ['✦', 'Closing summary'], ACTION_PROPOSED: ['◆', 'Action proposed'], ACTION_CONFIRMED: ['✔', 'Human confirmed'], ACTION_DISPATCHED: ['▶', 'Executed · mock tools'],
  ACTION_REROUTED: ['↻', 'Plan updated'], PLAN_CHANGED: ['⚠', 'New information changed the plan'], CONTRADICTION_DETECTED: ['⚠', 'Contradiction'],
  CONFLICT_RESOLVED: ['✓', 'Resolved'], PERMISSION_DENIED: ['⛔', 'Permission check'],
};

function renderFeed() {
  const html = feed.map((item) => {
    if (item.kind === 'sys') {
      const e = item.ev;
      const [icon, title] = sysMeta[e.type] || ['•', e.type];
      const body = e.type === 'INTERVENTION' && e.lines?.length
        ? e.lines.map((l) => `<p class="${l.language === 'hi' ? 'deva' : ''}"><b>${esc(l.name)} · ${langTag(l.language)}</b> ${esc(l.text)}</p>`).join('')
        : `<p>${esc(e.text)}</p>`;
      const lat = e.type === 'INTERVENTION' && e.ms != null ? ` <em>${(e.ms / 1000).toFixed(1)}s after trigger</em>` : '';
      return `<div class="sys ${e.type}"><span class="ic">${icon}</span><div class="sb"><b>${title}${lat}</b>${body}</div><time>${clock(e.at)}</time></div>`;
    }
    const u = state?.utterances.find((x) => x.id === item.id);
    if (!u) return '';
    const hi = u.language !== 'en';
    return `
      <article class="utt" style="--c:${speakerHue(u.speaker)}">
        <header><span class="av-s">${esc(nameOf(u.speaker)[0])}</span><b>${esc(nameOf(u.speaker))}</b><span class="chip">${langTag(u.language)}</span><span class="urgtag ${u.urgency}">${u.urgency}</span>
          <time>${fmt(u.start)}</time>${u.latencyMs ? `<span class="lat">${(u.latencyMs / 1000).toFixed(1)}s</span>` : ''}
          <button class="play" data-s="${u.start}" data-e="${u.end}" title="Replay original audio">▶</button></header>
        <p class="said ${hi ? 'deva' : ''}">${esc(u.transcript)}</p>
        ${hi ? `<p class="en">${esc(u.english)}</p>` : ''}
        <p class="cue">${(u.signals || []).map((x) => `<span>${esc(x)}</span>`).join('')}<span class="n">intensity ${(u.intensity || 0).toFixed(2)} · conf ${(u.signalConfidence || 0).toFixed(2)}</span></p>
        ${u.verbatim ? `<p class="gt"><span>Transcribe</span>${esc(u.verbatim)}</p>` : ''}
      </article>`;
  }).join('') + (pending ? `<div class="pending"><span class="gdots sm"><i></i><i></i><i></i><i></i></span>Analysing audio: language, signals, claims…</div>` : '');
  const tl = $('timeline');
  tl.innerHTML = html || '<p class="empty">Speak. RescueRoom listens continuously.</p>';
  if (Date.now() - lastUserScroll > 6000) tl.scrollTop = tl.scrollHeight;
}
$('timeline').addEventListener('wheel', () => { lastUserScroll = Date.now(); });

function evidenceBtn(uttId: string, label: string) {
  const u = state!.utterances.find((x) => x.id === uttId);
  if (!u) return '';
  return `<button class="clip" data-s="${u.start}" data-e="${u.end}" style="--c:${speakerHue(u.speaker)}"><span class="pl">▶</span><span><b>${label}</b><small>${esc(nameOf(u.speaker))} · ${langTag(u.language)} · ${fmt(u.start)}</small></span></button>`;
}

function renderContradictions() {
  const cs = state!.contradictions;
  if (!cs.length) return;
  $('contradictions').innerHTML = cs.slice().reverse().map((c) => `
    <div class="con ${c.status}">
      <div class="con-top"><span class="badge">${c.status === 'OPEN' ? 'Contradiction' : 'Resolved'}</span>${c.crossLanguage ? '<span class="chip">cross-language</span>' : ''}</div>
      <div class="claims">
        <div class="claim"><small>Claim A</small><p>${esc(c.claimA)}</p>${evidenceBtn(c.utterA, 'Play evidence A')}</div>
        <div class="vs">vs</div>
        <div class="claim"><small>Claim B</small><p>${esc(c.claimB)}</p>${evidenceBtn(c.utterB, 'Play evidence B')}</div>
      </div>
      ${c.resolution ? `<p class="res">✓ ${esc(c.resolution)}</p>` : `<p class="qline">${esc(c.question || c.explanation)}</p>`}
    </div>`).join('');
}

function renderFacts() {
  const fs = state!.facts;
  if (!fs.length) return;
  $('facts').innerHTML = fs.slice().reverse().map((f) => `
    <div class="fact ${f.status}${f.settled ? ' settled' : ''}"><span class="fs">${f.status === 'ACTIVE' ? (f.settled ? 'Verified' : 'Reported') : f.status.toLowerCase()}</span>
      <p>${esc(f.text)}</p><small>${esc(nameOf(f.speaker))}${f.confidence != null ? ` · conf ${f.confidence.toFixed(2)}` : ''}</small></div>`).join('');
}

const STEPS = ['Proposed', 'Safety gate', 'Human confirm', 'Executed'];
function stepIndex(a: Action) {
  if (a.status === 'DISPATCHED') return 4;
  if (a.status === 'CONFIRMED' || a.status === 'REPLANNING') return 3;
  if (a.status === 'AWAITING_CONFIRMATION') return 2;
  return 1;
}
function summarizeTool(t: Tool) {
  const r = t.result || {};
  switch (t.name) {
    case 'lookup_location': return `${r.coords} · ${r.access} · ETA ${r.eta_min}m`;
    case 'get_weather': return `${r.conditions}, visibility ${r.visibility}`;
    case 'knowledge_lookup': return r.protocol;
    case 'create_task': return `${r.task_id} → ${r.assigned} (${r.route})`;
    case 'send_notification': return `→ ${r.to}: ${r.message}`;
    default: return JSON.stringify(r).slice(0, 80);
  }
}
function renderActions() {
  const as = state!.actions;
  if (!as.length) return;
  $('actionsList').innerHTML = as.slice().reverse().map((a) => {
    const si = stepIndex(a);
    return `
    <div class="act ${a.status}">
      <div class="act-top"><b>${esc(a.label)}</b><span class="prio ${a.priority}">${a.priority}</span></div>
      <div class="act-meta"><span>📍 ${esc(a.location)}</span>${a.route ? `<span>via ${esc(a.route)}</span>` : ''}${a.eta ? `<span class="eta">ETA ${a.eta} min</span>` : ''}${a.taskId ? `<span>${esc(a.taskId)} · ${esc(a.unit || '')}</span>` : ''}</div>
      <div class="steps">${STEPS.map((st, i) => `<span class="${i < si ? 'done' : i === si ? 'now' : ''}"><i></i>${st}</span>`).join('')}</div>
      <div class="status-line">${a.status.replace(/_/g, ' ').toLowerCase()}${a.confirmedBy ? ` · confirmed by ${esc(a.confirmedBy)}` : ''}</div>
      ${a.constraints.length ? `<div class="constraints">${a.constraints.map((c) => `<span>⚠ ${esc(c)}</span>`).join('')}</div>` : ''}
      <ul class="checks">${a.safety.map((c) => { const gate = c.check.startsWith('High-impact'); return `<li class="${c.pass ? 'ok' : gate ? 'gate' : 'no'}"><span>${c.pass ? '✓' : gate ? '◆' : '✕'}</span><div><b>${esc(c.check)}</b><small>${esc(c.note)}</small></div></li>`; }).join('')}</ul>
      ${a.tools.length ? `<div class="tools">${a.tools.map((t) => `<div class="tool ${t.status}"><code>${esc(t.name)}</code><span>${t.status === 'running' ? '<i class="spin-s"></i>running' : `${t.ms}ms`}</span><small>${t.result ? esc(summarizeTool(t)) : ''}</small></div>`).join('')}</div>` : ''}
      ${a.status === 'AWAITING_CONFIRMATION' ? `<div class="confirm-row"><button class="confirm" data-act="${a.id}">✔ Confirm as dispatcher</button><small>or just say “Confirm”</small></div>` : ''}
    </div>`;
  }).join('');
}

const KEY = new Set(['CONTRADICTION_DETECTED', 'CONFLICT_RESOLVED', 'ACTION_PROPOSED', 'ACTION_CONFIRMED', 'ACTION_DISPATCHED', 'PLAN_CHANGED', 'ACTION_REROUTED', 'FACT_ESTABLISHED', 'LANGUAGE_DETECTED', 'BARGE_IN']);
function renderTimeline() {
  const t = state!.timeline.filter((e) => KEY.has(e.type)).slice(-14).reverse();
  if (!t.length) return;
  $('keyTimeline').innerHTML = t.map((e) => `<div class="te ${e.type}"><i></i><time>${clock(e.at)}</time><p>${esc(e.text)}</p></div>`).join('');
}

// ---------------- clicks: evidence replay + confirm ----------------
document.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  const conf = target.closest('button.confirm') as HTMLButtonElement | null;
  if (conf) { send({ type: 'confirm_action', id: conf.dataset.act }); conf.disabled = true; return; }
  const btn = target.closest('button.clip, button.play') as HTMLButtonElement | null;
  if (!btn) return;
  const key = `${btn.dataset.s}-${btn.dataset.e}-${Math.random()}`;
  btn.classList.add('playing');
  const b64 = await new Promise<string>((res) => { clipWaiters.set(key, res); send({ type: 'clip', key, start: Number(btn.dataset.s), end: Number(btn.dataset.e) }); });
  const buf = await player.ctx.decodeAudioData(b64ToArrayBuffer(b64));
  await player.playOnce(buf);
  btn.classList.remove('playing');
});

// ---------------- final report ----------------
function openModal(html: string) { $('sheet').innerHTML = html; $('modal').classList.remove('hidden'); }
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').classList.add('hidden'); });

function renderReport(m: any) {
  if (m.error || !m.brief) return openModal(`<h2>Report failed</h2><p>${esc(m.error || 'unknown')}</p>`);
  const b = m.brief, s = state!;
  const list = (xs: string[]) => xs?.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="empty">None</p>';
  openModal(`
    <div class="report">
      <span class="gdots"><i></i><i></i><i></i><i></i></span>
      <small class="kicker">Incident report · ${esc(s.session_id)} · Gemini Transcribe + Flash</small>
      <h2>${esc(b.headline)}</h2>
      <p class="lead">${esc(b.situation)}</p>
      <div class="cols">
        <div class="rc"><h3>Verified facts</h3>${list(b.verified_facts)}</div>
        <div class="rc"><h3>Actions</h3>${s.actions.length ? `<ul>${s.actions.map((a) => `<li><b>${esc(a.label)}</b> → ${esc(a.location)} · ${a.status.toLowerCase()}${a.route ? ` · via ${esc(a.route)}` : ''}${a.eta ? ` · ETA ${a.eta}m` : ''}${a.confirmedBy ? ` · confirmed by ${esc(a.confirmedBy)}` : ''}</li>`).join('')}</ul>` : '<p class="empty">None</p>'}</div>
        <div class="rc"><h3>Resolved contradictions</h3>${list(b.resolved)}</div>
        <div class="rc"><h3>Open issues</h3>${list(b.open_issues)}</div>
      </div>
      <h3>Audio evidence</h3>
      <div class="evidence-grid">${s.contradictions.map((c) => `${evidenceBtn(c.utterA, 'Claim A')}${evidenceBtn(c.utterB, 'Claim B')}`).join('') || '<p class="empty">No disputed claims.</p>'}</div>
      <h3>Timeline</h3>
      <div class="rtl">${(b.timeline || []).map((t: any) => `<div><time>${esc(t.t)}</time><span>${esc(t.event)}</span></div>`).join('')}</div>
      <h3>Vocal signal arc <small>observable signals, not diagnoses</small></h3><p>${esc(b.signal_arc)}</p>
      <h3>Speaker-separated transcript</h3>
      <div class="transcript">${s.utterances.map((u) => `<div><b style="color:${speakerHue(u.speaker)}">${esc(nameOf(u.speaker))}</b> <span class="chip">${langTag(u.language)}</span> <time>${fmt(u.start)}</time> <button class="play" data-s="${u.start}" data-e="${u.end}">▶</button><p class="${u.language !== 'en' ? 'deva' : ''}">${esc(u.transcript)}</p>${u.language !== 'en' ? `<p class="en">${esc(u.english)}</p>` : ''}</div>`).join('')}</div>
      <button class="filled" onclick="document.getElementById('modal').classList.add('hidden')">Close</button>
    </div>`);
}

// ---------------- modes ----------------
function beginSession(label: string) {
  $('btnStart').setAttribute('disabled', '');
  $('btnDemo').setAttribute('disabled', '');
  $('btnWrap').removeAttribute('disabled');
  const mb = $('modeBadge'); mb.textContent = label; mb.className = `mode ${mode}`;
}

$('btnStart').onclick = async () => {
  try {
    await player.ctx.resume();
    await connect('mic');
    mic.onChunk = (pcm, rms) => {
      micLevel = rms;
      if (ws?.readyState === 1) ws.send(pcm);
      // Client-side barge-in: sustained voice while RescueRoom talks flushes the playback queue instantly.
      if (player.playing && performance.now() - speakingSince > 700) {
        loudChunks = rms > 0.06 ? loudChunks + 1 : 0;
        if (loudChunks >= 3) { spokenCount++; player.stop(); hideSpeaking(true); send({ type: 'barge_in' }); loudChunks = 0; }
      }
    };
    await mic.start();
    setHealth('hMic', 'ready');
    mode = 'mic';
    beginSession('● Live mode');
  } catch (err: any) {
    setHealth('hMic', 'error');
    alert(`Could not start: ${err.message}`);
  }
};

// Demo fallback: plays pre-recorded voices through the speakers AND streams them through the real live pipeline.
$('btnDemo').onclick = async () => {
  await player.ctx.resume();
  await connect('demo');
  mode = 'demo';
  beginSession('▶ Demo fallback · recorded voices, live models');
  const script: { id: string; waitFor?: string }[] = await (await fetch('/demo/script.json')).json();
  const lines = await Promise.all(script.map(async (l) => ({ ...l, pcm: await (await fetch(`/demo/${l.id}.pcm`)).arrayBuffer() })));
  let current: Int16Array | null = null, pos = 0;
  const CH = 1600;
  const feeder = setInterval(() => {
    if (ws?.readyState !== 1) return;
    let chunk: Int16Array;
    if (current && pos < current.length) { chunk = current.slice(pos, pos + CH); pos += CH; micLevel = rmsOf(chunk); }
    else { chunk = new Int16Array(CH); micLevel = 0; }
    ws.send(chunk.buffer as ArrayBuffer);
  }, 100);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  await sleep(2500);
  for (const line of lines) {
    const before = spokenCount, t = Date.now();
    current = new Int16Array(line.pcm); pos = 0;
    await player.playOnce(player.pcmBuffer(line.pcm, 16000));
    current = null;
    if (line.waitFor === 'audio') {
      while (!player.playing && Date.now() - t < 20000) await sleep(150);
      await sleep(2800);
    } else if (line.waitFor === 'done') {
      while (spokenCount === before && Date.now() - t < 40000) await sleep(150);
      await sleep(600);
    } else await sleep(1500);
  }
  await sleep(3000);
  clearInterval(feeder);
  setInterval(() => ws?.readyState === 1 && ws.send(new Int16Array(CH).buffer), 100);
};

$('btnWrap').onclick = () => {
  if (mode === 'mic') { mic.stop(); setHealth('hMic', 'idle'); }
  mode = 'idle';
  $('btnWrap').setAttribute('disabled', '');
  $('btnWrap').textContent = 'Ended';
  micLevel = 0;
  send({ type: 'wrapup' });
};

function rmsOf(a: Int16Array) { let s = 0; for (const v of a) s += (v / 32768) ** 2; return Math.sqrt(s / a.length); }

// ---------------- orb: Google four-colour ring while listening, Gemini gradient while speaking ----------------
const orb = $<HTMLCanvasElement>('orb');
const g = orb.getContext('2d')!;
const GCOL = ['66,133,244', '234,67,53', '251,188,4', '52,168,83'];
let smooth = 0, phase = 0, speakMix = 0;
function draw() {
  const speaking = player.playing;
  const voice = speaking ? player.level() * 3 : 0;
  smooth += (Math.min(1, Math.max(micLevel * 6, voice)) - smooth) * 0.18;
  speakMix += ((speaking ? 1 : 0) - speakMix) * 0.08;
  phase += 0.012 + smooth * 0.04;
  $('orbLabel').textContent = speaking ? 'speaking' : micLevel > 0.02 ? 'hearing' : mode === 'idle' ? 'idle' : 'listening';
  const W = 440, C = W / 2;
  g.clearRect(0, 0, W, W);
  // soft glow
  const glow = g.createRadialGradient(C, C, 40, C, C, 200);
  glow.addColorStop(0, speakMix > 0.5 ? `rgba(155,114,203,${0.25 + smooth * 0.3})` : `rgba(66,133,244,${0.12 + smooth * 0.25})`);
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glow; g.beginPath(); g.arc(C, C, 200, 0, Math.PI * 2); g.fill();
  // four coloured arcs (Google) that morph into a Gemini gradient blob when RescueRoom speaks
  for (let k = 0; k < 4; k++) {
    g.beginPath();
    const base = 108 + k * 7;
    for (let a = 0; a <= Math.PI * 2 + 0.02; a += 0.04) {
      const wob = Math.sin(a * (2 + k) + phase * (1.2 + k * 0.3)) * (3 + smooth * 26) + Math.cos(a * 3 - phase * 2) * smooth * 10;
      const r = base + wob + smooth * 14;
      const x = C + Math.cos(a) * r, y = C + Math.sin(a) * r;
      a === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.closePath();
    if (speakMix > 0.05) {
      const grad = g.createLinearGradient(C - 140, C - 140, C + 140, C + 140);
      grad.addColorStop(0, `rgba(66,133,244,${0.55 * speakMix})`);
      grad.addColorStop(0.5, `rgba(155,114,203,${0.55 * speakMix})`);
      grad.addColorStop(1, `rgba(217,101,112,${0.55 * speakMix})`);
      g.strokeStyle = grad;
      g.lineWidth = 3;
      g.stroke();
    }
    g.strokeStyle = `rgba(${GCOL[k]},${(0.85 - k * 0.12) * (1 - speakMix)})`;
    g.lineWidth = 3;
    g.stroke();
  }
  requestAnimationFrame(draw);
}
draw();
