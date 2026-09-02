// Real nearby-competitor/vendor lookup via the Places API (New) searchText
// endpoint — one free-text query with a location phrase, no separate
// Geocoding key.
const { topHighValueNeighborhoods, addressInHighValueZip } = require('./vendorTargeting');

const PLACES_BASE = 'https://places.googleapis.com/v1/places:searchText';

async function searchNearbyCompetitors({ services, serviceArea, industry, highValueFocus }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set on the server.');
  }
  const base = (services || industry || 'business').slice(0, 60);
  // highValueFocus (set by callers — currently only the vendors route,
  // see routes/onboarding.js) biases the query toward Houston's known
  // high-value neighborhoods instead of a plain service-area search, for
  // a tenant whose own bio signals a luxury/high-end market (see
  // lib/vendorTargeting.js). Directional, not a geographic filter — Places
  // searchText takes one free-text string, not a location restriction.
  const textQuery = highValueFocus
    ? `${base} near ${topHighValueNeighborhoods().join(', ')}, ${serviceArea || 'Houston'}`.trim()
    : `${base} in ${serviceArea || ''}`.trim();

  const r = await fetch(PLACES_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.websiteUri'
    },
    body: JSON.stringify({ textQuery, maxResultCount: 10 })
  });
  const body = await r.json();
  if (!r.ok) {
    throw new Error(body.error?.message || `Places API request failed (${r.status})`);
  }
  const results = (body.places || []).map(p => ({
    name: p.displayName?.text || 'Unknown',
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? null,
    address: p.formattedAddress || null,
    website: p.websiteUri || null,
    inHighValueZip: addressInHighValueZip(p.formattedAddress)
  }));
  if (highValueFocus) {
    // Surface high-value-zip matches first without discarding the rest —
    // Places' own relevance ranking still decides order among the others.
    results.sort((a, b) => (b.inHighValueZip === true) - (a.inHighValueZip === true));
  }
  return results;
}

module.exports = { searchNearbyCompetitors };
