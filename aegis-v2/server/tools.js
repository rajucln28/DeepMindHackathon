// Mock operational tools (hackathon-safe: nothing real is dispatched). Each resolves after a realistic delay
// so the UI visibly shows tools running in parallel.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const TOOLS = {
  async lookup_location({ location, avoid }) {
    await sleep(350 + Math.random() * 250);
    const h = hash(location);
    const lat = (17.38 + (h % 100) / 1000).toFixed(4), lng = (78.47 + (h % 73) / 1000).toFixed(4);
    const access = avoid ? `South access road (avoiding ${avoid})` : 'North entrance, service road';
    return { coords: `${lat}, ${lng}`, access, eta_min: avoid ? 11 : 8, nearest_unit: 'Medic-7 (Station 3)' };
  },
  async get_weather({ location }) {
    await sleep(250 + Math.random() * 250);
    return { conditions: 'Heavy rain', visibility: '1.2 km', advisory: 'Flooding risk near riverbanks', location };
  },
  async knowledge_lookup({ topic }) {
    await sleep(300 + Math.random() * 300);
    return { protocol: 'Entrapment + breathing difficulty → ALS unit, extraction kit, oxygen', topic };
  },
  async create_task({ type, location, priority, route }) {
    await sleep(450 + Math.random() * 300);
    return { task_id: `INC-${String(hash(type + location + (route || ''))).slice(-4)}`, assigned: 'Medic-7', priority, route: route || 'standard' };
  },
  async send_notification({ to, message }) {
    await sleep(300 + Math.random() * 250);
    return { delivered: true, to, message };
  },
};

async function run(name, args) {
  const t0 = Date.now();
  const result = await TOOLS[name](args);
  return { name, args, result, ms: Date.now() - t0 };
}

module.exports = { run, TOOLS };
