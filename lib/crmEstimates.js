// Estimates in Eagle I CRM: a cost catalog, line-item estimates on a deal, and
// a private link where the homeowner views, downloads and accepts or declines.
//
// Money rules:
//  - each line's price = quantity × unit cost × (1 + markup %), in cents;
//  - the homeowner only ever sees prices, never costs or markups;
//  - totals are recalculated on the server on every save, never trusted from
//    the browser.
//
// What happens on its own:
//  - sending a design agreement moves the deal to "Design agreement sent";
//    sending a construction estimate moves it to "Proposal sent" (so that
//    stage's approved follow-up emails start);
//  - the first time the homeowner opens it, that goes on the deal's timeline;
//  - accepting moves the deal to "In design" or "Contract signed" and tells
//    the team; declining goes to "Needs you".
const crypto = require('crypto');
const { query, pool } = require('../db');
const { sendEmail } = require('./email');
const crm = require('./crm');

const KINDS = { design_agreement: 'Design agreement', construction: 'Construction estimate' };
const CATEGORIES = ['labor', 'materials', 'subcontract', 'allowance', 'other'];
const UNITS = ['ea', 'sf', 'lf', 'sy', 'cy', 'hr', 'day', 'ls', 'allow'];
const MAX_LINES = 300;
const SEND_STAGE = { design_agreement: 'design_agreement', construction: 'proposal' };
const ACCEPT_STAGE = { design_agreement: 'in_design', construction: 'signed' };
const STAGE_ORDER = crm.STAGES.map(s => s.key);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const cents = (n) => Math.round((Number(n) || 0) * 100);
const fromCents = (c) => Math.round(c) / 100;

function num(v, { min = 0, max = 1e9, fallback = 0 } = {}) {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[$,\s%]/g, ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
const text = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max) : null; };

// ---------- pure math ----------

function linePrice({ quantity, unit_cost, markup_pct }) {
  return fromCents(Math.round(num(quantity, { max: 1e7 }) * cents(num(unit_cost, { max: 1e8 })) * (1 + num(markup_pct, { max: 1000 }) / 100)));
}

// Cleans what the browser sent and works out every number on the server.
function computeEstimate({ lines, default_markup_pct = 20, tax_pct = 0, deposit_pct = 0 }) {
  const dm = num(default_markup_pct, { max: 1000, fallback: 20 });
  const clean = (Array.isArray(lines) ? lines : []).slice(0, MAX_LINES).map((l, i) => {
    const description = text(l && l.description, 500);
    if (!description) return null;
    const quantity = num(l.quantity, { max: 1e7, fallback: 1 });
    const unit_cost = fromCents(cents(num(l.unit_cost, { max: 1e8 })));
    const markup_pct = l.markup_pct === '' || l.markup_pct == null ? dm : num(l.markup_pct, { max: 1000 });
    const unit = UNITS.includes(l.unit) ? l.unit : 'ea';
    return {
      position: i, section: text(l.section, 80), description, quantity, unit, unit_cost, markup_pct,
      price: linePrice({ quantity, unit_cost, markup_pct }),
      catalog_item_id: typeof l.catalog_item_id === 'string' && /^[0-9a-f-]{36}$/.test(l.catalog_item_id) ? l.catalog_item_id : null
    };
  }).filter(Boolean).map((l, i) => ({ ...l, position: i }));
  const costC = clean.reduce((n, l) => n + Math.round(l.quantity * cents(l.unit_cost)), 0);
  const subC = clean.reduce((n, l) => n + cents(l.price), 0);
  const taxP = num(tax_pct, { max: 30 });
  const taxC = Math.round(subC * taxP / 100);
  return {
    lines: clean, default_markup_pct: dm, tax_pct: taxP, deposit_pct: num(deposit_pct, { max: 100 }),
    cost_total: fromCents(costC), subtotal: fromCents(subC), tax: fromCents(taxC), total: fromCents(subC + taxC),
    deposit: fromCents(Math.round((subC + taxC) * num(deposit_pct, { max: 100 }) / 100))
  };
}

// What the homeowner may see: no costs, no markups.
function publicView(est, lines, company) {
  const sections = [];
  for (const l of lines) {
    const name = l.section || '';
    let s = sections.find(x => x.name === name);
    if (!s) { s = { name, lines: [], total: 0 }; sections.push(s); }
    s.lines.push({ description: l.description, quantity: Number(l.quantity), unit: l.unit, price: est.show_line_prices ? Number(l.price) : null });
    s.total = fromCents(cents(s.total) + cents(l.price));
  }
  const total = Number(est.total);
  return {
    number: est.number, kind: est.kind, kindLabel: KINDS[est.kind], title: est.title, intro: est.intro, terms: est.terms,
    status: est.status, validUntil: est.valid_until, expired: isExpired(est), showLinePrices: est.show_line_prices,
    sections, subtotal: Number(est.subtotal), taxPct: Number(est.tax_pct), tax: Number(est.tax), total,
    depositPct: Number(est.deposit_pct), deposit: fromCents(Math.round(cents(total) * Number(est.deposit_pct) / 100)),
    acceptedAt: est.accepted_at, acceptedName: est.accepted_name, declinedAt: est.declined_at,
    customer: { name: est.contact_name, address: est.property_address },
    company
  };
}

function isExpired(est, now = new Date()) {
  if (!est.valid_until || est.status !== 'sent') return false;
  const end = new Date(est.valid_until);
  end.setUTCHours(23, 59, 59, 999);
  return now > end;
}

// ---------- catalog ----------

async function listCatalog(tenantId) {
  return (await query('SELECT * FROM crm_catalog_items WHERE tenant_id = $1 AND archived = false ORDER BY category, name', [tenantId])).rows;
}

function cleanItem(b) {
  const name = text(b.name, 160);
  if (!name) throw err('Give the item a name.');
  return {
    name, description: text(b.description, 500), category: CATEGORIES.includes(b.category) ? b.category : 'materials',
    unit: UNITS.includes(b.unit) ? b.unit : 'ea', unit_cost: fromCents(cents(num(b.unit_cost, { max: 1e8 }))),
    markup_pct: b.markup_pct === '' || b.markup_pct == null ? null : num(b.markup_pct, { max: 1000 })
  };
}

async function saveCatalogItem({ tenantId, id = null, body }) {
  const it = cleanItem(body || {});
  if (id) {
    const r = await query(
      `UPDATE crm_catalog_items SET name = $3, description = $4, category = $5, unit = $6, unit_cost = $7, markup_pct = $8, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`, [id, tenantId, it.name, it.description, it.category, it.unit, it.unit_cost, it.markup_pct]);
    if (!r.rows.length) throw err('Item not found.', 404);
    return r.rows[0];
  }
  return (await query(
    `INSERT INTO crm_catalog_items (tenant_id, name, description, category, unit, unit_cost, markup_pct) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [tenantId, it.name, it.description, it.category, it.unit, it.unit_cost, it.markup_pct])).rows[0];
}

async function archiveCatalogItem({ tenantId, id }) {
  return (await query('UPDATE crm_catalog_items SET archived = true, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId])).rowCount > 0;
}

// ---------- estimates ----------

const DEFAULT_TERMS = {
  design_agreement: 'This agreement covers design and pre-construction: site measurements, drawings, selections and a detailed construction price. The fee is due at signing and is credited toward construction if you go ahead with us.',
  construction: 'Prices are based on the scope described above. Changes requested after signing are priced as change orders before the work is done. Payment schedule: deposit at signing, progress payments as work is completed, final payment at completion.'
};

async function nextNumber(client, tenantId) {
  const r = await client.query('SELECT COALESCE(MAX(number), 1000) + 1 AS n FROM crm_estimates WHERE tenant_id = $1', [tenantId]);
  return r.rows[0].n;
}

async function createEstimate({ tenantId, dealId, kind = 'construction', userId = null, copyFromId = null }) {
  const deal = await crm.getDeal(tenantId, dealId);
  if (!deal) throw err('Deal not found.', 404);
  const k = KINDS[kind] ? kind : 'construction';
  let source = null, sourceLines = [];
  if (copyFromId) {
    source = (await query('SELECT * FROM crm_estimates WHERE id = $1 AND tenant_id = $2', [copyFromId, tenantId])).rows[0];
    if (!source) throw err('Estimate to copy not found.', 404);
    sourceLines = (await query('SELECT * FROM crm_estimate_lines WHERE estimate_id = $1 ORDER BY position', [copyFromId])).rows;
  }
  const valid = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await client.query('BEGIN');
        const number = await nextNumber(client, tenantId);
        const est = (await client.query(
          `INSERT INTO crm_estimates (tenant_id, deal_id, number, kind, title, intro, terms, default_markup_pct, tax_pct, deposit_pct, show_line_prices,
                                      valid_until, cost_total, subtotal, tax, total, public_token, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
          [tenantId, dealId, number, source ? source.kind : k,
           source ? `${source.title} (revised)` : (k === 'design_agreement' ? `Design agreement — ${deal.title}` : deal.title),
           source ? source.intro : null, source ? source.terms : DEFAULT_TERMS[k],
           source ? source.default_markup_pct : 20, source ? source.tax_pct : 0, source ? source.deposit_pct : (k === 'design_agreement' ? 100 : 10),
           source ? source.show_line_prices : true, valid,
           source ? source.cost_total : 0, source ? source.subtotal : 0, source ? source.tax : 0, source ? source.total : 0,
           crypto.randomBytes(24).toString('hex'), userId])).rows[0];
        for (const l of sourceLines) {
          await client.query(
            `INSERT INTO crm_estimate_lines (estimate_id, position, section, description, quantity, unit, unit_cost, markup_pct, price, catalog_item_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [est.id, l.position, l.section, l.description, l.quantity, l.unit, l.unit_cost, l.markup_pct, l.price, l.catalog_item_id]);
        }
        await client.query('COMMIT');
        await crm.logActivity({ tenantId, dealId, kind: 'system', userId, body: `Started ${KINDS[est.kind].toLowerCase()} #${est.number}${source ? ` (copy of #${source.number})` : ''}.` });
        return est;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (e.code !== '23505' || attempt === 2) throw e; // two estimates took the same number at once: try the next one
      }
    }
  } finally {
    client.release();
  }
}

async function getEstimate(tenantId, id) {
  const est = (await query(
    `SELECT e.*, d.title AS deal_title, d.stage AS deal_stage, c.name AS contact_name, c.email AS contact_email, p.address AS property_address
     FROM crm_estimates e JOIN crm_deals d ON d.id = e.deal_id JOIN crm_contacts c ON c.id = d.contact_id
     LEFT JOIN crm_properties p ON p.id = d.property_id WHERE e.id = $1 AND e.tenant_id = $2`, [id, tenantId])).rows[0];
  if (!est) return null;
  est.lines = (await query('SELECT * FROM crm_estimate_lines WHERE estimate_id = $1 ORDER BY position', [id])).rows;
  return est;
}

async function listEstimates(tenantId, { dealId = null } = {}) {
  return (await query(
    `SELECT e.id, e.number, e.kind, e.title, e.status, e.total, e.sent_at, e.first_viewed_at, e.view_count, e.accepted_at, e.declined_at,
            e.valid_until, e.deal_id, d.title AS deal_title, c.name AS contact_name, e.updated_at
     FROM crm_estimates e JOIN crm_deals d ON d.id = e.deal_id JOIN crm_contacts c ON c.id = d.contact_id
     WHERE e.tenant_id = $1 AND ($2::uuid IS NULL OR e.deal_id = $2::uuid)
     ORDER BY e.updated_at DESC LIMIT 500`, [tenantId, dealId])).rows.map(e => ({ ...e, expired: isExpired(e) }));
}

// Saves the whole estimate. Changing one that was already sent puts it back
// to draft: the homeowner's link shows it is being updated until it's resent.
async function saveEstimate({ tenantId, id, body }) {
  const est = await getEstimate(tenantId, id);
  if (!est) throw err('Estimate not found.', 404);
  if (est.status === 'accepted') throw err('This estimate was accepted, so it can’t be changed. Make a copy to revise it.');
  const b = body || {};
  const title = text(b.title, 160);
  if (!title) throw err('Give the estimate a title.');
  const c = computeEstimate({ lines: b.lines, default_markup_pct: b.default_markup_pct, tax_pct: b.tax_pct, deposit_pct: b.deposit_pct });
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(String(b.valid_until || '')) ? b.valid_until : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE crm_estimates SET title = $3, kind = $4, intro = $5, terms = $6, default_markup_pct = $7, tax_pct = $8, deposit_pct = $9,
         show_line_prices = $10, valid_until = $11, cost_total = $12, subtotal = $13, tax = $14, total = $15,
         status = CASE WHEN status IN ('sent', 'declined') THEN 'draft' ELSE status END, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId, title, KINDS[b.kind] ? b.kind : est.kind, text(b.intro, 3000), text(b.terms, 6000), c.default_markup_pct, c.tax_pct, c.deposit_pct,
       b.show_line_prices !== false, valid, c.cost_total, c.subtotal, c.tax, c.total]);
    await client.query('DELETE FROM crm_estimate_lines WHERE estimate_id = $1', [id]);
    for (const l of c.lines) {
      await client.query(
        `INSERT INTO crm_estimate_lines (estimate_id, position, section, description, quantity, unit, unit_cost, markup_pct, price, catalog_item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (SELECT id FROM crm_catalog_items WHERE id = $10::uuid AND tenant_id = $11))`,
        [id, l.position, l.section, l.description, l.quantity, l.unit, l.unit_cost, l.markup_pct, l.price, l.catalog_item_id, tenantId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  // Back to draft: its "about to expire" reminder no longer applies.
  await require('./crmPlaybooks').cancelForEstimate(id, 'estimate_changed');
  return getEstimate(tenantId, id);
}

async function deleteEstimate({ tenantId, id }) {
  const r = await query(`DELETE FROM crm_estimates WHERE id = $1 AND tenant_id = $2 AND status = 'draft' RETURNING id`, [id, tenantId]);
  if (!r.rowCount) throw err('Only drafts can be deleted.', 400);
}

async function companyFor(tenantId) {
  const r = (await query(
    `SELECT t.company_name, bp.phone, bp.email, bp.address, bp.site, bp.founder_name FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [tenantId])).rows[0] || {};
  return { name: r.company_name, phone: r.phone, email: r.email, address: r.address, site: r.site, founder: r.founder_name };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Emails the homeowner a link to the estimate and moves the deal along.
async function sendEstimate({ tenantId, id, userId = null, message = null, baseUrl = '', send = sendEmail }) {
  const est = await getEstimate(tenantId, id);
  if (!est) throw err('Estimate not found.', 404);
  if (est.status === 'accepted') throw err('This estimate was already accepted.');
  if (!est.lines.length) throw err('Add at least one line before sending.');
  if (Number(est.total) <= 0) throw err('The total is $0. Check the prices before sending.');
  const to = String(est.contact_email || '').trim();
  if (!EMAIL_RE.test(to)) throw err('This contact has no email address. Add one on the deal first.');
  const blocked = (await query(`SELECT reason FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) AND reason IN ('bounced', 'complained')`, [tenantId, to])).rows[0];
  if (blocked) throw err(blocked.reason === 'bounced' ? 'Email to this address bounced before, so it can’t be sent. Check the address.' : 'This person reported your email as spam, so it can’t be sent by email.');
  const company = await companyFor(tenantId);
  if ((company.address || '').trim().length < 8) throw err('Add your business address under Company details first; it goes on every estimate.');
  const link = `${baseUrl}/e/${est.public_token}`;
  const first = String(est.contact_name || '').trim().split(/\s+/)[0] || 'there';
  const note = text(message, 1500);
  const label = KINDS[est.kind].toLowerCase();
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#14202b;max-width:560px;line-height:1.5">
<p>Hi ${esc(first)},</p>
${note ? note.split(/\n\n+/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') : `<p>Here is your ${esc(label)} from ${esc(company.name)}: <b>${esc(est.title)}</b>.</p>`}
<p style="margin:22px 0"><a href="${link}" style="background:#1f4e79;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">View your ${esc(label)}</a></p>
<p>Total: <b>${money(est.total)}</b>${est.valid_until ? ` · valid until ${new Date(est.valid_until).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}` : ''}</p>
<p>You can review it, download a PDF, and accept it online. Questions? Just reply to this email${company.phone ? ` or call ${esc(company.phone)}` : ''}.</p>
<p>${esc(company.founder || company.name)}<br>${esc(company.name)}</p>
<p style="color:#55636f;font-size:12px;margin-top:24px">${esc(company.name)} · ${esc(company.address)}</p></div>`;
  const textBody = `Hi ${first},\n\n${note || `Here is your ${label} from ${company.name}: ${est.title}.`}\n\nView it here: ${link}\n\nTotal: ${money(est.total)}\n\nYou can review it, download a PDF, and accept it online. Questions? Just reply${company.phone ? ` or call ${company.phone}` : ''}.\n\n${company.founder || company.name}\n${company.name} · ${company.address}`;
  const fromAddress = await require('./sendingDomain').getVerifiedFromAddress(tenantId);
  await send({
    to, subject: `Your ${label} from ${company.name}: ${est.title}`.slice(0, 150), html, text: textBody,
    replyTo: EMAIL_RE.test(String(company.email || '')) ? company.email : undefined, fromName: company.name, fromAddress: fromAddress || undefined
  });
  const sentRow = (await query(`UPDATE crm_estimates SET status = 'sent', sent_at = now(), sent_to = $3, declined_at = NULL, decline_reason = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`, [id, tenantId, to])).rows[0];
  await require('./crmPlaybooks').scheduleEstimateExpiry(sentRow, baseUrl).catch(e => console.error('[crmEstimates] expiry reminder failed:', e.message));
  await crm.logActivity({ tenantId, dealId: est.deal_id, kind: 'email', userId, body: `Sent ${label} #${est.number} (${money(est.total)}) to ${to}.`, meta: { estimate: est.id } });
  // Move the deal forward (never backward) so the right follow-ups start.
  const target = SEND_STAGE[est.kind];
  const deal = await crm.getDeal(tenantId, est.deal_id);
  if (deal && deal.stage !== 'lost' && STAGE_ORDER.indexOf(deal.stage) < STAGE_ORDER.indexOf(target)) {
    await crm.changeStage({ tenantId, dealId: est.deal_id, stage: target, userId, baseUrl });
  }
  return { to, link };
}

// ---------- the homeowner's side (no login; the link is the key) ----------

// `viewerTenantId`: the company's own team may preview a draft that was never sent.
async function getByToken(token, { viewerTenantId = null } = {}) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  const est = (await query(
    `SELECT e.*, c.name AS contact_name, p.address AS property_address FROM crm_estimates e
     JOIN crm_deals d ON d.id = e.deal_id JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id
     WHERE e.public_token = $1`, [token])).rows[0];
  if (!est) return null;
  if (est.status === 'draft' && !est.sent_at && est.tenant_id !== viewerTenantId) return null; // never sent: nothing to show
  const lines = (await query('SELECT * FROM crm_estimate_lines WHERE estimate_id = $1 ORDER BY position', [est.id])).rows;
  const view = publicView(est, lines, await companyFor(est.tenant_id));
  // The deposit invoice for an accepted estimate, so the homeowner can pay it right here.
  const dep = est.status === 'accepted' && (await query(`SELECT public_token, status, amount FROM crm_invoices WHERE estimate_id = $1 AND kind = 'deposit'`, [est.id])).rows[0];
  if (dep) view.depositInvoice = { link: `/i/${dep.public_token}`, paid: dep.status === 'paid', amount: Number(dep.amount) };
  return { est, view };
}

async function recordView(est) {
  await query('UPDATE crm_estimates SET view_count = view_count + 1, first_viewed_at = COALESCE(first_viewed_at, now()) WHERE id = $1', [est.id]);
  if (!est.first_viewed_at) {
    await crm.logActivity({ tenantId: est.tenant_id, dealId: est.deal_id, kind: 'system', actor: 'contact', body: `Opened ${KINDS[est.kind].toLowerCase()} #${est.number}.` });
  }
}

async function notifyTeam({ est, subject, body }) {
  const r = (await query(
    `SELECT COALESCE(u.email, bp.email) AS to_email FROM crm_deals d LEFT JOIN users u ON u.id = d.owner_user_id
     LEFT JOIN business_profile bp ON bp.tenant_id = d.tenant_id WHERE d.id = $1`, [est.deal_id])).rows[0];
  const to = r && r.to_email;
  if (!EMAIL_RE.test(String(to || ''))) return;
  await sendEmail({ to, subject, html: `<p>${esc(body)}</p><p>Open Eagle I CRM to see the deal.</p>`, text: `${body}\n\nOpen Eagle I CRM to see the deal.` }).catch(() => {});
}

async function acceptByToken({ token, name, ip, baseUrl = '' }) {
  const found = await getByToken(token);
  if (!found) throw err('This estimate link is not valid.', 404);
  const { est } = found;
  if (est.status === 'accepted') return found.view;
  if (est.status !== 'sent') throw err('This estimate is being updated. Please wait for the new version.');
  if (isExpired(est)) throw err('This estimate has expired. Please contact us for an updated one.');
  const nm = text(name, 120);
  if (!nm || nm.length < 3) throw err('Type your full name to accept.');
  const upd = await query(
    `UPDATE crm_estimates SET status = 'accepted', accepted_at = now(), accepted_name = $2, accepted_ip = $3, updated_at = now()
     WHERE id = $1 AND status = 'sent' RETURNING id`, [est.id, nm, String(ip || '').slice(0, 64)]);
  if (!upd.rowCount) throw err('This estimate changed while you were viewing it. Please reload.', 409);
  await require('./crmPlaybooks').cancelForEstimate(est.id, 'accepted');
  const label = KINDS[est.kind].toLowerCase();
  await crm.logActivity({ tenantId: est.tenant_id, dealId: est.deal_id, kind: 'system', actor: 'contact', body: `Accepted ${label} #${est.number} (${money(est.total)}), signed as “${nm}”.`, meta: { estimate: est.id } });
  const deal = await crm.getDeal(est.tenant_id, est.deal_id);
  const target = ACCEPT_STAGE[est.kind];
  if (deal && STAGE_ORDER.indexOf(deal.stage) < STAGE_ORDER.indexOf(target)) {
    await crm.changeStage({ tenantId: est.tenant_id, dealId: est.deal_id, stage: target, actor: 'contact', baseUrl });
    require('./crmPlaybooks').processDueSends({ onlyDealId: est.deal_id }).catch(() => {});
  }
  if (est.kind === 'construction' || est.kind === 'design_agreement') {
    await query('UPDATE crm_deals SET value = COALESCE(value, $2) WHERE id = $1', [est.deal_id, est.total]);
  }
  await crm.addInboxItem({
    tenantId: est.tenant_id, dealId: est.deal_id, kind: 'estimate_accepted', dedupeKey: `accepted:${est.id}`,
    title: `${est.contact_name} accepted ${label} #${est.number}`, detail: `${money(est.total)}. Next: set up the kickoff and collect the deposit.`
  });
  await notifyTeam({ est, subject: `Accepted: ${est.title} (${money(est.total)})`, body: `${est.contact_name} accepted ${label} #${est.number} for ${money(est.total)}, signed as "${nm}".` });
  // Money due at signing: its invoice is made now, ready to pay from this page.
  await require('./crmPayments').depositForEstimate(est.id).catch(e => console.error('[crmEstimates] deposit invoice failed:', e.message));
  return (await getByToken(token)).view;
}

async function declineByToken({ token, reason }) {
  const found = await getByToken(token);
  if (!found) throw err('This estimate link is not valid.', 404);
  const { est } = found;
  if (est.status !== 'sent') throw err('This estimate can’t be declined right now.');
  const why = text(reason, 1000);
  await query(`UPDATE crm_estimates SET status = 'declined', declined_at = now(), decline_reason = $2, updated_at = now() WHERE id = $1`, [est.id, why]);
  await require('./crmPlaybooks').cancelForEstimate(est.id, 'declined');
  const label = KINDS[est.kind].toLowerCase();
  await crm.logActivity({ tenantId: est.tenant_id, dealId: est.deal_id, kind: 'reply', actor: 'contact', body: `Declined ${label} #${est.number}${why ? `: ${why}` : '.'}`, meta: { estimate: est.id, category: 'not_now' } });
  await crm.addInboxItem({
    tenantId: est.tenant_id, dealId: est.deal_id, kind: 'negative_reply', dedupeKey: `declined:${est.id}:${Date.now()}`,
    title: `${est.contact_name} declined ${label} #${est.number}`, detail: why || 'No reason given.'
  });
  await notifyTeam({ est, subject: `Declined: ${est.title}`, body: `${est.contact_name} declined ${label} #${est.number}.${why ? ` Reason: ${why}` : ''}` });
  return (await getByToken(token)).view;
}

module.exports = {
  KINDS, CATEGORIES, UNITS, DEFAULT_TERMS, linePrice, computeEstimate, publicView, isExpired,
  listCatalog, saveCatalogItem, archiveCatalogItem,
  createEstimate, getEstimate, listEstimates, saveEstimate, deleteEstimate, sendEstimate,
  getByToken, recordView, acceptByToken, declineByToken
};
