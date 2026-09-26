/**
 * Pure-function WorldState reducer.
 * Every event produces a new state — no mutations, no side effects.
 */

function createInitialState() {
  return {
    system_status: 'LISTENING',
    confidence_score: 100,
    threat_level: 'GREEN',
    active_speakers: {},       // { speaker_id: SpeakerProfile }
    languages_present: [],
    primary_language: 'en',
    established_facts: [],     // { id, description, speaker_id, confidence, established_at, status }
    unresolved_contradictions: [], // { id, fact_a, fact_b, description, detected_at }
    resolved_contradictions: [],
    emotional_temperature: 50, // 0 (hostile) to 100 (harmonious), start neutral at 50
    dominant_emotion: 'neutral',
    last_event_at: Date.now(),
    event_count: 0,
    silence_duration_ms: 0,
  };
}

let factCounter = 0;
let contradictionCounter = 0;

function generateFactId() {
  return `fact_${++factCounter}`;
}

function generateContradictionId() {
  return `contradiction_${++contradictionCounter}`;
}

function reduce(state, event) {
  // Deep clone to avoid mutation
  const next = JSON.parse(JSON.stringify(state));
  next.event_count++;
  next.last_event_at = Date.now();
  next.silence_duration_ms = 0;

  switch (event.event_type) {
    case 'SPEAKER_ENTERED': {
      const sid = event.speaker_id || `speaker_${Object.keys(next.active_speakers).length + 1}`;
      if (!next.active_speakers[sid]) {
        next.active_speakers[sid] = {
          id: sid,
          language: event.language || next.primary_language,
          emotion: event.emotion || 'neutral',
          fact_count: 0,
          contradiction_count: 0,
          first_seen_at: Date.now(),
          last_heard_at: Date.now(),
        };
      }
      const speakerCount = Object.keys(next.active_speakers).length;
      if (speakerCount >= 3 && next.system_status === 'LISTENING') {
        next.system_status = 'TRACKING';
      }
      break;
    }

    case 'SPEAKER_LEFT': {
      const sid = event.speaker_id;
      if (sid && next.active_speakers[sid]) {
        delete next.active_speakers[sid];
      }
      break;
    }

    case 'LANGUAGE_DETECTED': {
      if (event.language && !next.languages_present.includes(event.language)) {
        next.languages_present.push(event.language);
      }
      if (next.languages_present.length > 1) {
        if (next.system_status === 'LISTENING') {
          next.system_status = 'TRACKING';
        }
      }
      // Update speaker language
      if (event.speaker_id && next.active_speakers[event.speaker_id]) {
        next.active_speakers[event.speaker_id].language = event.language;
        next.active_speakers[event.speaker_id].last_heard_at = Date.now();
      }
      break;
    }

    case 'FACT_ESTABLISHED': {
      const factId = generateFactId();
      next.established_facts.push({
        id: factId,
        description: event.description,
        speaker_id: event.speaker_id || 'unknown',
        confidence: event.confidence,
        established_at: Date.now(),
        status: 'ACTIVE',
      });
      // Update speaker stats
      if (event.speaker_id && next.active_speakers[event.speaker_id]) {
        next.active_speakers[event.speaker_id].fact_count++;
        next.active_speakers[event.speaker_id].last_heard_at = Date.now();
      }
      // Slight confidence boost when facts are established cleanly
      next.confidence_score = Math.min(100, next.confidence_score + 2);
      break;
    }

    case 'FACT_REVISED': {
      // Find and mark the old fact as REVISED
      if (event.related_facts && event.related_facts.length > 0) {
        for (const relId of event.related_facts) {
          const fact = next.established_facts.find(f => f.id === relId);
          if (fact) fact.status = 'REVISED';
        }
      }
      // Add the revised fact
      const revisedFactId = generateFactId();
      next.established_facts.push({
        id: revisedFactId,
        description: event.description,
        speaker_id: event.speaker_id || 'unknown',
        confidence: event.confidence,
        established_at: Date.now(),
        status: 'ACTIVE',
      });
      next.confidence_score = Math.max(0, next.confidence_score - 10);
      break;
    }

    case 'CONTRADICTION_DETECTED': {
      const cId = generateContradictionId();
      next.unresolved_contradictions.push({
        id: cId,
        fact_a: event.related_facts?.[0] || null,
        fact_b: event.related_facts?.[1] || null,
        description: event.description,
        detected_at: Date.now(),
      });
      // Mark related facts as CONTRADICTED
      if (event.related_facts) {
        for (const relId of event.related_facts) {
          const fact = next.established_facts.find(f => f.id === relId);
          if (fact) fact.status = 'CONTRADICTED';
        }
      }
      // Massive confidence drop
      next.confidence_score = Math.max(0, next.confidence_score - 40);
      next.system_status = 'RE-EVALUATING';
      next.threat_level = next.confidence_score < 40 ? 'RED' : 'YELLOW';
      // Update speaker contradiction count
      if (event.speaker_id && next.active_speakers[event.speaker_id]) {
        next.active_speakers[event.speaker_id].contradiction_count++;
      }
      break;
    }

    case 'EMOTIONAL_SHIFT': {
      if (event.speaker_id && next.active_speakers[event.speaker_id]) {
        next.active_speakers[event.speaker_id].emotion = event.emotion || 'neutral';
        next.active_speakers[event.speaker_id].last_heard_at = Date.now();
      }
      next.dominant_emotion = event.emotion || next.dominant_emotion;

      if (event.emotion === 'angry' || event.emotion === 'frustrated') {
        next.emotional_temperature = Math.max(0, next.emotional_temperature - 20);
        if (next.emotional_temperature < 25) {
          next.threat_level = 'RED';
          next.system_status = 'ESCALATING';
        } else if (next.emotional_temperature < 40) {
          next.threat_level = 'YELLOW';
        }
      } else if (event.emotion === 'calm' || event.emotion === 'confident') {
        next.emotional_temperature = Math.min(100, next.emotional_temperature + 10);
      }
      break;
    }

    case 'UNCERTAINTY_SPIKE': {
      next.confidence_score = Math.max(0, next.confidence_score - 25);
      if (next.confidence_score < 40) {
        next.threat_level = 'RED';
        next.system_status = 'RE-EVALUATING';
      } else if (next.confidence_score < 65) {
        next.threat_level = 'YELLOW';
      }
      break;
    }

    case 'AGREEMENT_REACHED': {
      next.confidence_score = Math.min(100, next.confidence_score + 15);
      next.emotional_temperature = Math.min(100, next.emotional_temperature + 10);
      if (next.unresolved_contradictions.length === 0) {
        next.system_status = 'STABLE';
        next.threat_level = 'GREEN';
      }
      break;
    }

    case 'CONFLICT_RESOLVED': {
      // Move the most recent unresolved contradiction to resolved
      if (next.unresolved_contradictions.length > 0) {
        const resolved = next.unresolved_contradictions.shift();
        resolved.resolved_at = Date.now();
        resolved.resolution = event.description;
        next.resolved_contradictions.push(resolved);
      }
      next.confidence_score = Math.min(100, next.confidence_score + 30);
      next.emotional_temperature = Math.min(100, next.emotional_temperature + 15);
      if (next.unresolved_contradictions.length === 0) {
        next.system_status = 'STABLE';
        next.threat_level = 'GREEN';
      }
      break;
    }

    case 'TOPIC_CHANGED': {
      // Slight confidence dip on topic changes
      next.confidence_score = Math.max(0, next.confidence_score - 5);
      break;
    }

    case 'URGENCY_ESCALATION': {
      next.system_status = 'ESCALATING';
      next.threat_level = 'RED';
      next.confidence_score = Math.max(0, next.confidence_score - 15);
      break;
    }

    default:
      break;
  }

  // Clamp values
  next.confidence_score = Math.max(0, Math.min(100, next.confidence_score));
  next.emotional_temperature = Math.max(0, Math.min(100, next.emotional_temperature));

  // Recalculate threat level based on current scores
  if (next.threat_level !== 'RED') {
    if (next.confidence_score < 40 || next.emotional_temperature < 25) {
      next.threat_level = 'RED';
    } else if (next.confidence_score < 65 || next.emotional_temperature < 40) {
      next.threat_level = 'YELLOW';
    } else {
      next.threat_level = 'GREEN';
    }
  }

  return next;
}

module.exports = { createInitialState, reduce };
