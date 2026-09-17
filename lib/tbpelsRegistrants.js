// Real Texas engineering and surveying firms, sourced from TBPELS's own
// public roster download — see migrations/..._tbpels_registrants.js for
// where this data comes from and why the FIRM roster specifically.
const { query } = require('../db');
const { readZipEntries } = require('./xlsxReader');
const { parseCsvObjects } = require('./csvReader');

const FIRM_ROSTER_URL = 'https://tbpedownloads.s3-us-west-2.amazonaws.com/roster_firm.zip';
const FIRM_CSV_ENTRY = 'firm_roster.csv';

const HOUSTON_METRO_CITIES = [
  'HOUSTON', 'SUGAR LAND', 'THE WOODLANDS', 'KATY', 'PEARLAND', 'SPRING', 'CYPRESS',
  'BELLAIRE', 'MISSOURI CITY', 'RICHMOND', 'CONROE', 'LEAGUE CITY', 'PASADENA',
  'BAYTOWN', 'FRIENDSWOOD', 'HUMBLE', 'KINGWOOD', 'TOMBALL', 'STAFFORD',
  'WEST UNIVERSITY PLACE', 'BUNKER HILL VILLAGE', 'PINEY POINT VILLAGE',
  'HUNTERS CREEK VILLAGE', 'JERSEY VILLAGE', 'WEBSTER', 'DEER PARK', 'ROSENBERG',
  'CHANNELVIEW', 'ALVIN'
];

// expire_date reads "7/31/2028" (no leading zeros); create_date reads
// "2000-05-12 00:00:00.000" — two genuinely different formats in the same
// real file, confirmed live, not a guess.
function parseSlashDate(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}
function parseIsoDateTime(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function parseRegistrantRow(raw) {
  return {
    firmNumber: (raw.Firm_num || '').trim(),
    firmName: (raw.firm_name || '').trim() || null,
    addressLine1: (raw.firm_address1 || '').trim() || null,
    addressLine2: (raw.firm_address2 || '').trim() || null,
    city: (raw.firm_city || '').trim() || null,
    state: (raw.firm_state || '').trim() || null,
    zip: (raw.firm_zip || '').trim() || null,
    phone: (raw.firm_phone || '').trim() || null,
    firmType: (raw.firm_type || '').trim() || null,
    expireDate: parseSlashDate(raw.expire_date),
    createDate: parseIsoDateTime(raw.create_date)
  };
}

// TBPELS's CSV is windows-1252 encoded, not UTF-8 — confirmed live (a
// plain UTF-8 decode throws on real bytes in the file, likely an en-dash
// in an address or firm name). Node's built-in TextDecoder handles it
// natively, no dependency needed.
async function fetchRoster({ log = () => {} } = {}) {
  log('Downloading TBPELS firm roster...');
  const r = await fetch(FIRM_ROSTER_URL, { headers: { 'User-Agent': 'EagleI (https://myeaglei.com, admin@myeaglei.com)' } });
  if (!r.ok) throw new Error(`TBPELS firm roster download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  log(`  Downloaded ${(buf.length / 1e3).toFixed(0)}KB.`);

  const entries = readZipEntries(buf, [FIRM_CSV_ENTRY]);
  if (!entries[FIRM_CSV_ENTRY]) throw new Error(`${FIRM_CSV_ENTRY} not found inside the TBPELS firm roster zip.`);
  const text = new TextDecoder('windows-1252').decode(entries[FIRM_CSV_ENTRY]);
  return parseCsvObjects(text).map(parseRegistrantRow).filter(r => r.firmNumber);
}

async function upsertRegistrants(rows) {
  const CHUNK = 1000;
  const COLS = 10;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * COLS;
      values.push(
        r.firmNumber, r.firmName, r.addressLine1, r.addressLine2, r.city,
        r.state, r.zip, r.phone, r.firmType, r.expireDate
      );
      const slots = Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`);
      return `(${slots.join(', ')})`;
    });
    await query(
      `INSERT INTO tbpels_registrants
         (firm_number, firm_name, address_line1, address_line2, city, state, zip, phone, firm_type, expire_date)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (firm_number) DO UPDATE SET
         firm_name = EXCLUDED.firm_name, address_line1 = EXCLUDED.address_line1,
         address_line2 = EXCLUDED.address_line2, city = EXCLUDED.city, state = EXCLUDED.state,
         zip = EXCLUDED.zip, phone = EXCLUDED.phone, firm_type = EXCLUDED.firm_type,
         expire_date = EXCLUDED.expire_date, imported_at = now()`,
      values
    );
  }
}

async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM tbpels_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function recordImportCompleted(totalCount) {
  await query('INSERT INTO tbpels_import_state (total_count) VALUES ($1)', [totalCount]);
}

async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  const rows = await fetchRoster({ log });
  const withExpiry = rows.filter(r => r.expireDate);
  const houstonMetro = rows.filter(r => HOUSTON_METRO_CITIES.includes((r.city || '').toUpperCase()));
  log(`Parsed ${rows.length.toLocaleString()} total firms, ${withExpiry.length.toLocaleString()} with an expiration date on file, ${houstonMetro.length.toLocaleString()} in the Houston metro area.`);

  if (dryRun) {
    log('--dry-run: not writing to the database.');
    return { total: rows.length };
  }
  log(`Upserting ${rows.length.toLocaleString()} rows into tbpels_registrants...`);
  await upsertRegistrants(rows);
  await recordImportCompleted(rows.length);
  return { total: rows.length };
}

// Houston-metro engineering/surveying firms with a currently-unexpired
// registration.
async function getHoustonAreaRegistrants({ search, limit = 40, offset = 0 }) {
  const conditions = [
    'firm_name IS NOT NULL', 'expire_date IS NOT NULL', 'expire_date >= CURRENT_DATE',
    'UPPER(city) = ANY($1)'
  ];
  const params = [HOUSTON_METRO_CITIES];
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`firm_name ILIKE $${params.length}`);
  }
  params.push(limit, offset);
  const r = await query(
    `SELECT id, firm_number, firm_name, city, phone, firm_type, expire_date,
            website, contact_email, places_formatted_address, contact_checked_at,
            COUNT(*) OVER() AS total_count
     FROM tbpels_registrants
     WHERE ${conditions.join(' AND ')}
     ORDER BY firm_name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = r.rows[0] ? Number(r.rows[0].total_count) : 0;
  return {
    total,
    registrants: r.rows.map(row => ({
      id: row.id,
      firmNumber: row.firm_number,
      displayName: row.firm_name,
      city: row.city,
      phone: formatPhone(row.phone),
      firmType: row.firm_type,
      expireDate: row.expire_date,
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
    `SELECT id, firm_number, firm_name, city, website, contact_email, places_formatted_address, contact_checked_at
     FROM tbpels_registrants WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function saveContactInfo(id, { website, contactEmail, placesFormattedAddress }) {
  await query(
    `UPDATE tbpels_registrants
     SET website = $1, contact_email = $2, places_formatted_address = $3, contact_checked_at = now()
     WHERE id = $4`,
    [website || null, contactEmail || null, placesFormattedAddress || null, id]
  );
}

module.exports = {
  HOUSTON_METRO_CITIES,
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
