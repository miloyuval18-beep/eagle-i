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

// Full replace, scoped to one profession at a time — so a run that only
// successfully re-downloaded one of the two rosters doesn't wipe the
// other. Same chunked-insert shape as replaceOwnerParcels/replaceParcelAges
// in lib/hcadZipValues.js.
async function replaceRegistrantsForProfession(profession, rows) {
  await query('DELETE FROM tbae_registrants WHERE profession = $1', [profession]);
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
       VALUES ${placeholders.join(',')}`,
      values
    );
  }
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
  replaceRegistrantsForProfession,
  getHoustonAreaRegistrants,
  getRegistrantById,
  saveContactInfo
};
