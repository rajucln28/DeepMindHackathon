// Per-utterance cognition: one Gemini Flash call that hears the audio and reasons over the world state.
const { flashJson } = require('./gemini');

const TONES = ['neutral', 'calm', 'confident', 'excited', 'frustrated', 'angry', 'anxious', 'confused'];

const SCHEMA = {
  type: 'object',
  properties: {
    is_aegis_echo: { type: 'boolean', description: 'True if this audio is AEGIS itself speaking (its own intervention leaking into the mic), not a human.' },
    transcript: { type: 'string', description: 'Verbatim transcript in the original script (Devanagari for Hindi).' },
    language: { type: 'string', enum: ['en', 'hi', 'mixed'] },
    english: { type: 'string', description: 'Faithful English rendering.' },
    tone: { type: 'string', enum: TONES },
    tone_cue: { type: 'string', description: 'The acoustic cue behind the tone, e.g. "raised pitch, fast clipped delivery".' },
    speaker_id: { type: 'string', description: 'Existing speaker id if the voice matches a known speaker, otherwise the next new id.' },
    speaker_name: { type: 'string', description: 'Name if the speaker introduced themselves or was addressed by name, else empty.' },
    voice_signature: { type: 'string', description: 'Short description of the voice: gender, pitch, accent, timbre.' },
    new_facts: {
      type: 'array',
      description: 'Concrete claims, decisions, numbers, dates or commitments made in this utterance. Empty if none.',
      items: { type: 'string' },
    },
    contradiction: {
      type: 'object',
      description: 'Set only if this utterance directly conflicts with an ACTIVE known fact.',
      properties: {
        fact_id: { type: 'string' },
        explanation: { type: 'string', description: 'One sentence: X said A, but Y now says B.' },
      },
      required: ['fact_id', 'explanation'],
    },
    resolution: {
      type: 'object',
      description: 'Set only if this utterance settles an OPEN contradiction.',
      properties: {
        contradiction_id: { type: 'string' },
        settled_fact: { type: 'string', description: 'The fact everyone should now treat as true.' },
      },
      required: ['contradiction_id', 'settled_fact'],
    },
    agreement: { type: 'boolean', description: 'True if the speaker explicitly agrees with or accepts something.' },
    intervention: {
      type: 'string',
      description: 'Only when a contradiction is set: what AEGIS should say aloud, max 30 words. Empty otherwise.',
    },
  },
  required: ['is_aegis_echo', 'transcript', 'language', 'english', 'tone', 'tone_cue', 'speaker_id', 'voice_signature', 'new_facts', 'agreement'],
};

function buildPrompt(state, lastIntervention) {
  const speakers = Object.values(state.speakers).map(s =>
    `- ${s.id}${s.name ? ` (${s.name})` : ''}: voice="${s.voice}", language=${s.language}`).join('\n') || '- none yet';
  const facts = state.facts.filter(f => f.status === 'ACTIVE').map(f =>
    `- ${f.id} [${f.speaker}]: ${f.text}`).join('\n') || '- none yet';
  const open = state.contradictions.filter(c => c.status === 'OPEN').map(c =>
    `- ${c.id}: ${c.explanation}`).join('\n') || '- none';
  const recent = state.utterances.slice(-6).map(u => `${u.speaker}: ${u.english}`).join('\n') || '(start of meeting)';
  const nextId = `speaker_${Object.keys(state.speakers).length + 1}`;

  return `You are the perception core of AEGIS, a meeting guardian that listens to a live multi-speaker meeting.
The meeting is mainly in English; some participants speak Hindi or Hinglish.
Analyse the attached audio clip (one utterance) and return JSON.

KNOWN SPEAKERS (match by voice; if the voice is clearly new, use ${nextId}):
${speakers}

ACTIVE FACTS:
${facts}

OPEN CONTRADICTIONS:
${open}

RECENT CONVERSATION (English):
${recent}

AEGIS's last spoken line (if the clip is this voice, set is_aegis_echo=true): ${lastIntervention || '(none)'}

Rules:
- The assistant listening is called AEGIS (pronounced "ee-jis"). People may address it, e.g. "Aegis, stop" — transcribe that name as "AEGIS".
- Speaker matching: most turns come from people already known. Short clips (a few words) carry little voice information — prefer the most plausible KNOWN speaker (often whoever spoke recently or is replying to AEGIS) unless the voice is clearly different from everyone listed.
- Judge tone from HOW it is said (pitch, pace, volume, hesitation), not only the words.
- A contradiction means the new claim and an ACTIVE fact CANNOT both be true: different amounts, different days, yes vs no, approved vs cancelled. Be strict:
  * Refinements, extra detail, or compatible timing (e.g. "live Friday" vs "done by Friday evening") are NOT contradictions.
  * Agreeing, building on, or planning around a fact is NOT a contradiction.
  * Only flag when a reasonable person would say "wait, those two can't both be right".
- If the utterance settles an OPEN contradiction (someone confirms which version is true), fill resolution and do not report a new contradiction.
- Intervention wording depends on the tone of the person who just spoke:
  * frustrated/angry → soft and collaborative, acknowledge them first ("I hear the concern…").
  * anxious/confused → grounding and direct, restate what was locked earlier.
  * otherwise → crisp and neutral.
  Name both sides (by name if known). If the contradicting speaker spoke Hindi, add one short Hindi sentence addressed to them at the end. End with a short question asking them to clarify.
- Do not invent facts that were not said.`;
}

// Hedged request: two identical calls race, first valid answer wins. Cuts API tail latency roughly in half.
async function analyzeUtterance(pcm16k, state, lastIntervention) {
  const prompt = buildPrompt(state, lastIntervention);
  const call = () => flashJson(prompt, { audio: pcm16k, schema: SCHEMA });
  return Promise.any([call(), new Promise(r => setTimeout(r, 150)).then(call)]);
}

// Fast path: text-only check of the Live caption against active facts (~1.5s vs ~3-5s for full audio analysis).
async function quickCheck(caption, state) {
  const facts = state.facts.filter(f => f.status === 'ACTIVE');
  if (!facts.length || caption.trim().length < 8) return null;
  const ask = () => flashJson(`Active facts in a meeting:
${facts.map(f => `- ${f.id}: ${f.text}`).join('\n')}

Someone just said (live caption, may be Hindi or English, may be imperfect): "${caption}"

Does this statement directly contradict an active fact — i.e. both cannot be true (different amount, date, yes/no)? Refinements, agreement, or confirmations are NOT contradictions.
Return JSON {"fact_id": string or null, "gist": "short English gist of the new claim"}`);
  const r = await Promise.any([ask(), ask()]);
  return r?.fact_id ? r : null;
}

async function summarize(state, groundTruth) {
  const facts = state.facts.map(f => `${f.id} [${f.status}] ${f.speaker}: ${f.text}`).join('\n');
  const cons = state.contradictions.map(c => `${c.id} [${c.status}] ${c.explanation}${c.resolution ? ` → settled: ${c.resolution}` : ''}`).join('\n');
  const speakers = Object.values(state.speakers).map(s => `${s.id}${s.name ? ` (${s.name})` : ''}`).join(', ');
  return flashJson(`You write the end-of-meeting brief for AEGIS.
Speakers: ${speakers}
Ground-truth transcript (Gemini Transcribe):
${groundTruth || '(unavailable)'}

Utterance log:
${state.utterances.map(u => `${u.speaker} [${u.language}, ${u.tone}]: ${u.english}`).join('\n')}

Facts:
${facts}

Contradictions:
${cons || 'none'}

Return JSON: {"headline": string, "decisions": [string], "action_items": [{"owner": string, "task": string}], "resolved": [string], "open_issues": [string], "tone_arc": string}`, {});
}

module.exports = { analyzeUtterance, quickCheck, summarize, TONES };
