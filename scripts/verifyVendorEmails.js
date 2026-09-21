// Verifies every stored vendor contact email (see lib/emailVerification.js
// for what that does and does not prove) and records the result on the row.
//
//   node scripts/verifyVendorEmails.js             # check + save unchecked rows
//   node scripts/verifyVendorEmails.js --dry-run   # check, print, save nothing
//   node scripts/verifyVendorEmails.js --recheck   # redo rows already checked
//   node scripts/verifyVendorEmails.js --limit 50  # cap rows per source (testing)
//
// Rows with no saved Google match name (looked up before match-checking
// existed) also get the website-is-this-business check, since nothing else
// vouches that the email came from the right company.
const { query } = require('../db');
const { SOURCES } = require('../lib/vendorDirectories');
const { verifyEmail } = require('../lib/emailVerification');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const recheck = args.includes('--recheck');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null;
const CONCURRENCY = 8;

async function runPool(items, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const item = items[i++]; await worker(item); }
  }));
}

(async () => {
  const overall = {};
  const samples = {};
  for (const [key, s] of Object.entries(SOURCES)) {
    const rows = (await query(
      `SELECT id, ${s.name} AS name, contact_email, website, places_matched_name
       FROM ${s.table}
       WHERE contact_email IS NOT NULL AND contact_email <> '' ${recheck ? '' : 'AND email_checked_at IS NULL'}
       ORDER BY id ${limit ? 'LIMIT ' + limit : ''}`
    )).rows;
    if (!rows.length) continue;
    const tally = {};
    let done = 0;
    await runPool(rows, async (r) => {
      let result;
      try {
        result = await verifyEmail({ email: r.contact_email, website: r.website, businessName: r.name, checkSite: !r.places_matched_name });
      } catch (err) {
        result = { status: 'unknown', reason: 'check failed: ' + err.message };
      }
      tally[result.status] = (tally[result.status] || 0) + 1;
      if (result.status !== 'verified') (samples[result.status] = samples[result.status] || []).push(`${r.name} <${r.contact_email}> — ${result.reason}`);
      if (!dryRun) {
        await query(
          `UPDATE ${s.table} SET email_check_status = $1, email_check_reason = $2, email_checked_at = now() WHERE id = $3`,
          [result.status, result.reason, r.id]
        );
      }
      if (++done % 100 === 0) console.log(`  ${key}: ${done}/${rows.length}`);
    });
    overall[key] = { checked: rows.length, ...tally };
    console.log(`${key}: checked ${rows.length} —`, JSON.stringify(tally));
  }
  console.log(dryRun ? '\n(dry run — nothing saved)' : '\nSaved.');
  console.log('\nSAMPLES OF NON-VERIFIED (up to 6 per status):');
  for (const [st, list] of Object.entries(samples)) {
    console.log(`\n[${st}] ${list.length} total`);
    list.slice(0, 6).forEach(x => console.log('  ' + x));
  }
  process.exit(0);
})().catch(err => { console.error('Failed:', err); process.exit(1); });
