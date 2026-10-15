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

// What a file really is, from its first bytes.
function sniffType(buf) {
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf', ext: 'pdf', kind: 'document' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg', kind: 'photo' };
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png', kind: 'photo' };
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp', ext: 'webp', kind: 'photo' };
  return null;
}
function safeFilename(name, ext) {
  const base = String(name || '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').replace(/\.[a-z0-9]{1,5}$/i, '').trim().slice(0, 80) || 'file';
  return `${base}.${ext}`;
}

// `dataBase64`: the file's bytes, base64 (a data: URL prefix is fine).
async function addFile({ tenantId, dealId, filename, dataBase64, caption = null, shared = null, userId = null, fromHomeowner = false, updateId = null }) {
  const raw = String(dataBase64 || '').replace(/^data:[^,]*,/, '');
  if (!raw) throw err('Choose a file to upload.');
  if (raw.length > Math.ceil(MAX_FILE * 4 / 3) + 8) throw err('That file is too big. The limit is 8 MB.');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length > MAX_FILE) throw err('That file is too big. The limit is 8 MB.');
  const t = sniffType(buf);
  if (!t) throw err('Only photos (JPEG, PNG, WebP) and PDFs can be uploaded.');
  const count = (await query('SELECT COUNT(*)::int AS n FROM crm_files WHERE deal_id = $1', [dealId])).rows[0].n;
  if (count >= MAX_FILES_PER_DEAL) throw err('This deal already has the most files allowed.');
  const share = shared == null ? fromHomeowner : !!shared;
  const row = (await query(
    `INSERT INTO crm_files (tenant_id, deal_id, filename, content_type, size, data, caption, shared, uploaded_by, from_homeowner, update_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, filename, content_type, size, caption, shared, from_homeowner, created_at`,
    [tenantId, dealId, safeFilename(filename, t.ext), t.type, buf.length, buf, String(caption || '').trim().slice(0, 300) || null, share, userId, fromHomeowner, updateId])).rows[0];
  return { ...row, kind: t.kind };
}

async function listFiles(tenantId, dealId, { sharedOnly = false } = {}) {
  return (await query(
    `SELECT f.id, f.filename, f.content_type, f.size, f.caption, f.shared, f.from_homeowner, f.update_id, f.created_at, COALESCE(u.name, u.email) AS uploaded_by_name
     FROM crm_files f LEFT JOIN users u ON u.id = f.uploaded_by
     WHERE f.tenant_id = $1 AND f.deal_id = $2 AND ($3::boolean = false OR f.shared = true) ORDER BY f.created_at DESC`,
    [tenantId, dealId, sharedOnly])).rows.map(f => ({ ...f, kind: f.content_type === 'application/pdf' ? 'document' : 'photo' }));
}

async function getFile(tenantId, id) {
  return (await query('SELECT * FROM crm_files WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0] || null;
}

async function updateFile({ tenantId, id, shared, caption }) {
  const sets = [], vals = [id, tenantId];
  if (typeof shared === 'boolean') { vals.push(shared); sets.push(`shared = $${vals.length}`); }
  if (caption !== undefined) { vals.push(String(caption || '').trim().slice(0, 300) || null); sets.push(`caption = $${vals.length}`); }
  if (!sets.length) return true;
  return (await query(`UPDATE crm_files SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING id`, vals)).rowCount > 0;
}

async function deleteFile({ tenantId, id }) {
  return (await query('DELETE FROM crm_files WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId])).rowCount > 0;
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
    `SELECT d.*, c.name AS contact_name, c.email AS contact_email, p.address AS property_address FROM crm_deals d
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
    total: Number(e.total), link: `/e/${e.public_token}`
  }));
  const files = await listFiles(deal.tenant_id, deal.id, { sharedOnly: true });
  const updates = (await query(
    `SELECT u.id, u.body, u.created_at, COALESCE(us.name, us.email) AS author FROM crm_portal_updates u LEFT JOIN users us ON us.id = u.created_by
     WHERE u.deal_id = $1 ORDER BY u.created_at DESC LIMIT 100`, [deal.id])).rows;
  return {
    company: { name: company.name, phone: company.phone, email: company.email },
    project: { title: deal.title, address: deal.property_address, status: HOMEOWNER_STATUS[deal.stage] || 'In progress', stageKey: deal.stage, customer: deal.contact_name },
    nextVisit: deal.site_visit_at && new Date(deal.site_visit_at) > new Date() ? deal.site_visit_at : null,
    estimates,
    files: files.map(f => ({ id: f.id, filename: f.filename, kind: f.kind, caption: f.caption, fromHomeowner: f.from_homeowner, updateId: f.update_id, createdAt: f.created_at })),
    updates: updates.map(u => ({ id: u.id, body: u.body, author: u.author, createdAt: u.created_at })),
    job: await require('./crmJobs').portalJob(deal.id),
    home: await require('./crmLifetime').portalHome(deal)
  };
}

async function portalFile(token, fileId) {
  const deal = await dealByPortal(token);
  if (!deal || !/^[0-9a-f-]{36}$/.test(String(fileId || ''))) return null;
  return (await query('SELECT * FROM crm_files WHERE id = $1 AND deal_id = $2 AND shared = true', [fileId, deal.id])).rows[0] || null;
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
async function portalMessage({ token, message }) {
  const deal = await dealByPortal(token);
  if (!deal) throw err('This link is not valid.', 404);
  const text = String(message || '').trim().slice(0, 3000);
  if (!text) throw err('Write a message first.');
  await crm.logActivity({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'reply', actor: 'contact', body: `Message from the portal: ${text}` });
  await require('./crmPlaybooks').cancelForDeal(deal.id, 'replied', { trigger: 'stage' });
  await crm.addInboxItem({ tenantId: deal.tenant_id, dealId: deal.id, kind: 'reply', dedupeKey: `portal-msg:${deal.id}:${Date.now()}`, title: `${deal.contact_name} sent a message from their portal`, detail: text.slice(0, 600) });
  await notifyTeam(deal, `Message from ${deal.contact_name}: ${deal.title}`.slice(0, 150), `${deal.contact_name} wrote from their project portal:\n\n${text}`);
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
  await crm.logActivity({ tenantId, dealId, kind: 'system', userId, body: `Posted a portal update: ${text.slice(0, 200)}` });
  let emailed = false;
  if (email) {
    const to = String(deal.contact_email || '').trim();
    if (!EMAIL_RE.test(to)) throw err('This contact has no email address, so the update was posted but not emailed.');
    const blocked = (await query(`SELECT 1 FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) AND reason IN ('bounced', 'complained')`, [tenantId, to])).rows[0];
    if (blocked) throw err('Email to this person bounced or was reported, so the update was posted but not emailed.');
    const link = `${baseUrl}/p/${await portalToken(tenantId, dealId)}`;
    const co = (await query(`SELECT t.company_name, bp.address, bp.email FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [tenantId])).rows[0] || {};
    const first = String(deal.contact_name || '').trim().split(/\s+/)[0] || 'there';
    await send({
      to, subject: `Project update from ${co.company_name}: ${deal.title}`.slice(0, 150),
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#14202b;max-width:560px;line-height:1.5"><p>Hi ${esc(first)},</p><p style="white-space:pre-wrap">${esc(text)}</p><p><a href="${link}">See photos and everything about your project</a></p><p style="color:#55636f;font-size:12px">${esc(co.company_name)}${co.address ? ' · ' + esc(co.address) : ''}</p></div>`,
      text: `Hi ${first},\n\n${text}\n\nSee photos and everything about your project: ${link}\n\n${co.company_name}${co.address ? ' · ' + co.address : ''}`,
      replyTo: EMAIL_RE.test(String(co.email || '')) ? co.email : undefined, fromName: co.company_name,
      fromAddress: (await require('./sendingDomain').getVerifiedFromAddress(tenantId)) || undefined
    });
    await query('UPDATE crm_portal_updates SET emailed_at = now() WHERE id = $1', [u.id]);
    emailed = true;
  }
  return { update: u, emailed };
}

module.exports = {
  MAX_FILE, HOMEOWNER_STATUS, sniffType, safeFilename, addFile, listFiles, getFile, updateFile, deleteFile,
  portalToken, resetPortalToken, portalView, portalFile, portalMessage, portalUpload, postUpdate
};
