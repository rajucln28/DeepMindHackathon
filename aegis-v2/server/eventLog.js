/**
 * Append-only event log for world events.
 * Provides an immutable audit trail.
 */

class EventLog {
  constructor() {
    this.events = [];
  }

  append(event) {
    const enriched = {
      ...event,
      id: `evt_${this.events.length + 1}`,
      timestamp: Date.now(),
      received_at: new Date().toISOString(),
    };
    this.events.push(enriched);
    return enriched;
  }

  getAll() {
    return [...this.events];
  }

  getRecent(n = 20) {
    return this.events.slice(-n);
  }

  getByType(type) {
    return this.events.filter(e => e.event_type === type);
  }

  size() {
    return this.events.length;
  }
}

module.exports = EventLog;
