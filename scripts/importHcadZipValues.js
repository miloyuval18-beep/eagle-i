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
// This also populates hcad_owner_parcels — a per-parcel table of just the
// address + owner name for accounts where the owner-of-record parses as a
// confident individual (lib/hcadOwnerNames.js filters out businesses,
// trusts, government owners, and HCAD's own "CURRENT OWNER" placeholder).
// That's the "bigger ask" this file's comment used to say wasn't taken on
// — it now is, specifically to let the Permits mailer address a letter to
// a real name instead of "Property Owner" when — and only when — the match
// is unambiguous. See README.md's "HCAD real home-value data" section and
// lib/hcadZipValues.js's findConfidentOwners().
//
// Usage:
//   node scripts/importHcadZipValues.js               # downloads, imports, writes to DB
//   node scripts/importHcadZipValues.js --dry-run      # downloads + parses, prints summary, writes nothing
//   node scripts/importHcadZipValues.js --header-only  # downloads, prints real_acct.txt's full column
//                                                       # list + a plausibility spot-check of any
//                                                       # candidate year-built/deed-date columns, then
//                                                       # exits before the full parse or any DB write —
//                                                       # a one-off feasibility check for a planned
//                                                       # feature (aging-system targeting), see the
//                                                       # "Feature D" plan this codebase's git history
//                                                       # has for the full context.

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
const HEADER_ONLY = process.argv.includes('--header-only');
// Column-name substrings worth flagging as candidates for a property's
// original-construction year or its most recent sale/deed date — real
// Texas CAD real_acct exports commonly (not guaranteed) carry something
// like this, but nothing in this codebase has ever read past the four
// columns already in use, so this is a genuine unknown until checked
// against the live file.
const YEAR_BUILT_CANDIDATES = /yr_impr|year_?built|yr_?built|impr_?yr|act_yr_?built|eff_yr_?built/i;
const DEED_DATE_CANDIDATES = /deed_?dt|deed_?date|sale_?dt|sale_?date|instr_?dt|ownership_?dt/i;
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

  const {
    buildRealAcctHeaderIndex, parseRealAcctLine, parseRealAcctOwnerLine, parseRealAcctParcelAgeLine,
    aggregateZipValues, upsertZipStats, replaceOwnerParcels, replaceParcelAges
  } = require('../lib/hcadZipValues');

  const firstNewline = buf.indexOf(NEWLINE);
  const headerLine = buf.subarray(0, firstNewline).toString('utf8');
  const headerIndex = buildRealAcctHeaderIndex(headerLine);
  if (headerIndex.site_addr_3 === undefined || headerIndex.tot_mkt_val === undefined) {
    throw new Error('real_acct.txt header did not contain expected columns (site_addr_3, tot_mkt_val) — HCAD may have changed their file layout. See README.md\'s "HCAD real home-value data" section.');
  }
  if (headerIndex.site_addr_1 === undefined || headerIndex.mailto === undefined) {
    throw new Error('real_acct.txt header did not contain expected columns (site_addr_1, mailto) — HCAD may have changed their file layout. See README.md\'s "HCAD real home-value data" section.');
  }

  if (HEADER_ONLY) {
    const allColumns = Object.keys(headerIndex);
    console.log(`\nreal_acct.txt has ${allColumns.length} columns:`);
    console.log(allColumns.join(', '));

    const yearBuiltCols = allColumns.filter(c => YEAR_BUILT_CANDIDATES.test(c));
    const deedDateCols = allColumns.filter(c => DEED_DATE_CANDIDATES.test(c));
    console.log(`\nYear-built candidate column(s): ${yearBuiltCols.length ? yearBuiltCols.join(', ') : 'NONE FOUND'}`);
    console.log(`Deed/sale-date candidate column(s): ${deedDateCols.length ? deedDateCols.join(', ') : 'NONE FOUND'}`);

    if (yearBuiltCols.length) {
      // Spot-check plausibility against a real sample (not the whole
      // 1.8M-line file) — a column matching the name pattern could still
      // be something else entirely (e.g. a permit-year field, or blank).
      const col = yearBuiltCols[0];
      const idx = headerIndex[col];
      const sampleValues = [];
      let lineStart = firstNewline + 1;
      let sampled = 0;
      while (lineStart < buf.length && sampled < 500) {
        let lineEnd = buf.indexOf(NEWLINE, lineStart);
        if (lineEnd === -1) lineEnd = buf.length;
        const line = buf.subarray(lineStart, lineEnd).toString('utf8');
        lineStart = lineEnd + 1;
        sampled++;
        const cells = line.split('\t');
        const raw = (cells[idx] || '').trim();
        if (raw) sampleValues.push(raw);
      }
      const numeric = sampleValues.map(v => parseInt(v, 10)).filter(n => Number.isFinite(n));
      const plausibleYears = numeric.filter(n => n >= 1900 && n <= new Date().getFullYear());
      console.log(`\nSpot-check of "${col}" across the first 500 lines:`);
      console.log(`  ${sampleValues.length} non-blank values, ${numeric.length} numeric, ${plausibleYears.length} in a plausible year range (1900-${new Date().getFullYear()}).`);
      console.log(`  Sample raw values: ${sampleValues.slice(0, 15).join(', ')}`);
      console.log(plausibleYears.length >= numeric.length * 0.8
        ? '  Looks plausible as a real year-built field.'
        : '  Does NOT look like a plausible year-built field — verify manually before building on it.');
    }

    console.log('\n--header-only: not parsing the full file or writing to the database.');
    return;
  }

  console.log('Parsing zip/value aggregates, confident owner names, and parcel ages (Houston-area zips only)...');
  const parsed = [];
  const ownerRows = [];
  const ageRows = [];
  let lineStart = firstNewline + 1;
  let totalLines = 0;
  // One pass over the file for all three parsers — a second or third
  // independent full scan of an ~800MB+ inflated buffer would meaningfully
  // slow an already multi-minute, ~1.8M-line import.
  while (lineStart < buf.length) {
    let lineEnd = buf.indexOf(NEWLINE, lineStart);
    if (lineEnd === -1) lineEnd = buf.length;
    const line = buf.subarray(lineStart, lineEnd).toString('utf8');
    lineStart = lineEnd + 1;
    totalLines++;
    const row = parseRealAcctLine(headerIndex, line);
    if (row && row.zip.startsWith(HOUSTON_ZIP_PREFIX)) parsed.push(row);
    const ownerRow = parseRealAcctOwnerLine(headerIndex, line);
    if (ownerRow && ownerRow.zip.startsWith(HOUSTON_ZIP_PREFIX)) ownerRows.push(ownerRow);
    const ageRow = parseRealAcctParcelAgeLine(headerIndex, line);
    if (ageRow && ageRow.zip.startsWith(HOUSTON_ZIP_PREFIX)) ageRows.push(ageRow);
  }
  console.log(`Scanned ${totalLines.toLocaleString()} accounts, kept ${parsed.length.toLocaleString()} with a usable Houston-area zip + market value.`);
  console.log(`Of those, ${ownerRows.length.toLocaleString()} parsed as a confident individual owner name (businesses, trusts, government owners, and HCAD's "CURRENT OWNER" placeholder are excluded).`);
  console.log(`Of those, ${ageRows.length.toLocaleString()} had a usable year-built value.`);

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
  console.log(`Writing ${ownerRows.length.toLocaleString()} rows to hcad_owner_parcels (replacing the previous import)...`);
  await replaceOwnerParcels(ownerRows, taxYear);
  console.log(`Writing ${ageRows.length.toLocaleString()} rows to hcad_parcel_ages (replacing the previous import)...`);
  await replaceParcelAges(ageRows, taxYear);
  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Import failed:', err.message);
    process.exit(1);
  });
