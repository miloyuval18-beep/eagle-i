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

// A price request from "Price this project" (lib/crmPricing.js) also carries its run, its
// package and the lines to price: the email lists them, the page prices each one, and a
// reply by email is read for the prices (reply+bid-<id>@ when inbound email is set up).
async function sendBidRequests({ tenantId, dealId, vendorIds, scope = null, message = null, fileIds = [], dueDate = null, userId = null, baseUrl = '', send = sendEmail, runId = null, packageKey = null, lines = null }) {
  const deal = await crm.getDeal(tenantId, dealId);
  if (!deal) throw err('Deal not found.', 404);
  const files = fileIds.length ? (await query('SELECT id, filename FROM crm_files WHERE tenant_id = $1 AND deal_id = $2 AND id = ANY($3)', [tenantId, dealId, fileIds])).rows : [];
  if (files.length !== new Set(fileIds).size) throw err('One of those files isn’t on this deal.');
  const vendors = await recipients({ tenantId, vendorIds });
  if (!vendors.length) throw err('Pick at least one sub or vendor.');
  const due = dueDate && require('./day').test(dueDate) ? dueDate : null;
  const co = (await query(`SELECT t.company_name, bp.phone, bp.email FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [tenantId])).rows[0] || {};
  const fromAddress = await require('./sendingDomain').getVerifiedFromAddress(tenantId);
  const out = { sent: [], skipped: [] };
  for (const v of vendors) {
    if (!EMAIL_RE.test(String(v.email || '').trim())) { out.skipped.push({ name: v.name, why: 'no email address' }); continue; }
    const token = crypto.randomBytes(24).toString('hex');
    let page = { text: '' };
    const row = (await query(
      `INSERT INTO crm_bid_requests (tenant_id, deal_id, vendor_id, token, scope, message, file_ids, due_date, created_by, run_id, package_key, lines) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [tenantId, dealId, v.id, token, scope ? String(scope).slice(0, 4000) : null, message ? String(message).slice(0, 4000) : null, files.map(f => f.id), due, userId, runId, packageKey, Array.isArray(lines) && lines.length ? JSON.stringify(lines) : null])).rows[0];
    const list = Array.isArray(lines) && lines.length ? lines : null;
    const replyAddr = require('./email').buildReplyToAddress('bid', row.id);
    const link = `${baseUrl}/bid/${token}`;
    const area = areaOf(deal.property_address) || '';
    const subject = `Bid request from ${co.company_name}: ${deal.title}${area ? ` (${area})` : ''}`.slice(0, 150);
    const html = `<div style="font-family:Arial,sans-serif;font-size:17px;color:#14202b;max-width:560px;line-height:1.5"><p>Hi ${esc(v.name)},</p>
${message ? `<p style="white-space:pre-wrap">${esc(message)}</p>` : `<p>${esc(co.company_name)} would like your price on <b>${esc(deal.title)}</b>${area ? ` in ${esc(area)}` : ''}.</p>`}
${scope ? `<p style="white-space:pre-wrap;background:#f4f6f8;border-radius:8px;padding:10px 12px">${esc(scope)}</p>` : ''}
${list ? `<p><b>Please price these${list.length > 1 ? ' (each line)' : ''}:</b></p><table style="border-collapse:collapse;width:100%;font-size:15px">${list.map(l => `<tr><td style="border-bottom:1px solid #dde3e8;padding:6px 4px">${esc(l.name)}${l.spec ? `<br><span style="color:#55636f">${esc(l.spec)}</span>` : ''}</td><td style="border-bottom:1px solid #dde3e8;padding:6px 4px;text-align:right;white-space:nowrap">${l.quantity != null ? esc(l.quantity) + ' ' + esc(l.unit || '') : ''}</td></tr>`).join('')}</table>` : ''}
${files.length ? `<p>${files.length} file${files.length === 1 ? '' : 's'} attached to the request: ${files.map(f => esc(f.filename)).join(', ')}</p>` : ''}
${due ? `<p>Please send your price by <b>${esc(new Date(due + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }))}</b>.</p>` : ''}
<p style="margin:20px 0"><a href="${link}" style="background:#1f4e79;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">See the plans and send your price</a></p>
<p>${replyAddr ? 'You can also just reply to this email with your prices or attach your quote.' : 'Questions? Reply to this email.'}${co.phone ? ` Questions? Call ${esc(co.phone)}.` : ''}</p><p>${esc(co.company_name)}</p>${(page = await require('./crmSubPortal').pageLine(tenantId, v.id, baseUrl)).html}</div>`;
    const text = `Hi ${v.name},\n\n${message || `${co.company_name} would like your price on ${deal.title}${area ? ` in ${area}` : ''}.`}\n${scope ? `\n${scope}\n` : ''}${list ? `\nPlease price these:\n${list.map(l => `- ${l.name}${l.spec ? ` (${l.spec})` : ''}${l.quantity != null ? `: ${l.quantity} ${l.unit || ''}` : ''}`).join('\n')}\n` : ''}${files.length ? `\nFiles: ${files.map(f => f.filename).join(', ')}\n` : ''}${due ? `\nPlease send your price by ${due}.\n` : ''}\nSee the plans and send your price: ${link}${replyAddr ? '\nOr just reply to this email with your prices.' : ''}\n\n${co.company_name}${page.text}`;
    try {
      await send({ to: v.email.trim(), subject, html, text, replyTo: replyAddr || (EMAIL_RE.test(String(co.email || '')) ? co.email : undefined), fromName: co.company_name, fromAddress: fromAddress || undefined });
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
    `SELECT b.id, b.status, b.amount, b.bid_note, b.sent_at, b.viewed_at, b.submitted_at, b.due_date, b.scope, b.run_id, b.package_key, b.lines, b.line_prices, b.quote_source, b.lead_time, v.name AS vendor, v.trade, v.phone, v.email
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
// Pure: the part of an address a sub may see before the job is theirs (city, state, ZIP), never the street.
function areaOf(address) {
  const parts = String(address || '').split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length > 1) return parts.slice(1).join(', ');
  const zip = String(address || '').match(/\b\d{5}\b/);
  return zip ? zip[0] : null;
}
async function bidInfo(token) {
  const b = await byToken(token);
  if (!b) return null;
  if (!b.viewed_at) await query(`UPDATE crm_bid_requests SET viewed_at = now(), status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END WHERE id = $1`, [b.id]);
  // Plans revised since the request went out: the sub sees the newest version.
  const ids = await require('./crmPortal').latestVersions(b.file_ids);
  const files = ids.length ? (await query('SELECT id, filename, content_type, size, version FROM crm_files WHERE id = ANY($1)', [ids])).rows : [];
  return {
    company: b.company_name, companyPhone: b.company_phone, vendor: b.vendor, job: b.job, area: areaOf(b.address),
    address: b.status === 'awarded' ? b.address : null, scope: b.scope, message: b.message, due: b.due_date ? ymd(b.due_date) : null,
    files: files.map(f => ({ id: f.id, filename: f.filename, size: Number(f.size), version: f.version > 1 ? f.version : null })), status: b.status, amount: b.amount == null ? null : Number(b.amount), note: b.bid_note,
    lines: Array.isArray(b.lines) ? b.lines.map(l => ({ i: l.i, name: l.name, spec: l.spec || null, quantity: l.quantity, unit: l.unit })) : null,
    linePrices: Array.isArray(b.line_prices) ? b.line_prices : null, leadTime: b.lead_time || null
  };
}
async function bidFile(token, fileId) {
  const b = await byToken(token);
  if (!b || !(b.file_ids.includes(fileId) || (await require('./crmPortal').latestVersions(b.file_ids)).includes(fileId))) return null;
  return (await query('SELECT * FROM crm_files WHERE id = $1', [fileId])).rows[0] || null;
}
// Their price for each line asked about: only lines that were asked, a price per unit
// (or the line's total), and the overall amount is what the lines add up to.
function cleanLinePrices(asked, given) {
  const byI = new Map((Array.isArray(asked) ? asked : []).map(l => [Number(l.i), l]));
  const out = [];
  for (const g of Array.isArray(given) ? given : []) {
    const l = byI.get(Number(g && g.i));
    if (!l || out.some(o => o.i === l.i)) continue;
    const num = (x) => { const n = Number(String(x == null ? '' : x).replace(/[$,\s]/g, '')); return n > 0 && n < 1e9 ? n : null; };
    let unit = num(g.unit_price), total = num(g.total);
    const q = Number(l.quantity) > 0 ? Number(l.quantity) : 1;
    if (unit == null && total == null) continue;
    if (unit == null) unit = total / q;
    if (total == null) total = unit * q;
    out.push({ i: l.i, unit_price: Math.round(unit * 10000) / 10000, total: Math.round(total * 100) / 100, note: String(g.note || '').slice(0, 300) || null });
  }
  return out;
}

// Records a price (from the page or read from an email reply).
async function recordPrice(b, { amount, note, decline = false, lines = null, source = 'page', leadTime = null }) {
  if (b.status === 'awarded') throw err('This job has already been awarded. Thank you!');
  if (decline) {
    await query(`UPDATE crm_bid_requests SET status = 'declined', bid_note = $2, submitted_at = now(), quote_source = $3 WHERE id = $1`, [b.id, String(note || '').slice(0, 2000) || null, source]);
    await crm.logActivity({ tenantId: b.tenant_id, dealId: b.deal_id, kind: 'reply', actor: 'eagle_i', body: `${b.vendor} passed on the bid.${note ? ` “${String(note).slice(0, 200)}”` : ''}` });
    if (b.run_id) await require('./crmPricing').checkRun(b.run_id).catch(e => console.error('[crmBids] pricing check failed:', e.message));
    return { status: 'declined' };
  }
  const lp = Array.isArray(b.lines) && b.lines.length ? cleanLinePrices(b.lines, lines) : [];
  let n = Number(String(amount == null ? '' : amount).replace(/[$,\s]/g, ''));
  if (lp.length && !(n > 0)) n = lp.reduce((t, x) => t + x.total, 0);
  if (!(n > 0 && n < 1e9)) throw err(Array.isArray(b.lines) && b.lines.length ? 'Enter a price for at least one line, or your total.' : 'Enter your price.');
  await query(`UPDATE crm_bid_requests SET status = 'submitted', amount = $2, bid_note = $3, submitted_at = now(), line_prices = $4, quote_source = $5, lead_time = $6 WHERE id = $1`,
    [b.id, Math.round(n * 100) / 100, String(note || '').slice(0, 4000) || null, lp.length ? JSON.stringify(lp) : null, source, String(leadTime || '').slice(0, 200) || null]);
  await crm.logActivity({ tenantId: b.tenant_id, dealId: b.deal_id, kind: 'reply', actor: 'eagle_i', body: `${b.vendor} ${b.run_id ? 'priced' : 'bid'} ${money(n)}${lp.length ? ` (${lp.length} line${lp.length === 1 ? '' : 's'})` : ''}${source === 'email' ? ', by email' : ''}.${note ? ` “${String(note).slice(0, 300)}”` : ''}` });
  const others = (await query(`SELECT COUNT(*) FILTER (WHERE status = 'submitted')::int AS n, COUNT(*)::int AS total FROM crm_bid_requests WHERE deal_id = $1 AND sent_at > now() - interval '60 days'`, [b.deal_id])).rows[0];
  await crm.addInboxItem({ tenantId: b.tenant_id, dealId: b.deal_id, kind: 'reply', dedupeKey: `bid:${b.id}`, title: `${b.vendor} ${b.run_id ? 'priced' : 'bid'} ${money(n)} on ${b.job}`, detail: `${others.n} of ${others.total} prices in.${note ? ` “${String(note).slice(0, 300)}”` : ''}` });
  if (b.run_id) await require('./crmPricing').checkRun(b.run_id).catch(e => console.error('[crmBids] pricing check failed:', e.message));
  return { status: 'submitted', amount: Math.round(n * 100) / 100 };
}

async function submitBid({ token, amount, note, decline = false, lines = null, leadTime = null }) {
  const b = await byToken(token);
  if (!b) throw err('This link is no longer active.', 404);
  return recordPrice(b, { amount, note, decline, lines, leadTime, source: 'page' });
}

async function byId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const b = (await query(`SELECT token FROM crm_bid_requests WHERE id = $1`, [id])).rows[0];
  return b ? byToken(b.token) : null;
}

module.exports = { areaOf, recipients, sendBidRequests, listBids, award, bidInfo, bidFile, submitBid, recordPrice, cleanLinePrices, byId };
