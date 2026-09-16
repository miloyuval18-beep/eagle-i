#!/usr/bin/env node
// One-off cleanup: re-runs just the website-scrape step (no Places API
// call, so no additional cost beyond the website fetches themselves) for
// every tbae_registrants row whose contact_email was caught by a real bug
// in lib/vendorContactFinder.js's junk-email filter (fixed in this same
// change) — a Wix Sentry tracking pixel address and the literal
// "name@email.com" template placeholder were both slipping through.
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
if (!process.env.DATABASE_URL) {
  const v = loadDotEnvValue('DATABASE_URL');
  if (v) process.env.DATABASE_URL = v;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not found in env or .env.');
  const { query } = require('../db');
  const { findContactEmail } = require('../lib/vendorContactFinder');

  const rows = (await query(
    `SELECT id, website, contact_email FROM tbae_registrants
     WHERE contact_email ~* '@([a-z0-9-]+\\.)*wixpress\\.com$' OR lower(contact_email) = 'name@email.com'`
  )).rows;
  console.log(`${rows.length} rows to re-check.`);

  let cleared = 0, fixed = 0;
  for (const r of rows) {
    const before = r.contact_email;
    let after = null;
    if (r.website) {
      const contact = await findContactEmail(r.website);
      after = contact.email || null;
    }
    await query('UPDATE tbae_registrants SET contact_email = $1 WHERE id = $2', [after, r.id]);
    if (after && after !== before) fixed++;
    if (!after) cleared++;
    console.log(`  id=${r.id}: "${before}" -> ${after || '(none found)'}`);
  }
  console.log(`\nDone. ${fixed} replaced with a real email, ${cleared} cleared to null (no clean email published).`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Failed:', err.message); process.exit(1); });
