#!/usr/bin/env node
// Manual/periodic import of REAL per-zip home-value stats from Harris
// Central Appraisal District's own public bulk data export.
//
// Why this is a local script and not a live route: HCAD has no per-address
// or per-zip API — the only public access is a single county-wide export
// (Real_acct_owner.zip, ~1.8M parcels, ~200MB compressed) refreshed by HCAD
// roughly annually (certified values) with periodic revisions before that.
// Downloading and inflating that file on every request — or even once per
// server process — isn't something the live Render web service should do;
// it's exactly the kind of one-time/periodic batch job this project has
// consistently kept out of the request path (see the migration-via-local-
// script pattern already used for schema changes). Run this from a
// developer machine against the same DATABASE_URL the app uses (same
// pattern test/helpers.js and node-pg-migrate already use) whenever HCAD
// publishes updated values — a few times a year is plenty; home values
// don't move week to week the way permits or weather do.
//
// What this does NOT do: it does not store parcel-level data (owner name,
// exact address) — only per-zip aggregates (avg/median market value,
// parcel count). Parcel-level owner-name matching against specific permit
// addresses would need either the full ~1.8M-row county file kept in
// Postgres indefinitely, or a live per-address HCAD API that doesn't
// exist — both bigger asks than this pass takes on. See README.md's
// "HCAD real home-value data" section.
//
// Usage:
//   node scripts/importHcadZipValues.js            # downloads, imports, writes to DB
//   node scripts/importHcadZipValues.js --dry-run   # downloads + parses, prints summary, writes nothing

const path = require('path');
const { readZipEntries } = require('../lib/xlsxReader');

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
  const fromDotEnv = loadDotEnvValue('DATABASE_URL');
  if (fromDotEnv) process.env.DATABASE_URL = fromDotEnv;
}

const DRY_RUN = process.argv.includes('--dry-run');
const TAX_YEARS_URL = 'https://hcad.org/actions/hcad-pdata/default/get-tax-years';
const DOWNLOADS_URL = (year) =>
  `https://hcad.org/actions/hcad-pdata/default/get-property-downloads?t=${year}&c=CAMA&s=${encodeURIComponent('Real Property')}`;
const HOUSTON_ZIP_PREFIX = '77'; // Harris County zip codes are essentially all 77xxx — same scoping already used in lib/weatherSignals.js and lib/houstonPermits.js.

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'EagleI (https://myeaglei.com, admin@myeaglei.com)' } });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return r.json();
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not found in env or .env.');
  }

  console.log('Fetching current tax year from HCAD...');
  const years = await fetchJson(TAX_YEARS_URL);
  const taxYear = (years[0] && years[0].taxyears || '').trim();
  if (!taxYear) throw new Error('Could not determine current tax year from HCAD.');
  console.log(`Tax year: ${taxYear}`);

  console.log('Fetching Real Property download links...');
  const downloads = await fetchJson(DOWNLOADS_URL(taxYear));
  const realAcctEntry = downloads.find(d => d.filename === 'Real_acct_owner.zip');
  if (!realAcctEntry) throw new Error('Real_acct_owner.zip not found in HCAD download list — HCAD may have renamed/restructured their export.');
  console.log(`Download URL: ${realAcctEntry.downloadLink}`);

  console.log('Downloading Real_acct_owner.zip (this is ~200MB and can take a few minutes)...');
  const t0 = Date.now();
  const zipResp = await fetch(realAcctEntry.downloadLink);
  if (!zipResp.ok) throw new Error(`Download failed: ${zipResp.status}`);
  const zipBuf = Buffer.from(await zipResp.arrayBuffer());
  console.log(`Downloaded ${(zipBuf.length / 1e6).toFixed(1)}MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  console.log('Extracting real_acct.txt from the archive...');
  const entries = readZipEntries(zipBuf, ['real_acct.txt']);
  if (!entries['real_acct.txt']) throw new Error('real_acct.txt not found inside Real_acct_owner.zip.');
  const buf = entries['real_acct.txt'];
  console.log(`Extracted ${(buf.length / 1e6).toFixed(0)}MB.`);
  // Deliberately never call buf.toString('utf8') on the whole thing — the
  // inflated file is well over V8's ~536MB max string length (found by
  // hitting that exact error against the real file). Every string
  // conversion below is scoped to one line at a time via
  // Buffer.indexOf/subarray on the raw bytes, never the whole buffer.
  const NEWLINE = 0x0a;

  const { buildRealAcctHeaderIndex, parseRealAcctLine, aggregateZipValues, upsertZipStats } = require('../lib/hcadZipValues');

  const firstNewline = buf.indexOf(NEWLINE);
  const headerLine = buf.subarray(0, firstNewline).toString('utf8');
  const headerIndex = buildRealAcctHeaderIndex(headerLine);
  if (headerIndex.site_addr_3 === undefined || headerIndex.tot_mkt_val === undefined) {
    throw new Error('real_acct.txt header did not contain expected columns (site_addr_3, tot_mkt_val) — HCAD may have changed their file layout. See README.md\'s "HCAD real home-value data" section.');
  }

  console.log('Parsing and aggregating by zip (Houston-area zips only)...');
  const parsed = [];
  let lineStart = firstNewline + 1;
  let totalLines = 0;
  while (lineStart < buf.length) {
    let lineEnd = buf.indexOf(NEWLINE, lineStart);
    if (lineEnd === -1) lineEnd = buf.length;
    const line = buf.subarray(lineStart, lineEnd).toString('utf8');
    lineStart = lineEnd + 1;
    totalLines++;
    const row = parseRealAcctLine(headerIndex, line);
    if (row && row.zip.startsWith(HOUSTON_ZIP_PREFIX)) parsed.push(row);
  }
  console.log(`Scanned ${totalLines.toLocaleString()} accounts, kept ${parsed.length.toLocaleString()} with a usable Houston-area zip + market value.`);

  const stats = aggregateZipValues(parsed);
  console.log(`Aggregated into ${stats.length} zip codes.`);
  console.log('Top 10 by parcel count:');
  stats.slice(0, 10).forEach(s => {
    console.log(`  ${s.zip}  avg $${s.avgMarketValue.toLocaleString()}  median $${s.medianMarketValue.toLocaleString()}  (${s.parcelCount.toLocaleString()} parcels)`);
  });

  if (DRY_RUN) {
    console.log('\n--dry-run: not writing to the database.');
    return;
  }

  console.log(`\nWriting ${stats.length} rows to hcad_zip_stats...`);
  await upsertZipStats(stats, taxYear);
  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Import failed:', err.message);
    process.exit(1);
  });
