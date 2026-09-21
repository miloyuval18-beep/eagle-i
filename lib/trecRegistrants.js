// Real Texas real estate brokers, sourced from TREC's public Socrata
// dataset — see migrations/..._trec_registrants.js for the data source
// and why it's scoped to Broker Company / Broker Individual only.
const { query } = require('../db');
const markets = require('./markets');

const TREC_DATASET_ID = 's7ft-44qi';
const TREC_BASE = `https://data.texas.gov/resource/${TREC_DATASET_ID}.json`;

const LICENSE_TYPES = ['Broker Company', 'Broker Individual'];

const HOUSTON_METRO_COUNTIES = [
  'HARRIS', 'FORT BEND', 'MONTGOMERY', 'BRAZORIA', 'GALVESTON', 'LIBERTY', 'WALLER', 'CHAMBERS', 'AUSTIN'
];

function parseTrecDate(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function parseRegistrantRow(raw) {
  return {
    licenseType: raw.license_type,
    licenseNumber: raw.license_number,
    fullName: (raw.full_name || '').trim() || null,
    status: (raw.status || '').trim() || null,
    originalLicenseDate: parseTrecDate(raw.original_license_date),
    expirationDate: parseTrecDate(raw.license_expiration_date),
    county: (raw.county || '').trim() || null
  };
}

// Server-side filtered fetch — TREC's dataset (324K+ total rows across
// all license types statewide) supports real SoQL filtering, same as
// TDLR, so there's no need to page through the whole thing.
async function fetchLicenseType(licenseType, { log = () => {} } = {}) {
  const PAGE_SIZE = 1000;
  const countyList = markets.union(HOUSTON_METRO_COUNTIES, 'counties').map(c => `'${c.replace(/'/g, "''")}'`).join(',');
  const where = `license_type='${licenseType.replace(/'/g, "''")}' AND status='Active' AND upper(county) IN(${countyList})`;
  const all = [];
  let offset = 0;
  for (;;) {
    const url = `${TREC_BASE}?$where=${encodeURIComponent(where)}&$limit=${PAGE_SIZE}&$offset=${offset}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'EagleI (https://myeaglei.com, admin@myeaglei.com)' } });
    if (!r.ok) throw new Error(`TREC request failed (${r.status})`);
    const page = await r.json();
    all.push(...page);
    log(`  ${licenseType}: ${all.length.toLocaleString()} rows so far...`);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all.map(parseRegistrantRow);
}

async function upsertRegistrants(rows) {
  const CHUNK = 1000;
  const COLS = 7;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * COLS;
      values.push(r.licenseType, r.licenseNumber, r.fullName, r.status, r.originalLicenseDate, r.expirationDate, r.county);
      const slots = Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`);
      return `(${slots.join(', ')})`;
    });
    await query(
      `INSERT INTO trec_registrants (license_type, license_number, full_name, status, original_license_date, expiration_date, county)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (license_type, license_number) DO UPDATE SET
         full_name = EXCLUDED.full_name, status = EXCLUDED.status,
         original_license_date = EXCLUDED.original_license_date, expiration_date = EXCLUDED.expiration_date,
         county = EXCLUDED.county, imported_at = now()`,
      values
    );
  }
}

async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM trec_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function recordImportCompleted(countsByType) {
  await query('INSERT INTO trec_import_state (counts_by_type) VALUES ($1)', [JSON.stringify(countsByType)]);
}

async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  const counts = {};
  for (const licenseType of LICENSE_TYPES) {
    log(`Fetching ${licenseType} (Houston metro, Active)...`);
    const rows = await fetchLicenseType(licenseType, { log });
    counts[licenseType] = rows.length;
    log(`  ${licenseType}: ${rows.length.toLocaleString()} total.`);
    if (dryRun) {
      log(`  --dry-run: not writing ${licenseType} to the database.`);
      continue;
    }
    log(`  Upserting ${rows.length.toLocaleString()} rows into trec_registrants...`);
    await upsertRegistrants(rows);
  }
  if (!dryRun) await recordImportCompleted(counts);
  return counts;
}

async function getHoustonAreaRegistrants({ licenseType, search, limit = 40, offset = 0 }) {
  const conditions = ['license_type = $1', "status = 'Active'", 'full_name IS NOT NULL', 'UPPER(county) = ANY($2)'];
  const params = [licenseType, HOUSTON_METRO_COUNTIES];
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`full_name ILIKE $${params.length}`);
  }
  params.push(limit, offset);
  const r = await query(
    `SELECT id, license_number, full_name, county, expiration_date, website, contact_email,
            places_formatted_address, contact_checked_at,
            COUNT(*) OVER() AS total_count
     FROM trec_registrants
     WHERE ${conditions.join(' AND ')}
     ORDER BY full_name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = r.rows[0] ? Number(r.rows[0].total_count) : 0;
  return {
    total,
    registrants: r.rows.map(row => ({
      id: row.id,
      licenseNumber: row.license_number,
      displayName: row.full_name,
      county: row.county,
      expirationDate: row.expiration_date,
      website: row.website,
      contactEmail: row.contact_email,
      placesFormattedAddress: row.places_formatted_address,
      contactCheckedAt: row.contact_checked_at
    }))
  };
}

async function getRegistrantById(id) {
  const r = await query(
    `SELECT id, license_type, full_name, county, website, contact_email, places_formatted_address, contact_checked_at
     FROM trec_registrants WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function saveContactInfo(id, { website, contactEmail, placesFormattedAddress }) {
  await query(
    `UPDATE trec_registrants
     SET website = $1, contact_email = $2, places_formatted_address = $3, contact_checked_at = now()
     WHERE id = $4`,
    [website || null, contactEmail || null, placesFormattedAddress || null, id]
  );
}

module.exports = {
  LICENSE_TYPES,
  HOUSTON_METRO_COUNTIES,
  parseRegistrantRow,
  fetchLicenseType,
  upsertRegistrants,
  runFullImport,
  getLastImportCompletedAt,
  recordImportCompleted,
  getHoustonAreaRegistrants,
  getRegistrantById,
  saveContactInfo
};
