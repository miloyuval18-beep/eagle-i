// Real, live severe-weather alerts for the Houston metro from the National
// Weather Service's public alerts API — no key required. Polled in-process
// (same cache-plus-poller shape as lib/houstonPermits.js) rather than
// fetched per-request, since NWS asks callers not to hammer the API and the
// spec's own target is a 90-minute response window, not sub-second freshness.
//
// Scoped to Houston specifically, same simplifying assumption the Permits
// feature already makes — real per-tenant geo-zone resolution (turning an
// arbitrary tenant's free-text service_area into an NWS zone) is a separate,
// bigger problem than this covers.
const HOUSTON_POINT = '29.7604,-95.3698';
const ALERTS_URL = `https://api.weather.gov/alerts/active?point=${HOUSTON_POINT}`;
const USER_AGENT = 'EagleI (https://myeaglei.com, admin@myeaglei.com)';

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 60 min — matches the spec's own polling cadence
const CACHE_MAX_AGE_MS = 65 * 60 * 1000; // slightly over the poll interval so a stalled poller doesn't serve stale-forever data silently

// Named trigger types the spec calls out explicitly, matched against NWS's
// free-text `event` field. NWS event names are a fixed, documented set
// (e.g. "Severe Thunderstorm Warning", "Flood Watch", "High Wind Warning",
// "Winter Storm Warning", "Hurricane Warning") — substring match is
// deliberately broad so a new but related event name (e.g. "Flash Flood
// Warning") still gets caught rather than silently missed.
const TRIGGER_PATTERNS = [
  /hail/i, /thunderstorm/i, /tornado/i,
  /wind/i,
  /flood/i,
  /winter storm/i, /ice storm/i, /freeze/i,
  /hurricane/i, /tropical storm/i, /tropical cyclone/i,
  /coastal/i, /storm surge/i
];

let cache = { alerts: [], fetchedAt: null };
const otherCaches = new Map(); // point -> { alerts, fetchedAt } for the other metros, fetched on demand
let pollerStarted = false;

function isStormTrigger(eventName) {
  return TRIGGER_PATTERNS.some(re => re.test(eventName || ''));
}

async function refresh(point = HOUSTON_POINT) {
  const r = await fetch(`https://api.weather.gov/alerts/active?point=${point}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' } });
  if (!r.ok) throw new Error(`NWS alerts request failed (${r.status})`);
  const data = await r.json();
  const alerts = (data.features || []).map(f => {
    const p = f.properties || {};
    return {
      id: p.id,
      event: p.event,
      severity: p.severity,
      urgency: p.urgency,
      headline: p.headline,
      description: p.description,
      areaDesc: p.areaDesc,
      effective: p.effective,
      expires: p.expires,
      isStormTrigger: isStormTrigger(p.event)
    };
  });
  const fresh = { alerts, fetchedAt: Date.now() };
  if (point === HOUSTON_POINT) cache = fresh; else otherCaches.set(point, fresh);
  return fresh;
}

// `point` is "lat,lng" for the metro to check; Houston (the default) is kept
// fresh by the poller below, the others are fetched when asked and cached.
async function getActiveAlerts({ forceRefresh = false, point = HOUSTON_POINT } = {}) {
  const c = point === HOUSTON_POINT ? cache : (otherCaches.get(point) || { alerts: [], fetchedAt: null });
  if (!forceRefresh && c.fetchedAt && (Date.now() - c.fetchedAt) < CACHE_MAX_AGE_MS) {
    return c;
  }
  try {
    return await refresh(point);
  } catch (err) {
    // Serve stale cache rather than a hard failure if NWS is briefly down —
    // matches getRecentPermits()'s Promise.allSettled resilience posture.
    if (c.fetchedAt) return { ...c, staleError: err.message };
    throw err;
  }
}

function startWeatherSignalPoller() {
  if (pollerStarted) return;
  pollerStarted = true;
  refresh().catch(err => console.error('Initial weather-signal fetch failed:', err.message));
  setInterval(() => {
    refresh().catch(err => console.error('Weather-signal poll failed:', err.message));
  }, POLL_INTERVAL_MS);
}

module.exports = { getActiveAlerts, startWeatherSignalPoller };
