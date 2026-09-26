// Per-utterance cognition: one Gemini Flash call hears the audio and reasons over the shared incident state.
const { flashJson } = require('./gemini');

const TONES = ['neutral', 'calm', 'confident', 'urgent', 'distressed', 'frustrated', 'angry', 'anxious', 'confused'];
const SIGNALS = ['elevated intensity', 'fast pace', 'raised pitch', 'hesitation', 'uncertainty', 'distress cues', 'steady delivery', 'calm delivery'];
const ACTIONS = ['dispatch_medical_team', 'dispatch_rescue_team', 'notify_family', 'request_air_support', 'reroute_team'];

const SCHEMA = {
  type: 'object',
  properties: {
    is_rescueroom_echo: { type: 'boolean', description: 'True if this audio is RescueRoom itself speaking (its own voice leaking into the mic).' },
    transcript: { type: 'string', description: 'Verbatim transcript in the original script (Devanagari for Hindi).' },
    language: { type: 'string', enum: ['en', 'hi', 'mixed'] },
    english: { type: 'string', description: 'Faithful English rendering.' },
    tone: { type: 'string', enum: TONES },
    signals: { type: 'array', items: { type: 'string', enum: SIGNALS }, description: 'Observable vocal signals only (not diagnoses).' },
    intensity: { type: 'number', description: '0..1 vocal intensity (volume, pitch, pace) heard in the audio.' },
    signal_confidence: { type: 'number', description: '0..1 confidence in the vocal signal reading.' },
    tone_cue: { type: 'string', description: 'The acoustic cue behind the signals, e.g. "raised pitch, fast clipped delivery".' },
    urgency: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Operational urgency of what was said AND how it was said.' },
    speaker_id: { type: 'string', description: 'Existing speaker id if the voice matches a known speaker, otherwise the next new id.' },
    speaker_name: { type: 'string', description: 'Name if the speaker introduced themselves or was addressed by name, else empty.' },
    speaker_role: { type: 'string', enum: ['dispatcher', 'field_responder', 'family', 'unknown'] },
    voice_signature: { type: 'string', description: 'Short description of the voice: gender, pitch, accent, timbre.' },
    new_facts: { type: 'array', items: { type: 'string' }, description: 'Concrete operational claims (who, where, condition, access, numbers). If there is a contradiction, put the conflicting claim FIRST. Empty if none.' },
    contradiction: {
      type: 'object',
      description: 'Set only if this utterance directly conflicts with an ACTIVE fact.',
      properties: {
        fact_id: { type: 'string' },
        explanation: { type: 'string', description: 'One sentence: X said A, but Y now says B.' },
        question: { type: 'string', description: 'The clarifying question responders need answered, e.g. "West Bridge or Railway Bridge?"' },
      },
      required: ['fact_id', 'explanation', 'question'],
    },
    resolution: {
      type: 'object',
      description: 'Set only if this utterance settles an OPEN contradiction.',
      properties: { contradiction_id: { type: 'string' }, settled_fact: { type: 'string' } },
      required: ['contradiction_id', 'settled_fact'],
    },
    action_request: {
      type: 'object',
      description: 'Set only if the speaker asks for an operational action to be taken.',
      properties: {
        type: { type: 'string', enum: ACTIONS },
        location: { type: 'string' },
        priority: { type: 'string', enum: ['routine', 'urgent', 'critical'] },
        details: { type: 'string' },
      },
      required: ['type', 'location', 'priority'],
    },
    confirms_pending_action: { type: 'boolean', description: 'True if the speaker explicitly confirms/approves the action awaiting confirmation ("confirm", "yes, go", "approved").' },
    plan_update: {
      type: 'object',
      description: 'Set if the speaker reports new operational information that changes an ACTIVE action (blocked access, new hazard, changed route, patient condition change).',
      properties: { constraint: { type: 'string', description: 'e.g. "North entrance blocked"' }, new_route: { type: 'string', description: 'The alternative, if mentioned or obvious.' } },
      required: ['constraint'],
    },
    open_question: { type: 'string', description: 'An important unanswered question this utterance raises, else empty.' },
    situation: { type: 'string', description: 'One-line current picture of the incident AFTER this utterance, max 18 words.' },
    replies: {
      type: 'array',
      description: 'What RescueRoom should say aloud now, one line per addressee, in THEIR language. Only when there is a contradiction, an action request (read it back and ask the dispatcher to confirm), or a plan update (acknowledge + new plan). Otherwise empty.',
      items: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'speaker id' },
          language: { type: 'string', enum: ['en', 'hi'] },
          text: { type: 'string', description: 'Max 22 words. Hindi in Devanagari.' },
        },
        required: ['to', 'language', 'text'],
      },
    },
  },
  required: ['is_rescueroom_echo', 'transcript', 'language', 'english', 'tone', 'signals', 'intensity', 'urgency', 'speaker_id', 'speaker_role', 'voice_signature', 'new_facts', 'situation', 'confirms_pending_action'],
};

function buildPrompt(state, lastSpoken) {
  const speakers = Object.values(state.speakers).map(s =>
    `- ${s.id}${s.name ? ` (${s.name})` : ''}: role=${s.role}, language=${s.language}, voice="${s.voice}"`).join('\n') || '- none yet';
  const facts = state.facts.filter(f => f.status === 'ACTIVE').map(f => `- ${f.id} [${f.speaker}]: ${f.text}`).join('\n') || '- none yet';
  const open = state.contradictions.filter(c => c.status === 'OPEN').map(c => `- ${c.id}: ${c.explanation}`).join('\n') || '- none';
  const actions = state.actions.filter(a => !['DONE', 'CANCELLED'].includes(a.status)).map(a =>
    `- ${a.id}: ${a.type} → ${a.location} [${a.priority}] status=${a.status}${a.route ? `, route=${a.route}` : ''}`).join('\n') || '- none';
  const recent = state.utterances.slice(-6).map(u => `${u.speaker}: ${u.english}`).join('\n') || '(start of incident)';
  const nextId = `speaker_${Object.keys(state.speakers).length + 1}`;

  return `You are the perception core of RescueRoom, an audio-first emergency coordination system listening to a live, multilingual incident call (English and Hindi/Hinglish).
Analyse the attached audio clip (one utterance) and return JSON.

KNOWN SPEAKERS (match by voice; if the voice is clearly new use ${nextId}):
${speakers}

ACTIVE FACTS:
${facts}

OPEN CONTRADICTIONS:
${open}

ACTIONS IN PROGRESS:
${actions}

RECENT (English):
${recent}

RescueRoom's last spoken line (if this clip is that voice, set is_rescueroom_echo=true): ${lastSpoken || '(none)'}

Rules:
- The system is called RescueRoom. People may address it ("RescueRoom, stop").
- Speaker matching: short clips carry little voice info — prefer the most plausible KNOWN speaker unless the voice is clearly different.
- Roles: a dispatcher coordinates and requests actions; a field responder reports from the scene; family are relatives of the victim.
- Vocal signals: report only what is audible (intensity, pace, pitch, hesitation). Never diagnose emotions or mental state.
- Contradiction = the new claim and an ACTIVE fact cannot both be true (different locations, conscious vs unconscious, different counts). Extra detail or compatible info is NOT a contradiction. When flagged, fill contradiction.question.
- If the utterance settles an OPEN contradiction, fill resolution (do not also report a contradiction).
- Fill action_request ONLY when a dispatcher explicitly orders an action ("create/send/dispatch …"). A field responder or family member reporting an emergency or asking for help is NOT an action request. Use the verified location from ACTIVE facts if they don't say one.
- "Stop" + new operational info (blocked road, new hazard) while an action is active → fill plan_update.
- replies: address people by name if known, in their own language. Dispatcher gets English. Hindi speakers get Hindi. Keep each line short and operational. For a contradiction, ask the clarifying question to the dispatcher and tell the Hindi speaker in Hindi that it's being verified. For an action request, read it back to the dispatcher and ask "Confirm?". For a plan update, acknowledge and state the new route.
- Do not invent facts that were not said.`;
}

// Hedged request: two identical calls race, first valid answer wins. Cuts API tail latency.
async function analyzeUtterance(pcm16k, state, lastSpoken) {
  const prompt = buildPrompt(state, lastSpoken);
  const call = () => flashJson(prompt, { audio: pcm16k, schema: SCHEMA });
  return Promise.any([call(), new Promise(r => setTimeout(r, 150)).then(call)]);
}

// Fast path: text-only check of the Live caption against active facts.
async function quickCheck(caption, state) {
  const facts = state.facts.filter(f => f.status === 'ACTIVE');
  if (!facts.length || caption.trim().length < 8) return null;
  const ask = () => flashJson(`Active facts in an emergency call:
${facts.map(f => `- ${f.id}: ${f.text}`).join('\n')}

Someone just said (live caption, Hindi or English, may be imperfect): "${caption}"

Does this directly contradict an active fact — both cannot be true (different location, condition, count)? Extra detail or confirmation is NOT a contradiction.
Return JSON {"fact_id": string or null, "gist": "short English gist of the new claim"}`);
  const r = await Promise.any([ask(), ask()]);
  return r?.fact_id ? r : null;
}

async function summarize(state, groundTruth) {
  const facts = state.facts.map(f => `${f.id} [${f.status}] ${f.speaker}: ${f.text}`).join('\n');
  const cons = state.contradictions.map(c => `${c.id} [${c.status}] ${c.explanation}${c.resolution ? ` → settled: ${c.resolution}` : ''}`).join('\n');
  const acts = state.actions.map(a => `${a.id} ${a.type} → ${a.location} [${a.priority}] ${a.status}${a.route ? ` via ${a.route}` : ''}`).join('\n');
  const speakers = Object.values(state.speakers).map(s => `${s.id}${s.name ? ` (${s.name})` : ''} role=${s.role} lang=${s.language}`).join(', ');
  return flashJson(`You write the final incident report for RescueRoom.
Participants: ${speakers}
Ground-truth transcript (Gemini Transcribe):
${groundTruth || '(unavailable)'}

Utterance log:
${state.utterances.map(u => `[${(u.start / 1000).toFixed(1)}s] ${u.speaker} (${u.language}, urgency ${u.urgency}): ${u.english}`).join('\n')}

Facts:
${facts}

Contradictions:
${cons || 'none'}

Actions:
${acts || 'none'}

Return JSON: {"headline": string, "situation": string, "verified_facts": [string], "actions": [{"action": string, "status": string, "detail": string}], "resolved": [string], "open_issues": [string], "timeline": [{"t": "mm:ss", "event": string}], "signal_arc": "how urgency/vocal intensity evolved, as observable signals"}`, {});
}

module.exports = { analyzeUtterance, quickCheck, summarize, TONES };
