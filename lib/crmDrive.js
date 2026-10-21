// Project files in the company's Google Drive, for Eagle I CRM.
//
// Uses the same Google Workspace connection as email (lib/crmGoogle.js): the
// company's admin adds one more scope (Drive) to Eagle I's domain-wide
// delegation, then switches Drive on in Company details. Eagle I acts as that
// admin in Drive.
//
//  - A Shared Drive "Eagle I Projects" is made for the company (so the files
//    belong to the company, not to whoever uploaded them). If the Workspace
//    doesn't allow shared drives, an "Eagle I Projects" folder in the admin's
//    Drive is used instead.
//  - Every job gets a folder there (named after the job and the homeowner)
//    with a subfolder per kind of file: Plans (with "Old versions" inside),
//    Permits, Contracts, Photos, Selections, Receipts, Warranties, Other.
//  - Upload in Eagle I: the file goes into the right subfolder. Drop a file
//    into a job's subfolder in Drive: it shows up on the deal within minutes.
//    Move it between subfolders, rename or delete it in Drive: the deal
//    follows. Delete it in Eagle I: it goes to Drive's trash (restorable).
//  - Files up to 8 MB keep a copy in Eagle I too, so photos load fast and
//    nothing is lost if the connection is ever removed; bigger files live only
//    in Drive and are fetched when opened.
//  - Homeowners never need a Google account: shared files still reach them
//    through their portal, fetched from Drive by Eagle I.
const crypto = require('crypto');
const { query } = require('../db');

const SCOPE = 'https://www.googleapis.com/auth/drive';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_NAME = 'Eagle I Projects';
const SUBFOLDERS = [['plans', 'Plans'], ['permits', 'Permits'], ['contracts', 'Contracts'], ['photos', 'Photos'], ['selections', 'Selections'], ['receipts', 'Receipts'], ['warranties', 'Warranties'], ['other', 'Other']];
const OLD_VERSIONS = 'Old versions';
const KEEP_COPY_MAX = 8 * 1024 * 1024;
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

let httpOverride = null;
function setHttp(fn) { httpOverride = fn; }
const http = (...a) => (httpOverride || fetch)(...a);

async function connectionFor(tenantId) {
  return (await query('SELECT * FROM crm_google_connections WHERE tenant_id = $1', [tenantId])).rows[0] || null;
}
// Workspace: act as the admin. Signed in with Google: the account that allowed Drive.
async function token(conn) {
  const G = require('./crmGoogle');
  if (conn.kind === 'signin') {
    const m = conn.drive_mailbox_id && (await query('SELECT email, refresh_token_enc FROM crm_mailboxes WHERE id = $1 AND tenant_id = $2', [conn.drive_mailbox_id, conn.tenant_id])).rows[0];
    if (!m || !m.refresh_token_enc) throw err('Sign in with Google and allow Google Drive first.', 409);
    return G.mailboxToken(m, SCOPE, { http });
  }
  return G.getToken({ subject: conn.admin_email, scope: SCOPE, http });
}
const allDrives = (u) => { u.searchParams.set('supportsAllDrives', 'true'); return u; };

async function call(conn, method, path, { params = {}, body = null, raw = false } = {}) {
  const u = allDrives(new URL(path.startsWith('http') ? path : API + path));
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  const t = await token(conn);
  const r = await http(u.toString(), { method, headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) {
    if (!r.ok) throw err(`Google Drive couldn’t send the file (${r.status}).`, r.status === 404 ? 404 : 502);
    return Buffer.from(await r.arrayBuffer());
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = (j.error && j.error.message) || `Google Drive request failed (${r.status}).`;
    throw err(r.status === 403 && /scope|insufficient|delegat|access_denied/i.test(m) ? 'Google Drive refused access. In your Google Admin console, add the Drive scope to Eagle I’s domain-wide delegation.' : m, r.status === 404 ? 404 : r.status === 403 ? 403 : 502);
  }
  return j;
}

async function makeFolder(conn, name, parent) {
  const f = await call(conn, 'POST', '/files', { params: { fields: 'id' }, body: { name: String(name).replace(/[\\/]/g, '-').slice(0, 200), mimeType: FOLDER_MIME, parents: [parent] } });
  return f.id;
}

// ---------- switching it on ----------

async function status(tenantId) {
  const c = await connectionFor(tenantId);
  if (!c) return { connected: false, on: false, scope: SCOPE };
  const holder = c.kind === 'signin' && c.drive_mailbox_id ? (await query('SELECT email FROM crm_mailboxes WHERE id = $1', [c.drive_mailbox_id])).rows[0] : null;
  const files = (await query(`SELECT COUNT(*) FILTER (WHERE drive_id IS NOT NULL)::int AS in_drive, COUNT(*) FILTER (WHERE drive_id IS NULL)::int AS waiting FROM crm_files WHERE tenant_id = $1`, [tenantId])).rows[0];
  return {
    connected: c.status === 'connected', on: !!c.drive_on, scope: SCOPE, kind: c.kind, account: holder ? holder.email : null, needsSignIn: c.kind === 'signin' && !holder, sharedDrive: !!c.drive_shared_id, error: c.drive_error, syncedAt: c.drive_synced_at,
    link: c.drive_root_id ? (c.drive_shared_id ? `https://drive.google.com/drive/folders/${c.drive_shared_id}` : `https://drive.google.com/drive/folders/${c.drive_root_id}`) : null,
    inDrive: files.in_drive, waiting: c.drive_on ? files.waiting : 0
  };
}

async function enable(tenantId) {
  const c = await connectionFor(tenantId);
  if (!c || c.status !== 'connected') throw err('Connect Google first (above).');
  if (c.kind === 'signin' && !c.drive_mailbox_id) throw err('Sign in with Google and allow Google Drive first.', 409);
  if (c.drive_on && c.drive_root_id) return status(tenantId);
  let sharedId = c.drive_shared_id, rootId = c.drive_root_id;
  if (!rootId) {
    try {
      const d = await call(c, 'POST', '/drives', { params: { requestId: crypto.randomUUID() }, body: { name: ROOT_NAME } });
      sharedId = d.id; rootId = d.id;
    } catch (e) {
      if (e.status !== 403 && !/shared drive|teamdrive|not.*allowed|permission/i.test(e.message)) throw e;
      // Shared drives aren't allowed in this Workspace: a folder in the admin's Drive instead.
      rootId = await makeFolder(c, ROOT_NAME, 'root');
      sharedId = null;
    }
  }
  const start = await call(c, 'GET', '/changes/startPageToken', { params: sharedId ? { driveId: sharedId } : {} });
  await query(`UPDATE crm_google_connections SET drive_on = true, drive_root_id = $2, drive_shared_id = $3, drive_page_token = $4, drive_error = NULL WHERE tenant_id = $1`, [tenantId, rootId, sharedId, start.startPageToken]);
  return status(tenantId);
}

// Off: nothing is deleted anywhere. Files stay in Drive; copies kept here stay here.
async function disable(tenantId) {
  await query(`UPDATE crm_google_connections SET drive_on = false WHERE tenant_id = $1`, [tenantId]);
  return status(tenantId);
}

async function driveOn(tenantId) {
  const c = await connectionFor(tenantId);
  return c && c.drive_on && c.status === 'connected' && c.drive_root_id ? c : null;
}

// ---------- folders per job ----------

async function ensureDealFolder(conn, dealId) {
  const d = (await query(`SELECT d.id, d.title, d.drive_folder_id, d.drive_folders, c.name AS contact FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE d.id = $1`, [dealId])).rows[0];
  if (!d) throw err('Deal not found.', 404);
  if (d.drive_folder_id && d.drive_folders && d.drive_folders.plans) return d.drive_folders;
  const main = d.drive_folder_id || await makeFolder(conn, `${d.title}${d.contact && !String(d.title).includes(d.contact) ? ` – ${d.contact}` : ''}`, conn.drive_root_id);
  const map = { ...(d.drive_folders || {}), main };
  for (const [key, label] of SUBFOLDERS) if (!map[key]) map[key] = await makeFolder(conn, label, main);
  if (!map.old) map.old = await makeFolder(conn, OLD_VERSIONS, map.plans);
  await query('UPDATE crm_deals SET drive_folder_id = $2, drive_folders = $3 WHERE id = $1', [dealId, main, JSON.stringify(map)]);
  return map;
}

// Pure: a multipart/related body (metadata + bytes) for one upload.
function multipart(meta, buf, mime) {
  const b = 'eaglei' + crypto.randomBytes(8).toString('hex');
  return {
    boundary: b,
    body: Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`),
      buf, Buffer.from(`\r\n--${b}--`)
    ])
  };
}

async function upload(conn, { file, buf, folderId }) {
  const { boundary, body } = multipart({ name: file.filename, parents: [folderId], appProperties: { eagleiFileId: file.id } }, buf, file.content_type);
  const u = allDrives(new URL(UPLOAD));
  u.searchParams.set('uploadType', 'multipart');
  u.searchParams.set('fields', 'id,webViewLink,modifiedTime');
  const r = await http(u.toString(), { method: 'POST', headers: { Authorization: `Bearer ${await token(conn)}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw err((j.error && j.error.message) || `Google Drive upload failed (${r.status}).`, 502);
  return j;
}

// A file just added in Eagle I: into its job's subfolder in Drive.
async function pushFile(tenantId, fileId, buf = null) {
  const conn = await driveOn(tenantId);
  if (!conn) return null;
  const f = (await query('SELECT * FROM crm_files WHERE id = $1 AND tenant_id = $2', [fileId, tenantId])).rows[0];
  if (!f || f.drive_id) return f;
  await query('UPDATE crm_files SET drive_tried_at = now() WHERE id = $1', [f.id]);
  const map = await ensureDealFolder(conn, f.deal_id);
  const bytes = buf || f.data;
  if (!bytes) return f;
  const up = await upload(conn, { file: f, buf: Buffer.from(bytes), folderId: f.superseded_at ? map.old : map[f.folder] || map.other });
  // Too big to keep a copy here: Drive holds the only one.
  const dropCopy = Number(f.size) > KEEP_COPY_MAX;
  const r = await query(`UPDATE crm_files SET drive_id = $2, drive_link = $3, drive_modified_at = $4${dropCopy ? ', data = NULL' : ''} WHERE id = $1 RETURNING *`, [f.id, up.id, up.webViewLink || null, up.modifiedTime || null]);
  return r.rows[0];
}

async function download(tenantId, driveId) {
  const conn = await connectionFor(tenantId);
  if (!conn) throw err('This file is in Google Drive, and Drive isn’t connected any more.', 409);
  return call(conn, 'GET', `/files/${encodeURIComponent(driveId)}`, { params: { alt: 'media' }, raw: true });
}

async function moveFile(tenantId, f, toFolder, { old = false } = {}) {
  const conn = await driveOn(tenantId);
  if (!conn || !f.drive_id) return;
  const map = await ensureDealFolder(conn, f.deal_id);
  const target = old ? map.old : map[toFolder] || map.other;
  const cur = await call(conn, 'GET', `/files/${encodeURIComponent(f.drive_id)}`, { params: { fields: 'parents' } });
  const from = (cur.parents || []).filter(p => p !== target).join(',');
  if (!from && (cur.parents || []).includes(target)) return;
  await call(conn, 'PATCH', `/files/${encodeURIComponent(f.drive_id)}`, { params: { addParents: target, removeParents: from || null, fields: 'id' }, body: {} });
}
async function renameFile(tenantId, f, name) {
  const conn = await driveOn(tenantId);
  if (conn && f.drive_id) await call(conn, 'PATCH', `/files/${encodeURIComponent(f.drive_id)}`, { params: { fields: 'id' }, body: { name } });
}
// Deleting in Eagle I sends the Drive copy to the trash (it can be restored there).
async function trashFile(tenantId, f) {
  const conn = await driveOn(tenantId);
  if (conn && f.drive_id) await call(conn, 'PATCH', `/files/${encodeURIComponent(f.drive_id)}`, { params: { fields: 'id' }, body: { trashed: true } });
}

// ---------- reading what changed in Drive ----------

async function folderIndex(tenantId) {
  const rows = (await query(`SELECT id, drive_folders FROM crm_deals WHERE tenant_id = $1 AND drive_folders IS NOT NULL`, [tenantId])).rows;
  const idx = new Map();
  for (const r of rows) for (const [k, v] of Object.entries(r.drive_folders)) if (k !== 'main') idx.set(v, { dealId: r.id, folder: k === 'old' ? 'plans' : k, old: k === 'old' });
  return idx;
}

// Pure: what a Google file type is called here.
function kindOfMime(mime) {
  if (/^image\//.test(mime)) return 'photo';
  if (/^video\//.test(mime)) return 'video';
  return 'document';
}

async function applyChange(tenantId, ch, idx) {
  const portal = require('./crmPortal');
  const existing = (await query('SELECT * FROM crm_files WHERE tenant_id = $1 AND drive_id = $2', [tenantId, ch.fileId])).rows[0];
  const file = ch.file || null;
  const gone = ch.removed || !file || file.trashed;
  if (gone) {
    if (existing) await query('DELETE FROM crm_files WHERE id = $1', [existing.id]);
    return existing ? 'removed' : null;
  }
  if (file.mimeType === FOLDER_MIME) return null;
  const place = (file.parents || []).map(p => idx.get(p)).find(Boolean);
  if (!place) {
    // Moved out of every job folder: it's no longer part of a job.
    if (existing && !(file.appProperties && file.appProperties.eagleiFileId)) await query('DELETE FROM crm_files WHERE id = $1', [existing.id]);
    return null;
  }
  const ours = file.appProperties && file.appProperties.eagleiFileId;
  if (existing || ours) {
    const row = existing || (await query('SELECT * FROM crm_files WHERE id = $1 AND tenant_id = $2', [ours, tenantId]).catch(() => ({ rows: [] }))).rows[0];
    if (!row) return null;
    // Contents changed in Drive: the copy kept here is stale, so it's dropped (fetched fresh when opened).
    await query(`UPDATE crm_files SET deal_id = $2, folder = $3, filename = $4, drive_id = $5, drive_link = COALESCE($6, drive_link), drive_modified_at = $7,
                   superseded_at = CASE WHEN $8::boolean THEN COALESCE(superseded_at, now()) ELSE NULL END,
                   data = CASE WHEN drive_modified_at IS NOT NULL AND $7::timestamptz > drive_modified_at THEN NULL ELSE data END
                 WHERE id = $1`,
      [row.id, place.dealId, place.folder, String(file.name || row.filename).slice(0, 200), file.id, file.webViewLink || null, file.modifiedTime || null, place.old]);
    return 'updated';
  }
  // New in Drive: onto the deal (fetched from Drive when it's opened).
  const isGoogleDoc = /^application\/vnd\.google-apps\./.test(file.mimeType);
  const row = (await query(
    `INSERT INTO crm_files (tenant_id, deal_id, filename, content_type, size, data, shared, folder, drive_id, drive_link, drive_modified_at, superseded_at)
     VALUES ($1, $2, $3, $4, $5, NULL, false, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING RETURNING *`,
    [tenantId, place.dealId, String(file.name || 'file').slice(0, 200), String(file.mimeType || 'application/octet-stream').slice(0, 120), Number(file.size) || 0, place.folder, file.id, file.webViewLink || null, file.modifiedTime || null, place.old ? new Date() : null])).rows[0];
  if (row && !isGoogleDoc && place.folder === 'plans' && !place.old) await portal.applyVersioning(row);
  return row ? 'added' : null;
}

async function syncTenant(conn) {
  const idx = await folderIndex(conn.tenant_id);
  let pageToken = conn.drive_page_token, n = { added: 0, updated: 0, removed: 0 };
  for (let page = 0; page < 20 && pageToken; page++) {
    const r = await call(conn, 'GET', '/changes', { params: { pageToken, pageSize: 200, includeItemsFromAllDrives: 'true', ...(conn.drive_shared_id ? { driveId: conn.drive_shared_id } : {}), fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,parents,trashed,modifiedTime,webViewLink,appProperties))' } });
    for (const ch of r.changes || []) { const what = await applyChange(conn.tenant_id, ch, idx); if (what) n[what]++; }
    if (r.newStartPageToken) { pageToken = r.newStartPageToken; break; }
    pageToken = r.nextPageToken;
  }
  await query(`UPDATE crm_google_connections SET drive_page_token = $2, drive_synced_at = now(), drive_error = NULL WHERE tenant_id = $1`, [conn.tenant_id, pageToken]);
  return n;
}

// Every tick: folders for new jobs, files waiting to go up, and what changed in Drive.
async function processDriveSync({ limit = 25 } = {}) {
  const G = require('./crmGoogle');
  if (!G.serviceAccount() && !G.oauthClient() && !httpOverride) return { tenants: 0 };
  const conns = (await query(`SELECT c.* FROM crm_google_connections c JOIN tenants t ON t.id = c.tenant_id WHERE c.drive_on = true AND c.status = 'connected' AND 'crm' = ANY(t.products)`)).rows;
  const out = { tenants: conns.length, folders: 0, pushed: 0, added: 0, updated: 0, removed: 0, errors: 0 };
  for (const c of conns) {
    try {
      const deals = (await query(`SELECT id FROM crm_deals WHERE tenant_id = $1 AND drive_folder_id IS NULL AND stage <> 'lost' ORDER BY created_at DESC LIMIT 10`, [c.tenant_id])).rows;
      for (const d of deals) { await ensureDealFolder(c, d.id); out.folders++; }
      const files = (await query(`SELECT id FROM crm_files WHERE tenant_id = $1 AND drive_id IS NULL AND data IS NOT NULL AND (drive_tried_at IS NULL OR drive_tried_at < now() - interval '30 minutes') ORDER BY created_at DESC LIMIT $2`, [c.tenant_id, limit])).rows;
      for (const f of files) { try { await pushFile(c.tenant_id, f.id); out.pushed++; } catch (e) { console.error('[crmDrive] upload failed:', e.message); } }
      const s = await syncTenant(c);
      out.added += s.added; out.updated += s.updated; out.removed += s.removed;
    } catch (e) {
      out.errors++;
      await query(`UPDATE crm_google_connections SET drive_error = $2 WHERE tenant_id = $1`, [c.tenant_id, String(e.message).slice(0, 300)]);
    }
  }
  return out;
}

// ---------- the assistant's view of the whole Drive ----------
// (Owners and admins only: the connected Drive is the company's, not just the job folders.)

const GOOGLE_EXPORT = {
  'application/vnd.google-apps.document': { mime: 'text/plain', kind: 'text' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', kind: 'text' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', kind: 'pdf' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', kind: 'pdf' }
};
const READ_MAX = 25 * 1024 * 1024;
const kindLabel = (mime) => (/folder$/.test(mime) ? 'folder' : /document$/.test(mime) ? 'Google Doc' : /spreadsheet$/.test(mime) ? 'Google Sheet' : /presentation$/.test(mime) ? 'Google Slides' : /pdf$/.test(mime) ? 'PDF' : /^image\//.test(mime) ? 'photo' : /^video\//.test(mime) ? 'video' : /word/.test(mime) ? 'Word' : /sheet|excel|csv/.test(mime) ? 'Excel' : 'file');

async function needDrive(tenantId) {
  const conn = await driveOn(tenantId);
  if (!conn) throw err('Google Drive isn’t connected. The owner or an admin can switch it on in Company details → Google.', 409);
  return conn;
}

// Pure: a Drive search for words in the name or inside the file.
function searchQuery(text) {
  const words = String(text || '').replace(/['\\]/g, ' ').split(/\s+/).filter(w => w.length > 1).slice(0, 6);
  const parts = words.map(w => `(name contains '${w}' or fullText contains '${w}')`);
  return [...parts, 'trashed = false', `mimeType != '${FOLDER_MIME}'`].join(' and ');
}

async function searchDrive(tenantId, { text, limit = 15 }) {
  const conn = await needDrive(tenantId);
  const r = await call(conn, 'GET', '/files', { params: { q: searchQuery(text), pageSize: Math.min(30, limit), orderBy: 'modifiedTime desc', includeItemsFromAllDrives: 'true', corpora: conn.kind === 'signin' ? 'user' : 'allDrives', fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink,parents,owners(displayName))' } });
  const idx = await folderIndex(tenantId);
  const deals = new Map((await query(`SELECT id, title FROM crm_deals WHERE tenant_id = $1 AND drive_folders IS NOT NULL`, [tenantId])).rows.map(d => [d.id, d.title]));
  return (r.files || []).map(f => {
    const place = (f.parents || []).map(p => idx.get(p)).find(Boolean);
    return { id: f.id, name: f.name, kind: kindLabel(f.mimeType), modified: f.modifiedTime ? String(f.modifiedTime).slice(0, 10) : null, sizeKb: f.size ? Math.round(Number(f.size) / 1024) : null, link: f.webViewLink || null, owner: f.owners && f.owners[0] && f.owners[0].displayName, job: place ? deals.get(place.dealId) || null : null, jobFolder: place ? place.folder : null };
  });
}

// A Drive file's contents for reading: bytes (PDF, photos, office files) or text (Docs, Sheets).
async function readDriveFile(tenantId, fileId) {
  const conn = await needDrive(tenantId);
  const meta = await call(conn, 'GET', `/files/${encodeURIComponent(fileId)}`, { params: { fields: 'id,name,mimeType,size,webViewLink,modifiedTime' } });
  const exp = GOOGLE_EXPORT[meta.mimeType];
  if (/^application\/vnd\.google-apps\./.test(meta.mimeType) && !exp) throw err(`“${meta.name}” is a ${kindLabel(meta.mimeType)}, which can’t be read here. Open it in Drive: ${meta.webViewLink || ''}`);
  if (!exp && Number(meta.size) > READ_MAX) throw err(`“${meta.name}” is too big to read here (${Math.round(Number(meta.size) / 1048576)} MB). Split it, or open it in Drive.`);
  const buf = exp
    ? await call(conn, 'GET', `/files/${encodeURIComponent(fileId)}/export`, { params: { mimeType: exp.mime }, raw: true })
    : await call(conn, 'GET', `/files/${encodeURIComponent(fileId)}`, { params: { alt: 'media' }, raw: true });
  return { meta, mediaType: exp ? exp.mime : meta.mimeType, data: buf };
}

// A Drive file onto a job: copied into the job's subfolder in Drive (the original stays where it was)
// and listed on the deal.
async function copyToDeal({ tenantId, fileId, dealId, folder = null, userId = null }) {
  const conn = await needDrive(tenantId);
  const map = await ensureDealFolder(conn, dealId);
  const src = await readDriveFile(tenantId, fileId);
  const portal = require('./crmPortal');
  const fold = portal.FOLDERS[folder] ? folder : portal.guessFolder({ filename: src.meta.name, type: src.mediaType });
  const exp = GOOGLE_EXPORT[src.meta.mimeType];
  const name = exp ? `${src.meta.name}.${exp.mime === 'text/csv' ? 'csv' : exp.mime === 'text/plain' ? 'txt' : 'pdf'}` : src.meta.name;
  // A real file: one copy inside Drive. A Google Doc: its exported version, so Eagle I can read it later.
  if (!exp) {
    const copy = await call(conn, 'POST', `/files/${encodeURIComponent(fileId)}/copy`, { params: { fields: 'id,webViewLink,modifiedTime,size,mimeType' }, body: { name, parents: [map[fold] || map.other] } });
    const row = (await query(
      `INSERT INTO crm_files (tenant_id, deal_id, filename, content_type, size, data, shared, folder, drive_id, drive_link, drive_modified_at, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, $10, $11) RETURNING id, filename, folder`,
      [tenantId, dealId, String(name).slice(0, 200), String(copy.mimeType || src.mediaType).slice(0, 120), src.data.length, src.data.length <= KEEP_COPY_MAX ? src.data : null, fold, copy.id, copy.webViewLink || null, copy.modifiedTime || null, userId])).rows[0];
    await call(conn, 'PATCH', `/files/${encodeURIComponent(copy.id)}`, { params: { fields: 'id' }, body: { appProperties: { eagleiFileId: row.id } } }).catch(() => {});
    if (fold === 'plans') await portal.applyVersioning((await query('SELECT * FROM crm_files WHERE id = $1', [row.id])).rows[0]);
    return row;
  }
  const f = await portal.addFile({ tenantId, dealId, filename: name, buffer: src.data, folder: fold, userId, shared: false });
  return { id: f.id, filename: f.filename, folder: f.folder };
}

module.exports = { SCOPE, searchQuery, searchDrive, readDriveFile, copyToDeal, SUBFOLDERS, ROOT_NAME, KEEP_COPY_MAX, setHttp, status, enable, disable, driveOn, ensureDealFolder, multipart, pushFile, download, moveFile, renameFile, trashFile, kindOfMime, applyChange, syncTenant, processDriveSync };
