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

module.exports = {
  buildRealAcctHeaderIndex,
  parseRealAcctLine,
  aggregateZipValues,
  getRealHcadZipStats,
  getRealHcadZipStatsForZips,
  upsertZipStats
};
