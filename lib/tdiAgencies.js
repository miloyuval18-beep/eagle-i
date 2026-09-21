// Real Texas insurance agencies, sourced from TDI's public Socrata
// dataset — see migrations/..._tdi_agencies.js for the data source, why
// it's scoped to these agency types, and the duplicate-row quirk.
const { query } = require('../db');
const markets = require('./markets');

const TDI_AGENCY_DATASET_ID = '3yqc-fcdt';
const TDI_AGENCY_BASE = `https://data.texas.gov/resource/${TDI_AGENCY_DATASET_ID}.json`;

// Buttons in the UI map to these groups (a group can span several TDI
// license types — the small ones are pooled so the panel isn't a wall of
// tiny buttons).
const GROUPS = {
  general: { label: 'General Lines & Personal Lines Agencies', types: ['General Lines Agency', 'Pers Lines Prop and Cas Agency'] },
  specialty: { label: 'Specialty, Surplus Lines & MGAs', types: ['Specialty Insurance Agency', 'Surplus Lines Agency', 'Managing General Agency'] },
  adjuster: { label: 'Public Insurance Adjusters', types: ['Public Insurance Adjuster'] },
  title: { label: 'Title Agencies', types: ['Title Agency'] }
};
const ALL_TYPES = Object.values(GROUPS).flatMap(g => g.types);

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
    agencyLicenseNumber: (raw.agency_license_number || '').trim(),
    orgName: (raw.org_name || '').trim() || null,
    agencyType: (raw.agency_type || '').trim() || null,
    city: (raw.city || '').trim() || null,
    state: (raw.state || '').trim() || null,
    postalCode: (raw.pstl_cd || '').trim() || null,
    expirationDate: raw.expiration_date ? raw.expiration_date.slice(0, 10) : null
  };
}

async function fetchAgencies({ log = () => {} } = {}) {
  const PAGE_SIZE = 1000;
  const cityList = markets.union(HOUSTON_METRO_CITIES, 'cities').map(c => `'${c.replace(/'/g, "''")}'`).join(',');
  const typeList = ALL_TYPES.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
  const where = `state='TX' AND upper(city) IN(${cityList}) AND license_type IN(${typeList})`;
  const all = [];
  let offset = 0;
  for (;;) {
    const url = `${TDI_AGENCY_BASE}?$where=${encodeURIComponent(where)}&$order=${encodeURIComponent(':id')}&$limit=${PAGE_SIZE}&$offset=${offset}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'EagleI (https://myeaglei.com, admin@myeaglei.com)' } });
    if (!r.ok) throw new Error(`TDI agency request failed (${r.status})`);
    const page = await r.json();
    all.push(...page);
    log(`  ${all.length.toLocaleString()} agency rows so far...`);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  // One row per qualification line in the source — collapse to one per
  // agency, keeping the latest expiration seen.
  const byKey = new Map();
  for (const raw of all) {
    const row = parseRegistrantRow(raw);
    if (!row.agencyLicenseNumber) continue;
    const key = `${row.licenseType}|${row.agencyLicenseNumber}`;
    const prev = byKey.get(key);
    if (!prev || (row.expirationDate || '') > (prev.expirationDate || '')) byKey.set(key, row);
  }
  return [...byKey.values()];
}

async function upsertAgencies(rows) {
  const CHUNK = 1000;
  const COLS = 8;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * COLS;
      values.push(r.licenseType, r.agencyLicenseNumber, r.orgName, r.agencyType, r.city, r.state, r.postalCode, r.expirationDate);
      const slots = Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`);
      return `(${slots.join(', ')})`;
    });
    await query(
      `INSERT INTO tdi_agencies (license_type, agency_license_number, org_name, agency_type, city, state, postal_code, expiration_date)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (license_type, agency_license_number) DO UPDATE SET
         org_name = EXCLUDED.org_name, agency_type = EXCLUDED.agency_type, city = EXCLUDED.city,
         state = EXCLUDED.state, postal_code = EXCLUDED.postal_code,
         expiration_date = EXCLUDED.expiration_date, imported_at = now()`,
      values
    );
  }
}

async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM tdi_agencies_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function recordImportCompleted(totalCount) {
  await query('INSERT INTO tdi_agencies_import_state (total_count) VALUES ($1)', [totalCount]);
}

async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  log('Fetching TDI insurance agencies (Houston metro, TX)...');
  const rows = await fetchAgencies({ log });
  const active = rows.filter(r => r.expirationDate && r.expirationDate >= new Date().toISOString().slice(0, 10));
  log(`Parsed ${rows.length.toLocaleString()} distinct agencies, ${active.length.toLocaleString()} currently unexpired.`);
  if (dryRun) {
    log('--dry-run: not writing to the database.');
    return { total: rows.length };
  }
  log(`Upserting ${rows.length.toLocaleString()} rows into tdi_agencies...`);
  await upsertAgencies(rows);
  await recordImportCompleted(rows.length);
  return { total: rows.length };
}

async function getHoustonAreaAgencies({ group, search, limit = 40, offset = 0 }) {
  const g = GROUPS[group];
  if (!g) throw new Error('Unknown agency group.');
  const conditions = ['license_type = ANY($1)', 'org_name IS NOT NULL', 'expiration_date >= CURRENT_DATE', 'UPPER(city) = ANY($2)'];
  const params = [g.types, HOUSTON_METRO_CITIES];
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`org_name ILIKE $${params.length}`);
  }
  params.push(limit, offset);
  const r = await query(
    `SELECT id, license_type, agency_license_number, org_name, city, expiration_date, phone, website,
            contact_email, places_formatted_address, places_matched_name, google_rating, google_review_count,
            contact_checked_at, COUNT(*) OVER() AS total_count
     FROM tdi_agencies
     WHERE ${conditions.join(' AND ')}
     ORDER BY org_name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = r.rows[0] ? Number(r.rows[0].total_count) : 0;
  return {
    total,
    registrants: r.rows.map(row => ({
      id: row.id,
      licenseType: row.license_type,
      licenseNumber: row.agency_license_number,
      displayName: row.org_name,
      city: row.city,
      expirationDate: row.expiration_date,
      phone: formatPhone(row.phone),
      website: row.website,
      contactEmail: row.contact_email,
      placesFormattedAddress: row.places_formatted_address,
      placesMatchedName: row.places_matched_name,
      googleRating: row.google_rating !== null ? Number(row.google_rating) : null,
      googleReviewCount: row.google_review_count,
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
    `SELECT id, org_name, city, postal_code, website, phone, contact_email, places_formatted_address,
            places_matched_name, google_rating, google_review_count, contact_checked_at
     FROM tdi_agencies WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function saveContactInfo(id, { website, phone, contactEmail, placesFormattedAddress, matchedName, rating, reviewCount }) {
  await query(
    `UPDATE tdi_agencies
     SET website = $1, phone = $2, contact_email = $3, places_formatted_address = $4,
         places_matched_name = $5, google_rating = $6, google_review_count = $7, contact_checked_at = now()
     WHERE id = $8`,
    [website || null, phone || null, contactEmail || null, placesFormattedAddress || null,
     matchedName || null, rating ?? null, reviewCount ?? null, id]
  );
}

module.exports = {
  GROUPS,
  HOUSTON_METRO_CITIES,
  parseRegistrantRow,
  fetchAgencies,
  upsertAgencies,
  runFullImport,
  getLastImportCompletedAt,
  recordImportCompleted,
  getHoustonAreaAgencies,
  getRegistrantById,
  saveContactInfo,
  formatPhone
};
