// Real per-zip home-value stats sourced from Harris Central Appraisal
// District's own public bulk data export (real_acct.txt inside their
// Real_acct_owner.zip — see scripts/importHcadZipValues.js for how/why
// this is a manual/periodic local import rather than a live lookup, and
// README.md's "HCAD real home-value data" section for how to run it).
//
// This supplements lib/houstonZipValues.js's curated reference list — it
// doesn't replace it. HOUSTON_HIGH_VALUE_ZIPS stays as a same-day fallback
// for any zip this table doesn't have a row for yet (e.g. the import has
// never been run in this environment). Both are shown separately and
// labeled honestly wherever they're used — real appraisal data vs.
// curated market reporting — matching this app's existing pattern for
// real-vs-estimated data (see the Places-competitors and Permits pages).
const { query } = require('../db');
const { parseOwnerPersonName, normalizeAddress } = require('./hcadOwnerNames');

// ---- Pure logic (no DB, no network) — unit-testable in isolation ----

// Parses one tab-delimited data line from HCAD's real_acct.txt using a
// header-name -> column-index map (built once from the file's own header
// row by buildRealAcctHeaderIndex). Returns null for a line that doesn't
// have a usable zip + market value, rather than throwing — a 1.8M-row
// county file always has some blank/malformed rows and skipping them is
// the correct behavior, not an error.
function buildRealAcctHeaderIndex(headerLine) {
  const cols = headerLine.split('\t').map(c => c.trim());
  const index = {};
  cols.forEach((name, i) => { index[name] = i; });
  return index;
}

function parseRealAcctLine(headerIndex, line) {
  if (!line) return null;
  const cells = line.split('\t');
  const rawZip = cells[headerIndex.site_addr_3];
  const rawValue = cells[headerIndex.tot_mkt_val];
  if (!rawZip || !rawValue) return null;
  const zip = String(rawZip).trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return null;
  const marketValue = parseInt(String(rawValue).trim(), 10);
  if (!Number.isFinite(marketValue) || marketValue <= 0) return null;
  return { zip, marketValue };
}

// Parses one real_acct.txt data line into a per-parcel owner-name row, for
// the permit-mailer's optional real-name personalization (see
// lib/permitMailer.js and routes/permits.js). Uses the same header-index
// pattern as parseRealAcctLine above, just different columns (site_addr_1,
// mailto). Returns null for any row that isn't safe to use — a missing
// zip/address, or an owner name that doesn't parse as a confident
// individual (lib/hcadOwnerNames.js) — so only names actually worth storing
// ever reach the database.
function parseRealAcctOwnerLine(headerIndex, line) {
  if (!line) return null;
  const cells = line.split('\t');
  const rawZip = cells[headerIndex.site_addr_3];
  const rawAddress = cells[headerIndex.site_addr_1];
  const mailto = cells[headerIndex.mailto];
  if (!rawZip || !rawAddress) return null;
  const zip = String(rawZip).trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return null;
  const address = String(rawAddress).trim();
  if (!address) return null;
  const person = parseOwnerPersonName(mailto);
  if (!person) return null;
  return {
    zip,
    rawSiteAddress: address,
    normalizedAddress: normalizeAddress(address),
    ownerFirstName: person.firstName,
    ownerLastName: person.lastName
  };
}

// Parses one real_acct.txt data line into a per-parcel year-built row, for
// aging-system targeting (routes/permits.js's GET /api/permits/aging-systems
// — see migrations/1757300000000_hcad_parcel_ages.js for why this is its
// own table, not a column on hcad_owner_parcels). Same header-index
// pattern as the two parsers above, just the yr_impr column — confirmed
// present and plausible via scripts/importHcadZipValues.js's
// --header-only check before this was built. Fails closed like the owner
// parser: no zip/address, or a year_built that doesn't parse to a sane
// value, both return null rather than storing garbage.
function parseRealAcctParcelAgeLine(headerIndex, line) {
  if (!line) return null;
  const cells = line.split('\t');
  const rawZip = cells[headerIndex.site_addr_3];
  const rawAddress = cells[headerIndex.site_addr_1];
  const rawYear = cells[headerIndex.yr_impr];
  if (!rawZip || !rawAddress || !rawYear) return null;
  const zip = String(rawZip).trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return null;
  const address = String(rawAddress).trim();
  if (!address) return null;
  const yearBuilt = parseInt(String(rawYear).trim(), 10);
  if (!Number.isFinite(yearBuilt) || yearBuilt < 1800 || yearBuilt > new Date().getFullYear()) return null;
  return {
    zip,
    rawSiteAddress: address,
    normalizedAddress: normalizeAddress(address),
    yearBuilt
  };
}

// Groups already-parsed {zip, marketValue} rows into per-zip stats. Kept
// separate from parsing so it can be unit-tested with plain objects and so
// the import script can stream-parse without holding every raw line in
// memory at once (only the much smaller per-zip accumulators grow).
function aggregateZipValues(parsedRows) {
  const byZip = new Map(); // zip -> array of marketValue
  for (const row of parsedRows) {
    if (!row) continue;
    if (!byZip.has(row.zip)) byZip.set(row.zip, []);
    byZip.get(row.zip).push(row.marketValue);
  }
  const stats = [];
  for (const [zip, values] of byZip.entries()) {
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    stats.push({
      zip,
      avgMarketValue: Math.round(sum / sorted.length),
      medianMarketValue: Math.round(median),
      parcelCount: sorted.length
    });
  }
  return stats.sort((a, b) => b.parcelCount - a.parcelCount);
}

// ---- DB-backed reads (used by routes/permits.js and routes/signals.js) ----

function formatRow(row) {
  return {
    zip: row.zip,
    avgMarketValue: Math.round(Number(row.avg_market_value)),
    medianMarketValue: Math.round(Number(row.median_market_value)),
    parcelCount: row.parcel_count,
    taxYear: (row.tax_year || '').trim(),
    importedAt: row.imported_at
  };
}

async function getRealHcadZipStats(zip) {
  if (!zip) return null;
  const r = await query(
    'SELECT zip, avg_market_value, median_market_value, parcel_count, tax_year, imported_at FROM hcad_zip_stats WHERE zip = $1',
    [zip]
  );
  return r.rows.length ? formatRow(r.rows[0]) : null;
}

// Batches a lookup for many zips into one query instead of N — both
// routes that use this render a whole list of zips per request.
async function getRealHcadZipStatsForZips(zips) {
  const uniq = [...new Set((zips || []).filter(Boolean))];
  const map = new Map();
  if (!uniq.length) return map;
  const r = await query(
    'SELECT zip, avg_market_value, median_market_value, parcel_count, tax_year, imported_at FROM hcad_zip_stats WHERE zip = ANY($1)',
    [uniq]
  );
  for (const row of r.rows) map.set(row.zip, formatRow(row));
  return map;
}

async function upsertZipStats(stats, taxYear) {
  for (const s of stats) {
    await query(
      `INSERT INTO hcad_zip_stats (zip, avg_market_value, median_market_value, parcel_count, tax_year, imported_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (zip) DO UPDATE SET
         avg_market_value = EXCLUDED.avg_market_value,
         median_market_value = EXCLUDED.median_market_value,
         parcel_count = EXCLUDED.parcel_count,
         tax_year = EXCLUDED.tax_year,
         imported_at = now()`,
      [s.zip, s.avgMarketValue, s.medianMarketValue, s.parcelCount, taxYear]
    );
  }
}

// Replaces the entire hcad_owner_parcels table with a fresh set of rows —
// a full re-import each time (same cadence as upsertZipStats above, run a
// few times a year) rather than an upsert, since there's no natural stable
// key across runs and ownership genuinely changes. Chunked inserts (not
// one row at a time like upsertZipStats — this table can hold hundreds of
// thousands of rows, one per confidently-parsed individual owner, so a
// per-row round trip would make the import impractically slow).
async function replaceOwnerParcels(rows, taxYear) {
  await query('DELETE FROM hcad_owner_parcels');
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * 6;
      values.push(r.zip, r.normalizedAddress, r.ownerFirstName, r.ownerLastName, r.rawSiteAddress, taxYear);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });
    await query(
      `INSERT INTO hcad_owner_parcels (zip, normalized_address, owner_first_name, owner_last_name, raw_site_address, tax_year)
       VALUES ${placeholders.join(',')}`,
      values
    );
  }
}

// Same full-replace-in-chunks pattern as replaceOwnerParcels above, for
// hcad_parcel_ages. A property's age doesn't need incremental diffing —
// a fresh full import a few times a year is exactly as correct as any
// smarter upsert would be, and far simpler.
async function replaceParcelAges(rows, taxYear) {
  await query('DELETE FROM hcad_parcel_ages');
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * 5;
      values.push(r.zip, r.normalizedAddress, r.rawSiteAddress, r.yearBuilt, taxYear);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });
    await query(
      `INSERT INTO hcad_parcel_ages (zip, normalized_address, raw_site_address, year_built, tax_year)
       VALUES ${placeholders.join(',')}`,
      values
    );
  }
}

// Batched parcel-age lookup for a set of zips — one query regardless of
// how many zips a caller needs (same "batch, don't loop" posture as
// getRealHcadZipStatsForZips above). A single busy Houston zip can hold
// tens of thousands of parcels (50k+ in the top few), so the year range
// and a row limit are applied in SQL, not fetched wholesale and filtered
// in JS — routes/permits.js's aging-systems route always passes both.
async function getParcelAgesForZips(zips, { minYear, maxYear, limit = 300 } = {}) {
  const uniq = [...new Set((zips || []).filter(Boolean))];
  if (!uniq.length) return [];
  const conditions = ['zip = ANY($1)', 'year_built IS NOT NULL'];
  const params = [uniq];
  if (Number.isFinite(minYear)) { params.push(minYear); conditions.push(`year_built >= $${params.length}`); }
  if (Number.isFinite(maxYear)) { params.push(maxYear); conditions.push(`year_built <= $${params.length}`); }
  params.push(limit);
  const r = await query(
    `SELECT zip, normalized_address, raw_site_address, year_built, tax_year FROM hcad_parcel_ages
     WHERE ${conditions.join(' AND ')}
     ORDER BY year_built ASC
     LIMIT $${params.length}`,
    params
  );
  return r.rows.map(row => ({
    zip: row.zip,
    normalizedAddress: row.normalized_address,
    rawSiteAddress: row.raw_site_address,
    yearBuilt: row.year_built,
    taxYear: (row.tax_year || '').trim()
  }));
}

// Batched confident-owner lookup for the permit mailer (routes/permits.js)
// — pairs is [{id, zip, address}]; returns Map<id, {firstName,lastName}|null>.
// "Confident" means exactly one distinct owner name is on record for that
// exact (zip, normalized address) pair — zero rows (no match) or more than
// one distinct name (an ambiguous shared/placeholder address, e.g. several
// vacant-lot accounts under "0 MAIN ST") both resolve to null, same as a
// zip/address this table has never covered. One query total regardless of
// how many permits are being matched, not one round trip per permit.
async function findConfidentOwners(pairs) {
  const result = new Map();
  const byKey = new Map(); // `${zip}||${normalizedAddress}` -> [id, id, ...]
  const zips = new Set();
  const addresses = new Set();

  for (const p of pairs || []) {
    if (!p || p.id === undefined || !p.zip || !p.address) continue;
    const norm = normalizeAddress(p.address);
    const key = `${p.zip}||${norm}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p.id);
    zips.add(p.zip);
    addresses.add(norm);
    result.set(p.id, null);
  }
  if (!byKey.size) return result;

  const r = await query(
    'SELECT zip, normalized_address, owner_first_name, owner_last_name FROM hcad_owner_parcels WHERE zip = ANY($1) AND normalized_address = ANY($2)',
    [[...zips], [...addresses]]
  );

  const grouped = new Map();
  for (const row of r.rows) {
    const key = `${row.zip}||${row.normalized_address}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ firstName: row.owner_first_name, lastName: row.owner_last_name });
  }

  for (const [key, ids] of byKey.entries()) {
    const matches = grouped.get(key) || [];
    const distinct = [...new Set(matches.map(m => `${m.firstName}|${m.lastName}`))];
    const owner = distinct.length === 1 ? matches[0] : null;
    ids.forEach(id => result.set(id, owner));
  }
  return result;
}

module.exports = {
  buildRealAcctHeaderIndex,
  parseRealAcctLine,
  parseRealAcctOwnerLine,
  parseRealAcctParcelAgeLine,
  aggregateZipValues,
  getRealHcadZipStats,
  getRealHcadZipStatsForZips,
  upsertZipStats,
  replaceOwnerParcels,
  replaceParcelAges,
  getParcelAgesForZips,
  findConfidentOwners
};
