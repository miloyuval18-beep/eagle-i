// Real Responsible Master Plumbers, sourced from TSBPE's own free,
// real-time CSV licensee list — see migrations/..._tsbpe_registrants.js
// for where this data comes from and why RMP specifically.
const { query } = require('../db');
const { parseCsvObjects } = require('./csvReader');

// TSBPE's download endpoint sits behind a check that a plain User-Agent
// alone doesn't satisfy — confirmed live: fetching it directly 403s, but
// first loading the page it's linked from (to pick up a session cookie)
// and sending that page as the Referer on the CSV request succeeds.
const LIST_PAGE_URL = 'https://tsbpe.texas.gov/free-licensee-list/';
const RMP_CSV_URL = 'https://tsbpe.texas.gov/download-csv/RMP/';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HOUSTON_METRO_COUNTIES = [
  'HARRIS', 'FORT BEND', 'MONTGOMERY', 'BRAZORIA', 'GALVESTON', 'LIBERTY', 'WALLER', 'CHAMBERS', 'AUSTIN'
];

function parseTsbpeDate(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function parseRegistrantRow(raw) {
  return {
    licenseNumber: (raw.LICENSE_NBR || '').trim(),
    licStatus: (raw.LIC_STATUS || '').trim() || null,
    licenseDate: parseTsbpeDate(raw.LICENSE_DATE),
    expirationDate: parseTsbpeDate(raw.EXPIRATION_DTE),
    lastName: (raw.LAST_NAME || '').trim() || null,
    firstName: (raw.FIRST_NAME || '').trim() || null,
    middleName: (raw.MIDDLE_NAME || '').trim() || null,
    addressLine1: (raw.ADDR1 || '').trim() || null,
    city: (raw.CITY || '').trim() || null,
    state: (raw.STATE || '').trim() || null,
    zip: (raw.ZIP || '').trim() || null,
    phone: (raw.PHONE || '').trim() || null,
    county: (raw.COUNTY || '').trim() || null,
    plumbCompany: (raw.PLUMB_COMPANY || '').trim() || null,
    insuranceCompany: (raw.INSURANCE_COMPANY || '').trim() || null,
    insuranceExpiryDate: parseTsbpeDate(raw.INS_EXPIRY_DTE)
  };
}

async function fetchRoster({ log = () => {} } = {}) {
  log('Fetching TSBPE licensee-list page (for a session cookie)...');
  const pageResp = await fetch(LIST_PAGE_URL, { headers: { 'User-Agent': USER_AGENT } });
  const cookie = (pageResp.headers.get('set-cookie') || '').split(';')[0];

  log('Downloading Responsible Master Plumber CSV...');
  const csvResp = await fetch(RMP_CSV_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': LIST_PAGE_URL,
      ...(cookie ? { Cookie: cookie } : {})
    }
  });
  if (!csvResp.ok) throw new Error(`TSBPE RMP CSV download failed: ${csvResp.status}`);
  const text = await csvResp.text();
  if (!text.trim().startsWith('"')) throw new Error('TSBPE response did not look like the expected CSV (site may have changed its access check).');
  log(`  Downloaded ${(text.length / 1e3).toFixed(0)}KB.`);
  return parseCsvObjects(text).map(parseRegistrantRow);
}

async function upsertRegistrants(rows) {
  const CHUNK = 1000;
  const COLS = 16;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * COLS;
      values.push(
        r.licenseNumber, r.licStatus, r.licenseDate, r.expirationDate, r.lastName, r.firstName,
        r.middleName, r.addressLine1, r.city, r.state, r.zip, r.phone, r.county,
        r.plumbCompany, r.insuranceCompany, r.insuranceExpiryDate
      );
      const slots = Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`);
      return `(${slots.join(', ')})`;
    });
    await query(
      `INSERT INTO tsbpe_registrants
         (license_number, lic_status, license_date, expiration_date, last_name, first_name,
          middle_name, address_line1, city, state, zip, phone, county, plumb_company,
          insurance_company, insurance_expiry_date)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (license_number) DO UPDATE SET
         lic_status = EXCLUDED.lic_status, license_date = EXCLUDED.license_date,
         expiration_date = EXCLUDED.expiration_date, last_name = EXCLUDED.last_name,
         first_name = EXCLUDED.first_name, middle_name = EXCLUDED.middle_name,
         address_line1 = EXCLUDED.address_line1, city = EXCLUDED.city, state = EXCLUDED.state,
         zip = EXCLUDED.zip, phone = EXCLUDED.phone, county = EXCLUDED.county,
         plumb_company = EXCLUDED.plumb_company, insurance_company = EXCLUDED.insurance_company,
         insurance_expiry_date = EXCLUDED.insurance_expiry_date, imported_at = now()`,
      values
    );
  }
}

async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM tsbpe_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function recordImportCompleted(totalCount) {
  await query('INSERT INTO tsbpe_import_state (total_count) VALUES ($1)', [totalCount]);
}

async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  const rows = await fetchRoster({ log });
  const current = rows.filter(r => r.licStatus === 'Current');
  const houstonMetro = current.filter(r => HOUSTON_METRO_COUNTIES.includes((r.county || '').toUpperCase()));
  log(`Parsed ${rows.length.toLocaleString()} total, ${current.length.toLocaleString()} currently licensed, ${houstonMetro.length.toLocaleString()} in the Houston metro area.`);

  if (dryRun) {
    log('--dry-run: not writing to the database.');
    return { total: rows.length };
  }
  log(`Upserting ${rows.length.toLocaleString()} rows into tsbpe_registrants...`);
  await upsertRegistrants(rows);
  await recordImportCompleted(rows.length);
  return { total: rows.length };
}

// Houston-metro, currently-licensed Responsible Master Plumbers — unlike
// TBAE, a blank plumb_company is still shown (using the person's own
// name), since a sole-proprietor RMP with no separate registered company
// name is still a real, contactable individual, not a dead end the way a
// TBAE row with no published firm at all is.
async function getHoustonAreaRegistrants({ search, limit = 40, offset = 0 }) {
  const conditions = [
    "lic_status = 'Current'", 'UPPER(county) = ANY($1)'
  ];
  const params = [HOUSTON_METRO_COUNTIES];
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(plumb_company ILIKE $${params.length} OR last_name ILIKE $${params.length} OR first_name ILIKE $${params.length})`);
  }
  params.push(limit, offset);
  const r = await query(
    `SELECT id, license_number, first_name, last_name, middle_name, plumb_company, city, county, phone,
            expiration_date, insurance_company, insurance_expiry_date, website, contact_email,
            places_formatted_address, contact_checked_at,
            COUNT(*) OVER() AS total_count
     FROM tsbpe_registrants
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(plumb_company, last_name) ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = r.rows[0] ? Number(r.rows[0].total_count) : 0;
  const today = new Date().toISOString().slice(0, 10);
  return {
    total,
    registrants: r.rows.map(row => ({
      id: row.id,
      licenseNumber: row.license_number,
      displayName: row.plumb_company || [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' '),
      ownerName: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' '),
      city: row.city,
      county: row.county,
      phone: formatPhone(row.phone),
      expirationDate: row.expiration_date,
      insuranceCompany: row.insurance_company,
      currentlyInsured: !!(row.insurance_expiry_date && row.insurance_expiry_date.toISOString().slice(0, 10) >= today),
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
    `SELECT id, license_number, plumb_company, first_name, last_name, city, county, phone,
            website, contact_email, places_formatted_address, contact_checked_at
     FROM tsbpe_registrants WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function saveContactInfo(id, { website, contactEmail, placesFormattedAddress }) {
  await query(
    `UPDATE tsbpe_registrants
     SET website = $1, contact_email = $2, places_formatted_address = $3, contact_checked_at = now()
     WHERE id = $4`,
    [website || null, contactEmail || null, placesFormattedAddress || null, id]
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
