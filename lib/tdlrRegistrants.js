// Real electricians and HVAC (A/C) contractors, sourced from TDLR's
// public Socrata dataset — see migrations/..._tdlr_registrants.js for
// where this data comes from and why.
const { query } = require('../db');

const TDLR_DATASET_ID = '7358-krk7';
const TDLR_BASE = `https://data.texas.gov/resource/${TDLR_DATASET_ID}.json`;

// The two license types actually worth reaching as referral partners for
// a construction business — real contracting businesses, not individual
// technician/apprentice credentials (which are usually employees, not
// businesses of their own). Texas has no state license for plumbers
// (a separate board, TSBPE, not TDLR), general contractors, or roofers —
// confirmed during research, not assumed — so those categories simply
// aren't buildable this way.
const LICENSE_TYPES = ['Electrical Contractor', 'A/C Contractor'];

// The Houston-metro counties (the 9-county Houston-The Woodlands-Sugar
// Land MSA) — TDLR's data has county, not city, as its geographic field.
const HOUSTON_METRO_COUNTIES = [
  'HARRIS', 'FORT BEND', 'MONTGOMERY', 'BRAZORIA', 'GALVESTON', 'LIBERTY', 'WALLER', 'CHAMBERS', 'AUSTIN'
];

// "HOUSTON TX 77092-8003" -> {city, state, zip}. Some rows omit this
// field entirely (an individual license with no business address on
// file) — returns nulls rather than guessing.
function parseCityStateZip(str) {
  if (!str) return { city: null, state: null, zip: null };
  const m = String(str).trim().match(/^(.*?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!m) return { city: str.trim() || null, state: null, zip: null };
  return { city: m[1].trim(), state: m[2], zip: m[3] };
}

// TDLR dates read like "12/22/2026" (MM/DD/YYYY).
function parseTdlrDate(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function parseRegistrantRow(raw) {
  const { city, state, zip } = parseCityStateZip(raw.business_city_state_zip);
  return {
    licenseType: raw.license_type,
    licenseNumber: raw.license_number,
    businessName: (raw.business_name || '').trim() || null,
    ownerName: (raw.owner_name || '').trim() || null,
    businessAddressLine1: (raw.business_address_line1 || '').trim() || null,
    businessCity: city,
    businessState: state,
    businessZip: zip,
    businessCounty: (raw.business_county || '').trim() || null,
    businessPhone: (raw.business_telephone || '').trim() || null,
    licenseExpirationDate: parseTdlrDate(raw.license_expiration_date_mmddccyy)
  };
}

// Pages through Socrata's API for one license type, restricted server-side
// to the Houston-metro counties — unlike TBAE's flat-file roster, TDLR's
// dataset supports real filtering, so there's no need to download the
// full ~983k-row statewide file just to keep ~7,500 relevant rows.
async function fetchLicenseType(licenseType, { log = () => {} } = {}) {
  const PAGE_SIZE = 1000;
  const countyList = HOUSTON_METRO_COUNTIES.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
  const where = `license_type='${licenseType.replace(/'/g, "''")}' AND business_county IN(${countyList})`;
  const all = [];
  let offset = 0;
  for (;;) {
    const url = `${TDLR_BASE}?$where=${encodeURIComponent(where)}&$limit=${PAGE_SIZE}&$offset=${offset}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'EagleI (https://myeaglei.com, admin@myeaglei.com)' } });
    if (!r.ok) throw new Error(`TDLR request failed (${r.status})`);
    const page = await r.json();
    all.push(...page);
    log(`  ${licenseType}: ${all.length.toLocaleString()} rows so far...`);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all.map(parseRegistrantRow);
}

// Upsert on (license_type, license_number) — same reasoning as TBAE's
// upsert-by-reg_no: a monthly re-import must not wipe already-collected
// website/contact_email data (see lib/tbaeRegistrants.js's identical
// pattern for the fuller explanation).
async function upsertRegistrants(rows) {
  const CHUNK = 1000;
  const COLS = 11; // total columns inserted per row, including license_expiration_date
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * COLS;
      values.push(
        r.licenseType, r.licenseNumber, r.businessName, r.ownerName, r.businessAddressLine1,
        r.businessCity, r.businessState, r.businessZip, r.businessCounty, r.businessPhone,
        r.licenseExpirationDate
      );
      const slots = Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`);
      return `(${slots.join(', ')})`;
    });
    await query(
      `INSERT INTO tdlr_registrants
         (license_type, license_number, business_name, owner_name, business_address_line1,
          business_city, business_state, business_zip, business_county, business_phone, license_expiration_date)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (license_type, license_number) DO UPDATE SET
         business_name = EXCLUDED.business_name, owner_name = EXCLUDED.owner_name,
         business_address_line1 = EXCLUDED.business_address_line1, business_city = EXCLUDED.business_city,
         business_state = EXCLUDED.business_state, business_zip = EXCLUDED.business_zip,
         business_county = EXCLUDED.business_county, business_phone = EXCLUDED.business_phone,
         license_expiration_date = EXCLUDED.license_expiration_date, imported_at = now()`,
      values
    );
  }
}

async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM tdlr_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function recordImportCompleted(countsByType) {
  await query('INSERT INTO tdlr_import_state (counts_by_type) VALUES ($1)', [JSON.stringify(countsByType)]);
}

// Shared orchestration for both the manual CLI and the monthly worker —
// same shape as lib/tbaeRegistrants.js's runFullImport.
async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  const counts = {};
  for (const licenseType of LICENSE_TYPES) {
    log(`Fetching ${licenseType} (Houston metro)...`);
    const rows = await fetchLicenseType(licenseType, { log });
    counts[licenseType] = rows.length;
    const withBusinessName = rows.filter(r => r.businessName).length;
    log(`  ${licenseType}: ${rows.length.toLocaleString()} total, ${withBusinessName.toLocaleString()} with a business name on file.`);
    if (dryRun) {
      log(`  --dry-run: not writing ${licenseType} to the database.`);
      continue;
    }
    log(`  Upserting ${rows.length.toLocaleString()} rows into tdlr_registrants...`);
    await upsertRegistrants(rows);
  }
  if (!dryRun) await recordImportCompleted(counts);
  return counts;
}

// Houston-metro registrants for one license type, with a real business
// name and a currently-unexpired license. Paginated: callers pass
// limit/offset, get a total back for a "Load more" UI.
async function getHoustonAreaRegistrants({ licenseType, search, limit = 40, offset = 0 }) {
  const conditions = [
    'license_type = $1', 'business_name IS NOT NULL',
    'license_expiration_date IS NOT NULL', 'license_expiration_date >= CURRENT_DATE',
    'UPPER(business_county) = ANY($2)'
  ];
  const params = [licenseType, HOUSTON_METRO_COUNTIES];
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(business_name ILIKE $${params.length} OR owner_name ILIKE $${params.length})`);
  }
  params.push(limit, offset);
  const r = await query(
    `SELECT id, license_number, business_name, owner_name, business_city, business_county, business_phone,
            license_expiration_date, website, contact_email, places_formatted_address, contact_checked_at,
            COUNT(*) OVER() AS total_count
     FROM tdlr_registrants
     WHERE ${conditions.join(' AND ')}
     ORDER BY business_name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = r.rows[0] ? Number(r.rows[0].total_count) : 0;
  return {
    total,
    registrants: r.rows.map(row => ({
      id: row.id,
      licenseNumber: row.license_number,
      displayName: row.business_name || row.owner_name,
      ownerName: row.owner_name,
      city: row.business_city,
      county: row.business_county,
      phone: formatPhone(row.business_phone),
      licenseExpirationDate: row.license_expiration_date,
      website: row.website,
      contactEmail: row.contact_email,
      placesFormattedAddress: row.places_formatted_address,
      contactCheckedAt: row.contact_checked_at
    }))
  };
}

// TDLR stores raw 10-digit strings ("7136800011") — formatted for
// display/dialing the same way a phone number from Places would read.
function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 10) return raw;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

async function getRegistrantById(id) {
  const r = await query(
    `SELECT id, license_type, license_number, business_name, owner_name, business_city, business_county,
            business_phone, website, contact_email, places_formatted_address, contact_checked_at
     FROM tdlr_registrants WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function saveContactInfo(id, { website, contactEmail, placesFormattedAddress }) {
  await query(
    `UPDATE tdlr_registrants
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
  saveContactInfo,
  formatPhone
};
