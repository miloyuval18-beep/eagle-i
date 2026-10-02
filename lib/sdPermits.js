// Real, current City of San Diego building-permit data, from the city's own
// Open Data Portal (data.sandiego.gov -> "Approvals for development projects"),
// which Development Services refreshes daily. This is the San Diego counterpart
// of lib/houstonPermits.js and returns records in exactly the same shape, so the
// Permits page, the permit-spike detector and the mailer work on either.
//
// What the file has (confirmed by downloading and profiling the real 2026 file):
// an approval id, approval type, issue date, a street address (usually with
// city/state/ZIP, sometimes without the ZIP), the assessor's parcel number, a
// valuation on about 40% of building permits, the job's description, and the
// permit holder's name -- which is often a contractor or company rather than the
// homeowner, so it is deliberately NOT used to address mail. It has no ZIP
// column; ZIPs come from the address text, and for the rest from the public
// SANDAG parcel layer by parcel number (which also supplies the street address
// for the many no-plan permits that carry only a parcel number).
//
// Coverage: the City of San Diego only. Chula Vista, Oceanside, Escondido,
// Carlsbad and the unincorporated county publish their permits separately.
const { parseCsvStream, responseTextChunks } = require('./csvStream');

const BASE = 'https://seshat.datasd.org/development_permits';
const PARCEL_LAYERS = ['Parcels_South', 'Parcels_North', 'Parcels_East'];
const PARCEL_URL = (layer) => `https://geo.sandag.org/server/rest/services/Hosted/${layer}/FeatureServer/0/query`;
const UA = 'EagleI (https://myeaglei.com, admin@myeaglei.com)';
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // the source updates daily; twice a day is plenty
const DAY = 86400000;

let cache = { records: [], fetchedAt: null, failures: [] };
const apnInfo = new Map(); // parcel number -> { zip, address } (null = looked up, not found); parcels do not move

// Permit types a home-services business can act on: building and trade permits
// on houses, plus demolitions. Traffic control, street work, noise, fire-system,
// sign and paperwork approvals are about the same address but are not
// renovation work, so they are left out. Residential solar auto-approvals are
// left out too (thousands a year, and not a sign of a project to bid).
const KEEP_TYPES = [
  /^Building Permit$/i, /^Combination Building Permit$/i, /^Electrical Pmt$/i, /^Plumbing Pmt$/i, /^Mechanical Pmt$/i,
  /^No-Plan - Residential/i, /Demolition Pmt/i
];
// The job description says when a "building permit" is really a tenant
// improvement or other non-residential job.
const DROP_JOBS = /non-?res|tenant improvement|five or more|3\+ fam/i;

const TYPE_LABELS = {
  'No-Plan - Residential - Combination Mech/Elec/Plum': 'Residential Mechanical / Electrical / Plumbing',
  'Combination Building Permit': 'Building Permit (Combination)',
  'Electrical Pmt': 'Electrical Permit', 'Plumbing Pmt': 'Plumbing Permit', 'Mechanical Pmt': 'Mechanical (HVAC) Permit',
  'Approval - Construction - Demolition Pmt': 'Demolition Permit'
};

const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s'’(\/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const properStreet = (s) => (s === s.toUpperCase() ? titleCase(s).replace(/\b(Ne|Nw|Se|Sw)\b/g, m => m.toUpperCase()) : s);

// "5295 Joan Ct, San Diego, CA 92115" / "541 GRAVILLA ST " / "2310 CAMINO DEL RIO NORTH [Pending]"
// -> { street, zip }.
function parseAddress(raw) {
  let a = String(raw || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!a) return null;
  const zipMatch = a.match(/,\s*CA\s+(9\d{4})(?:-\d{4})?\s*$/i);
  const zip = zipMatch ? zipMatch[1] : null;
  const street = properStreet(a.split(',')[0].trim());
  if (!/^\d+/.test(street)) return null; // no street number = nothing to mail to
  return { street, zip };
}

// The scope text often starts with the community plan area: "COLLEGE AREA: No
// Plan combination building permit for...", "TORREY PINES; Building, Mechanical...".
function splitScope(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^([A-Z][A-Z .&\/'-]{2,40}?)\s*[:;]\s+(.*)$/);
  return m ? { community: titleCase(m[1].trim()), rest: m[2].trim() } : { community: null, rest: t };
}

function toRecord(r) {
  const type = (r.APPROVAL_TYPE || '').trim();
  if (!KEEP_TYPES.some(re => re.test(type))) return null;
  if (DROP_JOBS.test(r.JOB_BC_CODE_DESCRIPTION || '')) return null;
  const date = (r.APPROVAL_ISSUE_DATE || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // Most no-plan residential permits carry only a parcel number; their address
  // and ZIP are filled in from the parcel layer afterwards.
  const apn = String(r.GIS_APN || '').trim() || null;
  const addr = parseAddress(r.GIS_ADDRESS) || (apn ? { street: null, zip: null } : null);
  if (!addr) return null;
  const { community, rest } = splitScope(r.APPROVAL_SCOPE || r.PROJECT_SCOPE || '');
  const job = (r.JOB_BC_CODE_DESCRIPTION || '').trim();
  const valuation = parseFloat(r.APPROVAL_VALUATION);
  return {
    zip: addr.zip,                     // may be null here; filled from the parcel layer below
    apn,
    permitDate: date,
    permitType: TYPE_LABELS[type] || type,
    projectNo: String(r.APPROVAL_ID || '').trim() || null,
    address: addr.street,
    // The no-plan residential combination permits have no description at all; say what the type means.
    comments: (rest || job || (/^No-Plan - Residential/i.test(type) ? 'mechanical, electrical or plumbing work' : '')).slice(0, 220) || null,
    jobType: job || null,
    community,
    valuation: Number.isFinite(valuation) && valuation > 0 ? Math.round(valuation) : null
  };
}

async function fetchYear(year, onRecord) {
  const url = `${BASE}/approvals_issued_${year}_datasd.csv`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`San Diego permit file for ${year} failed to download (${r.status})`);
  let header = null;
  await parseCsvStream(responseTextChunks(r.body, 'utf-8'), (fields, n) => {
    if (n === 0) { header = fields.map(h => h.trim()); return; }
    const rec = {};
    header.forEach((h, i) => { rec[h] = fields[i] !== undefined ? fields[i] : ''; });
    onRecord(rec);
  });
}

// Street address and ZIP for permits whose address text lacked them, by parcel
// number. The parcel layers are the public SANDAG release (no owner names); a
// parcel can live in any of three regional layers, so all three are asked. Done
// in batches, and remembered for the life of the process.
const upperStreet = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function parcelAddress(a) {
  const num = a.situs_address;
  if (!num) return null;
  const parts = [num, upperStreet(a.situs_fraction), upperStreet(a.situs_pre_dir), upperStreet(a.situs_street), upperStreet(a.situs_suffix), upperStreet(a.situs_post_dir)].filter(Boolean);
  const street = parts.join(' ');
  return /^\d+/.test(street) && parts.length >= 2 ? properStreet(street) : null;
}

async function fillFromParcels(records) {
  const need = [...new Set(records.filter(r => (!r.zip || !r.address) && r.apn && /^\d{10}$/.test(r.apn) && !apnInfo.has(r.apn)).map(r => r.apn))];
  for (let i = 0; i < need.length; i += 150) {
    const batch = need.slice(i, i + 150);
    const where = `apn IN (${batch.map(a => `'${a}'`).join(',')})`;
    for (const layer of PARCEL_LAYERS) {
      try {
        const res = await fetch(PARCEL_URL(layer), {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: new URLSearchParams({ where, outFields: 'apn,situs_zip,situs_address,situs_fraction,situs_pre_dir,situs_street,situs_suffix,situs_post_dir', returnGeometry: 'false', f: 'json' })
        });
        const j = await res.json();
        for (const f of (j.features || [])) {
          const a = f.attributes;
          const z = String(a.situs_zip || '').trim().slice(0, 5);
          apnInfo.set(String(a.apn).trim(), { zip: /^9\d{4}$/.test(z) ? z : null, address: parcelAddress(a) });
        }
      } catch (e) { /* a layer being down just leaves those permits without an address this time */ }
    }
    for (const a of batch) if (!apnInfo.has(a)) apnInfo.set(a, null);
  }
  for (const r of records) {
    const info = r.apn && apnInfo.get(r.apn);
    if (!info) continue;
    if (!r.zip && info.zip) r.zip = info.zip;
    if (!r.address && info.address) r.address = info.address;
  }
}

// Permits issued in the most recent `weeksBack` weeks the city has published
// (counted back from the newest issue date in the file, not from today), cached
// in-process since this is shared city-wide data.
async function getRecentPermits({ weeksBack = 4, forceRefresh = false } = {}) {
  if (!forceRefresh && cache.fetchedAt && (Date.now() - cache.fetchedAt) < CACHE_MAX_AGE_MS && cache.weeksBack === weeksBack) return cache;

  const year = new Date().getFullYear();
  const all = [];
  const failures = [];
  try { await fetchYear(year, (rec) => { const r = toRecord(rec); if (r) all.push(r); }); }
  catch (e) { failures.push({ url: `${BASE}/approvals_issued_${year}_datasd.csv`, error: e.message }); }
  let newest = all.reduce((m, r) => (r.permitDate > m ? r.permitDate : m), '');
  // Early in January the current year's file is nearly empty; reach into last year's.
  if (!newest || (new Date(newest).getTime() - new Date(`${year}-01-01`).getTime()) < weeksBack * 7 * DAY) {
    try { await fetchYear(year - 1, (rec) => { const r = toRecord(rec); if (r) all.push(r); }); }
    catch (e) { failures.push({ url: `${BASE}/approvals_issued_${year - 1}_datasd.csv`, error: e.message }); }
    newest = all.reduce((m, r) => (r.permitDate > m ? r.permitDate : m), '');
  }
  if (!all.length && failures.length) {
    if (cache.fetchedAt) return { ...cache, failures }; // serve what we had rather than nothing
    throw new Error(failures[0].error);
  }

  const cutoff = newest ? new Date(new Date(newest).getTime() - (weeksBack * 7 - 1) * DAY).toISOString().slice(0, 10) : '';
  const records = all.filter(r => r.permitDate >= cutoff);
  await fillFromParcels(records);
  // A permit we cannot place at a street address and ZIP is of no use for mail or area filtering.
  const withZip = records.filter(r => r.zip && r.address);

  cache = { records: withZip, fetchedAt: Date.now(), failures, weeksBack, droppedNoZip: records.length - withZip.length };
  return cache;
}

module.exports = { getRecentPermits, parseAddress, splitScope, toRecord, KEEP_TYPES };
