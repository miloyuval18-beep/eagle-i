// Houston-area specialty-trade businesses from the Comptroller's public
// Active Sales Tax Permit Holders dataset, by NAICS code — see
// migrations/..._comptroller_trades.js for what this is (and, importantly,
// what it is NOT: a registration, not a license).
const { query } = require('../db');
const markets = require('./markets');

const DATASET_ID = 'jrea-zgmq';
const BASE = `https://data.texas.gov/resource/${DATASET_ID}.json`;

// key -> NAICS code + display strings. 238990 is the census bucket that
// actually holds fence erection, swimming pool construction, decks, and
// other trades with no NAICS code of their own — labelled honestly as
// "other specialty trades" rather than implying it's only those three.
const TRADES = {
  roofing:  { naics: '238160', label: 'Roofers',                       noun: 'roofing contractor' },
  painting: { naics: '238320', label: 'Painters',                      noun: 'painting contractor' },
  flooring: { naics: '238330', label: 'Flooring',                      noun: 'flooring contractor' },
  drywall:  { naics: '238310', label: 'Drywall & Insulation',          noun: 'drywall or insulation contractor' },
  concrete: { naics: '238110', label: 'Concrete',                      noun: 'concrete contractor' },
  masonry:  { naics: '238140', label: 'Masonry',                       noun: 'masonry contractor' },
  framing:  { naics: '238130', label: 'Framing',                       noun: 'framing contractor' },
  tile:     { naics: '238340', label: 'Tile',                          noun: 'tile contractor' },
  glass:    { naics: '238150', label: 'Glass & Glazing',               noun: 'glass and glazing contractor' },
  siding:   { naics: '238170', label: 'Siding',                        noun: 'siding contractor' },
  excavation:{ naics: '238910', label: 'Excavation & Site Prep',       noun: 'excavation or site preparation contractor' },
  specialty:{ naics: '238990', label: 'Fencing, Pools, Decks & Other', noun: 'specialty trade contractor (fencing, pools, decks, and similar)' }
};
// Businesses a contractor BUYS from or hires for site work, rather than
// subcontracts specialty trades to: building-material and trade suppliers,
// equipment rental, landscaping. Same source, same "registered, not licensed"
// caveat; a group can span several NAICS codes.
const SUPPLY_GROUPS = {
  materials: { label: 'Building Materials Suppliers', noun: 'building materials supplier', plural: 'building materials suppliers', naics: ['423310', '423320', '423330', '423390', '444110', '444190'] },
  paint_hardware: { label: 'Paint & Hardware', noun: 'paint or hardware supplier', plural: 'paint and hardware suppliers', naics: ['444120', '444130', '423710'] },
  trade_supply: { label: 'Electrical, Plumbing & HVAC Supply', noun: 'electrical, plumbing or HVAC supplier', plural: 'electrical, plumbing and HVAC suppliers', naics: ['423610', '423720'] },
  rental: { label: 'Equipment Rental', noun: 'equipment rental company', plural: 'equipment rental companies', naics: ['532412', '532310'] },
  landscaping: { label: 'Landscaping', noun: 'landscaping company', plural: 'landscaping companies', naics: ['561730'] }
};
const ALL_NAICS = [
  ...Object.values(TRADES).map(t => t.naics),
  ...new Set(Object.values(SUPPLY_GROUPS).flatMap(g => g.naics))
];

// Comptroller county codes (alphabetical index of Texas's 254 counties),
// verified live against known cities: Harris 101 (Houston), Fort Bend 079
// (Sugar Land), Montgomery 170 (Conroe), Galveston 084, Brazoria 020
// (Pearland), Liberty 146, Waller 237 (Hempstead), Chambers 036
// (Anahuac), Austin 008 (Bellville).
const HOUSTON_METRO_COUNTY_CODES = ['101', '079', '170', '084', '020', '146', '237', '036', '008'];

function parseDate(iso) {
  return iso ? String(iso).slice(0, 10) : null;
}

function parseRow(raw) {
  return {
    taxpayerNumber: (raw.taxpayer_number || '').trim(),
    naicsCode: (raw.outlet_naics_code || '').trim(),
    taxpayerName: (raw.taxpayer_name || '').trim() || null,
    outletName: (raw.outlet_name || '').trim() || null,
    outletAddress: (raw.outlet_address || '').trim() || null,
    outletCity: (raw.outlet_city || '').trim() || null,
    outletZip: (raw.outlet_zip_code || '').trim() || null,
    outletCountyCode: (raw.outlet_county_code || '').trim() || null,
    permitIssueDate: parseDate(raw.outlet_permit_issue_date),
    firstSalesDate: parseDate(raw.outlet_first_sales_date)
  };
}

// Which metro a Comptroller county code belongs to (Houston's nine counties are the default).
function marketOfCounty(code) {
  for (const mk of Object.values(markets.MARKETS)) if (mk.key !== 'houston' && (mk.countyCodes || []).includes(code)) return mk.key;
  return 'houston';
}

async function fetchTrades({ log = () => {} } = {}) {
  const PAGE_SIZE = 1000;
  const countyList = markets.union(HOUSTON_METRO_COUNTY_CODES, 'countyCodes').map(c => `'${c}'`).join(',');
  const naicsList = ALL_NAICS.map(c => `'${c}'`).join(',');
  const where = `outlet_county_code IN(${countyList}) AND outlet_naics_code IN(${naicsList})`;
  const all = [];
  let offset = 0;
  for (;;) {
    const url = `${BASE}?$where=${encodeURIComponent(where)}&$order=${encodeURIComponent(':id')}&$limit=${PAGE_SIZE}&$offset=${offset}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'EagleI (https://myeaglei.com, admin@myeaglei.com)' } });
    if (!r.ok) throw new Error(`Comptroller sales-tax request failed (${r.status})`);
    const page = await r.json();
    all.push(...page);
    log(`  ${all.length.toLocaleString()} permit outlets so far...`);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  // One row per outlet in the source — collapse to one business per
  // (taxpayer, NAICS), keeping the earliest permit (longest tenure).
  const byKey = new Map();
  for (const raw of all) {
    const row = parseRow(raw);
    if (!row.taxpayerNumber || !row.naicsCode) continue;
    row.market = marketOfCounty(row.outletCountyCode);
    const key = `${row.taxpayerNumber}|${row.naicsCode}|${row.market}`;
    const prev = byKey.get(key);
    if (!prev || (row.permitIssueDate || '9999') < (prev.permitIssueDate || '9999')) byKey.set(key, row);
  }
  return [...byKey.values()];
}

// Upsert marks every seen row active. Contact columns (website, phone,
// email, rating, ...) are deliberately never in the DO UPDATE clause —
// same "never re-pay for already-found contact data" rule as every other
// source.
async function upsertTrades(rows) {
  const CHUNK = 1000;
  const COLS = 11;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * COLS;
      values.push(
        r.taxpayerNumber, r.naicsCode, r.taxpayerName, r.outletName, r.outletAddress,
        r.outletCity, r.outletZip, r.outletCountyCode, r.permitIssueDate, r.firstSalesDate, r.market
      );
      const slots = Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`);
      return `(${slots.join(', ')})`;
    });
    await query(
      `INSERT INTO comptroller_trades
         (taxpayer_number, naics_code, taxpayer_name, outlet_name, outlet_address, outlet_city,
          outlet_zip, outlet_county_code, permit_issue_date, first_sales_date, market)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (taxpayer_number, naics_code, market) DO UPDATE SET
         taxpayer_name = EXCLUDED.taxpayer_name, outlet_name = EXCLUDED.outlet_name,
         outlet_address = EXCLUDED.outlet_address, outlet_city = EXCLUDED.outlet_city,
         outlet_zip = EXCLUDED.outlet_zip, outlet_county_code = EXCLUDED.outlet_county_code,
         permit_issue_date = EXCLUDED.permit_issue_date, first_sales_date = EXCLUDED.first_sales_date,
         active = true, imported_at = now()`,
      values
    );
  }
}

async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM comptroller_trades_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function recordImportCompleted(totalCount) {
  await query('INSERT INTO comptroller_trades_import_state (total_count) VALUES ($1)', [totalCount]);
}

// The source only lists ACTIVE permits and has no expiry/status column,
// so a business that closes just stops appearing. After a fully
// successful import (any fetch error throws before we get here), anything
// not touched during this run is no longer on the active list — flag it
// inactive so it drops out of the panel, without deleting the row (and
// the contact data already paid for).
async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  log('Fetching Comptroller sales-tax permit holders (Houston metro, construction trade NAICS codes)...');
  const rows = await fetchTrades({ log });
  const byNaics = {};
  for (const r of rows) byNaics[r.naicsCode] = (byNaics[r.naicsCode] || 0) + 1;
  log(`Parsed ${rows.length.toLocaleString()} distinct businesses: ${JSON.stringify(byNaics)}`);
  if (dryRun) {
    log('--dry-run: not writing to the database.');
    return { total: rows.length, byNaics };
  }
  // The cutoff comes from the database's own clock, not this process's —
  // upserted rows get imported_at = the DB's now(), so comparing against
  // app-server time could wrongly deactivate fresh rows under clock skew.
  const startedAt = (await query('SELECT now() AS t')).rows[0].t;
  log(`Upserting ${rows.length.toLocaleString()} rows into comptroller_trades...`);
  await upsertTrades(rows);
  const deactivated = await query(
    'UPDATE comptroller_trades SET active = false WHERE active = true AND imported_at < $1',
    [startedAt]
  );
  log(`Flagged ${deactivated.rowCount} businesses no longer on the active permit list.`);
  await recordImportCompleted(rows.length);
  return { total: rows.length, byNaics, deactivated: deactivated.rowCount };
}

async function getHoustonAreaTrades({ trade, search, limit = 40, offset = 0 }) {
  const t = TRADES[trade];
  if (!t) throw new Error('Unknown trade.');
  const conditions = ['naics_code = $1', 'active = true', 'COALESCE(outlet_name, taxpayer_name) IS NOT NULL'];
  const params = [t.naics];
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(outlet_name ILIKE $${params.length} OR taxpayer_name ILIKE $${params.length})`);
  }
  params.push(limit, offset);
  const r = await query(
    `SELECT id, taxpayer_name, outlet_name, outlet_address, outlet_city, outlet_zip, permit_issue_date,
            first_sales_date, phone, website, contact_email, places_formatted_address, places_matched_name,
            google_rating, google_review_count, contact_checked_at, COUNT(*) OVER() AS total_count
     FROM comptroller_trades
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(outlet_name, taxpayer_name) ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = r.rows[0] ? Number(r.rows[0].total_count) : 0;
  return {
    total,
    registrants: r.rows.map(row => {
      const since = row.first_sales_date || row.permit_issue_date;
      return {
        id: row.id,
        displayName: row.outlet_name || row.taxpayer_name,
        legalName: row.taxpayer_name,
        address: row.outlet_address,
        city: row.outlet_city,
        zip: row.outlet_zip,
        inBusinessSince: since ? new Date(since).getUTCFullYear() : null,
        phone: formatPhone(row.phone),
        website: row.website,
        contactEmail: row.contact_email,
        placesFormattedAddress: row.places_formatted_address,
        placesMatchedName: row.places_matched_name,
        googleRating: row.google_rating !== null ? Number(row.google_rating) : null,
        googleReviewCount: row.google_review_count,
        contactCheckedAt: row.contact_checked_at
      };
    })
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
    `SELECT id, taxpayer_name, outlet_name, outlet_address, outlet_city, outlet_zip, website, phone, contact_email,
            places_formatted_address, places_matched_name, google_rating, google_review_count, contact_checked_at
     FROM comptroller_trades WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function saveContactInfo(id, { website, phone, contactEmail, placesFormattedAddress, matchedName, rating, reviewCount }) {
  await query(
    `UPDATE comptroller_trades
     SET website = $1, phone = $2, contact_email = $3, places_formatted_address = $4,
         places_matched_name = $5, google_rating = $6, google_review_count = $7, contact_checked_at = now()
     WHERE id = $8`,
    [website || null, phone || null, contactEmail || null, placesFormattedAddress || null,
     matchedName || null, rating ?? null, reviewCount ?? null, id]
  );
}

module.exports = {
  TRADES,
  SUPPLY_GROUPS,
  HOUSTON_METRO_COUNTY_CODES,
  parseRow,
  fetchTrades,
  upsertTrades,
  runFullImport,
  getLastImportCompletedAt,
  recordImportCompleted,
  getHoustonAreaTrades,
  getRegistrantById,
  saveContactInfo,
  formatPhone
};
