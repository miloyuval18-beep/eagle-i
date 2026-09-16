#!/usr/bin/env node
// One-time backfill: runs the exact same Places-lookup + website-scrape
// pipeline as routes/tbaeRegistrants.js's find-contact endpoint, but for
// EVERY Houston-metro, Active, published-firm TBAE registrant at once
// instead of one-at-a-time on tenant click. Real cost: Places Text Search
// with the phone/website/rating field mask bills at Google's "Enterprise"
// tier ($35/1000 calls) — see the cost discussion this was run under.
//
// Results are written straight into tbae_registrants via saveContactInfo
// — the SAME storage the app's own find-contact endpoint uses — so this
// is genuinely reusable by every tenant afterward, not a side artifact.
// Idempotent/resumable: any registrant that already has a
// contact_checked_at is skipped, so re-running this after an interruption
// (or after the monthly roster worker adds new registrants) only pays for
// what hasn't been checked yet.
//
// Usage: node scripts/tbaeFullContactLookup.js
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

const DELAY_MS = 150; // light pacing between calls — polite to Places' QPS limits, not strictly required

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not found in env or .env.');
  if (!process.env.GOOGLE_PLACES_API_KEY) throw new Error('GOOGLE_PLACES_API_KEY not found in env or .env.');

  const { query } = require('../db');
  const { HOUSTON_METRO_CITIES } = require('../lib/tbaeRegistrants');
  const { saveContactInfo } = require('../lib/tbaeRegistrants');
  const { searchNearbyCompetitors } = require('../lib/googlePlaces');
  const { findContactEmail } = require('../lib/vendorContactFinder');

  const pending = await query(
    `SELECT id, profession, firm_name, city FROM tbae_registrants
     WHERE lic_status = 'Active' AND firm_name IS NOT NULL AND UPPER(city) = ANY($1)
       AND contact_checked_at IS NULL
     ORDER BY profession, firm_name`,
    [HOUSTON_METRO_CITIES]
  );
  const rows = pending.rows;
  console.log(`${rows.length} registrants pending a contact-info check (already-checked ones skipped).`);

  let websiteFound = 0, emailFound = 0, phoneFound = 0, errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const results = await searchNearbyCompetitors({
        services: r.firm_name,
        serviceArea: `${r.city || 'Houston'}, TX`,
        resultCount: 1
      });
      const match = results[0];

      let email = null;
      if (match && match.website) {
        const contact = await findContactEmail(match.website);
        email = contact.email || null;
      }

      await saveContactInfo(r.id, {
        website: match?.website || null,
        phone: match?.phone || null,
        contactEmail: email,
        placesFormattedAddress: match?.address || null
      });

      if (match?.website) websiteFound++;
      if (match?.phone) phoneFound++;
      if (email) emailFound++;
    } catch (err) {
      errors++;
      console.error(`  [${i + 1}/${rows.length}] FAILED "${r.firm_name}": ${err.message}`);
      // Best-effort even on failure — mark it checked so a re-run doesn't
      // retry a firm that's genuinely erroring (e.g. a malformed name),
      // rather than spinning on it forever.
      try { await saveContactInfo(r.id, { website: null, phone: null, contactEmail: null, placesFormattedAddress: null }); } catch { /* ignore */ }
    }

    if ((i + 1) % 50 === 0 || i === rows.length - 1) {
      console.log(`[${i + 1}/${rows.length}] website:${websiteFound} phone:${phoneFound} email:${emailFound} errors:${errors}`);
    }
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }

  console.log('\n=== Done ===');
  console.log(`Checked: ${rows.length}`);
  console.log(`Website found: ${websiteFound}`);
  console.log(`Phone found: ${phoneFound}`);
  console.log(`Email found: ${emailFound}`);
  console.log(`Errors: ${errors}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
