// Real nearby-competitor lookup via the Places API (New) searchText endpoint
// — one free-text query with a location phrase, no separate Geocoding key.
const PLACES_BASE = 'https://places.googleapis.com/v1/places:searchText';

async function searchNearbyCompetitors({ services, serviceArea, industry }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set on the server.');
  }
  const textQuery = `${(services || industry || 'business').slice(0, 60)} in ${serviceArea || ''}`.trim();

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
  return (body.places || []).map(p => ({
    name: p.displayName?.text || 'Unknown',
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? null,
    address: p.formattedAddress || null,
    website: p.websiteUri || null
  }));
}

module.exports = { searchNearbyCompetitors };
