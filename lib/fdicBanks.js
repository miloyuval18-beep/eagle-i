// Houston-metro banks and lenders from the FDIC's BankFind API — see
// migrations/..._fdic_banks.js. Same import shape as the other sources: fetch,
// collapse, upsert that never touches contact columns, flag what disappeared.
const { query } = require('../db');
const markets = require('./markets');

const BASE = 'https://banks.data.fdic.gov/api/locations';
const COUNTIES = ['Harris', 'Fort Bend', 'Montgomery', 'Brazoria', 'Galveston', 'Liberty', 'Waller', 'Chambers', 'Austin'];
const UA = { 'User-Agent': 'EagleI (https://myeaglei.com, admin@myeaglei.com)' };

// SERVTYPE 11 = a full-service branch the public can walk into (excludes
// limited-service, loan-production and other non-branch offices).
async function fetchBranches({ log = () => {}, counties = COUNTIES } = {}) {
  const filters = `STALP:TX AND COUNTY:(${counties.map(c => `"${c}"`).join(' OR ')}) AND SERVTYPE:11`;
  const fields = 'NAME,OFFNAME,ADDRESS,CITY,ZIP,COUNTY,CERT,MAINOFF';
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const url = `${BASE}?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent(fields)}&limit=1000&offset=${offset}&sort_by=CERT&sort_order=ASC`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`FDIC request failed (${r.status})`);
    const j = await r.json();
    all.push(...j.data.map(x => x.data));
    log(`  ${all.length.toLocaleString()} of ${j.meta.total.toLocaleString()} branches so far...`);
    if (all.length >= j.meta.total || !j.data.length) break;
  }
  return all;
}

// One row per institution: the metro main office if it has one, else its
// first metro branch (by city, then address, so the choice is stable).
function collapseToInstitutions(branches) {
  const byCert = new Map();
  for (const b of branches) {
    if (!b.CERT || !b.NAME) continue;
    if (!byCert.has(b.CERT)) byCert.set(b.CERT, []);
    byCert.get(b.CERT).push(b);
  }
  return [...byCert.entries()].map(([cert, list]) => {
    const main = list.find(b => b.MAINOFF === 1);
    const pick = main || [...list].sort((a, b) => String(a.CITY).localeCompare(String(b.CITY)) || String(a.ADDRESS).localeCompare(String(b.ADDRESS)))[0];
    return {
      cert: String(cert), name: pick.NAME.trim(), address: (pick.ADDRESS || '').trim() || null, city: (pick.CITY || '').trim() || null,
      zip: (pick.ZIP || '').trim() || null, county: (pick.COUNTY || '').trim() || null, branches: list.length, hasMain: !!main
    };
  });
}

async function upsertBanks(rows, market = 'houston') {
  for (const r of rows) {
    await query(
      `INSERT INTO fdic_banks (cert, name, address, city, zip, county, metro_branches, has_metro_main_office, market)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (cert, market) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, city = EXCLUDED.city,
         zip = EXCLUDED.zip, county = EXCLUDED.county, metro_branches = EXCLUDED.metro_branches,
         has_metro_main_office = EXCLUDED.has_metro_main_office, active = true, imported_at = now()`,
      [r.cert, r.name, r.address, r.city, r.zip, r.county, r.branches, r.hasMain, market]
    );
  }
}

async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM fdic_banks_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  const startedAt = (await query('SELECT now() AS t')).rows[0].t; // DB clock, not this process's
  let total = 0, totalBranches = 0;
  for (const mk of Object.values(markets.MARKETS)) {
    log(`Fetching ${mk.label} bank branches from the FDIC...`);
    const branches = await fetchBranches({ log, counties: mk.fdicCounties || COUNTIES });
    const rows = collapseToInstitutions(branches);
    log(`  ${branches.length.toLocaleString()} branches -> ${rows.length} institutions (${rows.filter(r => r.hasMain).length} with a main office in the area).`);
    total += rows.length; totalBranches += branches.length;
    if (!dryRun) await upsertBanks(rows, mk.key);
  }
  if (dryRun) { log('--dry-run: not writing to the database.'); return { total, branches: totalBranches }; }
  const gone = await query('UPDATE fdic_banks SET active = false WHERE active = true AND imported_at < $1', [startedAt]);
  log(`Flagged ${gone.rowCount} institutions no longer listed.`);
  await query('INSERT INTO fdic_banks_import_state (total_count) VALUES ($1)', [total]);
  return { total, branches: totalBranches, deactivated: gone.rowCount };
}

module.exports = { COUNTIES, fetchBranches, collapseToInstitutions, upsertBanks, getLastImportCompletedAt, runFullImport };
