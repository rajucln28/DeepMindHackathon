// Shared incident state: plain in-memory object, updated incrementally by apply() for every analysed utterance.

const HOSTILE = new Set(['frustrated', 'angry']);
const UNSURE = new Set(['anxious', 'confused']);
const HOT = new Set(['urgent', 'distressed']);
const URGENCY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const ACTION_LABEL = {
  dispatch_medical_team: 'Dispatch medical team', dispatch_rescue_team: 'Dispatch rescue team',
  notify_family: 'Notify family', request_air_support: 'Request air support', reroute_team: 'Reroute team',
};

function createState() {
  return {
    session_id: `RR-${Date.now().toString(36).toUpperCase()}`,
    status: 'LISTENING',
    confidence: 100,
    threat: 'GREEN',
    temperature: 70,
    urgency: 'low',
    situation: 'Awaiting first report.',
    current_speaker: null,
    speakers: {},
    languages: [],
    facts: [],
    contradictions: [],
    open_questions: [],
    actions: [],
    utterances: [],
    timeline: [],
    counters: { fact: 0, con: 0, utt: 0, q: 0, act: 0 },
  };
}

function recompute(s) {
  s.confidence = Math.max(0, Math.min(100, Math.round(s.confidence)));
  s.temperature = Math.max(0, Math.min(100, Math.round(s.temperature)));
  const open = s.contradictions.some(c => c.status === 'OPEN');
  if (open || s.confidence < 40 || s.urgency === 'critical') s.threat = 'RED';
  else if (s.confidence < 70 || s.urgency === 'high') s.threat = 'YELLOW';
  else s.threat = 'GREEN';
  if (open) s.status = 'VERIFYING';
  else if (s.actions.some(a => a.status === 'AWAITING_CONFIRMATION')) s.status = 'AWAITING CONFIRMATION';
  else if (s.actions.some(a => a.status === 'REPLANNING')) s.status = 'REPLANNING';
  else if (s.actions.some(a => a.status === 'DISPATCHED')) s.status = 'RESPONSE ACTIVE';
  else if (s.utterances.length) s.status = 'TRACKING';
}

function mark(s, type, text, extra = {}) {
  const e = { type, text, at: Date.now(), ...extra };
  s.timeline.push(e);
  return e;
}

// Safety / permission gate for consequential actions.
function safety(s, action, requester) {
  const disputed = s.contradictions.find(c => c.status === 'OPEN');
  const checks = [
    { check: 'Location verified', pass: !disputed, note: disputed ? `Disputed: ${disputed.question || disputed.explanation}` : `${action.location} — no conflicting reports` },
    { check: 'Requester authorised', pass: requester?.role === 'dispatcher', note: requester?.role === 'dispatcher' ? `${requester.name || requester.id} (dispatcher)` : `Role: ${requester?.role || 'unknown'} — dispatcher approval needed` },
    { check: 'State confidence', pass: s.confidence >= 60, note: `${s.confidence}% (min 60%)` },
    { check: 'High-impact → human confirmation', pass: false, note: 'Dispatch is consequential: RescueRoom recommends, a human confirms' },
  ];
  return { checks, blocked: !!disputed };
}

function reevaluate(s) {
  for (const a of s.actions) {
    if (a.status !== 'BLOCKED') continue;
    const { checks, blocked } = safety(s, a, s.speakers[a.requestedBy]);
    a.safety = checks;
    if (!blocked) { a.status = 'AWAITING_CONFIRMATION'; a.history.push({ at: Date.now(), text: 'Unblocked — location verified' }); }
  }
}

// Mutates state, returns everything the session needs to act on.
function apply(s, a, clip) {
  const events = [];
  const ev = (type, text, extra = {}) => events.push(mark(s, type, text, extra));

  // Speaker
  const sid = (a.speaker_id || '').trim() || `speaker_${Object.keys(s.speakers).length + 1}`;
  let spk = s.speakers[sid];
  if (!spk) {
    spk = s.speakers[sid] = { id: sid, name: '', role: a.speaker_role || 'unknown', voice: a.voice_signature || '', language: a.language, tone: a.tone, intensity: 0, utterances: 0, facts: 0, contradictions: 0 };
    ev('SPEAKER_ENTERED', `${sid} joined — ${a.voice_signature || 'new voice'}`, { speaker: sid });
  }
  if (a.speaker_name && !spk.name) spk.name = a.speaker_name;
  if (a.speaker_role && a.speaker_role !== 'unknown') spk.role = a.speaker_role;
  spk.utterances++;
  spk.language = a.language;
  spk.tone = a.tone;
  spk.intensity = a.intensity ?? 0;
  spk.signals = a.signals || [];
  s.current_speaker = sid;
  const label = spk.name || sid;

  for (const l of (a.language === 'mixed' ? ['en', 'hi'] : [a.language])) if (l && !s.languages.includes(l)) {
    s.languages.push(l);
    if (l !== 'en') ev('LANGUAGE_DETECTED', `${l === 'hi' ? 'Hindi' : l} detected from ${label}`, { speaker: sid, language: l });
  }

  // Vocal signals + urgency
  if (HOSTILE.has(a.tone) || HOT.has(a.tone)) s.temperature -= 30;
  else if (UNSURE.has(a.tone)) { s.temperature -= 8; s.confidence -= 5; }
  else s.temperature += 8;
  if ((a.signals || []).length && (a.intensity ?? 0) >= 0.6) ev('VOCAL_SIGNAL', `${label}: ${a.signals.join(', ')} (intensity ${(a.intensity).toFixed(2)})`, { speaker: sid });
  const recentUrg = s.utterances.slice(-2).map(u => URGENCY_RANK[u.urgency] ?? 0);
  const urg = Math.max(URGENCY_RANK[a.urgency] ?? 0, ...recentUrg, s.actions.some(x => x.priority === 'critical' && x.status !== 'DONE') ? 3 : 0);
  s.urgency = Object.keys(URGENCY_RANK)[urg];
  if (a.situation) s.situation = a.situation;

  const utt = {
    id: `u${++s.counters.utt}`, speaker: sid, start: clip.start, end: clip.end,
    transcript: a.transcript, english: a.english, language: a.language, tone: a.tone, toneCue: a.tone_cue,
    signals: a.signals || [], intensity: a.intensity ?? 0, signalConfidence: a.signal_confidence ?? 0.7, urgency: a.urgency, verbatim: '',
  };
  s.utterances.push(utt);

  // Resolution
  let resolved = null;
  if (a.resolution?.contradiction_id) {
    const c = s.contradictions.find(x => x.id === a.resolution.contradiction_id && x.status === 'OPEN') || s.contradictions.find(x => x.status === 'OPEN');
    if (c) {
      c.status = 'RESOLVED'; c.resolution = a.resolution.settled_fact; c.resolvedBy = sid; c.resolvedUtterance = utt.id;
      for (const fid of [c.factA, c.factB]) { const f = s.facts.find(x => x.id === fid); if (f) f.status = 'SUPERSEDED'; }
      s.facts.push({ id: `f${++s.counters.fact}`, text: a.resolution.settled_fact, speaker: sid, utterance: utt.id, status: 'ACTIVE', settled: true, confidence: 0.95 });
      for (const q of s.open_questions) if (q.contradiction === c.id && q.status === 'OPEN') { q.status = 'ANSWERED'; q.answer = a.resolution.settled_fact; }
      s.confidence += 50;
      resolved = c;
      ev('CONFLICT_RESOLVED', `${label} settled it: ${c.resolution}`, { speaker: sid, contradiction: c.id });
      reevaluate(s);
    }
  }

  // Facts + contradiction
  let contradiction = null;
  const target = !resolved && a.contradiction?.fact_id ? s.facts.find(f => f.id === a.contradiction.fact_id && f.status === 'ACTIVE') : null;
  const newFacts = (a.new_facts || []).filter(Boolean);
  if (target && !newFacts.length) newFacts.push(a.english);
  if (!resolved) newFacts.forEach((text, i) => {
    const f = { id: `f${++s.counters.fact}`, text, speaker: sid, utterance: utt.id, status: 'ACTIVE', confidence: 0.8 };
    s.facts.push(f);
    spk.facts++;
    if (target && i === 0) {
      target.status = 'DISPUTED'; target.confidence = 0.45; f.status = 'DISPUTED'; f.confidence = 0.45;
      contradiction = {
        id: `c${++s.counters.con}`, factA: target.id, factB: f.id, claimA: target.text, claimB: text,
        utterA: target.utterance, utterB: utt.id, speakerA: target.speaker, speakerB: sid,
        explanation: a.contradiction.explanation, question: a.contradiction.question, status: 'OPEN', detectedAt: Date.now(),
        crossLanguage: (s.speakers[target.speaker]?.language || 'en') !== a.language,
      };
      s.contradictions.push(contradiction);
      s.open_questions.push({ id: `q${++s.counters.q}`, text: a.contradiction.question || a.contradiction.explanation, status: 'OPEN', contradiction: contradiction.id, raisedBy: 'RescueRoom' });
      spk.contradictions++;
      s.confidence -= 60;
      ev('CONTRADICTION_DETECTED', a.contradiction.explanation, { speaker: sid, contradiction: contradiction.id });
    } else {
      s.confidence += 2;
      ev('FACT_ESTABLISHED', text, { speaker: sid, fact: f.id });
    }
  });

  if (a.open_question && !contradiction) {
    s.open_questions.push({ id: `q${++s.counters.q}`, text: a.open_question, status: 'OPEN', raisedBy: label });
    ev('OPEN_QUESTION', a.open_question, { speaker: sid });
  }

  // Action request → safety gate
  let actionRequested = null;
  // Only a dispatcher can raise an action; a field report or family plea must never create one.
  if (a.action_request?.type && spk.role === 'dispatcher') {
    const r = a.action_request;
    const settled = s.facts.filter(f => f.settled && f.status === 'ACTIVE').pop();
    const action = {
      id: `A${++s.counters.act}`, type: r.type, label: ACTION_LABEL[r.type] || r.type,
      location: r.location || settled?.text || 'unknown', priority: r.priority || 'urgent', details: r.details || '',
      requestedBy: sid, requestedUtterance: utt.id, status: 'AWAITING_CONFIRMATION', tools: [], constraints: [], route: '',
      history: [{ at: Date.now(), text: `Requested by ${label}` }],
    };
    const { checks, blocked } = safety(s, action, spk);
    action.safety = checks;
    if (blocked) { action.status = 'BLOCKED'; action.history.push({ at: Date.now(), text: 'Blocked by safety gate — location disputed' }); }
    s.actions.push(action);
    actionRequested = action;
    ev('ACTION_PROPOSED', `${action.label} → ${action.location} [${action.priority}] — ${action.status.replace('_', ' ').toLowerCase()}`, { speaker: sid, action: action.id });
  }

  // Confirmation
  let confirmed = null;
  if (a.confirms_pending_action && !actionRequested) {
    const pending = [...s.actions].reverse().find(x => x.status === 'AWAITING_CONFIRMATION');
    if (pending) {
      if (spk.role === 'dispatcher') {
        confirmed = confirmAction(s, pending, label);
        ev('ACTION_CONFIRMED', `${label} confirmed: ${pending.label} → ${pending.location}`, { speaker: sid, action: pending.id });
      } else {
        ev('PERMISSION_DENIED', `${label} (${spk.role}) tried to confirm — dispatcher approval required`, { speaker: sid, action: pending.id });
      }
    }
  }

  // Plan update (interruption with new operational info)
  let replanned = null;
  if (a.plan_update?.constraint) {
    const active = [...s.actions].reverse().find(x => ['CONFIRMED', 'DISPATCHED', 'AWAITING_CONFIRMATION'].includes(x.status));
    s.facts.push({ id: `f${++s.counters.fact}`, text: a.plan_update.constraint, speaker: sid, utterance: utt.id, status: 'ACTIVE', confidence: 0.85 });
    if (active) {
      active.constraints.push(a.plan_update.constraint);
      active.pendingRoute = a.plan_update.new_route || '';
      active.previousStatus = active.status;
      active.status = 'REPLANNING';
      active.history.push({ at: Date.now(), text: `Replanning: ${a.plan_update.constraint}` });
      replanned = active;
      ev('PLAN_CHANGED', `${a.plan_update.constraint} → replanning ${active.label}`, { speaker: sid, action: active.id });
    } else {
      ev('FACT_ESTABLISHED', a.plan_update.constraint, { speaker: sid });
    }
  }

  recompute(s);
  return { events, utterance: utt, contradiction, resolved, actionRequested, confirmed, replanned };
}

function confirmAction(s, action, by) {
  action.status = 'CONFIRMED';
  action.confirmedBy = by;
  action.history.push({ at: Date.now(), text: `Confirmed by ${by}` });
  recompute(s);
  return action;
}

function view(s) {
  const { counters, ...rest } = s;
  return rest;
}

module.exports = { createState, apply, recompute, view, confirmAction, mark, HOSTILE, UNSURE, HOT };
