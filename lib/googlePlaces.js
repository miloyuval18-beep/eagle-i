// Real nearby-competitor/vendor lookup via the Places API (New) searchText
// endpoint — one free-text query with a location phrase, no separate
// Geocoding key.
const { topHighValueNeighborhoods, addressInHighValueZip } = require('./vendorTargeting');

const PLACES_BASE = 'https://places.googleapis.com/v1/places:searchText';

const PLACES_PAGE_SIZE = 20; // Text Search's own per-request max
const PLACE_FIELD_MASK = 'places.id,places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,nextPageToken';

// resultCount can exceed one page (20) — Places Text Search (New) supports
// pageToken-based pagination (confirmed live: a second page returns fresh,
// non-overlapping results), capped in practice around 60 total same as the
// legacy API. Used to fetch significantly more real businesses for the
// vendor/partner-lookup callers (people to work with) than the plain
// competitor lookup needs — see routes/onboarding.js's two call sites.
async function fetchPlacesPages(apiKey, textQuery, resultCount) {
  const places = [];
  let pageToken;
  while (places.length < resultCount) {
    const body = { textQuery, maxResultCount: Math.min(PLACES_PAGE_SIZE, resultCount - places.length) };
    if (pageToken) body.pageToken = pageToken;
    const r = await fetch(PLACES_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': PLACE_FIELD_MASK
      },
      body: JSON.stringify(body)
    });
    const respBody = await r.json();
    if (!r.ok) {
      if (places.length) break; // later page failed — keep what we already have
      throw new Error(respBody.error?.message || `Places API request failed (${r.status})`);
    }
    places.push(...(respBody.places || []));
    if (!respBody.nextPageToken || !respBody.places?.length) break;
    pageToken = respBody.nextPageToken;
    // A freshly issued pageToken needs a moment before Places will accept
    // it — confirmed live; an immediate follow-up request can 400.
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return places;
}

async function searchNearbyCompetitors({ services, serviceArea, industry, highValueFocus, resultCount = 10 }) {
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

  const places = await fetchPlacesPages(apiKey, textQuery, resultCount);
  const results = places.map(p => ({
    placeId: p.id || null, // a stable per-competitor identity — see getPlaceRatingById below, used for tracking one specific competitor's rating over time
    name: p.displayName?.text || 'Unknown',
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? null,
    address: p.formattedAddress || null,
    website: p.websiteUri || null,
    phone: p.nationalPhoneNumber || null,
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

// Re-checks one specific competitor's current rating by its stable Places
// id, via the Places Details endpoint — used by lib/competitorRatingWorker.js
// for the periodic recheck instead of re-running searchNearbyCompetitors,
// since a broad text search isn't guaranteed to re-surface the same
// competitor (or even the same ranking) on every run.
async function getPlaceRatingById(placeId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set on the server.');
  }
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'rating,userRatingCount'
    }
  });
  const body = await r.json();
  if (!r.ok) {
    throw new Error(body.error?.message || `Places API request failed (${r.status})`);
  }
  return { rating: body.rating ?? null, reviewCount: body.userRatingCount ?? null };
}

// Finds real candidate Places for the tenant's OWN business, so they can
// confirm which one is really them (same "match, then human confirms"
// pattern as the rest of the app — never auto-picked, since a wrong match
// would show them someone else's real reviews). Up to 5 candidates, one
// page, no pagination — a business's own name+address should surface it
// near the top if it's on Google at all.
async function findOwnPlaceCandidates({ name, address }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set on the server.');
  }
  const textQuery = [name, address].filter(Boolean).join(' ').trim().slice(0, 120);
  if (!textQuery) return [];
  const r = await fetch(PLACES_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': PLACE_FIELD_MASK
    },
    body: JSON.stringify({ textQuery, maxResultCount: 5 })
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error?.message || `Places API request failed (${r.status})`);
  return (body.places || []).map(p => ({
    placeId: p.id || null,
    name: p.displayName?.text || 'Unknown',
    address: p.formattedAddress || null,
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? null,
    website: p.websiteUri || null,
    phone: p.nationalPhoneNumber || null
  }));
}

// Real reviews for one place, via Place Details' `reviews` field — Google
// caps this at 5 reviews per place regardless of account/tier, always the
// ones Google itself picks as "most relevant," not necessarily the most
// recent. Worth being upfront about that limit wherever this is shown.
async function getPlaceReviews(placeId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set on the server.');
  }
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'reviews,rating,userRatingCount'
    }
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error?.message || `Places API request failed (${r.status})`);
  const reviews = (body.reviews || []).map(rv => ({
    ref: rv.name || null, // "places/{id}/reviews/{id}" — stable per review
    authorName: rv.authorAttribution?.displayName || 'A Google user',
    rating: rv.rating ?? null,
    text: rv.text?.text || rv.originalText?.text || '',
    publishedAt: rv.relativePublishTimeDescription || null
  })).filter(rv => rv.ref);
  return { reviews, rating: body.rating ?? null, reviewCount: body.userRatingCount ?? null };
}

module.exports = { searchNearbyCompetitors, geocodeAddress, getPlaceRatingById, findOwnPlaceCandidates, getPlaceReviews };
