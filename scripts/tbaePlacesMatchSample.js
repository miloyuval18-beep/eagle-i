#!/usr/bin/env node
// One-off measurement: what fraction of TBAE-verified Houston architects/
// interior designers actually turn up a real Google Places match on their
// firm name? Answers "how many are found once cross-referenced with Google
// Maps" via a real, representative SAMPLE rather than the full 1,303
// registrants — a full run costs real Google Cloud billing (~$35-42 at
// Places' "Enterprise" tier for the phone/rating field mask the app's own
// find-contact endpoint uses); this uses a minimal id+displayName field
// mask instead (Places' cheaper "Pro" tier, $32/1000, 5,000 free/month)
// since a match/no-match count doesn't need phone or rating.
//
// Query text is built identically to lib/googlePlaces.js's
// searchNearbyCompetitors (`${firmName} in ${city}, TX`) so the sample's
// hit rate reflects what the real find-contact feature would actually see.
//
// Usage: node scripts/tbaePlacesMatchSample.js [sampleSize]
const path = require('path');
const ROOT = path.join(__dirname, '..');

function loadDotEnvValue(key) {
  const fs = require('fs');
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const line = text.split('\n').find(l => l.startsWith(key + '='));
    return line ? line.slice(key.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}
for (const key of ['DATABASE_URL', 'GOOGLE_PLACES_API_KEY']) {
  if (!process.env[key]) {
    const v = loadDotEnvValue(key);
    if (v) process.env[key] = v;
  }
}

const PLACES_BASE = 'https://places.googleapis.com/v1/places:searchText';
const MINIMAL_FIELD_MASK = 'places.id,places.displayName'; // Pro tier — no rating/phone/website

async function findMatch(apiKey, textQuery) {
  const r = await fetch(PLACES_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': MINIMAL_FIELD_MASK
    },
    body: JSON.stringify({ textQuery, maxResultCount: 1 })
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error?.message || `Places request failed (${r.status})`);
  return (body.places || [])[0] || null;
}

async function main() {
  const sampleSize = parseInt(process.argv[2], 10) || 150;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not found in env or .env.');
  if (!process.env.GOOGLE_PLACES_API_KEY) throw new Error('GOOGLE_PLACES_API_KEY not found in env or .env.');

  const { query } = require('../db');
  const { HOUSTON_METRO_CITIES } = require('../lib/tbaeRegistrants');

  // Proportional stratified sample: same ratio as the real population
  // (934 architects : 369 interior designers, confirmed via the live
  // import) so the combined hit rate isn't skewed toward whichever
  // profession happens to search better/worse on Places.
  const archCount = Math.round(sampleSize * 934 / 1303);
  const idCount = sampleSize - archCount;

  async function sampleFor(profession, n) {
    const r = await query(
      `SELECT firm_name, city FROM tbae_registrants
       WHERE profession = $1 AND lic_status = 'Active' AND firm_name IS NOT NULL
         AND UPPER(city) = ANY($2)
       ORDER BY RANDOM() LIMIT $3`,
      [profession, HOUSTON_METRO_CITIES, n]
    );
    return r.rows;
  }

  const archSample = await sampleFor('architect', archCount);
  const idSample = await sampleFor('interior_designer', idCount);
  console.log(`Sampling ${archSample.length} architects + ${idSample.length} interior designers (${archSample.length + idSample.length} total)...`);

  async function run(label, rows) {
    let matched = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const textQuery = `${r.firm_name} in ${r.city}, TX`;
      try {
        const place = await findMatch(process.env.GOOGLE_PLACES_API_KEY, textQuery);
        if (place) matched++;
      } catch (err) {
        console.error(`  [${label}] lookup failed for "${r.firm_name}": ${err.message}`);
      }
      if ((i + 1) % 25 === 0) console.log(`  [${label}] ${i + 1}/${rows.length} checked, ${matched} matched so far`);
    }
    return matched;
  }

  const archMatched = await run('architects', archSample);
  const idMatched = await run('interior designers', idSample);

  const archRate = archSample.length ? archMatched / archSample.length : 0;
  const idRate = idSample.length ? idMatched / idSample.length : 0;
  const combinedRate = (archMatched + idMatched) / (archSample.length + idSample.length);

  console.log('\n=== Results ===');
  console.log(`Architects:         ${archMatched}/${archSample.length} matched (${(archRate * 100).toFixed(1)}%) → extrapolated: ~${Math.round(archRate * 934)} of 934`);
  console.log(`Interior Designers: ${idMatched}/${idSample.length} matched (${(idRate * 100).toFixed(1)}%) → extrapolated: ~${Math.round(idRate * 369)} of 369`);
  console.log(`Combined:           ${archMatched + idMatched}/${archSample.length + idSample.length} matched (${(combinedRate * 100).toFixed(1)}%) → extrapolated: ~${Math.round(combinedRate * 1303)} of 1303`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
