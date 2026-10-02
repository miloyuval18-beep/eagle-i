#!/usr/bin/env node
// Builds data/sd_zip_values.json: per-ZIP home-value stats for San Diego County,
// from the PUBLIC SANDAG/SanGIS parcel layers (geo.sandag.org -- the regional
// open-data release, which has the owner names removed). Only single-family
// parcels (ASR_LANDUSE 11) are read, and only the handful of fields needed:
// ZIP, community, assessed value, and the recording date of the last transfer.
//
// Why "recently recorded" assessed value and not all parcels: California
// reassesses a home to its purchase price when it sells and then caps growth
// (Prop 13), so the assessed value of a home nobody has bought in 20 years is
// far below what it is worth. For homes whose last transfer was recorded in
// the last few years, the assessed value is close to what they actually sold
// for, so that subset's median is a usable "how expensive is this area" signal.
// ZIPs with too few recent transfers are left without a value rather than
// guessed at.
//
// No owner fields are requested. This is a manual, occasional run (the numbers
// move slowly), and the output file is committed.
//
// Usage: node scripts/importSdZipValues.js [--years=4] [--out=data/sd_zip_values.json]

const fs = require('fs');
const path = require('path');

const LAYERS = ['Parcels_South', 'Parcels_North', 'Parcels_East'];
const BASE = 'https://geo.sandag.org/server/rest/services/Hosted';
const FIELDS = 'objectid,situs_zip,situs_community,asr_total,docdate,doctype';
const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : dflt; };
const YEARS = parseInt(arg('years', '4'), 10);
const OUT = path.join(__dirname, '..', arg('out', 'data/sd_zip_values.json'));
const MIN_RECENT = 30; // fewer recent transfers than this and the ZIP gets no value

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

async function getJson(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'ArcGIS error');
      return j;
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
}

// docdate is MMDDYY. Two-digit years 00-26 are read as 2000-2026 (recent), the
// rest as 1900s, which is safe here because this only decides "is it recent".
function docYear(docdate) {
  const d = String(docdate || '').trim();
  if (!/^\d{6}$/.test(d)) return null;
  const yy = parseInt(d.slice(4), 10);
  return yy <= 26 ? 2000 + yy : 1900 + yy;
}

async function main() {
  const nowYear = new Date().getFullYear();
  const fromYear = nowYear - YEARS;
  const zips = new Map(); // zip -> { all: [], recent: [], comm: Map }
  let total = 0;
  for (const layer of LAYERS) {
    for (let off = 0; ; ) {
      const q = new URLSearchParams({
        where: "asr_landuse = 11 AND asr_total > 0 AND situs_zip IS NOT NULL", outFields: FIELDS, returnGeometry: 'false',
        orderByFields: 'objectid', resultOffset: String(off), resultRecordCount: '2000', f: 'json'
      });
      const j = await getJson(`${BASE}/${layer}/FeatureServer/0/query?${q}`);
      const rows = (j.features || []).map(f => f.attributes);
      for (const r of rows) {
        const zip = String(r.situs_zip || '').trim().slice(0, 5);
        if (!/^9\d{4}$/.test(zip)) continue;
        if (!zips.has(zip)) zips.set(zip, { all: 0, recent: [], comm: new Map() });
        const z = zips.get(zip);
        z.all++;
        const comm = String(r.situs_community || '').trim();
        if (comm) z.comm.set(comm, (z.comm.get(comm) || 0) + 1);
        const y = docYear(r.docdate);
        if (r.doctype === '1' && y !== null && y >= fromYear) z.recent.push(r.asr_total);
      }
      total += rows.length; off += rows.length;
      process.stdout.write(`\r${layer}: ${total.toLocaleString()} single-family parcels read`);
      if (!j.exceededTransferLimit || !rows.length) break;
    }
  }
  console.log();
  const out = { source: 'SANDAG/SanGIS public parcel layers (geo.sandag.org)', generatedAt: new Date().toISOString().slice(0, 10), recentSinceYear: fromYear, minRecent: MIN_RECENT, zips: {} };
  for (const [zip, z] of [...zips.entries()].sort()) {
    const community = [...z.comm.entries()].sort((a, b) => b[1] - a[1])[0];
    out.zips[zip] = {
      singleFamilyParcels: z.all,
      recentTransfers: z.recent.length,
      medianRecentValue: z.recent.length >= MIN_RECENT ? median(z.recent) : null,
      community: community ? community[0] : null
    };
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  const valued = Object.values(out.zips).filter(z => z.medianRecentValue);
  console.log(`Wrote ${OUT}: ${Object.keys(out.zips).length} ZIPs, ${valued.length} with a value (>= ${MIN_RECENT} recent transfers).`);
}

main().catch(e => { console.error('Import failed:', e.message); process.exit(1); });
