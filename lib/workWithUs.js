// "Work with us": a public page a company can point vendors to (and print as a
// QR code on mailed letters) where a vendor sends its details, a portfolio,
// its licence and proof of insurance.
//
// The page and its upload endpoint are public, so they are locked down:
//  - only PDF, JPEG and PNG files, identified by their first bytes (not the
//    file name or the type the browser claims), each up to 2.5 MB;
//  - a per-address rate limit, a hidden trap field for robots, and a cap on how
//    much one company can store;
//  - files are only ever served back to the owner, as downloads, never rendered
//    on this site;
//  - everything a visitor types is escaped wherever it is shown.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('./email');
const relationships = require('./relationships');

const MAX_FILE_BYTES = 2.5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 7 * 1024 * 1024;
const MAX_FILES = 4;
const MAX_SUBMISSIONS_PER_TENANT = 300;
const MAX_STORED_BYTES_PER_TENANT = 80 * 1024 * 1024;
const KINDS = ['portfolio', 'license', 'insurance'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (message, status, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
const oneLine = (s, n) => String(s == null ? '' : s).split('').filter(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join('').replace(/\s+/g, ' ').trim().slice(0, n);

// Keeps line breaks, drops other control characters.
const multiLine = (s, n) => String(s == null ? '' : s).split('').filter(ch => { const c = ch.charCodeAt(0); return c === 10 || c === 13 || c === 9 || (c >= 32 && c !== 127); }).join('').trim().slice(0, n);

const DEFAULT_INTRO = 'We are always looking for skilled trade partners, designers and suppliers to work with. Tell us about your company and send a few samples of your work, your license and proof of insurance. We read every submission.';

// What a file really is, from its first bytes.
function sniffType(buf) {
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  return null;
}

const safeFilename = (name, ext, kind) => {
  const base = oneLine(name, 80).replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[a-z0-9]{1,5}$/i, '').trim() || kind;
  return `${base}.${ext}`;
};

function slugify(name) {
  return String(name || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'company';
}

async function getSettings(tenantId) {
  const r = await query(
    `SELECT bp.work_page_enabled AS enabled, bp.work_page_slug AS slug, bp.work_page_intro AS intro, t.company_name
     FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [tenantId]);
  const row = r.rows[0];
  if (!row) return null;
  const counts = (await query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'new')::int AS fresh FROM vendor_submissions WHERE tenant_id = $1", [tenantId])).rows[0];
  return { enabled: !!row.enabled, slug: row.slug || null, intro: row.intro || '', defaultIntro: DEFAULT_INTRO, total: counts.total, fresh: counts.fresh };
}

async function saveSettings(tenantId, { enabled, intro }) {
  const cur = (await query('SELECT bp.work_page_slug AS slug, t.company_name FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1', [tenantId])).rows[0];
  if (!cur) throw fail('Tenant not found.', 404);
  let slug = cur.slug;
  if (enabled === true && !slug) {
    for (let i = 0; i < 6 && !slug; i++) {
      const candidate = `${slugify(cur.company_name)}-${crypto.randomBytes(3).toString('hex')}`;
      if (!(await query('SELECT 1 FROM business_profile WHERE work_page_slug = $1', [candidate])).rows.length) slug = candidate;
    }
    if (!slug) throw fail('Could not create a page address. Try again.', 500);
  }
  const cleanIntro = intro === undefined ? undefined : String(intro).trim().slice(0, 800);
  if (typeof enabled === 'boolean') await query('UPDATE business_profile SET work_page_enabled = $1, work_page_slug = $2 WHERE tenant_id = $3', [enabled, slug, tenantId]);
  if (cleanIntro !== undefined) await query('UPDATE business_profile SET work_page_intro = $1 WHERE tenant_id = $2', [cleanIntro || null, tenantId]);
  return getSettings(tenantId);
}

async function getPublicPage(slug) {
  const r = await query(
    `SELECT t.id AS tenant_id, t.company_name, bp.work_page_intro AS intro, bp.service_area
     FROM business_profile bp JOIN tenants t ON t.id = bp.tenant_id
     WHERE bp.work_page_slug = $1 AND bp.work_page_enabled = true`, [slug]);
  return r.rows[0] || null;
}

// Decodes and checks the uploaded files; throws a friendly error for the first problem.
function checkFiles(files) {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files) || files.length > MAX_FILES) throw fail(`You can attach up to ${MAX_FILES} files.`, 400);
  let total = 0;
  const out = [];
  for (const f of files) {
    const kind = KINDS.includes(f && f.kind) ? f.kind : 'portfolio';
    const b64 = String(f && f.data || '');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw fail('One of the files could not be read. Try attaching it again.', 400);
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw fail('One of the files is empty.', 400);
    if (buf.length > MAX_FILE_BYTES) throw fail('Each file can be up to 2.5 MB. Send a smaller or compressed copy, or include a link to it in your message.', 400, 'file_too_big');
    total += buf.length;
    if (total > MAX_TOTAL_BYTES) throw fail('The files together are too large. Keep the total under 7 MB.', 400, 'file_too_big');
    const kindOfFile = sniffType(buf);
    if (!kindOfFile) throw fail('Files must be PDF, JPG or PNG.', 400, 'bad_file_type');
    out.push({ kind, buf, type: kindOfFile.type, filename: safeFilename(f.name, kindOfFile.ext, kind) });
  }
  return out;
}

async function submit(slug, body, { send = sendEmail, baseUrl = '' } = {}) {
  const page = await getPublicPage(slug);
  if (!page) throw fail('This page is not available.', 404);
  const b = body || {};
  const companyName = oneLine(b.companyName, 120);
  const email = oneLine(b.email, 200).toLowerCase();
  if (!companyName) throw fail('Please tell us your company name.', 400);
  if (!EMAIL_RE.test(email)) throw fail('Please enter an email address we can reach you at.', 400);
  const files = checkFiles(b.files);

  const used = (await query(
    `SELECT COUNT(DISTINCT s.id)::int AS n, COALESCE(SUM(f.size), 0)::bigint AS bytes
     FROM vendor_submissions s LEFT JOIN vendor_submission_files f ON f.submission_id = s.id WHERE s.tenant_id = $1`, [page.tenant_id])).rows[0];
  if (used.n >= MAX_SUBMISSIONS_PER_TENANT || Number(used.bytes) + files.reduce((a, f) => a + f.buf.length, 0) > MAX_STORED_BYTES_PER_TENANT) {
    throw fail('This company is not accepting new submissions right now. Please email them directly.', 503, 'full');
  }

  const website = oneLine(b.website, 200);
  const s = (await query(
    `INSERT INTO vendor_submissions (tenant_id, company_name, contact_name, email, phone, trade, website, message, via)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [page.tenant_id, companyName, oneLine(b.contactName, 120) || null, email, oneLine(b.phone, 40) || null, oneLine(b.trade, 80) || null,
     website || null, multiLine(b.message, 2000) || null, b.via === 'qr' ? 'qr' : 'link'])).rows[0];
  for (const f of files) {
    await query('INSERT INTO vendor_submission_files (submission_id, kind, filename, content_type, size, data) VALUES ($1,$2,$3,$4,$5,$6)',
      [s.id, f.kind, f.filename, f.type, f.buf.length, f.buf]);
  }
  // They reached out, so they go straight into the relationship tracker.
  relationships.upsert(page.tenant_id, {
    source: 'inbound', sourceId: s.id, name: companyName, email, phone: oneLine(b.phone, 40) || undefined, stage: 'replied',
    notes: `Came in through your Work With Us page${b.via === 'qr' ? ' (scanned the QR code on a mailed letter)' : ''}.${b.trade ? ' Trade: ' + oneLine(b.trade, 80) + '.' : ''}`
  }).catch(err => console.error('[workWithUs] relationship failed:', err.message));
  alertOwner({ tenantId: page.tenant_id, companyName: page.company_name, submission: { companyName, email, phone: oneLine(b.phone, 40), trade: oneLine(b.trade, 80), fileCount: files.length, via: b.via === 'qr' ? 'qr' : 'link' }, baseUrl, send })
    .catch(err => console.error('[workWithUs] alert failed:', err.message));
  return { id: Number(s.id) };
}

async function alertOwner({ tenantId, companyName, submission, baseUrl, send }) {
  const r = await query(
    `SELECT bp.email AS profile_email, (SELECT u.email FROM users u WHERE u.tenant_id = $1 ORDER BY u.created_at ASC LIMIT 1) AS account_email
     FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [tenantId]);
  const to = [r.rows[0] && r.rows[0].profile_email, r.rows[0] && r.rows[0].account_email].find(e => e && EMAIL_RE.test(e.trim()));
  if (!to) return;
  const line = (k, v) => (v ? `<tr><td style="padding:3px 14px 3px 0;color:#5a7290">${k}</td><td>${esc(v)}</td></tr>` : '');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#12203a;line-height:1.5">
<p style="font-size:16px;margin:0 0 4px"><b>A vendor sent you their details</b></p>
<p style="margin:0 0 14px;color:#5a7290">Through the Work With Us page for ${esc(companyName)}${submission.via === 'qr' ? ' (they scanned the QR code on a mailed letter)' : ''}.</p>
<table style="border-collapse:collapse;font-size:14px">${line('Company', submission.companyName)}${line('Email', submission.email)}${line('Phone', submission.phone)}${line('Trade', submission.trade)}${line('Files', submission.fileCount ? `${submission.fileCount} attached` : '')}</table>
<p style="margin:18px 0 0"><a href="${esc(baseUrl || '')}/" style="color:#12203a">Open Eagle I</a> to read the message and download their files.</p>
</div>`;
  const text = `A vendor sent you their details through your Work With Us page.\n\nCompany: ${submission.companyName}\nEmail: ${submission.email}${submission.phone ? '\nPhone: ' + submission.phone : ''}${submission.trade ? '\nTrade: ' + submission.trade : ''}${submission.fileCount ? `\nFiles: ${submission.fileCount} attached` : ''}\n\nOpen Eagle I to read the message and download their files: ${baseUrl || ''}/`;
  await send({ to: to.trim(), subject: `New vendor submission: ${submission.companyName}`.slice(0, 150), html, text, fromName: 'Eagle I' });
}

async function listSubmissions(tenantId) {
  const subs = (await query('SELECT * FROM vendor_submissions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200', [tenantId])).rows;
  if (!subs.length) return [];
  const files = (await query('SELECT id, submission_id, kind, filename, content_type, size FROM vendor_submission_files WHERE submission_id = ANY($1) ORDER BY id', [subs.map(s => s.id)])).rows;
  return subs.map(s => ({
    id: Number(s.id), companyName: s.company_name, contactName: s.contact_name, email: s.email, phone: s.phone, trade: s.trade, website: s.website,
    message: s.message, via: s.via, status: s.status, createdAt: s.created_at,
    files: files.filter(f => f.submission_id === s.id).map(f => ({ id: Number(f.id), kind: f.kind, filename: f.filename, contentType: f.content_type, size: f.size }))
  }));
}

async function getFile(tenantId, submissionId, fileId) {
  const r = await query(
    `SELECT f.filename, f.content_type, f.data FROM vendor_submission_files f JOIN vendor_submissions s ON s.id = f.submission_id
     WHERE f.id = $1 AND s.id = $2 AND s.tenant_id = $3`, [fileId, submissionId, tenantId]);
  return r.rows[0] || null;
}

async function setStatus(tenantId, id, status) {
  if (!['new', 'reviewed', 'declined'].includes(status)) throw fail('Unknown status.', 400);
  const r = await query('UPDATE vendor_submissions SET status = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId, status]);
  if (!r.rows.length) throw fail('Not found.', 404);
}

async function removeSubmission(tenantId, id) {
  return (await query('DELETE FROM vendor_submissions WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rowCount;
}

// The public page. Everything interpolated is escaped.
function renderPage({ companyName, intro, serviceArea, slug }) {
  const e = esc;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Work with ${e(companyName)}</title>
<meta name="robots" content="noindex">
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f9;color:#12203a;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:24px;line-height:1.2;margin:8px 0 10px}
.intro{color:#41546e;margin:0 0 20px;white-space:pre-wrap}
form{background:#fff;border:1px solid #dfe6ee;border-radius:10px;padding:18px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 4px}
input[type=text],input[type=email],input[type=tel],input[type=url],textarea,select{width:100%;padding:11px 12px;border:1px solid #c5d0dd;border-radius:8px;font:inherit;background:#fff;color:inherit}
textarea{min-height:100px;resize:vertical}
.hint{font-size:12px;color:#6b7f98;margin:4px 0 0}
.files{border:1px dashed #b5c3d4;border-radius:8px;padding:12px;margin-top:6px}
.files label{margin:8px 0 3px;font-weight:500}
button{margin-top:20px;width:100%;padding:13px;border:0;border-radius:8px;background:#12203a;color:#fff;font:600 16px inherit;cursor:pointer}
button[disabled]{opacity:.6;cursor:default}
.msg{margin-top:14px;padding:11px 12px;border-radius:8px;font-size:14px;display:none}
.msg.err{display:block;background:#fdecec;color:#8a1f1f}
.msg.ok{display:block;background:#e7f6ec;color:#1d6b3a}
.trap{position:absolute;left:-9999px;height:0;overflow:hidden}
</style></head><body><div class="wrap">
<h1>Work with ${e(companyName)}</h1>
<p class="intro">${e(intro)}</p>
${serviceArea ? `<p class="hint" style="margin:-8px 0 16px">${e(companyName)} serves ${e(serviceArea)}.</p>` : ''}
<form id="f" novalidate>
<label for="companyName">Company name *</label><input id="companyName" type="text" maxlength="120" required autocomplete="organization">
<label for="contactName">Your name</label><input id="contactName" type="text" maxlength="120" autocomplete="name">
<label for="email">Email *</label><input id="email" type="email" maxlength="200" required autocomplete="email">
<label for="phone">Phone</label><input id="phone" type="tel" maxlength="40" autocomplete="tel">
<label for="trade">What do you do?</label><input id="trade" type="text" maxlength="80" placeholder="Electrician, architect, roofer, supplier...">
<label for="website">Website</label><input id="website" type="text" maxlength="200" placeholder="yourcompany.com">
<label for="message">Anything you would like us to know</label><textarea id="message" maxlength="2000"></textarea>
<label>Attach files (optional)</label>
<div class="files">
<label for="fPortfolio">Portfolio or samples of your work</label><input id="fPortfolio" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" data-kind="portfolio" multiple>
<label for="fLicense">Your license</label><input id="fLicense" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" data-kind="license">
<label for="fInsurance">Proof of insurance</label><input id="fInsurance" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" data-kind="insurance">
<p class="hint">PDF, JPG or PNG. Up to 4 files, 2.5 MB each.</p>
</div>
<div class="trap"><label for="fax">Leave this empty</label><input id="fax" type="text" tabindex="-1" autocomplete="off"></div>
<button id="go" type="submit">Send to ${e(companyName)}</button>
<div id="msg" class="msg" role="status"></div>
</form></div>
<script>
(function(){
var via=new URLSearchParams(location.search).get('src')==='qr'?'qr':'link';
var f=document.getElementById('f'),msg=document.getElementById('msg'),go=document.getElementById('go');
function show(t,ok){msg.textContent=t;msg.className='msg '+(ok?'ok':'err');}
function readFile(file,kind){return new Promise(function(res,rej){var r=new FileReader();r.onload=function(){var s=String(r.result);res({kind:kind,name:file.name,data:s.slice(s.indexOf(',')+1)});};r.onerror=function(){rej(new Error('read'));};r.readAsDataURL(file);});}
f.addEventListener('submit',async function(ev){
 ev.preventDefault();
 var v=function(id){return document.getElementById(id).value.trim();};
 if(!v('companyName')){show('Please tell us your company name.');return;}
 if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v('email'))){show('Please enter an email address we can reach you at.');return;}
 var picked=[];document.querySelectorAll('input[type=file]').forEach(function(inp){Array.prototype.forEach.call(inp.files,function(file){picked.push({file:file,kind:inp.getAttribute('data-kind')});});});
 if(picked.length>4){show('You can attach up to 4 files.');return;}
 var total=0;for(var i=0;i<picked.length;i++){if(picked[i].file.size>2.5*1024*1024){show('"'+picked[i].file.name+'" is over 2.5 MB. Send a smaller copy, or link to it in your message.');return;}total+=picked[i].file.size;}
 if(total>7*1024*1024){show('The files together are too large. Keep the total under 7 MB.');return;}
 go.disabled=true;show('Sending...',true);
 try{
  var files=await Promise.all(picked.map(function(p){return readFile(p.file,p.kind);}));
  var r=await fetch(location.pathname+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyName:v('companyName'),contactName:v('contactName'),email:v('email'),phone:v('phone'),trade:v('trade'),website:v('website'),message:v('message'),fax:v('fax'),via:via,files:files})});
  var d=await r.json().catch(function(){return {};});
  if(!r.ok){show((d.error&&d.error.message)||'Something went wrong. Please try again.');go.disabled=false;return;}
  f.reset();show('Thank you. We received your information and will be in touch if it is a fit.',true);
 }catch(err){show('Something went wrong. Please try again.');go.disabled=false;}
});
})();
</script></body></html>`;
}

module.exports = {
  KINDS, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_FILES, DEFAULT_INTRO, sniffType, slugify,
  getSettings, saveSettings, getPublicPage, submit, listSubmissions, getFile, setStatus, removeSubmission, renderPage, checkFiles
};
