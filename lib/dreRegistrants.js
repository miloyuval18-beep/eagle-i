// Real California real estate brokers and brokerages from the Department of
// Real Estate's public licensee list -- see
// migrations/1760200000000_california_license_sources.js for what it has and
// what it does not (no phone, no email).
//
// Only the "Broker" (an individual broker) and "Corporation" (a brokerage)
// licenses are kept: salespeople work under a broker, so the broker is the
// business to reach. The DRE's separate examinee list carries a legal limit on
// use (education marketing only); this file is the licensee list, which does not.
const { query } = require('../db');
const markets = require('./markets');
const { readZipEntries } = require('./xlsxReader');
const { parseCsvStream, bufferTextChunks } = require('./csvStream');

const LIST_URL = 'https://secure.dre.ca.gov/datafile/CurrList.zip';
const ENTRY = 'CurrList.csv';
const UA = 'EagleI (https://myeaglei.com, admin@myeaglei.com)';
const LICENSE_TYPES = ['Broker', 'Corporation'];

const clean = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };
// The file writes dates as YYYYMMDD.
function parseDate(str) {
  const m = String(str || '').trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  return m && m[2] !== '00' && m[3] !== '00' ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

// A record -> a table row. An individual broker is stored as "First Last" (the
// file has last name and first name in separate columns, often in the wrong
// case); a brokerage keeps its registered name.
function parseRecord(rec) {
  const type = clean(rec.lic_type);
  if (!LICENSE_TYPES.includes(type)) return null;
  const licNumber = clean(rec.lic_number);
  const last = clean(rec.lastname_primary);
  if (!licNumber || !last) return null;
  const firstNames = clean(rec.firstname_secondary);
  const suffix = clean(rec.name_suffix);
  const isPerson = type === 'Broker';
  const name = isPerson ? [titleCase(firstNames), titleCase(last), suffix].filter(Boolean).join(' ') : last;
  const officer = !isPerson && clean(rec.related_lastname_primary)
    ? [titleCase(clean(rec.related_firstname_secondary)), titleCase(clean(rec.related_lastname_primary)), clean(rec.related_name_suffix)].filter(Boolean).join(' ')
    : null;
  return {
    licNumber, licenseType: type, name,
    firstName: isPerson && firstNames ? titleCase(firstNames.split(/\s+/)[0]) : null,
    officerName: officer,
    status: clean(rec.lic_status),
    restricted: clean(rec.restricted_flag) === 'Y',
    originalDate: parseDate(rec.original_date_of_license),
    expirationDate: parseDate(rec.lic_expiration_date),
    city: clean(rec.city), county: clean(rec.county_name), zip: clean(rec.zip_code) && String(rec.zip_code).trim().slice(0, 10)
  };
}

async function streamLicensees({ counties, onRecord, log = () => {} }) {
  log('Downloading the DRE licensee list (about 20MB zipped)...');
  const r = await fetch(LIST_URL, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`DRE licensee list download failed: ${r.status}`);
  const zip = Buffer.from(await r.arrayBuffer());
  const csv = readZipEntries(zip, [ENTRY])[ENTRY];
  if (!csv) throw new Error(`DRE zip has no ${ENTRY}.`);
  const want = new Set(counties.map(c => c.toUpperCase()));
  let header = null, countyIdx = -1, seen = 0, kept = 0;
  // The file is windows-1252 (names like "Muñoz" arrive as single bytes).
  await parseCsvStream(bufferTextChunks(csv, 'windows-1252'), (fields, n) => {
    if (n === 0) { header = fields.map(h => h.trim()); countyIdx = header.indexOf('county_name'); if (countyIdx < 0) throw new Error('DRE file has no county_name column.'); return; }
    seen++;
    if (!want.has((fields[countyIdx] || '').trim().toUpperCase())) return;
    const rec = {};
    header.forEach((h, i) => { rec[h] = fields[i] !== undefined ? fields[i] : ''; });
    kept++;
    onRecord(rec);
  });
  log(`  ${seen.toLocaleString()} licenses in the file, ${kept.toLocaleString()} in the markets we serve.`);
  return { seen, kept };
}

async function upsertRegistrants(rows) {
  const CHUNK = 500;
  const COLS = 13;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * COLS;
      values.push(r.licNumber, r.licenseType, r.name, r.firstName, r.officerName, r.status, r.restricted, r.originalDate,
        r.expirationDate, r.city, r.county, r.zip, true);
      return `(${Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`).join(', ')})`;
    });
    await query(
      `INSERT INTO dre_registrants
         (lic_number, license_type, name, first_name, officer_name, status, restricted, original_date,
          expiration_date, city, county, zip, active)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (lic_number) DO UPDATE SET
         license_type = EXCLUDED.license_type, name = EXCLUDED.name, first_name = EXCLUDED.first_name,
         officer_name = EXCLUDED.officer_name, status = EXCLUDED.status, restricted = EXCLUDED.restricted,
         original_date = EXCLUDED.original_date, expiration_date = EXCLUDED.expiration_date, city = EXCLUDED.city,
         county = EXCLUDED.county, zip = EXCLUDED.zip, active = true, imported_at = now()`,
      values
    );
  }
}

async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM dre_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  const startedAt = (await query('SELECT now() AS t')).rows[0].t;
  const counties = markets.countiesInState('CA');
  const byLicense = new Map();
  const { seen } = await streamLicensees({
    counties, log,
    onRecord: (rec) => { const row = parseRecord(rec); if (row) byLicense.set(row.licNumber, row); }
  });
  const rows = [...byLicense.values()];
  const licensed = rows.filter(r => r.status === 'Licensed').length;
  log(`Parsed ${rows.length.toLocaleString()} broker and brokerage licenses (${licensed.toLocaleString()} currently licensed) for ${counties.join(', ')} counties.`);
  if (dryRun) { log('--dry-run: not writing to the database.'); return { total: rows.length, licensed, seen }; }

  await upsertRegistrants(rows);
  const gone = await query('UPDATE dre_registrants SET active = false WHERE active = true AND imported_at < $1', [startedAt]);
  log(`Flagged ${gone.rowCount} licenses no longer listed.`);
  await query('INSERT INTO dre_import_state (total_count) VALUES ($1)', [rows.length]);
  return { total: rows.length, licensed, seen, deactivated: gone.rowCount };
}

module.exports = { LICENSE_TYPES, parseRecord, parseDate, streamLicensees, upsertRegistrants, getLastImportCompletedAt, runFullImport };
