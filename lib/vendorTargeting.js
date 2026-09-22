// Biases the real vendor Places search toward Houston's known high-value
// neighborhoods when a tenant's own business profile signals a luxury/
// high-value market focus — a deterministic keyword check on the
// business's own words (services/differentiators), not an AI judgment
// call, so it's predictable and free to run on every lookup.
const { HOUSTON_HIGH_VALUE_ZIPS } = require('./houstonZipValues');
const { query } = require('../db');

const HIGH_VALUE_KEYWORDS = [
  'luxury', 'luxurious', 'high-end', 'high end', 'upscale', 'premium',
  'high-value', 'high value', 'custom home', 'custom estate', 'estate home',
  'high net worth', 'high-net-worth', 'exclusive', 'prestige', 'prestigious',
  'elite', 'affluent', 'executive home', 'million-dollar', 'million dollar'
];

function detectsHighValueFocus(...texts) {
  const combined = texts.filter(Boolean).join(' ').toLowerCase();
  return HIGH_VALUE_KEYWORDS.some(kw => combined.includes(kw));
}

// A handful of Houston's best-known high-value neighborhoods, by
// approxMedianValue descending — enough to bias a Places free-text query
// without making the query itself unwieldy (Places doesn't take a list of
// areas, just one text string).
function topHighValueNeighborhoods(count = 5) {
  return [...HOUSTON_HIGH_VALUE_ZIPS]
    .sort((a, b) => b.approxMedianValue - a.approxMedianValue)
    .slice(0, count)
    .map(z => z.neighborhood);
}

const HIGH_VALUE_ZIP_SET = new Set(HOUSTON_HIGH_VALUE_ZIPS.map(z => z.zip));

// Best-effort: true if a Places formattedAddress's zip is one of Houston's
// known high-value ones — matches the zip immediately after a 2-letter
// state code (the standard USPS shape Places addresses use), not just any
// 5-digit run, so a street number doesn't get mistaken for a zip.
function addressInHighValueZip(address) {
  if (!address) return false;
  const m = address.match(/\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b/);
  return !!m && HIGH_VALUE_ZIP_SET.has(m[1]);
}

const EARTH_MILES = 3958.8;
function haversineMiles(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

// A business doesn't have to be headquartered IN a high-value zip to
// realistically serve clients there — an architect a few miles away in the
// Heights still does River Oaks jobs. Real ZIP centroids (US Census ZCTA
// gazetteer, lib/houstonZipRegions.js's companion table) let this be an
// actual distance check instead of a guess: every zip within radiusMiles of
// ANY high-value zip's centroid counts as "serves a high-value area" — this
// naturally includes the high-value zips themselves (distance 0).
async function getHighValueServiceZipSet(radiusMiles = 10) {
  const hvZips = HOUSTON_HIGH_VALUE_ZIPS.map(z => z.zip);
  const hv = await query('SELECT czip, clat, clng FROM zip_centroids WHERE czip = ANY($1)', [hvZips]);
  const hvPoints = hv.rows.map(r => [Number(r.clat), Number(r.clng)]);
  if (!hvPoints.length) return new Set(hvZips);
  // Bound the candidate pool to a bounding box around the high-value zips
  // (roughly 1 degree latitude/longitude per radiusMiles/50) so this stays a
  // cheap single query instead of scanning every US ZIP centroid.
  const pad = Math.max(0.5, radiusMiles / 50);
  const lats = hvPoints.map(p => p[0]), lngs = hvPoints.map(p => p[1]);
  const candidates = await query(
    `SELECT czip, clat, clng FROM zip_centroids
     WHERE clat BETWEEN $1 AND $2 AND clng BETWEEN $3 AND $4`,
    [Math.min(...lats) - pad, Math.max(...lats) + pad, Math.min(...lngs) - pad, Math.max(...lngs) + pad]
  );
  const inRange = new Set(hvZips);
  for (const c of candidates.rows) {
    const lat = Number(c.clat), lng = Number(c.clng);
    if (hvPoints.some(([hlat, hlng]) => haversineMiles(lat, lng, hlat, hlng) <= radiusMiles)) inRange.add(c.czip);
  }
  return inRange;
}

// Same zip-extraction as addressInHighValueZip, tested against a
// getHighValueServiceZipSet() result instead of the fixed curated set.
function addressServesHighValueZip(address, serviceZipSet) {
  if (!address || !serviceZipSet) return false;
  const m = address.match(/\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b/);
  return !!m && serviceZipSet.has(m[1]);
}

module.exports = {
  detectsHighValueFocus, topHighValueNeighborhoods, addressInHighValueZip, HIGH_VALUE_KEYWORDS,
  getHighValueServiceZipSet, addressServesHighValueZip
};
