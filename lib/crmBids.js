// Bid requests in Eagle I CRM: plans out to subs, prices back in.
//
// "Send these plans to all the framers": each sub gets an email with the job,
// the scope, the due date and a private link (/bid/<token>) where they can
// download the plans and send back a price and a note. Their bid lands on the
// deal next to everyone else's; opening the link is recorded; the team picks
// one ("award") with a tap. Subs only ever see the files picked for the
// request, never anything else on the job.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('./email');
const crm = require('./crm');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

// Who a request would go to: named vendors, or everyone whose trade matches.
async function recipients({ tenantId, vendorIds = null, trade = null }) {
  if (Array.isArray(vendorIds) && vendorIds.length) {
    return (await query('SELECT id, name, trade, email FROM crm_vendors WHERE tenant_id = $1 AND id = ANY($2) AND archived = false ORDER BY name', [tenantId, vendorIds])).rows;
  }
  const t = String(trade || '').trim().toLowerCase();
  if (!t) return [];
  const stem = t.replace(/(ers|ing|er|s)$/, '');
  return (await query(`SELECT id, name, trade, email FROM crm_vendors WHERE tenant_id = $1 AND archived = false AND (LOWER(trade) LIKE $2 OR LOWER(name) LIKE $2) ORDER BY name`,
    [tenantId, `%${stem}%`])).rows;
}

async function sendBidRequests({ tenantId, dealId, vendorIds, scope = null, message = null, fileIds = [], dueDate = null, userId = null, baseUrl = '', send = sendEmail }) {
  const deal = await crm.getDeal(tenantId, dealId);
  if (!deal) throw err('Deal not found.', 404);
  const files = fileIds.length ? (await query('SELECT id, filename FROM crm_files WHERE tenant_id = $1 AND deal_id = $2 AND id = ANY($3)', [tenantId, dealId, fileIds])).rows : [];
  if (files.length !== new Set(fileIds).size) throw err('One of those files isn’t on this deal.');
  const vendors = await recipients({ tenantId, vendorIds });
  if (!vendors.length) throw err('Pick at least one sub or vendor.');
  const due = dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : null;
  const co = (await query(`SELECT t.company_name, bp.phone, bp.email FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [tenantId])).rows[0] || {};
  const fromAddress = await require('./sendingDomain').getVerifiedFromAddress(tenantId);
  const out = { sent: [], skipped: [] };
  for (const v of vendors) {
    if (!EMAIL_RE.test(String(v.email || '').trim())) { out.skipped.push({ name: v.name, why: 'no email address' }); continue; }
    const token = crypto.randomBytes(24).toString('hex');
    const row = (await query(
      `INSERT INTO crm_bid_requests (tenant_id, deal_id, vendor_id, token, scope, message, file_ids, due_date, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [tenantId, dealId, v.id, token, scope ? String(scope).slice(0, 4000) : null, message ? String(message).slice(0, 4000) : null, files.map(f => f.id), due, userId])).rows[0];
    const link = `${baseUrl}/bid/${token}`;
    const area = deal.property_address ? deal.property_address.split(',').slice(-2).join(',').trim() : '';
    const subject = `Bid request from ${co.company_name}: ${deal.title}${area ? ` (${area})` : ''}`.slice(0, 150);
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#14202b;max-width:560px;line-height:1.5"><p>Hi ${esc(v.name)},</p>
${message ? `<p style="white-space:pre-wrap">${esc(message)}</p>` : `<p>${esc(co.company_name)} would like your price on <b>${esc(deal.title)}</b>${area ? ` in ${esc(area)}` : ''}.</p>`}
${scope ? `<p style="white-space:pre-wrap;background:#f4f6f8;border-radius:8px;padding:10px 12px">${esc(scope)}</p>` : ''}
${files.length ? `<p>${files.length} file${files.length === 1 ? '' : 's'} attached to the request: ${files.map(f => esc(f.filename)).join(', ')}</p>` : ''}
${due ? `<p>Please send your price by <b>${esc(new Date(due + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }))}</b>.</p>` : ''}
<p style="margin:20px 0"><a href="${link}" style="background:#1f4e79;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">See the plans and send your price</a></p>
<p>Questions? Reply to this email${co.phone ? ` or call ${esc(co.phone)}` : ''}.</p><p>${esc(co.company_name)}</p></div>`;
    const text = `Hi ${v.name},\n\n${message || `${co.company_name} would like your price on ${deal.title}${area ? ` in ${area}` : ''}.`}\n${scope ? `\n${scope}\n` : ''}${files.length ? `\nFiles: ${files.map(f => f.filename).join(', ')}\n` : ''}${due ? `\nPlease send your price by ${due}.\n` : ''}\nSee the plans and send your price: ${link}\n\n${co.company_name}`;
    try {
      await send({ to: v.email.trim(), subject, html, text, replyTo: EMAIL_RE.test(String(co.email || '')) ? co.email : undefined, fromName: co.company_name, fromAddress: fromAddress || undefined });
      out.sent.push({ id: row.id, name: v.name });
    } catch (e) {
      await query('DELETE FROM crm_bid_requests WHERE id = $1', [row.id]);
      out.skipped.push({ name: v.name, why: /RESEND_API_KEY/.test(e.message) ? 'email sending isn’t set up' : 'the email failed' });
    }
  }
  if (out.sent.length) await crm.logActivity({ tenantId, dealId, kind: 'email', userId, actor: userId ? 'owner' : 'eagle_i', body: `Sent a bid request${files.length ? ` with ${files.length} file${files.length === 1 ? '' : 's'}` : ''} to ${out.sent.map(s => s.name).join(', ')}.` });
  return out;
}

async function listBids(tenantId, dealId) {
  return (await query(
    `SELECT b.id, b.status, b.amount, b.bid_note, b.sent_at, b.viewed_at, b.submitted_at, b.due_date, b.scope, v.name AS vendor, v.trade, v.phone, v.email
     FROM crm_bid_requests b JOIN crm_vendors v ON v.id = b.vendor_id WHERE b.tenant_id = $1 AND b.deal_id = $2 ORDER BY (b.amount IS NULL), b.amount, b.sent_at DESC`, [tenantId, dealId])).rows;
}

async function award({ tenantId, id, userId = null }) {
  const b = (await query(`SELECT b.*, v.name AS vendor FROM crm_bid_requests b JOIN crm_vendors v ON v.id = b.vendor_id WHERE b.id = $1 AND b.tenant_id = $2`, [id, tenantId])).rows[0];
  if (!b) throw err('Bid not found.', 404);
  if (b.status !== 'submitted') throw err('Only a submitted bid can be picked.');
  await query(`UPDATE crm_bid_requests SET status = 'awarded' WHERE id = $1`, [id]);
  await crm.logActivity({ tenantId, dealId: b.deal_id, kind: 'system', userId, body: `Picked ${b.vendor}’s bid (${money(b.amount)}).` });
  return { ok: true };
}

// ---------- the sub's page ----------

async function byToken(token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  return (await query(
    `SELECT b.*, v.name AS vendor, d.title AS job, p.address, t.company_name, bp.phone AS company_phone FROM crm_bid_requests b JOIN crm_vendors v ON v.id = b.vendor_id
     JOIN crm_deals d ON d.id = b.deal_id LEFT JOIN crm_properties p ON p.id = d.property_id JOIN tenants t ON t.id = b.tenant_id LEFT JOIN business_profile bp ON bp.tenant_id = b.tenant_id
     WHERE b.token = $1`, [token])).rows[0] || null;
}
async function bidInfo(token) {
  const b = await byToken(token);
  if (!b) return null;
  if (!b.viewed_at) await query(`UPDATE crm_bid_requests SET viewed_at = now(), status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END WHERE id = $1`, [b.id]);
  // Plans revised since the request went out: the sub sees the newest version.
  const ids = await require('./crmPortal').latestVersions(b.file_ids);
  const files = ids.length ? (await query('SELECT id, filename, content_type, size, version FROM crm_files WHERE id = ANY($1)', [ids])).rows : [];
  return {
    company: b.company_name, companyPhone: b.company_phone, vendor: b.vendor, job: b.job, area: b.address ? b.address.split(',').slice(-2).join(',').trim() : null,
    address: b.status === 'awarded' ? b.address : null, scope: b.scope, message: b.message, due: b.due_date ? ymd(b.due_date) : null,
    files: files.map(f => ({ id: f.id, filename: f.filename, size: Number(f.size), version: f.version > 1 ? f.version : null })), status: b.status, amount: b.amount == null ? null : Number(b.amount), note: b.bid_note
  };
}
async function bidFile(token, fileId) {
  const b = await byToken(token);
  if (!b || !(b.file_ids.includes(fileId) || (await require('./crmPortal').latestVersions(b.file_ids)).includes(fileId))) return null;
  return (await query('SELECT * FROM crm_files WHERE id = $1', [fileId])).rows[0] || null;
}
async function submitBid({ token, amount, note, decline = false }) {
  const b = await byToken(token);
  if (!b) throw err('This link is no longer active.', 404);
  if (b.status === 'awarded') throw err('This job has already been awarded. Thank you!');
  if (decline) {
    await query(`UPDATE crm_bid_requests SET status = 'declined', bid_note = $2, submitted_at = now() WHERE id = $1`, [b.id, String(note || '').slice(0, 2000) || null]);
    await crm.logActivity({ tenantId: b.tenant_id, dealId: b.deal_id, kind: 'reply', actor: 'eagle_i', body: `${b.vendor} passed on the bid.${note ? ` “${String(note).slice(0, 200)}”` : ''}` });
    return { status: 'declined' };
  }
  const n = Number(String(amount == null ? '' : amount).replace(/[$,\s]/g, ''));
  if (!(n > 0 && n < 1e9)) throw err('Enter your price.');
  await query(`UPDATE crm_bid_requests SET status = 'submitted', amount = $2, bid_note = $3, submitted_at = now() WHERE id = $1`, [b.id, Math.round(n * 100) / 100, String(note || '').slice(0, 4000) || null]);
  await crm.logActivity({ tenantId: b.tenant_id, dealId: b.deal_id, kind: 'reply', actor: 'eagle_i', body: `${b.vendor} bid ${money(n)}.${note ? ` “${String(note).slice(0, 300)}”` : ''}` });
  const others = (await query(`SELECT COUNT(*) FILTER (WHERE status = 'submitted')::int AS n, COUNT(*)::int AS total FROM crm_bid_requests WHERE deal_id = $1 AND sent_at > now() - interval '60 days'`, [b.deal_id])).rows[0];
  await crm.addInboxItem({ tenantId: b.tenant_id, dealId: b.deal_id, kind: 'reply', dedupeKey: `bid:${b.id}`, title: `${b.vendor} bid ${money(n)} on ${b.job}`, detail: `${others.n} of ${others.total} bids in.${note ? ` “${String(note).slice(0, 300)}”` : ''}` });
  return { status: 'submitted' };
}

module.exports = { recipients, sendBidRequests, listBids, award, bidInfo, bidFile, submitBid };
