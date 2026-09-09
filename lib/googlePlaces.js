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

// Resolves a specific street address to a real lat/lng, reusing the same
// Places API (New) key/endpoint rather than a separate Geocoding API key
// — a highly specific free-text query with maxResultCount:1 reliably
// resolves a single real address without needing a second Google Cloud
// API enabled. Used by routes/jobs.js to geocode a job site once, so its
// coordinates can be reused for radius ad targeting (routes/ads.js)
// without re-geocoding on every campaign.
async function geocodeAddress(addressText) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set on the server.');
  }
  const textQuery = String(addressText || '').trim();
  if (!textQuery) return null;

  const r = await fetch(PLACES_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.location,places.formattedAddress'
    },
    body: JSON.stringify({ textQuery, maxResultCount: 1 })
  });
  const body = await r.json();
  if (!r.ok) {
    throw new Error(body.error?.message || `Places API request failed (${r.status})`);
  }
  const place = (body.places || [])[0];
  if (!place || !place.location) return null;

  const formattedAddress = place.formattedAddress || null;
  const zipMatch = formattedAddress ? formattedAddress.match(/\b(\d{5})\b(?!.*\d{5})/) : null;
  return {
    placeId: place.id || null,
    lat: place.location.latitude,
    lng: place.location.longitude,
    formattedAddress,
    zip: zipMatch ? zipMatch[1] : null
  };
}

module.exports = { searchNearbyCompetitors, geocodeAddress };
