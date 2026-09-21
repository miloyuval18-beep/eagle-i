// Real Texas escrow officers (title company professionals), sourced from
// TDI's public Socrata dataset — see migrations/..._tdi_registrants.js
// for the data source and its honest limitations (no business name, no
// phone — see that migration's comment).
const { query } = require('../db');
const markets = require('./markets');

const TDI_DATASET_ID = 'kxv3-diwf';
const TDI_BASE = `https://data.texas.gov/resource/${TDI_DATASET_ID}.json`;

const LICENSE_TYPES = ['Escrow Officer'];

const HOUSTON_METRO_CITIES = [
  'HOUSTON', 'SUGAR LAND', 'THE WOODLANDS', 'KATY', 'PEARLAND', 'SPRING', 'CYPRESS',
  'BELLAIRE', 'MISSOURI CITY', 'RICHMOND', 'CONROE', 'LEAGUE CITY', 'PASADENA',
  'BAYTOWN', 'FRIENDSWOOD', 'HUMBLE', 'KINGWOOD', 'TOMBALL', 'STAFFORD',
  'WEST UNIVERSITY PLACE', 'JERSEY VILLAGE', 'WEBSTER', 'DEER PARK', 'ROSENBERG',
  'CHANNELVIEW', 'ALVIN'
];

function parseRegistrantRow(raw) {
  return {
    licenseType: raw.license_type,
    licenseNumber: raw.license_number,
    name: (raw.name || '').trim() || null,
    city: (raw.city || '').trim() || null,
    state: (raw.state || '').trim() || null,
    postalCode: (raw.pstl_cd || '').trim() || null,
    expirationDate: raw.expiration_date ? raw.expiration_date.slice(0, 10) : null
  };
}

async function fetchLicenseType(licenseType, { log = () => {} } = {}) {
  const PAGE_SIZE = 1000;
  const cityList = markets.union(HOUSTON_METRO_CITIES, 'cities').map(c => `'${c.replace(/'/g, "''")}'`).join(',');
  const where = `license_type='${licenseType.replace(/'/g, "''")}' AND state='TX' AND upper(city) IN(${cityList})`;
  const all = [];
  let offset = 0;
  for (;;) {
    const url = `${TDI_BASE}?$where=${encodeURIComponent(where)}&$limit=${PAGE_SIZE}&$offset=${offset}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'EagleI (https://myeaglei.com, admin@myeaglei.com)' } });
    if (!r.ok) throw new Error(`TDI request failed (${r.status})`);
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
  const COLS = 6;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * COLS;
      values.push(r.licenseType, r.licenseNumber, r.name, r.city, r.state, r.expirationDate);
      const slots = Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`);
      return `(${slots.join(', ')})`;
    });
    await query(
      `INSERT INTO tdi_registrants (license_type, license_number, name, city, state, expiration_date)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (license_type, license_number) DO UPDATE SET
         name = EXCLUDED.name, city = EXCLUDED.city, state = EXCLUDED.state,
         expiration_date = EXCLUDED.expiration_date, imported_at = now()`,
      values
    );
  }
}

async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM tdi_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function recordImportCompleted(totalCount) {
  await query('INSERT INTO tdi_import_state (total_count) VALUES ($1)', [totalCount]);
}

async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  let total = 0;
  for (const licenseType of LICENSE_TYPES) {
    log(`Fetching ${licenseType} (Houston metro, TX)...`);
    const rows = await fetchLicenseType(licenseType, { log });
    total += rows.length;
    log(`  ${licenseType}: ${rows.length.toLocaleString()} total.`);
    if (dryRun) {
      log(`  --dry-run: not writing ${licenseType} to the database.`);
      continue;
    }
    log(`  Upserting ${rows.length.toLocaleString()} rows into tdi_registrants...`);
    await upsertRegistrants(rows);
  }
  if (!dryRun) await recordImportCompleted(total);
  return { total };
}

async function getHoustonAreaRegistrants({ search, limit = 40, offset = 0 }) {
  const conditions = ["license_type = 'Escrow Officer'", 'name IS NOT NULL', 'expiration_date >= CURRENT_DATE', 'UPPER(city) = ANY($1)'];
  const params = [HOUSTON_METRO_CITIES];
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`name ILIKE $${params.length}`);
  }
  params.push(limit, offset);
  const r = await query(
    `SELECT id, license_number, name, city, expiration_date, website, contact_email,
            places_formatted_address, contact_checked_at,
            COUNT(*) OVER() AS total_count
     FROM tdi_registrants
     WHERE ${conditions.join(' AND ')}
     ORDER BY name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = r.rows[0] ? Number(r.rows[0].total_count) : 0;
  return {
    total,
    registrants: r.rows.map(row => ({
      id: row.id,
      licenseNumber: row.license_number,
      displayName: row.name,
      city: row.city,
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
    `SELECT id, name, city, website, contact_email, places_formatted_address, contact_checked_at
     FROM tdi_registrants WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function saveContactInfo(id, { website, contactEmail, placesFormattedAddress }) {
  await query(
    `UPDATE tdi_registrants
     SET website = $1, contact_email = $2, places_formatted_address = $3, contact_checked_at = now()
     WHERE id = $4`,
    [website || null, contactEmail || null, placesFormattedAddress || null, id]
  );
}

module.exports = {
  LICENSE_TYPES,
  HOUSTON_METRO_CITIES,
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
