// Biases the real vendor Places search toward Houston's known high-value
// neighborhoods when a tenant's own business profile signals a luxury/
// high-value market focus — a deterministic keyword check on the
// business's own words (services/differentiators), not an AI judgment
// call, so it's predictable and free to run on every lookup.
const { HOUSTON_HIGH_VALUE_ZIPS } = require('./houstonZipValues');

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

module.exports = { detectsHighValueFocus, topHighValueNeighborhoods, addressInHighValueZip, HIGH_VALUE_KEYWORDS };
