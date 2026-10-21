// Files, photos and the homeowner portal in Eagle I CRM.
//
// Files: photos (JPEG, PNG, WebP) and PDFs on a deal, checked by their first
// bytes (not by name), up to MAX_FILE each. Each file is either shared with
// the homeowner or kept to the team.
//
// The portal (/p/<token>): one private link per deal for the homeowner. It
// shows the project's status in plain words, the next visit, their estimates,
// shared photos and documents, and the team's updates. The homeowner can send
// a message or add photos; either lands on the deal and in "Needs you".
// Nothing about cost, margin, notes or the team's internal history is ever
// shown there.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('./email');
const crm = require('./crm');

const MAX_FILE = 8 * 1024 * 1024;
const MAX_FILES_PER_DEAL = 300;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// What a file really is, from its first bytes (and, for office files that
// share a container format, its name). Anything a browser could run (HTML,
// SVG, scripts) is never accepted.
const OFFICE = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint' };
function sniffType(buf, name = '') {
  const ext = (String(name).match(/\.([a-z0-9]{1,5})$/i) || [])[1];
  const e = ext ? ext.toLowerCase() : '';
  const head = (n) => buf.slice(0, n).toString('latin1');
  if (buf.length >= 5 && head(5) === '%PDF-') return { type: 'application/pdf', ext: 'pdf', kind: 'document' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg', kind: 'photo' };
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png', kind: 'photo' };
  if (buf.length >= 12 && head(4) === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp', ext: 'webp', kind: 'photo' };
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('latin1');
    if (/^hei|^mif1|^heix/.test(brand)) return null; // iPhone HEIC: converted to JPEG on the phone before upload
    return brand === 'qt  ' || e === 'mov' ? { type: 'video/quicktime', ext: 'mov', kind: 'video' } : { type: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  if (buf.length >= 4 && head(4) === 'PK\u0003\u0004') {
    if (OFFICE[e] && ['docx', 'xlsx', 'pptx'].includes(e)) return { type: OFFICE[e], ext: e, kind: 'document' };
    if (e === 'zip') return { type: 'application/zip', ext: 'zip', kind: 'document' };
    return null;
  }
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return ['doc', 'xls', 'ppt'].includes(e) ? { type: OFFICE[e], ext: e, kind: 'document' } : null;
  if (buf.length >= 6 && /^AC10\d\d/.test(head(6))) return { type: 'application/acad', ext: 'dwg', kind: 'document' };
  // Plain text: CSV, TXT, DXF (CAD exchange). No NUL bytes, and nothing that looks like markup.
  if (['csv', 'txt', 'dxf'].includes(e) && !buf.slice(0, 4096).includes(0) && !/<\s*(html|script|svg)/i.test(head(4096))) return { type: e === 'csv' ? 'text/csv' : e === 'dxf' ? 'image/vnd.dxf' : 'text/plain', ext: e, kind: 'document' };
  return null;
}
function safeFilename(name, ext) {
  const base = String(name || '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').replace(/\.[a-z0-9]{1,5}$/i, '').trim().slice(0, 80) || 'file';
  return `${base}.${ext}`;
}
const kindOf = (type) => (/^image\//.test(type) && type !== 'image/vnd.dxf' ? 'photo' : /^video\//.test(type) ? 'video' : 'document');

// Folders on every job (the same names as the Drive subfolders).
const FOLDERS = { plans: 'Plans', permits: 'Permits', contracts: 'Contracts', photos: 'Photos', selections: 'Selections', receipts: 'Receipts', warranties: 'Warranties', other: 'Other' };
// Pure: where a new file goes when nobody said.
function guessFolder({ filename = '', type = '', caption = '' }) {
  const n = `${filename} ${caption}`.toLowerCase();
  if (/receipt|invoice from|bill\b/.test(n)) return 'receipts';
  if (/permit/.test(n)) return 'permits';
  if (/contract|agreement|signed|change order/.test(n)) return 'contracts';
  if (/warrant|manual|care guide/.test(n)) return 'warranties';
  if (/selection|spec sheet|finish schedule|tile|fixture/.test(n) && !/^image\//.test(type)) return 'selections';
  if (/plan|sheet|elevation|drawing|blueprint|floor ?plan|site ?plan|\b[asempc]-?\d{1,3}(\.\d+)?\b|\.dwg|\.dxf/.test(n) || /acad|dxf/.test(type)) return 'plans';
  if (/^image\/|^video\//.test(type)) return 'photos';
  return 'other';
}
// Pure: the sheet a plan file is, ignoring revision marks, dates and copies,
// so "A1 Floor Plan rev3.pdf" replaces "A1 Floor Plan rev2.pdf".
function sheetKey(filename) {
  return String(filename || '').toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '')
    .replace(/\((\d+)\)/g, ' ').replace(/\b(rev(ision)?|r|v|ver(sion)?)\s*[-_.]?\s*[a-z0-9]{1,3}\b/g, ' ')
    .replace(/\b(final|latest|updated|revised|new|current|copy|issued|for permit|ifc|draft)\b/g, ' ')
    .replace(/\b\d{1,4}[-_.]\d{1,2}[-_.]\d{1,4}\b|\b20\d{6}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

const MAX_DRIVE_FILE = 50 * 1024 * 1024;
// `buffer` (or `dataBase64`, a data: URL prefix is fine): the file's bytes.
async function addFile({ tenantId, dealId, filename, dataBase64 = null, buffer = null, caption = null, shared = null, userId = null, fromHomeowner = false, updateId = null, folder = null, newVersion = true }) {
  let buf = buffer;
  if (!buf) {
    const raw = String(dataBase64 || '').replace(/^data:[^,]*,/, '');
    if (!raw) throw err('Choose a file to upload.');
    if (raw.length > Math.ceil(MAX_DRIVE_FILE * 4 / 3) + 8) throw err('That file is too big. The limit is 50 MB.');
    buf = Buffer.from(raw, 'base64');
  }
  if (!buf.length) throw err('That file is empty.');
  const drive = await require('./crmDrive').driveOn(tenantId);
  if (buf.length > (drive ? MAX_DRIVE_FILE : MAX_FILE)) throw err(drive ? 'That file is too big. The limit is 50 MB.' : 'That file is too big. The limit is 8 MB, or 50 MB once Google Drive is connected (Company details).');
  const t = sniffType(buf, filename);
  if (!t) throw err(fromHomeowner ? 'Only photos (JPEG, PNG, WebP) and PDFs can be uploaded.' : 'That kind of file can’t be added. Photos, PDFs, videos, Word, Excel, PowerPoint, CSV, text and CAD (DWG/DXF) files can.');
  if (fromHomeowner && !['photo', 'document'].includes(t.kind)) throw err('Only photos and PDFs can be uploaded.');
  if (fromHomeowner && t.kind === 'document' && t.type !== 'application/pdf') throw err('Only photos (JPEG, PNG, WebP) and PDFs can be uploaded.');
  const count = (await query('SELECT COUNT(*)::int AS n FROM crm_files WHERE deal_id = $1', [dealId])).rows[0].n;
  if (count >= (drive ? 3000 : MAX_FILES_PER_DEAL)) throw err('This deal already has the most files allowed.');
  const share = shared == null ? fromHomeowner : !!shared;
  const name = safeFilename(filename, t.ext);
  const fold = FOLDERS[folder] ? folder : guessFolder({ filename: name, type: t.type, caption: caption || '' });
  const row = (await query(
    `INSERT INTO crm_files (tenant_id, deal_id, filename, content_type, size, data, caption, shared, uploaded_by, from_homeowner, update_id, folder)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [tenantId, dealId, name, t.type, buf.length, buf.length <= MAX_FILE ? buf : null, String(caption || '').trim().slice(0, 300) || null, share, userId, fromHomeowner, updateId, fold])).rows[0];
  const ver = fold === 'plans' && newVersion ? await applyVersioning(row) : null;
  // Into the job's Drive folder. A file too big to keep here must get there now; others can wait for the next run if Drive is slow.
  if (drive) {
    const up = require('./crmDrive').pushFile(tenantId, row.id, buf);
    if (buf.length > MAX_FILE) {
      try { await up; } catch (e) { await query('DELETE FROM crm_files WHERE id = $1', [row.id]); throw err(`Google Drive didn’t take the file: ${e.message}`, 502); }
    } else up.catch(e => console.error('[crmPortal] Drive upload failed (will retry):', e.message));
  }
  const { data, ...out } = row;
  return { ...out, kind: t.kind, replaced: ver && ver.replaced ? ver.replaced : null, version: ver ? ver.version : 1 };
}

// A new plan file with the same sheet as an earlier one becomes its next
// version; the earlier one is kept as an older version.
async function applyVersioning(row) {
  const key = sheetKey(row.filename);
  if (!key) return null;
  const prev = (await query(`SELECT * FROM crm_files WHERE deal_id = $1 AND folder = 'plans' AND superseded_at IS NULL AND id <> $2 ORDER BY created_at DESC`, [row.deal_id, row.id])).rows.find(f => sheetKey(f.filename) === key);
  if (!prev) return null;
  const group = prev.version_group || prev.id;
  await query('UPDATE crm_files SET version_group = $2 WHERE id = $1 AND version_group IS NULL', [prev.id, group]);
  await query('UPDATE crm_files SET superseded_at = now() WHERE id = $1', [prev.id]);
  await query('UPDATE crm_files SET version_group = $2, version = $3 WHERE id = $1', [row.id, group, (prev.version || 1) + 1]);
  require('./crmDrive').moveFile(row.tenant_id, prev, 'plans', { old: true }).catch(e => console.error('[crmPortal] moving the old version in Drive failed:', e.message));
  return { replaced: prev.filename, version: (prev.version || 1) + 1 };
}
// The newest version of each file (for bid requests sent before a revision).
async function latestVersions(fileIds) {
  if (!fileIds || !fileIds.length) return [];
  return (await query(
    `SELECT DISTINCT ON (COALESCE(n.id, f.id)) COALESCE(n.id, f.id) AS id FROM crm_files f
     LEFT JOIN LATERAL (SELECT x.id FROM crm_files x WHERE f.version_group IS NOT NULL AND x.version_group = f.version_group AND x.superseded_at IS NULL ORDER BY x.version DESC LIMIT 1) n ON true
     WHERE f.id = ANY($1::uuid[])`, [fileIds])).rows.map(r => r.id);
}

async function listFiles(tenantId, dealId, { sharedOnly = false } = {}) {
  return (await query(
    `SELECT f.id, f.filename, f.content_type, f.size, f.caption, f.shared, f.from_homeowner, f.update_id, f.created_at, f.folder, f.version, f.version_group,
            f.superseded_at, f.drive_link, f.drive_id IS NOT NULL AS in_drive, f.data IS NULL AS drive_only, COALESCE(u.name, u.email) AS uploaded_by_name
     FROM crm_files f LEFT JOIN users u ON u.id = f.uploaded_by
     WHERE f.tenant_id = $1 AND f.deal_id = $2 AND ($3::boolean = false OR (f.shared = true AND f.superseded_at IS NULL)) ORDER BY f.created_at DESC`,
    [tenantId, dealId, sharedOnly])).rows.map(f => ({ ...f, kind: kindOf(f.content_type), googleDoc: /^application\/vnd\.google-apps\./.test(f.content_type) }));
}

async function getFile(tenantId, id) {
  return (await query('SELECT * FROM crm_files WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0] || null;
}
// A file's bytes: the copy kept here, or fetched from Google Drive.
async function fileData(f) {
  if (!f) return null;
  if (f.data) return Buffer.from(f.data);
  if (!f.drive_id) return null;
  if (/^application\/vnd\.google-apps\./.test(f.content_type)) return null; // a Google Doc: opened in Drive
  const buf = await require('./crmDrive').download(f.tenant_id, f.drive_id);
  if (buf.length <= MAX_FILE) await query('UPDATE crm_files SET data = $2, size = $3 WHERE id = $1', [f.id, buf, buf.length]).catch(() => {});
  return buf;
}

async function updateFile({ tenantId, id, shared, caption, folder, filename, splitVersion = false }) {
  const f = await getFile(tenantId, id);
  if (!f) return false;
  const sets = [], vals = [id, tenantId];
  if (typeof shared === 'boolean') { vals.push(shared); sets.push(`shared = $${vals.length}`); }
  if (caption !== undefined) { vals.push(String(caption || '').trim().slice(0, 300) || null); sets.push(`caption = $${vals.length}`); }
  if (folder && FOLDERS[folder] && folder !== f.folder) { vals.push(folder); sets.push(`folder = $${vals.length}`); sets.push('superseded_at = NULL'); }
  let newName = null;
  if (filename && String(filename).trim()) {
    const ext = (f.filename.match(/\.([a-z0-9]{1,5})$/i) || [])[1];
    newName = ext ? safeFilename(filename, ext) : String(filename).replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').trim().slice(0, 120);
    vals.push(newName); sets.push(`filename = $${vals.length}`);
  }
  if (splitVersion) sets.push('version_group = NULL, version = 1, superseded_at = NULL');
  if (!sets.length) return true;
  const ok = (await query(`UPDATE crm_files SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING id`, vals)).rowCount > 0;
  const D = require('./crmDrive');
  if (ok && ((folder && folder !== f.folder) || (splitVersion && f.superseded_at))) await D.moveFile(tenantId, f, folder || f.folder).catch(e => console.error('[crmPortal] Drive move failed:', e.message));
  if (ok && newName) await D.renameFile(tenantId, f, newName).catch(e => console.error('[crmPortal] Drive rename failed:', e.message));
  // Pulled out of a version chain: the newest remaining one is the current version again.
  if (ok && splitVersion && f.version_group) {
    const top = (await query(`SELECT * FROM crm_files WHERE version_group = $1 ORDER BY version DESC LIMIT 1`, [f.version_group])).rows[0];
    if (top && top.superseded_at && !(await query(`SELECT 1 FROM crm_files WHERE version_group = $1 AND superseded_at IS NULL`, [f.version_group])).rows.length) {
      await query('UPDATE crm_files SET superseded_at = NULL WHERE id = $1', [top.id]);
      await D.moveFile(tenantId, top, 'plans').catch(() => {});
    }
  }
  return ok;
}

async function deleteFile({ tenantId, id }) {
  const f = await getFile(tenantId, id);
  if (!f) return false;
  await require('./crmDrive').trashFile(tenantId, f).catch(e => console.error('[crmPortal] Drive trash failed:', e.message));
  const ok = (await query('DELETE FROM crm_files WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId])).rowCount > 0;
  // Deleting the current plan: the version before it becomes current again.
  if (ok && f.version_group && !f.superseded_at) {
    const prev = (await query(`SELECT * FROM crm_files WHERE version_group = $1 ORDER BY version DESC LIMIT 1`, [f.version_group])).rows[0];
    if (prev) { await query('UPDATE crm_files SET superseded_at = NULL WHERE id = $1', [prev.id]); await require('./crmDrive').moveFile(tenantId, prev, 'plans').catch(() => {}); }
  }
  return ok;
}

// ---------- the portal ----------

async function portalToken(tenantId, dealId) {
  const r = (await query('SELECT portal_token FROM crm_deals WHERE id = $1 AND tenant_id = $2', [dealId, tenantId])).rows[0];
  if (!r) throw err('Deal not found.', 404);
  if (r.portal_token) return r.portal_token;
  const token = crypto.randomBytes(24).toString('hex');
  await query('UPDATE crm_deals SET portal_token = COALESCE(portal_token, $2) WHERE id = $1', [dealId, token]);
  return (await query('SELECT portal_token FROM crm_deals WHERE id = $1', [dealId])).rows[0].portal_token;
}

// A new link: the old one stops working (if it was sent to the wrong person, say).
async function resetPortalToken(tenantId, dealId) {
  const token = crypto.randomBytes(24).toString('hex');
  const r = await query('UPDATE crm_deals SET portal_token = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id', [dealId, tenantId, token]);
  if (!r.rowCount) throw err('Deal not found.', 404);
  return token;
}

// How the project's stage reads to a homeowner.
const HOMEOWNER_STATUS = {
  new: 'Getting started', qualified: 'Getting started', site_visit: 'Site visit', design_agreement: 'Design', in_design: 'Design',
  proposal: 'Proposal', signed: 'Getting ready to build', production: 'Under construction', complete: 'Complete', lost: 'Closed'
};

async function dealByPortal(token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  return (await query(
    `SELECT d.*, c.name AS contact_name, c.email AS contact_email, c.language AS contact_language, p.address AS property_address FROM crm_deals d
     JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id WHERE d.portal_token = $1`, [token])).rows[0] || null;
}

async function portalView(token) {
  const deal = await dealByPortal(token);
  if (!deal) return null;
  const company = (await query(
    `SELECT t.company_name AS name, bp.phone, bp.email, bp.address FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [deal.tenant_id])).rows[0] || {};
  const estimates = (await query(
    `SELECT number, kind, title, status, total, public_token, sent_at, accepted_at FROM crm_estimates
     WHERE deal_id = $1 AND (sent_at IS NOT NULL) ORDER BY created_at DESC`, [deal.id])).rows.map(e => ({
    number: e.number, kind: e.kind === 'design_agreement' ? 'Design agreement' : 'Estimate', title: e.title,
    status: e.status === 'accepted' ? 'Accepted' : e.status === 'declined' ? 'Declined' : e.status === 'draft' ? 'Being updated' : 'Waiting for you',
    total: Number(e.total), link: `/e/${e.public_token}`, kindKey: e.kind, statusKey: e.status
  }));
  const files = await listFiles(deal.tenant_id, deal.id, { sharedOnly: true });
  const updates = (await query(
    `SELECT u.id, u.body, u.created_at, COALESCE(us.name, us.email) AS author FROM crm_portal_updates u LEFT JOIN users us ON us.id = u.created_by
     WHERE u.deal_id = $1 ORDER BY u.created_at DESC LIMIT 100`, [deal.id])).rows;
  return {
    lang: deal.contact_language || null,
    company: { name: company.name, phone: company.phone, email: company.email },
    project: { title: deal.title, address: deal.property_address, status: HOMEOWNER_STATUS[deal.stage] || 'In progress', stageKey: deal.stage, customer: deal.contact_name },
    nextVisit: deal.site_visit_at && new Date(deal.site_visit_at) > new Date() ? deal.site_visit_at : null,
    estimates,
    files: files.map(f => ({ id: f.id, filename: f.filename, kind: f.kind, type: f.content_type, folder: f.folder, caption: f.caption, fromHomeowner: f.from_homeowner, updateId: f.update_id, createdAt: f.created_at })),
    updates: updates.map(u => ({ id: u.id, body: u.body, author: u.author, createdAt: u.created_at })),
    job: await require('./crmJobs').portalJob(deal.id),
    punch: (await query(`SELECT id, location, issue, status FROM crm_punch_items WHERE deal_id = $1 AND shared = true ORDER BY status = 'done', position LIMIT 100`, [deal.id])).rows,
    home: await require('./crmLifetime').portalHome(deal)
  };
}

async function portalFile(token, fileId) {
  const deal = await dealByPortal(token);
  if (!deal || !/^[0-9a-f-]{36}$/.test(String(fileId || ''))) return null;
  return (await query('SELECT * FROM crm_files WHERE id = $1 AND deal_id = $2 AND shared = true AND superseded_at IS NULL', [fileId, deal.id])).rows[0] || null;
}

async function notifyTeam(deal, subject, body) {
  const r = (await query(
    `SELECT COALESCE(u.email, bp.email) AS to_email FROM crm_deals d LEFT JOIN users u ON u.id = d.owner_user_id
     LEFT JOIN business_profile bp ON bp.tenant_id = d.tenant_id WHERE d.id = $1`, [deal.id])).rows[0];
  if (r && EMAIL_RE.test(String(r.to_email || ''))) {
    await sendEmail({ to: r.to_email, subject, html: `<p>${esc(body).replace(/\n/g, '<br>')}</p><p>Open Eagle I CRM to reply.</p>`, text: `${body}\n\nOpen Eagle I CRM to reply.` }).catch(() => {});
  }
}

// The homeowner wrote to the team from the portal.
async function portalMessage({ token, message, title = null }) {
  const deal = await dealByPortal(token);
  if (!deal) throw err('This link is not valid.', 404);
  const text = String(message || '').trim().slice(0, 3000);
  if (!text) throw err('Write a message first.');
  await crm.logActivity({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'reply', actor: 'contact', body: `Message from the portal: ${text}` });
  await require('./crmPlaybooks').cancelForDeal(deal.id, 'replied', { trigger: 'stage' });
  await crm.addInboxItem({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'reply', dedupeKey: `portal-msg:${deal.id}:${Date.now()}`, title: title ? `${deal.contact_name} ${title}` : `${deal.contact_name} sent a message from their portal`, detail: text.slice(0, 600) });
  await notifyTeam(deal, `${title ? 'Question' : 'Message'} from ${deal.contact_name}: ${deal.title}`.slice(0, 150), `${deal.contact_name} wrote from their project portal:\n\n${text}`);
}

async function portalUpload({ token, filename, dataBase64, caption }) {
  const deal = await dealByPortal(token);
  if (!deal) throw err('This link is not valid.', 404);
  const f = await addFile({ tenantId: deal.tenant_id, dealId: deal.id, filename, dataBase64, caption, fromHomeowner: true });
  await crm.logActivity({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'system', actor: 'contact', body: `Added a ${f.kind === 'photo' ? 'photo' : 'document'} in the portal: ${f.filename}` });
  return f;
}

// The team posts an update to the portal, optionally emailing the homeowner the link.
async function postUpdate({ tenantId, dealId, body, userId = null, email = false, baseUrl = '', send = sendEmail }) {
  const text = String(body || '').trim().slice(0, 5000);
  if (!text) throw err('Write the update first.');
  const deal = await crm.getDeal(tenantId, dealId);
  if (!deal) throw err('Deal not found.', 404);
  const u = (await query('INSERT INTO crm_portal_updates (tenant_id, deal_id, body, created_by) VALUES ($1, $2, $3, $4) RETURNING *', [tenantId, dealId, text, userId])).rows[0];
  // Posting clears this week's drafted update (lib/crmAssist.js) and its reminder.
  await query('UPDATE crm_deals SET update_draft = NULL WHERE id = $1', [dealId]);
  await query(`UPDATE crm_inbox SET status = 'done', resolved_at = now() WHERE deal_id = $1 AND kind = 'update_draft' AND status = 'open'`, [dealId]);
  await crm.logActivity({ tenantId, dealId, kind: 'system', userId, body: `Posted a portal update: ${text.slice(0, 200)}` });
  let emailed = false;
  if (email) {
    const to = String(deal.contact_email || '').trim();
    if (!EMAIL_RE.test(to)) throw err('This contact has no email address, so the update was posted but not emailed.');
    const blocked = (await query(`SELECT 1 FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) AND reason IN ('bounced', 'complained')`, [tenantId, to])).rows[0];
    if (blocked) throw err('Email to this person bounced or was reported, so the update was posted but not emailed.');
    const link = `${baseUrl}/p/${await portalToken(tenantId, dealId)}`;
    const co = (await query(`SELECT t.company_name, bp.address, bp.email FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [tenantId])).rows[0] || {};
    const { say, langOf } = require('./crmSpanish');
    const lang = langOf(deal.contact_language);
    const first = String(deal.contact_name || '').trim().split(/\s+/)[0] || say(lang, 'there');
    await send({
      to, subject: say(lang, 'upd_subject', { company: co.company_name, title: deal.title }).slice(0, 150),
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#14202b;max-width:560px;line-height:1.5"><p>${esc(say(lang, 'hi', { first }))}</p><p style="white-space:pre-wrap">${esc(text)}</p><p><a href="${link}">${esc(say(lang, 'upd_link'))}</a></p><p style="color:#55636f;font-size:12px">${esc(co.company_name)}${co.address ? ' · ' + esc(co.address) : ''}</p></div>`,
      text: `${say(lang, 'hi', { first })}\n\n${text}\n\n${say(lang, 'upd_link')}: ${link}\n\n${co.company_name}${co.address ? ' · ' + co.address : ''}`,
      replyTo: EMAIL_RE.test(String(co.email || '')) ? co.email : undefined, fromName: co.company_name,
      fromAddress: (await require('./sendingDomain').getVerifiedFromAddress(tenantId)) || undefined
    });
    await query('UPDATE crm_portal_updates SET emailed_at = now() WHERE id = $1', [u.id]);
    emailed = true;
  }
  return { update: u, emailed };
}

module.exports = {
  MAX_FILE, MAX_DRIVE_FILE, FOLDERS, HOMEOWNER_STATUS, sniffType, safeFilename, guessFolder, sheetKey, addFile, applyVersioning, latestVersions, listFiles, getFile, fileData, updateFile, deleteFile,
  portalToken, resetPortalToken, portalView, portalFile, portalMessage, portalUpload, postUpdate
};
