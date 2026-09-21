// Loads real ZIP-code coordinates so vendors can be ranked by distance to
// active job sites.
//
// Source: US Census Bureau ZIP Code Tabulation Area gazetteer (public domain,
// interior point of each ZCTA). It only knows ZIPs, not city names, so a
// city's location is derived from the vendor records themselves: the average
// of the ZIP centroids seen for that city across the directories. That is
// used only for businesses whose record has a city but no ZIP. Only Texas
// (75xxx-79xxx) ZIPs are used, and the median, so a record with a wrong ZIP can't skew a city.
//
// Run with the environment loaded:  set -a; . ./.env; set +a; node scripts/importZipCentroids.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { query } = require('../db');
const { SOURCES, METRO_CITIES } = require('../lib/vendorDirectories');
const markets = require('../lib/markets');
const ALL_CITIES = markets.union(METRO_CITIES, 'cities');

const URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip';

async function loadZips(log) {
  const tmp = path.join(os.tmpdir(), `zcta-${process.pid}.zip`);
  const r = await fetch(URL, { headers: { 'User-Agent': 'EagleI (https://myeaglei.com)' } });
  if (!r.ok) throw new Error(`Census download failed (${r.status})`);
  fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  const text = execFileSync('unzip', ['-p', tmp], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  fs.unlinkSync(tmp);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split('\t').map(h => h.trim());
  const iZip = header.indexOf('GEOID'), iLat = header.indexOf('INTPTLAT'), iLng = header.indexOf('INTPTLONG');
  if (iZip < 0 || iLat < 0 || iLng < 0) throw new Error('Unexpected gazetteer columns: ' + header.join(','));
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = line.split('\t').map(s => s.trim());
    const lat = Number(c[iLat]), lng = Number(c[iLng]);
    if (/^\d{5}$/.test(c[iZip]) && Number.isFinite(lat) && Number.isFinite(lng)) rows.push([c[iZip], lat, lng]);
  }
  log(`Parsed ${rows.length.toLocaleString()} ZIP centroids.`);
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const ph = chunk.map((r, j) => { values.push(r[0], r[1], r[2]); return `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`; });
    await query(`INSERT INTO zip_centroids (czip, clat, clng) VALUES ${ph.join(',')}
                 ON CONFLICT (czip) DO UPDATE SET clat = EXCLUDED.clat, clng = EXCLUDED.clng`, values);
  }
  return rows.length;
}

async function buildCityCentroids(log) {
  const pairs = new Map(); // "CITY|zip" -> true
  const seenTables = new Set();
  for (const s of Object.values(SOURCES)) {
    if (!s.lookup || s.lookup.zip === 'NULL' || s.lookup.city === 'NULL' || seenTables.has(s.table)) continue;
    seenTables.add(s.table);
    const r = await query(
      `SELECT DISTINCT UPPER(TRIM(${s.lookup.city})) AS city, LEFT(${s.lookup.zip}, 5) AS zip
       FROM ${s.table}
       WHERE UPPER(TRIM(${s.lookup.city})) = ANY($1) AND ${s.lookup.zip} IS NOT NULL AND LEFT(${s.lookup.zip}, 5) ~ '^7[5-9][0-9]{3}$'`,
      [ALL_CITIES]);
    for (const row of r.rows) pairs.set(`${row.city}|${row.zip}`, [row.city, row.zip]);
  }
  const byCity = new Map();
  const zips = [...new Set([...pairs.values()].map(p => p[1]))];
  const cent = new Map((await query('SELECT czip, clat, clng FROM zip_centroids WHERE czip = ANY($1)', [zips]))
    .rows.map(x => [x.czip, [Number(x.clat), Number(x.clng)]]));
  for (const [city, zip] of pairs.values()) {
    const c = cent.get(zip);
    if (!c) continue;
    const e = byCity.get(city) || { lats: [], lngs: [] };
    e.lats.push(c[0]); e.lngs.push(c[1]);
    byCity.set(city, e);
  }
  // Median, not mean: a stray record with the wrong ZIP must not drag a city across the state.
  const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  for (const [city, e] of byCity) {
    await query(`INSERT INTO city_centroids (ccity, clat, clng, zips_used) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (ccity) DO UPDATE SET clat = EXCLUDED.clat, clng = EXCLUDED.clng, zips_used = EXCLUDED.zips_used`,
      [city, median(e.lats).toFixed(6), median(e.lngs).toFixed(6), e.lats.length]);
  }
  log(`Derived ${byCity.size} city centres from vendor ZIPs.`);
  return byCity.size;
}

if (require.main === module) {
  (async () => {
    const log = (m) => console.log(m);
    await loadZips(log);
    await buildCityCentroids(log);
    process.exit(0);
  })().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { loadZips, buildCityCentroids };
