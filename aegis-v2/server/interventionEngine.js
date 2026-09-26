/**
 * Intervention Engine — autonomous rule-based voice interventions.
 * Evaluates WorldState against rules and fires TTS when conditions are met.
 */

const INTERVENTION_RULES = [
  {
    name: 'CONTRADICTION_ALERT',
    condition: (s) => s.confidence_score < 40 && s.unresolved_contradictions.length > 0,
    messageTemplate: (s) => {
      const c = s.unresolved_contradictions[0];
      return `Excuse me. I am detecting a factual conflict. ${c.description}. Can someone clarify?`;
    },
    cooldownMs: 15000,
    priority: 10,
  },
  {
    name: 'UNCERTAINTY_CHECK',
    condition: (s) => s.confidence_score < 25 && s.event_count > 10,
    messageTemplate: () =>
      'My understanding has dropped critically low. Can someone restate the key decision?',
    cooldownMs: 25000,
    priority: 9,
  },
  {
    name: 'EMOTIONAL_ESCALATION',
    condition: (s) => s.emotional_temperature < 25 && s.threat_level === 'RED',
    messageTemplate: () =>
      'I am noticing rising tension. Would it help to take a step back and summarize what we agree on?',
    cooldownMs: 30000,
    priority: 8,
  },
  {
    name: 'LANGUAGE_BRIDGE',
    condition: (s) => s.languages_present.length > 1 && s.confidence_score < 60,
    messageTemplate: (s) => {
      const langs = s.languages_present.join(' and ');
      return `I am bridging ${langs}. Let me quickly align both sides on what has been said.`;
    },
    cooldownMs: 20000,
    priority: 7,
  },
];

class InterventionEngine {
  constructor() {
    this.lastFiredAt = {}; // ruleName -> timestamp
    this.isIntervening = false;
  }

  /**
   * Evaluate all rules against current state.
   * Returns the highest-priority intervention that passes its condition and cooldown,
   * or null if no intervention is needed.
   */
  evaluate(state) {
    if (this.isIntervening) return null;
    if (state.event_count < 3) return null; // Don't intervene too early

    const now = Date.now();
    const candidates = [];

    for (const rule of INTERVENTION_RULES) {
      // Check cooldown
      const lastFired = this.lastFiredAt[rule.name] || 0;
      if (now - lastFired < rule.cooldownMs) continue;

      // Check condition
      if (rule.condition(state)) {
        candidates.push(rule);
      }
    }

    if (candidates.length === 0) return null;

    // Pick highest priority
    candidates.sort((a, b) => b.priority - a.priority);
    const winner = candidates[0];

    return {
      rule: winner.name,
      message: winner.messageTemplate(state),
      priority: winner.priority,
    };
  }

  /**
   * Mark a rule as fired (starts cooldown timer).
   */
  markFired(ruleName) {
    this.lastFiredAt[ruleName] = Date.now();
    this.isIntervening = true;
  }

  /**
   * Called when intervention audio finishes or is interrupted.
   */
  markComplete() {
    this.isIntervening = false;
  }

  /**
   * Cancel current intervention (e.g., barge-in).
   */
  cancelIntervention() {
    this.isIntervening = false;
  }
}

module.exports = InterventionEngine;
