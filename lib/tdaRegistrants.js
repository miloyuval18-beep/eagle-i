// Real Texas structural pest control (termite/pest) businesses, sourced
// from TDA's own public CSV export — see migrations/..._tda_registrants.js
// for the data source and why it's the "Commercial Business" file
// specifically.
const { query } = require('../db');
const { parseCsvObjects } = require('./csvReader');

const PEST_CSV_URL = 'https://texasagriculture.gov/Portals/0/Reports/PIR/spcs_commercial_business.csv';

const HOUSTON_METRO_COUNTIES = [
  'HARRIS', 'FORT BEND', 'MONTGOMERY', 'BRAZORIA', 'GALVESTON', 'LIBERTY', 'WALLER', 'CHAMBERS', 'AUSTIN'
];

function parseTdaDate(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function parseRegistrantRow(raw) {
  return {
    tpcl: (raw.TPCL || '').trim(),
    accountType: (raw.ACCOUNT_TYPE || '').trim() || null,
    categories: (raw.CATEGORIES || '').trim() || null,
    legalBusinessName: (raw.LEGAL_BUSINESS_NAME || '').trim() || null,
    dba: (raw.DBA || '').trim() || null,
    county: (raw.COUNTY || '').trim() || null,
    operator: (raw.OPERATOR || '').trim() || null,
    insuranceExpiredDate: parseTdaDate(raw.INSURANCE_EXPIRED),
    licenseExpiredDate: parseTdaDate(raw.LICENSE_EXPIRED),
    licenseIssuedDate: parseTdaDate(raw.LICENSE_ISSUED),
    licenseRenewedDate: parseTdaDate(raw.LICENSE_RENEWED),
    responsibleApplicator: (raw.RESPONSIBLE_APPLICATOR || '').trim() || null,
    responsibleApplicatorLicense: (raw.RESPONSIBLE_APPLICATOR_LICENSE || '').trim() || null
  };
}

// TDA's CSV is windows-1252 encoded like TBPELS's — confirmed live.
async function fetchRoster({ log = () => {} } = {}) {
  log('Downloading TDA structural pest control (commercial business) list...');
  const r = await fetch(PEST_CSV_URL, { headers: { 'User-Agent': 'EagleI (https://myeaglei.com, admin@myeaglei.com)' } });
  if (!r.ok) throw new Error(`TDA pest control CSV download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  log(`  Downloaded ${(buf.length / 1e3).toFixed(0)}KB.`);
  const text = new TextDecoder('windows-1252').decode(buf);
  const rows = parseCsvObjects(text).map(parseRegistrantRow).filter(r => r.tpcl);
  // TDA's own export contains a handful of exact-duplicate rows (same
  // TPCL twice) — confirmed live, not a parsing artifact. ON CONFLICT
  // DO UPDATE can't touch the same row twice within one INSERT, so
  // dedupe by tpcl here (last one wins, harmless since the duplicates
  // observed were byte-identical).
  const byTpcl = new Map();
  for (const r of rows) byTpcl.set(r.tpcl, r);
  return [...byTpcl.values()];
}

async function upsertRegistrants(rows) {
  const CHUNK = 1000;
  const COLS = 12;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * COLS;
      values.push(
        r.tpcl, r.accountType, r.categories, r.legalBusinessName, r.dba, r.county, r.operator,
        r.insuranceExpiredDate, r.licenseExpiredDate, r.licenseIssuedDate, r.licenseRenewedDate,
        r.responsibleApplicator
      );
      const slots = Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`);
      return `(${slots.join(', ')})`;
    });
    await query(
      `INSERT INTO tda_registrants
         (tpcl, account_type, categories, legal_business_name, dba, county, operator,
          insurance_expired_date, license_expired_date, license_issued_date, license_renewed_date,
          responsible_applicator)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (tpcl) DO UPDATE SET
         account_type = EXCLUDED.account_type, categories = EXCLUDED.categories,
         legal_business_name = EXCLUDED.legal_business_name, dba = EXCLUDED.dba, county = EXCLUDED.county,
         operator = EXCLUDED.operator, insurance_expired_date = EXCLUDED.insurance_expired_date,
         license_expired_date = EXCLUDED.license_expired_date, license_issued_date = EXCLUDED.license_issued_date,
         license_renewed_date = EXCLUDED.license_renewed_date, responsible_applicator = EXCLUDED.responsible_applicator,
         imported_at = now()`,
      values
    );
  }
}

async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM tda_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function recordImportCompleted(totalCount) {
  await query('INSERT INTO tda_import_state (total_count) VALUES ($1)', [totalCount]);
}

async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  const rows = await fetchRoster({ log });
  const houstonMetro = rows.filter(r => HOUSTON_METRO_COUNTIES.includes((r.county || '').toUpperCase()));
  log(`Parsed ${rows.length.toLocaleString()} total commercial pest control businesses, ${houstonMetro.length.toLocaleString()} in the Houston metro area.`);

  if (dryRun) {
    log('--dry-run: not writing to the database.');
    return { total: rows.length };
  }
  log(`Upserting ${rows.length.toLocaleString()} rows into tda_registrants...`);
  await upsertRegistrants(rows);
  await recordImportCompleted(rows.length);
  return { total: rows.length };
}

async function getHoustonAreaRegistrants({ search, limit = 40, offset = 0 }) {
  const conditions = [
    'legal_business_name IS NOT NULL', 'license_expired_date IS NOT NULL',
    'license_expired_date >= CURRENT_DATE', 'UPPER(county) = ANY($1)'
  ];
  const params = [HOUSTON_METRO_COUNTIES];
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(legal_business_name ILIKE $${params.length} OR dba ILIKE $${params.length})`);
  }
  params.push(limit, offset);
  const r = await query(
    `SELECT id, legal_business_name, dba, county, license_expired_date, insurance_expired_date,
            phone, website, contact_email, places_formatted_address, contact_checked_at,
            COUNT(*) OVER() AS total_count
     FROM tda_registrants
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(dba, legal_business_name) ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = r.rows[0] ? Number(r.rows[0].total_count) : 0;
  const today = new Date().toISOString().slice(0, 10);
  return {
    total,
    registrants: r.rows.map(row => ({
      id: row.id,
      displayName: row.dba || row.legal_business_name,
      county: row.county,
      licenseExpiredDate: row.license_expired_date,
      currentlyInsured: !!(row.insurance_expired_date && row.insurance_expired_date.toISOString().slice(0, 10) >= today),
      phone: formatPhone(row.phone),
      website: row.website,
      contactEmail: row.contact_email,
      placesFormattedAddress: row.places_formatted_address,
      contactCheckedAt: row.contact_checked_at
    }))
  };
}

function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 10) return raw;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

async function getRegistrantById(id) {
  const r = await query(
    `SELECT id, legal_business_name, dba, county, website, contact_email, places_formatted_address, contact_checked_at
     FROM tda_registrants WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function saveContactInfo(id, { website, phone, contactEmail, placesFormattedAddress }) {
  await query(
    `UPDATE tda_registrants
     SET website = $1, phone = $2, contact_email = $3, places_formatted_address = $4, contact_checked_at = now()
     WHERE id = $5`,
    [website || null, phone || null, contactEmail || null, placesFormattedAddress || null, id]
  );
}

module.exports = {
  HOUSTON_METRO_COUNTIES,
  parseRegistrantRow,
  fetchRoster,
  upsertRegistrants,
  runFullImport,
  getLastImportCompletedAt,
  recordImportCompleted,
  getHoustonAreaRegistrants,
  getRegistrantById,
  saveContactInfo,
  formatPhone
};
