// The customer for life in Eagle I CRM: referrals, trade partners, reviews and
// the home file.
//
//  - Referral links (/r/<code>): every client and every trade partner has one.
//    It opens the company's inquiry form; a lead that comes in through it is
//    credited to them. When that job signs, the referrer is owed the
//    company's reward and the team gets a "thank them" item in Needs you.
//  - Partner scoreboard: leads, signed jobs and revenue for each partner and
//    each referring client.
//  - Review requests: the "Ask for a review" playbook sends the company's
//    review link a week after a job is complete (never without a link).
//  - The home file: what went into the house. Finishing a job fills it on
//    its own (the workmanship warranty and every selection the homeowner
//    made); the team adds appliances and systems. The homeowner sees it in
//    their portal. Items with a care interval get care reminders; warranties
//    get a check-in before they end (both approve-once playbooks).
const crypto = require('crypto');
const { query } = require('../db');
const crm = require('./crm');

const PARTNER_KINDS = { realtor: 'Realtor', designer: 'Interior designer', architect: 'Architect', builder: 'Builder or trade', other: 'Other' };
const HOME_CATEGORIES = { finish: 'Finish', appliance: 'Appliance', system: 'System', warranty: 'Warranty', other: 'Other' };
const TZ = 'America/Chicago';
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const clean = (v, n) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : null; };
const newCode = () => crypto.randomBytes(5).toString('hex');
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const todayCentral = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: TZ });
function addMonths(dateYmd, months) {
  const [y, m, d] = dateYmd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
function dateOrNull(v, label) {
  if (v == null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || isNaN(new Date(v))) throw err(`${label} should be a date.`);
  return String(v);
}

// ---------- settings ----------

async function rawSettings(tenantId) {
  const r = (await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [tenantId])).rows[0];
  return (r && r.crm_settings) || {};
}
async function lifetimeSettings(tenantId) {
  const s = await rawSettings(tenantId);
  const reward = Number(s.referralReward);
  const months = parseInt(s.warrantyMonths, 10);
  return {
    referralReward: Number.isFinite(reward) && reward > 0 ? reward : null,
    reviewUrl: typeof s.reviewUrl === 'string' && /^https:\/\/\S+$/.test(s.reviewUrl) ? s.reviewUrl : null,
    warrantyMonths: Number.isFinite(months) && months >= 0 ? months : 12
  };
}
async function saveLifetimeSettings(tenantId, { referralReward, reviewUrl, warrantyMonths }) {
  const patch = {};
  if (referralReward !== undefined) {
    const raw = String(referralReward == null ? '' : referralReward).replace(/[$,\s]/g, '');
    const n = raw === '' ? null : Number(raw);
    if (n != null && (!Number.isFinite(n) || n < 0 || n > 100000)) throw err('Enter the reward as a dollar amount.');
    patch.referralReward = n;
  }
  if (reviewUrl !== undefined) {
    const u = String(reviewUrl || '').trim();
    if (u && !/^https:\/\/\S+$/.test(u)) throw err('Paste your review page link (it starts with https://).');
    patch.reviewUrl = u.slice(0, 500) || null;
  }
  if (warrantyMonths !== undefined) {
    const n = parseInt(warrantyMonths, 10);
    if (!Number.isFinite(n) || n < 0 || n > 240) throw err('Enter your warranty in months (0 to 240).');
    patch.warrantyMonths = n;
  }
  const cur = await rawSettings(tenantId);
  await query('UPDATE business_profile SET crm_settings = $1 WHERE tenant_id = $2', [JSON.stringify({ ...cur, ...patch }), tenantId]);
  return lifetimeSettings(tenantId);
}

// ---------- referral codes ----------

async function contactCode(tenantId, contactId) {
  const r = (await query('SELECT referral_code FROM crm_contacts WHERE id = $1 AND tenant_id = $2', [contactId, tenantId])).rows[0];
  if (!r) throw err('Contact not found.', 404);
  if (r.referral_code) return r.referral_code;
  for (let i = 0; i < 5; i++) {
    try {
      await query('UPDATE crm_contacts SET referral_code = COALESCE(referral_code, $2) WHERE id = $1', [contactId, newCode()]);
      return (await query('SELECT referral_code FROM crm_contacts WHERE id = $1', [contactId])).rows[0].referral_code;
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  throw err('Could not make a referral link. Please try again.', 500);
}

// Who a code belongs to.
async function resolveCode(code) {
  if (!/^[0-9a-f]{10}$/.test(String(code || ''))) return null;
  const c = (await query('SELECT id, tenant_id, name FROM crm_contacts WHERE referral_code = $1', [code])).rows[0];
  if (c) return { tenantId: c.tenant_id, contactId: c.id, name: c.name, kind: 'client' };
  const p = (await query('SELECT id, tenant_id, name FROM crm_partners WHERE code = $1 AND archived = false', [code])).rows[0];
  if (p) return { tenantId: p.tenant_id, partnerId: p.id, name: p.name, kind: 'partner' };
  return null;
}

// /r/<code>: on to the company's inquiry form, carrying the code.
async function referralTarget(code) {
  const who = await resolveCode(code);
  if (!who) return null;
  const tenant = (await query(`SELECT 1 FROM tenants WHERE id = $1 AND 'crm' = ANY(products)`, [who.tenantId])).rows[0];
  if (!tenant) return null;
  const key = await require('./crmIntake').getIntakeKey(who.tenantId);
  return `/crm/f/${key}?ref=${code}`;
}

// A lead from someone's link: credit them (never someone referring themselves).
async function attribute({ tenantId, dealId, code }) {
  const who = await resolveCode(code);
  if (!who || who.tenantId !== tenantId) return null;
  const deal = (await query('SELECT contact_id FROM crm_deals WHERE id = $1 AND tenant_id = $2', [dealId, tenantId])).rows[0];
  if (!deal || deal.contact_id === who.contactId) return null;
  await query('UPDATE crm_deals SET referred_by_contact_id = $3, partner_id = $4 WHERE id = $1 AND tenant_id = $2', [dealId, tenantId, who.contactId || null, who.partnerId || null]);
  await crm.logActivity({ tenantId, dealId, kind: 'system', actor: 'eagle_i', body: `Referred by ${who.name}${who.kind === 'partner' ? ' (trade partner)' : ''}.` });
  return who;
}

// Set or clear the referrer by hand from the deal sheet.
async function setReferrer({ tenantId, dealId, partnerId = null, contactId = null }) {
  if (partnerId && !(await query('SELECT 1 FROM crm_partners WHERE id = $1 AND tenant_id = $2', [partnerId, tenantId])).rows.length) throw err('Partner not found.', 404);
  if (contactId && !(await query('SELECT 1 FROM crm_contacts WHERE id = $1 AND tenant_id = $2', [contactId, tenantId])).rows.length) throw err('Contact not found.', 404);
  const r = await query('UPDATE crm_deals SET partner_id = $3, referred_by_contact_id = $4 WHERE id = $1 AND tenant_id = $2 RETURNING id', [dealId, tenantId, partnerId, contactId]);
  if (!r.rows.length) throw err('Deal not found.', 404);
  return true;
}

// A deal reached "Contract signed": if someone sent it, they're owed a thank-you.
async function onSigned(deal) {
  if (!deal.referred_by_contact_id && !deal.partner_id) return null;
  const { referralReward } = await lifetimeSettings(deal.tenant_id);
  const ins = (await query(
    `INSERT INTO crm_referral_rewards (tenant_id, deal_id, contact_id, partner_id, amount) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (deal_id) DO NOTHING RETURNING *`, [deal.tenant_id, deal.id, deal.referred_by_contact_id, deal.partner_id, referralReward])).rows[0];
  if (!ins) return null;
  const who = (await query(
    `SELECT COALESCE(p.name, c.name) AS name FROM crm_deals d LEFT JOIN crm_partners p ON p.id = d.partner_id LEFT JOIN crm_contacts c ON c.id = d.referred_by_contact_id WHERE d.id = $1`, [deal.id])).rows[0];
  await crm.addInboxItem({
    tenantId: deal.tenant_id, dealId: deal.id, kind: 'referral', dedupeKey: `referral:${deal.id}`,
    title: `Thank ${who.name}: their referral signed`,
    detail: referralReward ? `They're owed your $${referralReward.toLocaleString('en-US')} referral reward. Mark it paid under Referrals & partners.` : 'A call or a handwritten note goes a long way.'
  });
  return ins;
}

// ---------- partners and the scoreboard ----------

async function savePartner({ tenantId, id = null, body }) {
  const b = body || {};
  const name = clean(b.name, 120);
  if (!name) throw err('Add the partner’s name.');
  const kind = PARTNER_KINDS[b.kind] ? b.kind : 'other';
  const email = clean(b.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err('That email address does not look right.');
  const vals = [name, clean(b.company, 120), kind, email, clean(b.phone, 40), clean(b.notes, 1000)];
  if (id) {
    const r = await query('UPDATE crm_partners SET name = $3, company = $4, kind = $5, email = $6, phone = $7, notes = $8 WHERE id = $1 AND tenant_id = $2 RETURNING *', [id, tenantId, ...vals]);
    if (!r.rows.length) throw err('Partner not found.', 404);
    return r.rows[0];
  }
  for (let i = 0; i < 5; i++) {
    try {
      return (await query('INSERT INTO crm_partners (tenant_id, name, company, kind, email, phone, notes, code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *', [tenantId, ...vals, newCode()])).rows[0];
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  throw err('Could not save. Please try again.', 500);
}
async function archivePartner({ tenantId, id }) {
  return (await query('UPDATE crm_partners SET archived = true WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rowCount > 0;
}

const WON = `('signed', 'production', 'complete')`;
// Everyone who has sent work: partners first (all of them, even with nothing
// yet), then clients who have referred someone.
async function scoreboard(tenantId) {
  const partners = (await query(
    `SELECT p.id, p.name, p.company, p.kind, p.email, p.phone, p.code, p.notes,
            COUNT(d.id)::int AS leads, COUNT(d.id) FILTER (WHERE d.stage IN ${WON})::int AS signed,
            COALESCE(SUM(d.value) FILTER (WHERE d.stage IN ${WON}), 0)::float AS revenue, MAX(d.created_at) AS last_lead_at
     FROM crm_partners p LEFT JOIN crm_deals d ON d.partner_id = p.id
     WHERE p.tenant_id = $1 AND p.archived = false GROUP BY p.id ORDER BY revenue DESC, leads DESC, p.name`, [tenantId])).rows;
  const clients = (await query(
    `SELECT c.id, c.name, c.email, COUNT(d.id)::int AS leads, COUNT(d.id) FILTER (WHERE d.stage IN ${WON})::int AS signed,
            COALESCE(SUM(d.value) FILTER (WHERE d.stage IN ${WON}), 0)::float AS revenue, MAX(d.created_at) AS last_lead_at
     FROM crm_deals d JOIN crm_contacts c ON c.id = d.referred_by_contact_id
     WHERE d.tenant_id = $1 GROUP BY c.id ORDER BY revenue DESC, leads DESC LIMIT 50`, [tenantId])).rows;
  const rewards = (await query(
    `SELECT r.*, d.title AS deal_title, COALESCE(p.name, c.name) AS who FROM crm_referral_rewards r JOIN crm_deals d ON d.id = r.deal_id
     LEFT JOIN crm_partners p ON p.id = r.partner_id LEFT JOIN crm_contacts c ON c.id = r.contact_id
     WHERE r.tenant_id = $1 ORDER BY (r.status = 'owed') DESC, r.created_at DESC LIMIT 100`, [tenantId])).rows;
  const totals = (await query(
    `SELECT COUNT(*) FILTER (WHERE referred_by_contact_id IS NOT NULL OR partner_id IS NOT NULL OR source IN ('referral', 'partner', 'repeat'))::int AS leads,
            COUNT(*) FILTER (WHERE (referred_by_contact_id IS NOT NULL OR partner_id IS NOT NULL OR source IN ('referral', 'partner', 'repeat')) AND stage IN ${WON})::int AS signed,
            COALESCE(SUM(value) FILTER (WHERE (referred_by_contact_id IS NOT NULL OR partner_id IS NOT NULL OR source IN ('referral', 'partner', 'repeat')) AND stage IN ${WON}), 0)::float AS revenue
     FROM crm_deals WHERE tenant_id = $1 AND created_at > now() - interval '12 months'`, [tenantId])).rows[0];
  return { partners, clients, rewards, totals };
}

async function setRewardPaid({ tenantId, id, paid }) {
  const r = await query(
    `UPDATE crm_referral_rewards SET status = $3::varchar, paid_at = CASE WHEN $3::text = 'paid' THEN now() ELSE NULL END WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId, paid ? 'paid' : 'owed']);
  if (r.rows[0] && paid) await crm.resolveInbox(tenantId, `referral:${r.rows[0].deal_id}`).catch(() => {});
  return r.rows[0] || null;
}

// ---------- the home file ----------

function nextCare(installedOn, months, now = new Date()) {
  if (!months) return null;
  const today = todayCentral(now);
  let d = addMonths(installedOn || today, months);
  for (let i = 0; d <= today && i < 600; i++) d = addMonths(d, months);
  return d;
}

async function saveHomeItem({ tenantId, dealId = null, id = null, body, now = new Date() }) {
  const b = body || {};
  const name = clean(b.name, 160);
  if (!name) throw err('Give the item a name, like “Kitchen countertops”.');
  const category = HOME_CATEGORIES[b.category] ? b.category : 'other';
  const installedOn = dateOrNull(b.installedOn, 'Installed');
  const warrantyUntil = dateOrNull(b.warrantyUntil, 'Warranty until');
  const every = b.careEveryMonths === '' || b.careEveryMonths == null ? null : parseInt(b.careEveryMonths, 10);
  if (every != null && !(every >= 1 && every <= 120)) throw err('Care every… should be 1 to 120 months.');
  const vals = [category, name, clean(b.details, 500), installedOn, warrantyUntil, every, clean(b.careNote, 1000), nextCare(installedOn, every, now)];
  if (id) {
    const before = (await query('SELECT * FROM crm_home_items WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0];
    if (!before) throw err('Item not found.', 404);
    const sameWarranty = (before.warranty_until ? ymd(before.warranty_until) : null) === warrantyUntil;
    return (await query(
      `UPDATE crm_home_items SET category = $3, name = $4, details = $5, installed_on = $6, warranty_until = $7, care_every_months = $8, care_note = $9,
              next_care_at = $10, warranty_noticed = CASE WHEN $11 THEN warranty_noticed ELSE false END WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, ...vals, sameWarranty])).rows[0];
  }
  if (!(await query('SELECT 1 FROM crm_deals WHERE id = $1 AND tenant_id = $2', [dealId, tenantId])).rows.length) throw err('Deal not found.', 404);
  return (await query(
    `INSERT INTO crm_home_items (tenant_id, deal_id, category, name, details, installed_on, warranty_until, care_every_months, care_note, next_care_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`, [tenantId, dealId, ...vals])).rows[0];
}
async function deleteHomeItem({ tenantId, id }) {
  return (await query('DELETE FROM crm_home_items WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rowCount > 0;
}
async function listHomeItems(tenantId, dealId) {
  return (await query(
    `SELECT * FROM crm_home_items WHERE tenant_id = $1 AND deal_id = $2 ORDER BY CASE category WHEN 'warranty' THEN 0 WHEN 'system' THEN 1 WHEN 'appliance' THEN 2 ELSE 3 END, created_at`,
    [tenantId, dealId])).rows;
}

// A job was marked complete: start its home file from what's already known.
async function onComplete(deal, now = new Date()) {
  const { warrantyMonths } = await lifetimeSettings(deal.tenant_id);
  const today = todayCentral(now);
  let added = 0;
  if (warrantyMonths > 0) {
    const r = await query(
      `INSERT INTO crm_home_items (tenant_id, deal_id, category, name, details, installed_on, warranty_until, source, source_id)
       VALUES ($1, $2, 'warranty', 'Workmanship warranty', $3, $4, $5, 'warranty', $2)
       ON CONFLICT (deal_id, source, source_id) WHERE source_id IS NOT NULL DO NOTHING RETURNING id`,
      [deal.tenant_id, deal.id, `${warrantyMonths} months on our work, from the day the job was finished.`, today, addMonths(today, warrantyMonths)]);
    added += r.rowCount;
  }
  const sels = (await query('SELECT * FROM crm_selections WHERE deal_id = $1 AND chosen_index IS NOT NULL', [deal.id])).rows;
  for (const s of sels) {
    const opt = (s.options || [])[s.chosen_index] || {};
    if (!opt.name) continue;
    const r = await query(
      `INSERT INTO crm_home_items (tenant_id, deal_id, category, name, details, installed_on, source, source_id)
       VALUES ($1, $2, 'finish', $3, $4, $5, 'selection', $6)
       ON CONFLICT (deal_id, source, source_id) WHERE source_id IS NOT NULL DO NOTHING RETURNING id`,
      [deal.tenant_id, deal.id, `${s.category}: ${opt.name}`.slice(0, 160), clean(opt.note, 500), today, s.id]);
    added += r.rowCount;
  }
  return { added };
}

// What the homeowner sees in their portal.
async function portalHome(deal) {
  const items = (await listHomeItems(deal.tenant_id, deal.id)).map(i => ({
    category: HOME_CATEGORIES[i.category] || 'Other', name: i.name, details: i.details,
    installedOn: i.installed_on ? ymd(i.installed_on) : null, warrantyUntil: i.warranty_until ? ymd(i.warranty_until) : null,
    careEveryMonths: i.care_every_months, careNote: i.care_note
  }));
  const done = ['complete', 'production'].includes(deal.stage);
  return { items, referralCode: done ? await contactCode(deal.tenant_id, deal.contact_id) : null };
}

// Every tick: queue care reminders that have come due, and warranty
// check-ins 60 days out, then move each item's next care date on.
async function scanHomeCare({ now = new Date() } = {}) {
  const today = todayCentral(now);
  const horizon = addMonths(today, 2);
  const pb = require('./crmPlaybooks');
  const out = { care: 0, warranty: 0 };
  const baseUrl = async (tenantId) => ((await query(`SELECT base_url FROM crm_playbook_sends WHERE tenant_id = $1 AND base_url <> '' ORDER BY due_at DESC LIMIT 1`, [tenantId])).rows[0] || {}).base_url || process.env.RENDER_EXTERNAL_URL || '';
  const care = (await query(
    `SELECT i.* FROM crm_home_items i JOIN tenants t ON t.id = i.tenant_id WHERE i.next_care_at <= $1::date AND i.care_every_months IS NOT NULL AND 'crm' = ANY(t.products) LIMIT 200`, [today])).rows;
  for (const item of care) {
    const due = ymd(item.next_care_at);
    out.care += (await pb.scheduleHomeItem({ item, kind: 'home_care', date: due, baseUrl: await baseUrl(item.tenant_id), now })).scheduled;
    let next = addMonths(due, item.care_every_months);
    while (next <= today) next = addMonths(next, item.care_every_months);
    await query('UPDATE crm_home_items SET next_care_at = $2 WHERE id = $1', [item.id, next]);
  }
  const ending = (await query(
    `SELECT i.* FROM crm_home_items i JOIN tenants t ON t.id = i.tenant_id
     WHERE i.warranty_until IS NOT NULL AND i.warranty_noticed = false AND i.warranty_until <= $1::date AND i.warranty_until > $2::date AND 'crm' = ANY(t.products) LIMIT 200`, [horizon, today])).rows;
  for (const item of ending) {
    out.warranty += (await pb.scheduleHomeItem({ item, kind: 'warranty_end', date: ymd(item.warranty_until), baseUrl: await baseUrl(item.tenant_id), now })).scheduled;
    await query('UPDATE crm_home_items SET warranty_noticed = true WHERE id = $1', [item.id]);
    if (item.category === 'warranty') {
      await require('./crmTasks').createTask({
        tenantId: item.tenant_id, dealId: item.deal_id, title: `Warranty walkthrough before ${ymd(item.warranty_until)}`,
        dueAt: new Date(new Date(ymd(item.warranty_until) + 'T17:00:00Z').getTime() - 14 * 86400000), source: 'auto', autoKey: `warranty:${item.id}`
      }).catch(() => {});
    }
  }
  return out;
}

module.exports = {
  PARTNER_KINDS, HOME_CATEGORIES, addMonths, nextCare, lifetimeSettings, saveLifetimeSettings,
  contactCode, resolveCode, referralTarget, attribute, setReferrer, onSigned,
  savePartner, archivePartner, scoreboard, setRewardPaid,
  saveHomeItem, deleteHomeItem, listHomeItems, onComplete, portalHome, scanHomeCare
};
