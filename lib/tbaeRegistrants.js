// Real architects and Registered Interior Designers, sourced from TBAE's
// own public roster download — see migrations/..._tbae_registrants.js and
// scripts/importTbaeRoster.js for where this data comes from and why.
const { query } = require('../db');

// The TBAE download endpoint's profession_type_id for each roster — confirmed
// live: 3 = Architects, 2 = Registered Interior Designers, 1 = Landscape
// Architects (not imported here — out of scope for this feature).
const ROSTER_PROFESSION_TYPE_ID = {
  architect: 3,
  interior_designer: 2
};

// Confirmed live against the real TBAE_HOME metro-area distribution: the
// cities a Houston-area outreach feature should treat as "Houston" beyond
// the literal city name. Matched uppercase against the roster's own City
// column (which is itself free text the registrant typed in, not a
// controlled list).
const HOUSTON_METRO_CITIES = [
  'HOUSTON', 'SUGAR LAND', 'THE WOODLANDS', 'KATY', 'PEARLAND', 'SPRING', 'CYPRESS',
  'BELLAIRE', 'MISSOURI CITY', 'RICHMOND', 'CONROE', 'LEAGUE CITY', 'PASADENA',
  'BAYTOWN', 'FRIENDSWOOD', 'HUMBLE', 'KINGWOOD', 'TOMBALL', 'STAFFORD',
  'WEST UNIVERSITY PLACE', 'BUNKER HILL VILLAGE', 'PINEY POINT VILLAGE',
  'HUNTERS CREEK VILLAGE', 'JERSEY VILLAGE', 'WEBSTER', 'DEER PARK', 'ROSENBERG',
  'CHANNELVIEW', 'ALVIN'
];

// TBAE's roster dates read like "Nov 17 2014" — JS Date parses that format
// natively; anything that doesn't parse cleanly is stored as null rather
// than guessed.
function parseRosterDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// A registrant who opted out of publishing shows "Not Published" literally
// in the firm_name/city cells — normalized to null so every downstream
// query can treat "can this be geographically targeted" as one null check
// instead of a string comparison sprinkled everywhere.
function normalizePublished(v) {
  const s = (v || '').toString().trim();
  return (!s || s === 'Not Published') ? null : s;
}

// header: the roster's first row (column names); rows: every row after it,
// in the same column order — see lib/xlsxReader.js's readXlsxFirstSheet.
// Columns confirmed live: Reg No, Prefix, First Name, Last Name, Middle
// Name, Firm Name, City, State, Lic. Status, init lic date, lic exp date.
function parseRosterRows(rows, profession) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    out.push({
      profession,
      regNo: (r[0] || '').toString().trim() || null,
      prefix: (r[1] || '').toString().trim() || null,
      firstName: (r[2] || '').toString().trim() || null,
      lastName: (r[3] || '').toString().trim() || null,
      middleName: (r[4] || '').toString().trim() || null,
      firmName: normalizePublished(r[5]),
      city: normalizePublished(r[6]),
      state: (r[7] || '').toString().trim() || null,
      licStatus: (r[8] || '').toString().trim() || null,
      initLicDate: parseRosterDate(r[9]),
      licExpDate: parseRosterDate(r[10])
    });
  }
  return out;
}

// Upsert (by the profession+reg_no identity added in
// migrations/..._tbae_registrants_upsert_support.js), scoped to one
// profession at a time so a run that only successfully re-downloaded one
// of the two rosters doesn't touch the other. Deliberately NOT a
// DELETE+INSERT full replace like replaceOwnerParcels/replaceParcelAges in
// lib/hcadZipValues.js use — those tables hold nothing worth preserving
// between imports, but this one does: website/phone/contact_email/
// contact_checked_at come from a real, billed Places API call (see
// routes/tbaeRegistrants.js's find-contact endpoint), and a monthly
// roster refresh exists specifically to pick up NEW registrants — it
// must not force every already-checked firm to be re-looked-up (and
// re-paid-for) just because the roster was re-downloaded. The ON CONFLICT
// clause updates only the fields that actually come from TBAE's roster
// and leaves the Places-derived columns untouched.
async function upsertRegistrantsForProfession(profession, rows) {
  const CHUNK = 1000;
  const COLS = 12;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * COLS;
      values.push(
        r.profession, r.regNo, r.prefix, r.firstName, r.lastName, r.middleName,
        r.firmName, r.city, r.state, r.licStatus, r.initLicDate, r.licExpDate
      );
      const slots = Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`);
      return `(${slots.join(', ')})`;
    });
    await query(
      `INSERT INTO tbae_registrants
         (profession, reg_no, prefix, first_name, last_name, middle_name, firm_name, city, state, lic_status, init_lic_date, lic_exp_date)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (profession, reg_no) DO UPDATE SET
         prefix = EXCLUDED.prefix, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
         middle_name = EXCLUDED.middle_name, firm_name = EXCLUDED.firm_name, city = EXCLUDED.city,
         state = EXCLUDED.state, lic_status = EXCLUDED.lic_status, init_lic_date = EXCLUDED.init_lic_date,
         lic_exp_date = EXCLUDED.lic_exp_date, imported_at = now()`,
      values
    );
  }
}

// Most recent completed full-roster import, or null if one has never run.
// lib/tbaeRosterWorker.js uses this to decide "is it time to re-import
// yet" — a dedicated log table rather than inferring it from per-row
// imported_at (ambiguous after an upsert, since unrelated rows can carry
// different imported_at values from different runs).
async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM tbae_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function recordImportCompleted({ architectCount, interiorDesignerCount }) {
  await query(
    'INSERT INTO tbae_import_state (architect_count, interior_designer_count) VALUES ($1, $2)',
    [architectCount, interiorDesignerCount]
  );
}

// Downloads both real TBAE rosters, parses, and upserts them — the shared
// orchestration used by both the manual CLI (scripts/importTbaeRoster.js)
// and the monthly automatic worker (lib/tbaeRosterWorker.js), so there's
// one place that knows how to actually do a full import. Returns per-
// profession counts for logging/recording.
async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  const { readXlsxFirstSheet } = require('./xlsxReader');
  const ROSTER_URL = (typeId) => `https://indreg.tbae.texas.gov/Reports/RegistrantRostersDownload?profession_type_id=${typeId}`;
  const professions = [
    { key: 'architect', label: 'Architects' },
    { key: 'interior_designer', label: 'Registered Interior Designers' }
  ];
  const counts = {};

  for (const { key, label } of professions) {
    log(`Downloading ${label} roster...`);
    const r = await fetch(ROSTER_URL(ROSTER_PROFESSION_TYPE_ID[key]), {
      headers: { 'User-Agent': 'EagleI (https://myeaglei.com, admin@myeaglei.com)' }
    });
    if (!r.ok) throw new Error(`${label} roster download failed: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    log(`  Downloaded ${(buf.length / 1e3).toFixed(0)}KB.`);

    const rawRows = readXlsxFirstSheet(buf);
    const rows = parseRosterRows(rawRows, key);
    counts[key] = rows.length;
    const active = rows.filter(row => row.licStatus === 'Active');
    const published = active.filter(row => row.firmName && row.city);
    const houstonMetro = published.filter(row => HOUSTON_METRO_CITIES.includes((row.city || '').toUpperCase()));
    log(`  Parsed ${rows.length.toLocaleString()} total, ${active.length.toLocaleString()} active, ${published.length.toLocaleString()} with a published firm+city, ${houstonMetro.length.toLocaleString()} in the Houston metro area.`);

    if (dryRun) {
      log(`  --dry-run: not writing ${label} to the database.`);
      continue;
    }
    log(`  Upserting ${rows.length.toLocaleString()} rows into tbae_registrants (existing Places contact data preserved)...`);
    await upsertRegistrantsForProfession(key, rows);
  }

  if (!dryRun) {
    await recordImportCompleted({ architectCount: counts.architect || 0, interiorDesignerCount: counts.interior_designer || 0 });
  }
  return counts;
}

// Houston-metro registrants for one profession, with a real firm/name to
// search on — a null firm_name means the registrant opted out of
// publishing it, so there's nothing to look up via Places; those rows are
// deliberately excluded here rather than shown as dead ends. Paginated:
// callers pass limit/offset, get a total back for a "Load more" UI.
async function getHoustonAreaRegistrants({ profession, search, limit = 40, offset = 0 }) {
  // The roster's City column is free text a registrant typed in, not a
  // controlled list — real data has both "Houston" and "HOUSTON" (and
  // similarly for other cities), confirmed live, so this must match
  // case-insensitively or it silently drops most of one casing variant.
  const conditions = ['profession = $1', "lic_status = 'Active'", 'UPPER(city) = ANY($2)', 'firm_name IS NOT NULL'];
  const params = [profession, HOUSTON_METRO_CITIES];
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(firm_name ILIKE $${params.length} OR first_name ILIKE $${params.length} OR last_name ILIKE $${params.length})`);
  }
  params.push(limit, offset);
  const r = await query(
    `SELECT id, reg_no, prefix, first_name, last_name, middle_name, firm_name, city, lic_status,
            lic_exp_date, website, phone, contact_email, places_formatted_address, contact_checked_at,
            COUNT(*) OVER() AS total_count
     FROM tbae_registrants
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
      regNo: row.reg_no,
      displayName: row.firm_name || [row.prefix, row.first_name, row.last_name].filter(Boolean).join(' '),
      contactPerson: [row.prefix, row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' '),
      firmName: row.firm_name,
      city: row.city,
      licStatus: row.lic_status,
      licExpDate: row.lic_exp_date,
      website: row.website,
      phone: row.phone,
      contactEmail: row.contact_email,
      placesFormattedAddress: row.places_formatted_address,
      contactCheckedAt: row.contact_checked_at
    }))
  };
}

async function getRegistrantById(id) {
  const r = await query(
    `SELECT id, profession, reg_no, prefix, first_name, last_name, middle_name, firm_name, city,
            lic_status, website, phone, contact_email, places_formatted_address, contact_checked_at
     FROM tbae_registrants WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function saveContactInfo(id, { website, phone, contactEmail, placesFormattedAddress }) {
  await query(
    `UPDATE tbae_registrants
     SET website = $1, phone = $2, contact_email = $3, places_formatted_address = $4, contact_checked_at = now()
     WHERE id = $5`,
    [website || null, phone || null, contactEmail || null, placesFormattedAddress || null, id]
  );
}

module.exports = {
  ROSTER_PROFESSION_TYPE_ID,
  HOUSTON_METRO_CITIES,
  parseRosterRows,
  upsertRegistrantsForProfession,
  getHoustonAreaRegistrants,
  getRegistrantById,
  saveContactInfo,
  getLastImportCompletedAt,
  recordImportCompleted,
  runFullImport
};
