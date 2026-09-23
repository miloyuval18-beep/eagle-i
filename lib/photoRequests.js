// Before/after photo capture: a tenant sends a customer a one-time link
// after a job wraps, the customer uploads a few photos from their phone,
// no account needed. Same real file-signature-sniffing and size-cap
// pattern as lib/workWithUs.js — images only here, a bit more generous per
// file since these are real "after" shots, not scanned documents.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('./email');

const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_STORED_BYTES_PER_TENANT = 300 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ['before', 'after', 'other'];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (message, status, code) => { const e = new Error(message); e.status = status; if (code) e.code = code; return e; };
const oneLine = (s, n) => String(s == null ? '' : s).split('').filter(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join('').replace(/\s+/g, ' ').trim().slice(0, n);

// What a file really is, from its first bytes — same sniff as workWithUs, images only.
function sniffType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  return null;
}
const safeFilename = (name, ext) => {
  const base = oneLine(name, 80).replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[a-z0-9]{1,5}$/i, '').trim() || 'photo';
  return `${base}.${ext}`;
};

async function create(tenantId, { customerName, customerEmail, jobLabel }, { send = sendEmail, baseUrl = '' } = {}) {
  const name = oneLine(customerName, 120);
  const email = oneLine(customerEmail, 200).toLowerCase();
  if (!name) throw fail('Customer name is required.', 400);
  if (!email || !EMAIL_RE.test(email)) throw fail('A valid customer email is required.', 400);
  if (!process.env.RESEND_API_KEY) throw fail('Emails are not configured on this server yet (missing RESEND_API_KEY).', 503);

  const tenantRes = await query('SELECT company_name FROM tenants WHERE id = $1', [tenantId]);
  if (!tenantRes.rows.length) throw fail('Tenant not found.', 404);
  const companyName = tenantRes.rows[0].company_name;
  const token = crypto.randomBytes(20).toString('hex');
  const label = oneLine(jobLabel, 120) || null;

  const row = (await query(
    `INSERT INTO photo_requests (tenant_id, customer_name, customer_email, job_label, token) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, name, email, label, token]
  )).rows[0];

  const link = `${baseUrl}/photos/${token}`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#12203a">
<p>Hi ${esc(name)},</p>
<p>Thanks again for choosing ${esc(companyName)}${label ? ` for your ${esc(label)}` : ''}! If you have a couple of before/after photos on your phone, we'd love to see them — and with your OK, we may use them to show off the work.</p>
<p style="margin:16px 0"><a href="${esc(link)}" style="display:inline-block;background:#1a7ee8;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600">Share your photos</a></p>
<p style="color:#5a7290;font-size:13px">Thank you,<br>${esc(companyName)}</p>
</div>`;
  const text = `Hi ${name},\n\nThanks again for choosing ${companyName}${label ? ` for your ${label}` : ''}! If you have a couple of before/after photos on your phone, we'd love to see them.\n\n${link}\n\nThank you,\n${companyName}`;

  try {
    const sent = await send({ to: email, subject: `Got a photo or two from your project?`, html, text, fromName: companyName });
    await query('UPDATE photo_requests SET resend_email_id = $2 WHERE id = $1', [row.id, sent.id || null]);
  } catch (err) {
    await query('UPDATE photo_requests SET send_error = $2 WHERE id = $1', [row.id, err.message]);
    throw fail('Failed to send: ' + err.message, 502);
  }
  return { id: Number(row.id), token };
}

async function list(tenantId) {
  const reqs = (await query('SELECT * FROM photo_requests WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200', [tenantId])).rows;
  if (!reqs.length) return [];
  const files = (await query('SELECT id, request_id, kind, filename, content_type, size FROM photo_submission_files WHERE request_id = ANY($1) ORDER BY id', [reqs.map(r => r.id)])).rows;
  return reqs.map(r => ({
    id: Number(r.id), customerName: r.customer_name, customerEmail: r.customer_email, jobLabel: r.job_label,
    status: r.status, createdAt: r.created_at, submittedAt: r.submitted_at, sendError: r.send_error,
    files: files.filter(f => f.request_id === r.id).map(f => ({ id: Number(f.id), kind: f.kind, filename: f.filename, contentType: f.content_type, size: f.size }))
  }));
}

async function getRequestByToken(token) {
  const r = await query(
    `SELECT pr.id, pr.tenant_id, pr.customer_name, pr.job_label, pr.status, t.company_name
     FROM photo_requests pr JOIN tenants t ON t.id = pr.tenant_id WHERE pr.token = $1`, [token]);
  return r.rows[0] || null;
}

function checkFiles(files) {
  if (!Array.isArray(files) || !files.length) throw fail('Attach at least one photo.', 400);
  if (files.length > MAX_FILES) throw fail(`You can attach up to ${MAX_FILES} photos.`, 400);
  let total = 0;
  const out = [];
  for (const f of files) {
    const kind = KINDS.includes(f && f.kind) ? f.kind : 'other';
    const b64 = String(f && f.data || '');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw fail('One of the photos could not be read. Try again.', 400);
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw fail('One of the photos is empty.', 400);
    if (buf.length > MAX_FILE_BYTES) throw fail('Each photo can be up to 6 MB.', 400, 'file_too_big');
    total += buf.length;
    if (total > MAX_TOTAL_BYTES) throw fail('The photos together are too large. Keep the total under 24 MB, or send fewer at once.', 400, 'file_too_big');
    const kindOfFile = sniffType(buf);
    if (!kindOfFile) throw fail('Photos must be JPG, PNG or WEBP.', 400, 'bad_file_type');
    out.push({ kind, buf, type: kindOfFile.type, filename: safeFilename(f.name, kindOfFile.ext) });
  }
  return out;
}

async function submit(token, body) {
  const reqRow = await getRequestByToken(token);
  if (!reqRow) throw fail('This link is not valid.', 404);
  const files = checkFiles((body || {}).files);

  const used = (await query(
    `SELECT COALESCE(SUM(f.size), 0)::bigint AS bytes FROM photo_requests pr JOIN photo_submission_files f ON f.request_id = pr.id WHERE pr.tenant_id = $1`,
    [reqRow.tenant_id])).rows[0];
  if (Number(used.bytes) + files.reduce((a, f) => a + f.buf.length, 0) > MAX_STORED_BYTES_PER_TENANT) {
    throw fail('This business has reached its photo storage limit — please email them directly.', 503, 'full');
  }

  for (const f of files) {
    await query('INSERT INTO photo_submission_files (request_id, kind, filename, content_type, size, data) VALUES ($1,$2,$3,$4,$5,$6)',
      [reqRow.id, f.kind, f.filename, f.type, f.buf.length, f.buf]);
  }
  await query(`UPDATE photo_requests SET status = 'submitted', submitted_at = now() WHERE id = $1`, [reqRow.id]);
  return { ok: true, count: files.length };
}

async function getFile(tenantId, requestId, fileId) {
  const r = await query(
    `SELECT f.filename, f.content_type, f.data FROM photo_submission_files f JOIN photo_requests pr ON pr.id = f.request_id
     WHERE f.id = $1 AND pr.id = $2 AND pr.tenant_id = $3`, [fileId, requestId, tenantId]);
  return r.rows[0] || null;
}

async function remove(tenantId, id) {
  return (await query('DELETE FROM photo_requests WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rowCount;
}

// The public upload page. Everything interpolated is escaped.
function renderPage({ companyName, customerName, jobLabel, alreadySubmitted }) {
  const e = esc;
  if (alreadySubmitted) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you</title><meta name="robots" content="noindex">
<style>body{margin:0;background:#f4f6f9;color:#12203a;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}</style>
</head><body><div><h1>Thanks — already got your photos!</h1><p>If you'd like to send more, ask ${e(companyName)} for a new link.</p></div></body></html>`;
  }
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Share photos with ${e(companyName)}</title>
<meta name="robots" content="noindex">
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f9;color:#12203a;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:520px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;line-height:1.2;margin:8px 0 10px}
.intro{color:#41546e;margin:0 0 20px}
form{background:#fff;border:1px solid #dfe6ee;border-radius:10px;padding:18px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 4px}
input[type=file]{width:100%;padding:11px 12px;border:1px dashed #b5c3d4;border-radius:8px;font:inherit;background:#fafcfe}
.hint{font-size:12px;color:#6b7f98;margin:4px 0 0}
button{margin-top:20px;width:100%;padding:13px;border:0;border-radius:8px;background:#12203a;color:#fff;font:600 16px inherit;cursor:pointer}
button[disabled]{opacity:.6;cursor:default}
.msg{margin-top:14px;padding:11px 12px;border-radius:8px;font-size:14px;display:none}
.msg.err{display:block;background:#fdecec;color:#8a1f1f}
.msg.ok{display:block;background:#e7f6ec;color:#1d6b3a}
.thumbs{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.thumbs img{width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid #dfe6ee}
</style></head><body><div class="wrap">
<h1>Share photos with ${e(companyName)}</h1>
<p class="intro">Hi ${e(customerName)} — a couple of before/after shots from${jobLabel ? ` your ${e(jobLabel)}` : ' your project'} would mean a lot. Pick photos from your phone below (up to 10, JPG/PNG/WEBP, 6MB each).</p>
<form id="f" novalidate>
<label for="files">Photos</label>
<input id="files" type="file" accept="image/jpeg,image/png,image/webp" multiple required>
<div class="thumbs" id="thumbs"></div>
<p class="hint">By sharing, you're OK with ${e(companyName)} using these photos to show off the work (in ads, on their website, etc.).</p>
<button id="btn" type="submit">Share photos</button>
<div class="msg" id="msg"></div>
</form>
</div>
<script>
const filesInput=document.getElementById('files'),thumbs=document.getElementById('thumbs');
filesInput.addEventListener('change',()=>{
  thumbs.innerHTML='';
  [...filesInput.files].slice(0,10).forEach(f=>{
    const img=document.createElement('img');img.src=URL.createObjectURL(f);thumbs.appendChild(img);
  });
});
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn=document.getElementById('btn'),msg=document.getElementById('msg');
  const fl=[...filesInput.files];
  if(!fl.length){msg.className='msg err';msg.textContent='Choose at least one photo.';return;}
  btn.disabled=true;btn.textContent='Uploading…';msg.className='msg';msg.textContent='';
  try{
    const files=await Promise.all(fl.map(f=>new Promise((res,rej)=>{
      const r=new FileReader();
      r.onload=()=>res({name:f.name,data:r.result.split(',')[1]});
      r.onerror=rej;r.readAsDataURL(f);
    })));
    const resp=await fetch(location.pathname.replace('/photos/','/api/photos/')+'/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files})});
    const d=await resp.json();
    if(!resp.ok)throw new Error((d.error&&d.error.message)||'Upload failed');
    msg.className='msg ok';msg.textContent='Thank you! Your photos are in.';
    document.getElementById('f').style.display='none';
  }catch(err){msg.className='msg err';msg.textContent=err.message;btn.disabled=false;btn.textContent='Share photos';}
});
</script>
</body></html>`;
}

module.exports = { create, list, getRequestByToken, submit, getFile, remove, renderPage };
