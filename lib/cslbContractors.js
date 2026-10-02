// Real California licensed contractors from the Contractors State License
// Board's public master list -- see migrations/1760200000000_california_license_sources.js
// for what the file is and what it does not have (no email).
//
// The portal is a plain ASP.NET page: pick "License Master" from a drop-down
// (which posts the form back), then click the CSV link (which posts again and
// answers with the file). No login, no CAPTCHA, no fee -- it is the board's own
// public download, used the way the page offers it.
const https = require('https');
const { query } = require('../db');
const markets = require('./markets');
const { parseCsvStream, responseTextChunks } = require('./csvStream');

const PAGE_URL = 'https://www.cslb.ca.gov/onlineservices/dataportal/ContractorList';
const UA = 'EagleI (https://myeaglei.com, admin@myeaglei.com)';

// The trade classifications a general contractor actually deals with, keyed the
// way the directory panel keys them. `code` is the CSLB classification with the
// hyphen dropped (the file writes both "C10" and "C-10").
const CLASSES = {
  general:     { code: 'B',   label: 'General Contractors',           noun: 'general contractor' },
  remodeling:  { code: 'B2',  label: 'Residential Remodeling',        noun: 'residential remodeling contractor' },
  electrical:  { code: 'C10', label: 'Electricians',                  noun: 'electrical contractor' },
  plumbing:    { code: 'C36', label: 'Plumbers',                      noun: 'plumbing contractor' },
  hvac:        { code: 'C20', label: 'HVAC Contractors',              noun: 'HVAC contractor' },
  roofing:     { code: 'C39', label: 'Roofers',                       noun: 'roofing contractor' },
  painting:    { code: 'C33', label: 'Painters',                      noun: 'painting contractor' },
  flooring:    { code: 'C15', label: 'Flooring',                      noun: 'flooring contractor' },
  tile:        { code: 'C54', label: 'Tile',                          noun: 'tile contractor' },
  concrete:    { code: 'C8',  label: 'Concrete',                      noun: 'concrete contractor' },
  masonry:     { code: 'C29', label: 'Masonry',                       noun: 'masonry contractor' },
  framing:     { code: 'C5',  label: 'Framing & Rough Carpentry',     noun: 'framing contractor' },
  carpentry:   { code: 'C6',  label: 'Cabinets & Finish Carpentry',   noun: 'finish carpentry contractor' },
  drywall:     { code: 'C9',  label: 'Drywall',                       noun: 'drywall contractor' },
  plastering:  { code: 'C35', label: 'Plastering & Stucco',           noun: 'plastering contractor' },
  insulation:  { code: 'C2',  label: 'Insulation',                    noun: 'insulation contractor' },
  glazing:     { code: 'C17', label: 'Glazing & Windows',             noun: 'glazing contractor' },
  fencing:     { code: 'C13', label: 'Fencing',                       noun: 'fencing contractor' },
  landscaping: { code: 'C27', label: 'Landscaping',                   noun: 'landscape contractor' },
  pool:        { code: 'C53', label: 'Swimming Pools',                noun: 'pool contractor' },
  earthwork:   { code: 'C12', label: 'Earthwork & Paving',            noun: 'earthwork and paving contractor' },
  demolition:  { code: 'C21', label: 'Demolition',                    noun: 'demolition contractor' },
  solar:       { code: 'C46', label: 'Solar',                         noun: 'solar contractor' }
};

const normClass = (c) => String(c || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const clean = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };

// "MM/DD/YYYY" (sometimes with stray spaces) -> "YYYY-MM-DD", else null.
function parseDate(str) {
  const m = String(str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
const digits = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 ? d : (d.length === 11 && d[0] === '1' ? d.slice(1) : null); };

// One CSV record (an object keyed by the header names) -> a row for the table.
function parseRecord(rec) {
  const licenseNo = clean(rec.LicenseNo);
  if (!licenseNo) return null;
  const tradeName = clean(rec.BusinessName);
  const fullName = clean(rec.FullBusinessName);   // set for sole owners: their own name, in reading order
  const secondName = clean(rec['BUS-NAME-2']);    // the registered legal name when BusinessName is a trade name
  const displayName = fullName || tradeName;
  if (!displayName) return null;
  // A sole owner's license in their own name: keep the first name for the greeting.
  // A "full name" that is really a company ("M CASTRO PLUMBING") is not a person's name.
  const BUSINESSY = /\b(inc|llc|corp|co|company|construction|plumbing|electric|electrical|roofing|painting|landscap\w*|services?|builders?|contracting|contractors?|remodel\w*|pools?|concrete|tile|flooring|heating|air|hvac|enterprises?|design|solar|fence|fencing|masonry|drywall)\b/i;
  const personFirst = fullName && clean(rec.BusinessType) === 'Sole Owner' && !BUSINESSY.test(fullName) && fullName.split(/\s+/)[0].length >= 2
    ? fullName.split(/\s+/)[0] : null;
  return {
    licenseNo,
    displayName,
    firstName: personFirst ? personFirst.charAt(0) + personFirst.slice(1).toLowerCase() : null,
    legalName: secondName && secondName.toUpperCase() !== displayName.toUpperCase() ? secondName : null,
    mailingAddress: clean(rec.MailingAddress),
    city: clean(rec.City),
    county: clean(rec.County),
    zip: clean(rec.ZIPCode) && String(rec.ZIPCode).trim().slice(0, 10),
    phone: digits(rec.BusinessPhone),
    businessType: clean(rec.BusinessType),
    issueDate: parseDate(rec.IssueDate),
    expirationDate: parseDate(rec.ExpirationDate),
    primaryStatus: clean(rec.PrimaryStatus),
    classifications: [...new Set(String(rec['Classifications(s)'] || '').split('|').map(normClass).filter(Boolean))],
    wcCoverageType: clean(rec.WorkersCompCoverageType),
    wcExpirationDate: parseDate(rec.WCExpirationDate)
  };
}

// The portal's firewall answers 503 to Node's built-in fetch (it adds browser
// "sec-fetch-*" headers the portal does not expect) but serves the same request
// made with the plain https module, so that is what talks to it.
function httpsRequest(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { 'User-Agent': UA, ...headers };
    if (body !== null) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h }, resolve);
    req.setTimeout(120000, () => req.destroy(new Error('CSLB request timed out.')));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
const readAll = async (res) => { const parts = []; for await (const c of res) parts.push(c); return Buffer.concat(parts).toString('utf8'); };

// Walks the portal's two postbacks and streams the License Master CSV, handing
// every row of the wanted counties to `onRecord`. Rows of other counties are
// dropped as they stream past, so memory stays flat.
async function streamMasterList({ counties, onRecord, log = () => {} }) {
  let cookies = '';
  const remember = (res) => {
    const set = res.headers['set-cookie'] || [];
    if (set.length) cookies = [cookies, ...set.map(c => c.split(';')[0])].filter(Boolean).join('; ');
  };
  const field = (html, name) => {
    const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
    if (!m) throw new Error(`CSLB data portal page changed (no ${name} field).`);
    return m[1];
  };
  const post = (html, extra) => {
    const body = new URLSearchParams({
      __VIEWSTATE: field(html, '__VIEWSTATE'), __VIEWSTATEGENERATOR: field(html, '__VIEWSTATEGENERATOR'),
      __EVENTVALIDATION: field(html, '__EVENTVALIDATION'), 'ctl00$MainContent$ddlStatus': 'M', __EVENTARGUMENT: '', ...extra
    }).toString();
    return httpsRequest('POST', PAGE_URL, { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookies ? { Cookie: cookies } : {}) }, body);
  };

  const first = await httpsRequest('GET', PAGE_URL);
  if (first.statusCode !== 200) throw new Error(`CSLB data portal failed to load (${first.statusCode}).`);
  remember(first);
  let html = await readAll(first);
  const picked = await post(html, { __EVENTTARGET: 'ctl00$MainContent$ddlStatus' });
  if (picked.statusCode !== 200) throw new Error(`CSLB data portal rejected the file choice (${picked.statusCode}).`);
  remember(picked);
  html = await readAll(picked);
  log('Downloading the CSLB license master list (about 75MB)...');
  let file = await post(html, { __EVENTTARGET: 'ctl00$MainContent$lbMasterCSV' });
  // The button answers with a redirect to the file's own download address.
  if (file.statusCode >= 300 && file.statusCode < 400 && file.headers.location) {
    file.resume();
    file = await httpsRequest('GET', new URL(file.headers.location, PAGE_URL).toString(), cookies ? { Cookie: cookies } : {});
  }
  if (file.statusCode !== 200 || !/csv/i.test(file.headers['content-type'] || '')) {
    file.resume();
    throw new Error(`CSLB did not return the CSV (${file.statusCode}, ${file.headers['content-type']}).`);
  }

  const want = new Set(counties.map(c => c.toUpperCase()));
  let header = null, countyIdx = -1, seen = 0, kept = 0;
  await parseCsvStream(responseTextChunks(file, 'utf-8'), (fields, n) => {
    if (n === 0) { header = fields.map(h => h.trim()); countyIdx = header.indexOf('County'); if (countyIdx < 0) throw new Error('CSLB file has no County column.'); return; }
    seen++;
    if (!want.has((fields[countyIdx] || '').trim().toUpperCase())) return;
    const rec = {};
    header.forEach((h, i) => { rec[h] = fields[i] !== undefined ? fields[i] : ''; });
    kept++;
    onRecord(rec);
  });
  log(`  ${seen.toLocaleString()} licenses in the file, ${kept.toLocaleString()} in the markets we serve.`);
  return { seen, kept };
}

async function upsertContractors(rows) {
  const CHUNK = 500;
  const COLS = 17;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((r, j) => {
      const base = j * COLS;
      values.push(r.licenseNo, r.displayName, r.firstName, r.legalName, r.mailingAddress, r.city, r.county, r.zip, r.phone, r.businessType,
        r.issueDate, r.expirationDate, r.primaryStatus, r.classifications, r.wcCoverageType, r.wcExpirationDate, true);
      return `(${Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`).join(', ')})`;
    });
    // Contact columns (website, email, rating...) are never touched here, so
    // what a Google lookup already found survives every re-import.
    await query(
      `INSERT INTO cslb_contractors
         (license_no, display_name, first_name, legal_name, mailing_address, city, county, zip, phone, business_type,
          issue_date, expiration_date, primary_status, classifications, wc_coverage_type, wc_expiration_date, active)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (license_no) DO UPDATE SET
         display_name = EXCLUDED.display_name, first_name = EXCLUDED.first_name, legal_name = EXCLUDED.legal_name, mailing_address = EXCLUDED.mailing_address,
         city = EXCLUDED.city, county = EXCLUDED.county, zip = EXCLUDED.zip, phone = COALESCE(EXCLUDED.phone, cslb_contractors.phone),
         business_type = EXCLUDED.business_type, issue_date = EXCLUDED.issue_date, expiration_date = EXCLUDED.expiration_date,
         primary_status = EXCLUDED.primary_status, classifications = EXCLUDED.classifications,
         wc_coverage_type = EXCLUDED.wc_coverage_type, wc_expiration_date = EXCLUDED.wc_expiration_date,
         active = true, imported_at = now()`,
      values
    );
  }
}

async function getLastImportCompletedAt() {
  const r = await query('SELECT completed_at FROM cslb_import_state ORDER BY completed_at DESC LIMIT 1');
  return r.rows[0] ? r.rows[0].completed_at : null;
}

async function runFullImport({ dryRun = false, log = () => {} } = {}) {
  const startedAt = (await query('SELECT now() AS t')).rows[0].t; // DB clock, not this process's
  const counties = markets.countiesInState('CA');
  const byLicense = new Map();
  // A 75MB download over a government server occasionally drops; start over
  // (nothing is written until it has all arrived).
  let seen = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      byLicense.clear();
      ({ seen } = await streamMasterList({
        counties, log,
        onRecord: (rec) => { const row = parseRecord(rec); if (row) byLicense.set(row.licenseNo, row); }
      }));
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      log(`  Download failed (${err.message}); trying again...`);
      await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
  const rows = [...byLicense.values()];
  const good = rows.filter(r => r.primaryStatus === 'CLEAR').length;
  log(`Parsed ${rows.length.toLocaleString()} licenses (${good.toLocaleString()} in good standing) for ${counties.join(', ')} counties.`);
  if (dryRun) { log('--dry-run: not writing to the database.'); return { total: rows.length, inGoodStanding: good, seen }; }

  await upsertContractors(rows);
  // A license that dropped off the board's list (cancelled, or expired past renewal) is flagged, not deleted.
  const gone = await query('UPDATE cslb_contractors SET active = false WHERE active = true AND imported_at < $1', [startedAt]);
  log(`Flagged ${gone.rowCount} licenses no longer listed.`);
  await query('INSERT INTO cslb_import_state (total_count) VALUES ($1)', [rows.length]);
  return { total: rows.length, inGoodStanding: good, seen, deactivated: gone.rowCount };
}

module.exports = { CLASSES, normClass, parseRecord, parseDate, streamMasterList, upsertContractors, getLastImportCompletedAt, runFullImport };
