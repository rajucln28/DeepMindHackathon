// The world model: pure state + an apply() that turns an analysed utterance into events.

const HOSTILE = new Set(['frustrated', 'angry']);
const UNSURE = new Set(['anxious', 'confused']);

function createState() {
  return {
    status: 'LISTENING',
    confidence: 100,
    threat: 'GREEN',
    temperature: 70,         // 0 hostile … 100 harmonious
    speakers: {},
    languages: [],
    facts: [],
    contradictions: [],
    utterances: [],
    counters: { fact: 0, con: 0, utt: 0 },
  };
}

function recompute(s) {
  s.confidence = Math.max(0, Math.min(100, Math.round(s.confidence)));
  s.temperature = Math.max(0, Math.min(100, Math.round(s.temperature)));
  const open = s.contradictions.some(c => c.status === 'OPEN');
  if (open || s.confidence < 40 || s.temperature < 25) s.threat = 'RED';
  else if (s.confidence < 70 || s.temperature < 45) s.threat = 'YELLOW';
  else s.threat = 'GREEN';
  if (open) s.status = 'RE-EVALUATING';
  else if (s.status === 'RE-EVALUATING' || s.status === 'INTERVENING') s.status = 'STABLE';
}

// Mutates state, returns { events, utterance, contradiction }.
function apply(s, a, clip) {
  const events = [];
  const ev = (type, text, extra = {}) => events.push({ type, text, at: Date.now(), ...extra });

  // Speaker
  let sid = (a.speaker_id || '').trim() || `speaker_${Object.keys(s.speakers).length + 1}`;
  let spk = s.speakers[sid];
  if (!spk) {
    spk = s.speakers[sid] = { id: sid, name: '', voice: a.voice_signature || '', language: a.language, tone: a.tone, utterances: 0, facts: 0, contradictions: 0 };
    ev('SPEAKER_ENTERED', `${sid} joined — ${a.voice_signature || 'new voice'}`, { speaker: sid });
    if (Object.keys(s.speakers).length >= 2 && s.status === 'LISTENING') s.status = 'TRACKING';
  }
  if (a.speaker_name && !spk.name) spk.name = a.speaker_name;
  spk.utterances++;
  const label = spk.name || sid;

  // Language
  const langs = a.language === 'mixed' ? ['en', 'hi'] : [a.language];
  for (const l of langs) if (l && !s.languages.includes(l)) {
    s.languages.push(l);
    if (s.utterances.length > 0 || l !== 'en') ev('LANGUAGE_DETECTED', `${l === 'hi' ? 'Hindi' : 'English'} detected from ${label}`, { speaker: sid, language: l });
  }
  spk.language = a.language;

  // Tone
  if (a.tone !== spk.tone && spk.utterances > 1 || (spk.utterances === 1 && a.tone !== 'neutral' && a.tone !== 'calm')) {
    ev('EMOTIONAL_SHIFT', `${label} sounds ${a.tone} — ${a.tone_cue}`, { speaker: sid, tone: a.tone });
  }
  spk.tone = a.tone;
  if (HOSTILE.has(a.tone)) s.temperature -= 38;
  else if (UNSURE.has(a.tone)) { s.temperature -= 8; s.confidence -= 8; }
  else s.temperature += 6;

  // Utterance
  const utt = {
    id: `u${++s.counters.utt}`, speaker: sid, start: clip.start, end: clip.end,
    transcript: a.transcript, english: a.english, language: a.language, tone: a.tone, toneCue: a.tone_cue, verbatim: '',
  };
  s.utterances.push(utt);

  // Resolution first — it takes precedence over new conflicts.
  let resolved = null;
  if (a.resolution?.contradiction_id) {
    const c = s.contradictions.find(x => x.id === a.resolution.contradiction_id && x.status === 'OPEN')
      || s.contradictions.find(x => x.status === 'OPEN');
    if (c) {
      c.status = 'RESOLVED'; c.resolution = a.resolution.settled_fact; c.resolvedBy = sid; c.resolvedUtterance = utt.id;
      for (const fid of [c.factA, c.factB]) { const f = s.facts.find(x => x.id === fid); if (f) f.status = 'SUPERSEDED'; }
      const f = { id: `f${++s.counters.fact}`, text: a.resolution.settled_fact, speaker: sid, utterance: utt.id, status: 'ACTIVE', settled: true };
      s.facts.push(f);
      s.confidence += 55; s.temperature += 20;
      resolved = c;
      ev('CONFLICT_RESOLVED', `${label} settled it: ${c.resolution}`, { speaker: sid, contradiction: c.id });
    }
  }

  // New facts + contradiction
  let contradiction = null;
  const conflictTarget = !resolved && a.contradiction?.fact_id ? s.facts.find(f => f.id === a.contradiction.fact_id && f.status === 'ACTIVE') : null;
  const newFacts = (a.new_facts || []).filter(Boolean);
  if (conflictTarget && newFacts.length === 0) newFacts.push(a.english);
  if (!resolved) newFacts.forEach((text, i) => {
    const f = { id: `f${++s.counters.fact}`, text, speaker: sid, utterance: utt.id, status: 'ACTIVE' };
    s.facts.push(f);
    spk.facts++;
    if (conflictTarget && i === 0) {
      conflictTarget.status = 'DISPUTED'; f.status = 'DISPUTED';
      const owner = s.speakers[conflictTarget.speaker];
      contradiction = {
        id: `c${++s.counters.con}`, factA: conflictTarget.id, factB: f.id,
        utterA: conflictTarget.utterance, utterB: utt.id,
        speakerA: conflictTarget.speaker, speakerB: sid,
        explanation: a.contradiction.explanation, status: 'OPEN', detectedAt: Date.now(),
        crossLanguage: (owner?.language || 'en') !== a.language,
      };
      s.contradictions.push(contradiction);
      spk.contradictions++;
      s.confidence -= 60;
      ev('CONTRADICTION_DETECTED', a.contradiction.explanation, { speaker: sid, contradiction: contradiction.id });
    } else {
      s.confidence += 2;
      ev('FACT_ESTABLISHED', text, { speaker: sid, fact: f.id });
    }
  });

  if (a.agreement && !resolved && !contradiction) {
    s.confidence += 8; s.temperature += 10;
    ev('AGREEMENT_REACHED', `${label} agreed`, { speaker: sid });
  }

  recompute(s);
  return { events, utterance: utt, contradiction, resolved };
}

// Public view sent to the browser (drops internal counters).
function view(s) {
  const { counters, ...rest } = s;
  return rest;
}

module.exports = { createState, apply, recompute, view, HOSTILE, UNSURE };
