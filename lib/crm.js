// The CRM core: one record per person (contact), per house (property) and per
// job being sold (deal), a design-build pipeline, and a timeline of what
// happened on each deal.
//
// The rule this is built around: the pipeline moves because something
// happened, and the owner only sees what needs a person.
//  - Every landing-page lead becomes a contact + deal on its own (and existing
//    leads are brought in the first time the pipeline is opened).
//  - Moving a deal keeps the older Leads inbox in step (and stops the new-lead
//    emails), and the other way round.
//  - "Needs you" only lists exceptions: a new lead nobody has touched, a deal
//    that has sat in a stage too long, a reply to an automatic email.
//  - The weekly summary counts real records only; nothing is estimated.
const { query } = require('../db');
const { sendEmail } = require('./email');
const { zonedToUtc } = require('./outreachQueue');

// Design-build stages, in order. `stallDays` is how long a deal can sit
// without any activity before it shows up in "Needs you" (null = never).
const STAGES = [
  { key: 'new', label: 'New lead', open: true, stallDays: null },
  { key: 'qualified', label: 'Qualified', open: true, stallDays: 7 },
  { key: 'site_visit', label: 'Site visit set', open: true, stallDays: 7 },
  { key: 'design_agreement', label: 'Design agreement sent', open: true, stallDays: 10 },
  { key: 'in_design', label: 'In design', open: true, stallDays: 21 },
  { key: 'proposal', label: 'Proposal sent', open: true, stallDays: 10 },
  { key: 'signed', label: 'Contract signed', open: true, stallDays: 21 },
  { key: 'production', label: 'In production', open: true, stallDays: 30 },
  { key: 'complete', label: 'Complete', open: false, stallDays: null },
  { key: 'lost', label: 'Lost', open: false, stallDays: null }
];
const STAGE_BY_KEY = Object.fromEntries(STAGES.map(s => [s.key, s]));
const isStage = (k) => Object.prototype.hasOwnProperty.call(STAGE_BY_KEY, k);
const stageLabel = (k) => (STAGE_BY_KEY[k] ? STAGE_BY_KEY[k].label : k);
// Stages that count as a won job (for the summary and the Leads inbox).
const WON_STAGES = new Set(['signed', 'production', 'complete']);

// A deal the customer started (landing page, website form, forwarded lead email),
// as opposed to one the team typed in: its first timeline entry is by the contact.
const INBOUND_SQL = `EXISTS (SELECT 1 FROM crm_activities ia WHERE ia.deal_id = d.id AND ia.actor = 'contact' AND ia.kind IN ('lead_in', 'note'))`;
const SOURCE_LABELS = {
  manual: 'Added by hand', landing_page: 'Landing page', website: 'Website', phone: 'Phone call', referral: 'Referral', repeat: 'Past client',
  partner: 'Trade partner', google_ads: 'Google Ads', google_lsa: 'Google Local Services', facebook: 'Facebook & Instagram', nextdoor: 'Nextdoor',
  houzz: 'Houzz', angi: 'Angi', thumbtack: 'Thumbtack', home_show: 'Home show', signs: 'Yard signs', other: 'Other'
};
const SOURCES = new Set(Object.keys(SOURCE_LABELS));
const sourceLabel = (k) => SOURCE_LABELS[k] || k;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_SETTINGS = { paused: false, weeklySummary: true, waitingMinutes: 30 };

// ---------- small pure helpers ----------

// Last 10 digits of a phone number, or null — enough to recognise the same
// person typing "(713) 555-0100" one time and "713.555.0100" the next.
function phoneDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : null;
}

// A 5-digit ZIP from a ZIP field or the end of an address.
function extractZip(zip, address) {
  const direct = /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(String(zip || ''));
  if (direct) return direct[1];
  const m = /\b(\d{5})(?:-\d{4})?\s*$/.exec(String(address || '').trim());
  return m ? m[1] : null;
}

function cleanText(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : null;
}

// A dollar amount from "85,000", "$85k" or 85000; null when blank or nonsense.
function parseValue(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v) : null;
  const m = /^\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m)?\s*$/i.exec(String(v));
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (m[2]) n *= m[2].toLowerCase() === 'k' ? 1e3 : 1e6;
  return Number.isFinite(n) && n < 1e9 ? Math.round(n) : null;
}

// How the older Leads inbox's status maps onto a stage, and back.
function stageForLeadStatus(status) {
  return { new: 'new', contacted: 'qualified', won: 'signed', lost: 'lost' }[status] || 'new';
}
function leadStatusForStage(stage) {
  if (stage === 'new') return 'new';
  if (stage === 'lost') return 'lost';
  if (WON_STAGES.has(stage)) return 'won';
  return 'contacted';
}

function median(nums) {
  const a = nums.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// ---------- settings ----------

function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const mins = parseInt(s.waitingMinutes, 10);
  return {
    paused: !!s.paused,
    weeklySummary: s.weeklySummary !== false,
    waitingMinutes: [15, 30, 60, 120, 240].includes(mins) ? mins : DEFAULT_SETTINGS.waitingMinutes,
    // Who new leads are given to automatically (a team member's id), or null to leave them unassigned.
    leadOwnerUserId: typeof s.leadOwnerUserId === 'string' && /^[0-9a-f-]{36}$/.test(s.leadOwnerUserId) ? s.leadOwnerUserId : null,
    // The company's own names for stages ({ key: label }), and stages it doesn't use.
    stageLabels: cleanStageLabels(s.stageLabels),
    hiddenStages: Array.isArray(s.hiddenStages) ? s.hiddenStages.filter(k => HIDEABLE_STAGES.has(k)) : [],
    // Texting (lib/crmSms.js): where calls ring, and the missed-call text with the hash of the approved words.
    smsForwardTo: typeof s.smsForwardTo === 'string' && /^\+1\d{10}$/.test(s.smsForwardTo) ? s.smsForwardTo : null,
    missedCallText: typeof s.missedCallText === 'string' && s.missedCallText.trim() ? s.missedCallText.slice(0, 300) : null,
    missedCallApproved: typeof s.missedCallApproved === 'string' ? s.missedCallApproved : null,
    // The company's own job schedule template: [[phase, working days], ...] (lib/crmJobs.js).
    scheduleTemplate: Array.isArray(s.scheduleTemplate) ? s.scheduleTemplate.slice(0, 60) : null,
    // Qualifying and booking (lib/crmQualify.js normalises these itself).
    minJobValue: Number.isFinite(Number(s.minJobValue)) && s.minJobValue !== null && s.minJobValue !== '' ? Number(s.minJobValue) : null,
    booking: s.booking && typeof s.booking === 'object' ? s.booking : null,
    // Referrals, reviews and warranty (lib/crmLifetime.js normalises these itself).
    referralReward: Number.isFinite(Number(s.referralReward)) && s.referralReward !== null && s.referralReward !== '' ? Number(s.referralReward) : null,
    reviewUrl: typeof s.reviewUrl === 'string' ? s.reviewUrl : null,
    warrantyMonths: Number.isFinite(parseInt(s.warrantyMonths, 10)) ? parseInt(s.warrantyMonths, 10) : null,
    // Backlog (lib/crmMarketing.js normalises these itself).
    monthlyCapacity: Number.isFinite(Number(s.monthlyCapacity)) && s.monthlyCapacity !== null && s.monthlyCapacity !== '' ? Number(s.monthlyCapacity) : null,
    backlogLowWeeks: Number.isFinite(parseInt(s.backlogLowWeeks, 10)) ? parseInt(s.backlogLowWeeks, 10) : null,
    backlogHighWeeks: Number.isFinite(parseInt(s.backlogHighWeeks, 10)) ? parseInt(s.backlogHighWeeks, 10) : null,
    backfilledAt: s.backfilledAt || null
  };
}

// Stages a company may hide (for example a remodeler who doesn't sell paid design).
// New, signed, complete and lost are what everything else is built on, so they stay.
const HIDEABLE_STAGES = new Set(['qualified', 'site_visit', 'design_agreement', 'in_design', 'proposal', 'production']);
function cleanStageLabels(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const label = String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 40);
      if (STAGE_BY_KEY[k] && label && label !== STAGE_BY_KEY[k].label) out[k] = label;
    }
  }
  return out;
}
// The stages as this company sees them.
function stagesFor(settings) {
  return STAGES.map(s => ({ ...s, label: (settings.stageLabels && settings.stageLabels[s.key]) || s.label, hidden: (settings.hiddenStages || []).includes(s.key) }));
}

async function getSettings(tenantId) {
  const r = await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [tenantId]);
  return normalizeSettings(r.rows[0] && r.rows[0].crm_settings);
}

// Settings other parts of the CRM keep in the same place (draw template, pulse,
// setup...) are left as they are.
async function rawCrmSettings(tenantId) {
  const r = (await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [tenantId])).rows[0];
  return (r && r.crm_settings) || {};
}
async function saveSettings(tenantId, patch) {
  const cur = await getSettings(tenantId);
  const next = normalizeSettings({ ...cur, ...patch, backfilledAt: cur.backfilledAt });
  await query('UPDATE business_profile SET crm_settings = $1 WHERE tenant_id = $2', [JSON.stringify({ ...(await rawCrmSettings(tenantId)), ...next }), tenantId]);
  return next;
}

// ---------- records ----------

async function logActivity({ tenantId, dealId, kind, actor = 'owner', body = null, meta = null, userId = null }) {
  await query(
    `INSERT INTO crm_activities (tenant_id, deal_id, kind, actor, body, meta, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, dealId, kind, actor, body, meta ? JSON.stringify(meta) : null, actor === 'owner' ? userId : null]);
  // Only things a person did count as "activity" for spotting a stalled deal;
  // an automatic email going out doesn't mean anyone is working the deal.
  if (actor !== 'eagle_i') {
    await query('UPDATE crm_deals SET last_activity_at = now() WHERE id = $1', [dealId]);
  }
}

// The same person coming back (by email, else by phone) is matched to their
// existing contact rather than duplicated. Missing details are filled in.
async function findOrCreateContact({ tenantId, name, email, phone }) {
  const em = EMAIL_RE.test(String(email || '').trim()) ? String(email).trim() : null;
  const digits = phoneDigits(phone);
  let row = null;
  if (em) row = (await query('SELECT * FROM crm_contacts WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) ORDER BY created_at LIMIT 1', [tenantId, em])).rows[0];
  if (!row && digits) row = (await query('SELECT * FROM crm_contacts WHERE tenant_id = $1 AND phone_digits = $2 ORDER BY created_at LIMIT 1', [tenantId, digits])).rows[0];
  if (row) {
    if ((!row.email && em) || (!row.phone && phone)) {
      row = (await query(
        `UPDATE crm_contacts SET email = COALESCE(email, $2), phone = COALESCE(phone, $3), phone_digits = COALESCE(phone_digits, $4), updated_at = now()
         WHERE id = $1 RETURNING *`, [row.id, em, cleanText(phone, 40), digits])).rows[0];
    }
    return row;
  }
  return (await query(
    `INSERT INTO crm_contacts (tenant_id, name, email, phone, phone_digits) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [tenantId, cleanText(name, 120) || 'Unknown', em, cleanText(phone, 40), digits])).rows[0];
}

async function zipMedian(zip) {
  if (!zip) return null;
  try {
    const r = await query('SELECT median_market_value FROM hcad_zip_stats WHERE zip = $1', [zip]);
    return r.rows.length ? Number(r.rows[0].median_market_value) : null;
  } catch (err) {
    return null; // county data is a nice-to-have, never a reason to fail saving a deal
  }
}

async function createProperty({ tenantId, contactId, address, zip }) {
  const addr = cleanText(address, 200);
  const z = extractZip(zip, addr);
  if (!addr && !z) return null;
  return (await query(
    `INSERT INTO crm_properties (tenant_id, contact_id, address, zip, zip_median_value) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [tenantId, contactId, addr, z, await zipMedian(z)])).rows[0];
}

function defaultTitle(name, message) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'New';
  const hint = String(message || '').toLowerCase();
  for (const [word, label] of [['outdoor', 'outdoor living'], ['patio', 'outdoor living'], ['addition', 'addition'], ['whole', 'whole-home remodel'], ['new home', 'new home'], ['custom home', 'new home'], ['kitchen', 'kitchen'], ['bath', 'bathroom']]) {
    if (hint.includes(word)) return `${first} — ${label}`;
  }
  return `${first} — project`;
}

async function createDeal({ tenantId, name, email, phone, address, zip, title, stage = 'new', value, source = 'manual', leadId = null, note = null, actor = 'owner', createdAt = null, respondedAt = null, baseUrl = '', userId = null, ownerUserId = null }) {
  if (!isStage(stage)) stage = 'new';
  if (!SOURCES.has(source)) source = 'other';
  const contact = await findOrCreateContact({ tenantId, name, email, phone });
  const property = await createProperty({ tenantId, contactId: contact.id, address, zip });
  const ins = await query(
    `INSERT INTO crm_deals (tenant_id, contact_id, property_id, lead_id, title, stage, value, source, created_at, stage_entered_at, last_activity_at, first_response_at, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6::varchar, $7, $8, COALESCE($9::timestamptz, now()), COALESCE($9::timestamptz, now()), COALESCE($9::timestamptz, now()),
             CASE WHEN $6::varchar <> 'new' OR $10::text = 'owner' THEN COALESCE($11::timestamptz, $9::timestamptz, now()) END,
             (SELECT id FROM users WHERE id = $12::uuid AND tenant_id = $1))
     ON CONFLICT (lead_id) WHERE lead_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [tenantId, contact.id, property ? property.id : null, leadId, cleanText(title, 140) || defaultTitle(name, note), stage, parseValue(value), source, createdAt, actor, respondedAt, ownerUserId || (actor === 'owner' ? userId : null)]);
  if (!ins.rows.length) return null; // this lead already has a deal
  const deal = ins.rows[0];
  await query(
    `INSERT INTO crm_activities (tenant_id, deal_id, kind, actor, body, meta, created_at, user_id) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8)`,
    [tenantId, deal.id, leadId ? 'lead_in' : 'note', leadId ? 'contact' : actor,
     leadId ? (note || 'Filled out the form on your landing page.') : (note || 'Added by hand.'),
     JSON.stringify({ source, stage }), createdAt, !leadId && actor === 'owner' ? userId : null]);
  // How good a fit it looks (lib/crmQualify.js).
  await require('./crmQualify').scoreDeal(tenantId, deal.id).catch(e => console.error('[crm] scoring failed:', e.message));
  // A lead that just came in from outside: its three-line summary, written in the background (lib/crmCoach.js).
  if (actor === 'contact' && !createdAt) require('./crmCoach').leadSummary(tenantId, deal.id).catch(e => console.error('[crm] lead summary failed:', e.message));
  // Not for leads brought in from before the CRM existed: those are history.
  if (!createdAt) {
    await require('./crmPlaybooks').scheduleForDeal(deal, baseUrl).catch(err => console.error('[crm] scheduling playbooks failed:', err.message));
  }
  return deal;
}

async function hasCrm(tenantId) {
  const r = await query('SELECT products FROM tenants WHERE id = $1', [tenantId]);
  return !!(r.rows[0] && Array.isArray(r.rows[0].products) && r.rows[0].products.includes('crm'));
}

// Called right after a landing-page form is saved (only for companies that use
// the CRM). Never able to fail the visitor's submission.
async function createDealFromLead(lead) {
  if (!(await hasCrm(lead.tenant_id))) return null;
  const settings = await getSettings(lead.tenant_id);
  return createDeal({
    tenantId: lead.tenant_id, name: lead.name, email: lead.email, phone: lead.phone, title: null,
    stage: 'new', source: lead.source === 'landing_page' ? 'landing_page' : 'website', leadId: lead.id, note: lead.message || null,
    actor: 'contact', // the person reached out; nobody at the company has picked it up yet
    ownerUserId: settings.leadOwnerUserId // handed to the chosen team member automatically
  });
}

// Brings leads that came in before the CRM existed (or while it was failing)
// into the pipeline, once per lead. Safe to run any number of times.
async function backfillLeads(tenantId) {
  const missing = (await query(
    `SELECT l.* FROM leads l WHERE l.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM crm_deals d WHERE d.lead_id = l.id)
     ORDER BY l.created_at ASC LIMIT 500`, [tenantId])).rows;
  let added = 0;
  for (const lead of missing) {
    const deal = await createDeal({
      tenantId, name: lead.name, email: lead.email, phone: lead.phone, stage: stageForLeadStatus(lead.status),
      source: lead.source === 'landing_page' ? 'landing_page' : 'website', leadId: lead.id, note: lead.message || null,
      actor: 'contact', createdAt: lead.created_at, respondedAt: lead.status !== 'new' ? lead.updated_at : null
    });
    if (deal) added++;
  }
  return added;
}

async function ensureBackfilled(tenantId) {
  const settings = await getSettings(tenantId);
  const added = await backfillLeads(tenantId);
  if (!settings.backfilledAt) {
    await query('UPDATE business_profile SET crm_settings = $1 WHERE tenant_id = $2',
      [JSON.stringify({ ...(await rawCrmSettings(tenantId)), ...settings, backfilledAt: new Date().toISOString() }), tenantId]);
  }
  return added;
}

async function getDeal(tenantId, dealId) {
  return (await query(
    `SELECT d.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone, c.language AS contact_language,
            p.address AS property_address, p.zip AS property_zip, p.zip_median_value, COALESCE(u.name, u.email) AS owner_name
     FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id
     LEFT JOIN users u ON u.id = d.owner_user_id
     WHERE d.id = $1 AND d.tenant_id = $2`, [dealId, tenantId])).rows[0] || null;
}

// Moves a deal to another stage and lets everything that depends on that follow.
async function changeStage({ tenantId, dealId, stage, actor = 'owner', lostReason = null, baseUrl = '', syncLead = true, userId = null }) {
  if (!isStage(stage)) { const e = new Error('Unknown stage.'); e.status = 400; throw e; }
  const before = await getDeal(tenantId, dealId);
  if (!before) { const e = new Error('Deal not found.'); e.status = 404; throw e; }
  if (before.stage === stage) return before;
  const deal = (await query(
    `UPDATE crm_deals SET stage = $3::varchar, stage_entered_at = now(), updated_at = now(),
            lost_reason = CASE WHEN $3::varchar = 'lost' THEN $4::text ELSE NULL END,
            first_response_at = COALESCE(first_response_at, CASE WHEN $5::text = 'owner' THEN now() END)
     WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [dealId, tenantId, stage, cleanText(lostReason, 300), actor])).rows[0];
  const labels = Object.fromEntries(stagesFor(await getSettings(tenantId)).map(s => [s.key, s.label]));
  await logActivity({
    tenantId, dealId, kind: 'stage', actor, userId,
    body: `${labels[before.stage]} → ${labels[stage]}${stage === 'lost' && lostReason ? ` (${cleanText(lostReason, 300)})` : ''}`,
    meta: { from: before.stage, to: stage }
  });
  const playbooks = require('./crmPlaybooks');
  // Emails meant for the stage it just left must not go out any more.
  await playbooks.cancelForDeal(dealId, 'stage_changed', { trigger: 'stage' });
  // A deal that's over needs no more reminders either.
  if (stage === 'lost' || stage === 'complete') await playbooks.cancelForDeal(dealId, 'deal_closed');
  await playbooks.scheduleForDeal(deal, baseUrl);
  // What this stage asks someone to do next (kickoff, deposit, walkthrough...).
  await require('./crmTasks').createAutoTasks(deal, stage).catch(e => console.error('[crm] auto tasks failed:', e.message));
  // A signed contract gets its job schedule laid out from the company's template.
  if (stage === 'signed') await require('./crmJobs').createScheduleFromTemplate({ tenantId, dealId }).catch(e => console.error('[crm] schedule failed:', e.message));
  // Whoever referred a signed job is owed a thank-you; a finished job starts its home file.
  if (stage === 'signed') await require('./crmLifetime').onSigned(deal).catch(e => console.error('[crm] referral reward failed:', e.message));
  if (stage === 'complete') await require('./crmLifetime').onComplete(deal).catch(e => console.error('[crm] home file failed:', e.message));
  // Payment milestones (lib/crmDraws.js): laid against the new schedule, and the final one billed at the end.
  if (stage === 'signed') await require('./crmDraws').applyTemplate({ tenantId, dealId }).catch(e => console.error('[crm] draws failed:', e.message));
  if (stage === 'complete') await require('./crmDraws').onComplete(deal).catch(e => console.error('[crm] final draw failed:', e.message));
  // A lead someone is handling no longer needs a "waiting" alert.
  if (before.stage === 'new') await resolveInbox(tenantId, `waiting:${dealId}`);
  if (syncLead && deal.lead_id) {
    const status = leadStatusForStage(stage);
    await query('UPDATE leads SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 AND status <> $1', [status, deal.lead_id, tenantId]);
    if (status !== 'new') await require('./leadSequence').cancelForLead(deal.lead_id, 'lead_handled').catch(() => {});
  }
  return deal;
}

// The older Leads inbox changed a lead's status: move its deal to match.
// Only moves forward from "New" for "contacted", so a deal the owner already
// moved further along isn't dragged back.
async function syncFromLeadStatus({ tenantId, leadId, status, baseUrl = '', userId = null }) {
  const deal = (await query('SELECT * FROM crm_deals WHERE lead_id = $1 AND tenant_id = $2', [leadId, tenantId])).rows[0];
  if (!deal) return null;
  const target = stageForLeadStatus(status);
  if (status === 'contacted' && deal.stage !== 'new') return deal;
  if (status === 'new' && deal.stage !== 'new' && deal.stage !== 'lost') return deal;
  if (deal.stage === target) return deal;
  return changeStage({ tenantId, dealId: deal.id, stage: target, actor: 'owner', baseUrl, syncLead: false, userId });
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const same = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();

// Saves only what actually changed, and the timeline says exactly what that was.
async function updateDeal({ tenantId, dealId, patch, baseUrl = '', userId = null }) {
  const deal = await getDeal(tenantId, dealId);
  if (!deal) { const e = new Error('Deal not found.'); e.status = 404; throw e; }
  const changes = [];
  if (has(patch, 'title')) {
    const t = cleanText(patch.title, 140);
    if (!t) { const e = new Error('A deal needs a name.'); e.status = 400; throw e; }
    if (t !== deal.title) {
      await query('UPDATE crm_deals SET title = $1, updated_at = now() WHERE id = $2', [t, dealId]);
      changes.push('project name');
    }
  }
  if (has(patch, 'value')) {
    const v = parseValue(patch.value);
    if (patch.value !== '' && patch.value != null && v == null) { const e = new Error('Enter the value as a number, like 85000 or 85k.'); e.status = 400; throw e; }
    if (v !== (deal.value == null ? null : Number(deal.value))) {
      await query('UPDATE crm_deals SET value = $1, updated_at = now() WHERE id = $2', [v, dealId]);
      changes.push(v == null ? 'value (cleared)' : `value to $${v.toLocaleString('en-US')}`);
    }
  }
  if (has(patch, 'ownerUserId') && (patch.ownerUserId || null) !== (deal.owner_user_id || null)) {
    let owner = null;
    if (patch.ownerUserId) {
      owner = (await query('SELECT id, COALESCE(name, email) AS label FROM users WHERE id = $1 AND tenant_id = $2', [patch.ownerUserId, tenantId])).rows[0];
      if (!owner) { const e = new Error('That person is not on your team.'); e.status = 400; throw e; }
    }
    await query('UPDATE crm_deals SET owner_user_id = $1, updated_at = now() WHERE id = $2', [owner ? owner.id : null, dealId]);
    changes.push(owner ? `owner to ${owner.label}` : 'owner (unassigned)');
  }
  if (has(patch, 'source') && patch.source !== deal.source) {
    if (!SOURCES.has(patch.source)) { const e = new Error('Unknown source.'); e.status = 400; throw e; }
    await query('UPDATE crm_deals SET source = $1, updated_at = now() WHERE id = $2', [patch.source, dealId]);
    changes.push('where it came from');
  }
  const contactPatch = {};
  for (const [k, max, cur] of [['name', 120, deal.contact_name], ['email', 200, deal.contact_email], ['phone', 40, deal.contact_phone]]) {
    if (has(patch, k) && !same(patch[k], cur)) contactPatch[k] = cleanText(patch[k], max);
  }
  if (Object.keys(contactPatch).length) {
    if (has(contactPatch, 'name') && !contactPatch.name) { const e = new Error('The contact needs a name.'); e.status = 400; throw e; }
    if (contactPatch.email && !EMAIL_RE.test(contactPatch.email)) { const e = new Error('That email address does not look right.'); e.status = 400; throw e; }
    await query(
      `UPDATE crm_contacts SET name = COALESCE($2::text, name),
         email = CASE WHEN $5::boolean THEN $3::text ELSE email END,
         phone = CASE WHEN $6::boolean THEN $4::text ELSE phone END,
         phone_digits = CASE WHEN $6::boolean THEN $7::varchar ELSE phone_digits END, updated_at = now()
       WHERE id = $1`,
      [deal.contact_id, contactPatch.name || null, contactPatch.email || null, contactPatch.phone || null,
       has(contactPatch, 'email'), has(contactPatch, 'phone'), phoneDigits(contactPatch.phone)]);
    changes.push(...Object.keys(contactPatch));
  }
  // The language the homeowner reads: their automatic emails and pages follow it.
  if (has(patch, 'language')) {
    const lang = patch.language === 'es' ? 'es' : null;
    if ((deal.contact_language || null) !== lang) {
      await query('UPDATE crm_contacts SET language = $2, updated_at = now() WHERE id = $1', [deal.contact_id, lang]);
      changes.push(`language (${lang === 'es' ? 'Spanish' : 'English'})`);
    }
  }
  if (has(patch, 'address') || has(patch, 'zip')) {
    const addr = cleanText(has(patch, 'address') ? patch.address : deal.property_address, 200);
    const z = extractZip(has(patch, 'zip') ? patch.zip : deal.property_zip, addr);
    if (!same(addr, deal.property_address) || !same(z, deal.property_zip)) {
      if (deal.property_id) {
        await query('UPDATE crm_properties SET address = $2, zip = $3, zip_median_value = $4 WHERE id = $1', [deal.property_id, addr, z, await zipMedian(z)]);
      } else {
        const p = await createProperty({ tenantId, contactId: deal.contact_id, address: addr, zip: z });
        if (p) await query('UPDATE crm_deals SET property_id = $1 WHERE id = $2', [p.id, dealId]);
      }
      changes.push('address');
    }
  }
  let visitChanged = false;
  if (has(patch, 'siteVisitAt')) {
    const at = patch.siteVisitAt ? new Date(patch.siteVisitAt) : null;
    if (patch.siteVisitAt && (!at || isNaN(at.getTime()))) { const e = new Error('Pick a valid date and time for the site visit.'); e.status = 400; throw e; }
    const before = deal.site_visit_at ? new Date(deal.site_visit_at).getTime() : null;
    if ((at ? at.getTime() : null) !== before) {
      await query('UPDATE crm_deals SET site_visit_at = $1, updated_at = now() WHERE id = $2', [at, dealId]);
      changes.push(at ? `site visit to ${at.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'site visit (cleared)');
      visitChanged = true;
    }
  }
  if (changes.length) {
    await logActivity({ tenantId, dealId, kind: 'system', body: `Updated ${changes.join(', ')}.`, userId });
    await query('UPDATE crm_deals SET first_response_at = COALESCE(first_response_at, now()) WHERE id = $1', [dealId]);
  }
  if (patch.stage && patch.stage !== deal.stage) {
    await changeStage({ tenantId, dealId, stage: patch.stage, lostReason: patch.lostReason, baseUrl, userId });
  } else if (visitChanged && patch.siteVisitAt && STAGES.findIndex(s => s.key === deal.stage) < STAGES.findIndex(s => s.key === 'site_visit')) {
    // Booking a visit is what "Site visit set" means: move the deal there on its own.
    await changeStage({ tenantId, dealId, stage: 'site_visit', baseUrl, userId });
  }
  if (visitChanged) {
    const fresh = (await query('SELECT * FROM crm_deals WHERE id = $1', [dealId])).rows[0];
    await require('./crmPlaybooks').scheduleMeeting(fresh, baseUrl);
  }
  if (changes.some(c => /^(value|address|where it came from|email|phone)/.test(c))) await require('./crmQualify').scoreDeal(tenantId, dealId).catch(() => {});
  return getDeal(tenantId, dealId);
}

// `pickOut`: let Eagle I read the note (typed or dictated) for the job's value,
// the next step and a site-visit time, and fill in only what's missing.
async function addNote({ tenantId, dealId, body, userId = null, pickOut = false, baseUrl = '' }) {
  const text = cleanText(body, 4000);
  if (!text) { const e = new Error('Write a note first.'); e.status = 400; throw e; }
  const deal = await getDeal(tenantId, dealId);
  if (!deal) { const e = new Error('Deal not found.'); e.status = 404; throw e; }
  await logActivity({ tenantId, dealId, kind: 'note', body: text, userId });
  await query('UPDATE crm_deals SET first_response_at = COALESCE(first_response_at, now()) WHERE id = $1', [dealId]);
  if (deal.stage === 'new') await resolveInbox(tenantId, `waiting:${dealId}`);
  if (!pickOut) return { picked: [] };
  const tasks = require('./crmTasks');
  const found = await tasks.readNote({ text });
  const picked = [];
  if (!found) return { picked };
  if (found.value && deal.value == null) {
    await query('UPDATE crm_deals SET value = $2 WHERE id = $1', [dealId, found.value]);
    picked.push(`value $${found.value.toLocaleString('en-US')}`);
  }
  if (found.nextStep) {
    const due = found.nextStepDue ? require('./outreachQueue').zonedToUtc(...found.nextStepDue.split('-').map(Number), 17, 0) : null;
    await tasks.createTask({ tenantId, dealId, title: found.nextStep, dueAt: due, assigneeUserId: deal.owner_user_id || userId, createdBy: userId, source: 'voice' });
    picked.push(`task “${found.nextStep}”`);
  }
  if (found.siteVisitAt && !deal.site_visit_at && new Date(found.siteVisitAt) > new Date()) {
    await updateDeal({ tenantId, dealId, patch: { siteVisitAt: found.siteVisitAt }, baseUrl, userId });
    picked.push('the site visit time');
  }
  if (picked.length) await logActivity({ tenantId, dealId, kind: 'system', actor: 'eagle_i', body: `From your note, Eagle I added ${picked.join(', ')}.` });
  return { picked };
}

async function deleteDeal(tenantId, dealId) {
  return (await query('DELETE FROM crm_deals WHERE id = $1 AND tenant_id = $2 RETURNING id', [dealId, tenantId])).rowCount > 0;
}

async function listPipeline(tenantId) {
  const deals = (await query(
    `SELECT d.id, d.title, d.stage, d.value, d.source, d.stage_entered_at, d.last_activity_at, d.created_at, d.first_response_at, ${INBOUND_SQL} AS inbound,
            c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone, p.address AS property_address, p.zip AS property_zip,
            d.owner_user_id, COALESCE(u.name, u.email) AS owner_name, d.site_visit_at, d.score, d.grade,
            (SELECT COUNT(*)::int FROM crm_playbook_sends s WHERE s.deal_id = d.id AND s.status = 'pending') AS automations_waiting
     FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id
     LEFT JOIN users u ON u.id = d.owner_user_id
     WHERE d.tenant_id = $1
     ORDER BY d.stage_entered_at DESC LIMIT 1000`, [tenantId])).rows;
  const counts = Object.fromEntries(STAGES.map(s => [s.key, 0]));
  const values = Object.fromEntries(STAGES.map(s => [s.key, 0]));
  for (const d of deals) { counts[d.stage] = (counts[d.stage] || 0) + 1; values[d.stage] = (values[d.stage] || 0) + Number(d.value || 0); }
  const openValue = deals.filter(d => STAGE_BY_KEY[d.stage] && STAGE_BY_KEY[d.stage].open && !WON_STAGES.has(d.stage)).reduce((n, d) => n + Number(d.value || 0), 0);
  return { stages: stagesFor(await getSettings(tenantId)), deals, counts, values, openValue };
}

async function dealTimeline(tenantId, dealId) {
  const activities = (await query(
    `SELECT a.id, a.kind, a.actor, a.body, a.meta, a.created_at, COALESCE(u.name, u.email) AS user_name
     FROM crm_activities a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.deal_id = $1 AND a.tenant_id = $2 ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    [dealId, tenantId])).rows;
  const automations = (await query(
    `SELECT s.id, s.step, s.due_at, s.status, s.cancel_reason, s.sent_at, s.subject, p.name AS playbook_name
     FROM crm_playbook_sends s JOIN crm_playbooks p ON p.id = s.playbook_id
     WHERE s.deal_id = $1 AND s.tenant_id = $2 ORDER BY s.due_at ASC LIMIT 50`, [dealId, tenantId])).rows;
  return { activities, automations };
}

// ---------- "Needs you" ----------

async function addInboxItem({ tenantId, dealId = null, kind, title, detail = null, dedupeKey }) {
  const r = await query(
    `INSERT INTO crm_inbox (tenant_id, deal_id, kind, title, detail, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING id`,
    [tenantId, dealId, kind, String(title).slice(0, 200), detail ? String(detail).slice(0, 2000) : null, dedupeKey]);
  return r.rows.length > 0;
}

async function resolveInbox(tenantId, dedupeKey) {
  await query(`UPDATE crm_inbox SET status = 'done', resolved_at = now() WHERE tenant_id = $1 AND dedupe_key = $2 AND status = 'open'`, [tenantId, dedupeKey]);
}

async function listInbox(tenantId, { now = new Date() } = {}) {
  return (await query(
    `SELECT i.id, i.kind, i.title, i.detail, i.deal_id, i.created_at, i.dedupe_key, d.title AS deal_title, d.stage AS deal_stage, d.owner_user_id AS deal_owner_user_id
     FROM crm_inbox i LEFT JOIN crm_deals d ON d.id = i.deal_id
     WHERE i.tenant_id = $1 AND i.status = 'open' AND (i.snooze_until IS NULL OR i.snooze_until <= $2)
     ORDER BY CASE i.kind WHEN 'negative_reply' THEN 0 WHEN 'unhappy' THEN 0 WHEN 'waiting_lead' THEN 1 WHEN 'reply' THEN 2 WHEN 'weather' THEN 2 ELSE 3 END, i.created_at DESC
     LIMIT 200`, [tenantId, now])).rows;
}

async function actOnInbox({ tenantId, id, action, days = 1 }) {
  if (action === 'done') {
    return (await query(`UPDATE crm_inbox SET status = 'done', resolved_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING id`, [id, tenantId])).rowCount > 0;
  }
  if (action === 'snooze') {
    const d = [1, 3, 7].includes(Number(days)) ? Number(days) : 1;
    return (await query(`UPDATE crm_inbox SET snooze_until = now() + ($3 || ' days')::interval WHERE id = $1 AND tenant_id = $2 AND status = 'open' RETURNING id`, [id, tenantId, String(d)])).rowCount > 0;
  }
  const e = new Error('Unknown action.'); e.status = 400; throw e;
}

// Looks for the exceptions worth a person's attention. Runs on the background tick.
async function scanExceptions({ now = new Date() } = {}) {
  const summary = { waiting: 0, stalled: 0 };
  // New leads nobody has touched. Only recent ones: a lead from last month that
  // was never touched is a stalled deal, not an emergency.
  const waiting = (await query(
    `SELECT d.id, d.tenant_id, d.title, d.created_at, c.name, c.phone, c.email, bp.crm_settings
     FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN business_profile bp ON bp.tenant_id = d.tenant_id
     WHERE d.stage = 'new' AND d.first_response_at IS NULL AND d.created_at > $1::timestamptz - interval '3 days'
     LIMIT 500`, [now])).rows;
  for (const d of waiting) {
    const mins = normalizeSettings(d.crm_settings).waitingMinutes;
    const ageMin = (now - new Date(d.created_at)) / 60000;
    if (ageMin < mins) continue;
    const added = await addInboxItem({
      tenantId: d.tenant_id, dealId: d.id, kind: 'waiting_lead', dedupeKey: `waiting:${d.id}`,
      title: `New lead not picked up yet: ${d.name}`,
      detail: [`Came in ${new Date(d.created_at).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit' })} Central`, d.phone, d.email].filter(Boolean).join(' · ')
    });
    if (added) summary.waiting++;
  }
  for (const s of STAGES.filter(x => x.stallDays)) {
    const stalled = (await query(
      `SELECT d.id, d.tenant_id, d.title, d.last_activity_at FROM crm_deals d
       WHERE d.stage = $1 AND d.last_activity_at < $2::timestamptz - ($3 || ' days')::interval LIMIT 500`,
      [s.key, now, String(s.stallDays)])).rows;
    for (const d of stalled) {
      const days = Math.floor((now - new Date(d.last_activity_at)) / 86400000);
      const added = await addInboxItem({
        tenantId: d.tenant_id, dealId: d.id, kind: 'stalled',
        // Keyed to the last activity: once someone works the deal and it stalls again, it comes back.
        dedupeKey: `stalled:${d.id}:${new Date(d.last_activity_at).getTime()}`,
        title: `${d.title} has had no activity for ${days} days`,
        detail: `Still in “${s.label}”.`
      });
      if (added) summary.stalled++;
    }
  }
  return summary;
}

// ---------- weekly summary ----------

// Monday 00:00 Central of the week containing `now`, and the Monday before it.
function weekBounds(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', hour12: false })
    .formatToParts(now).map(x => [x.type, x.value]));
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  const thisMondayLocal = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day - dow));
  const lastMondayLocal = new Date(thisMondayLocal.getTime() - 7 * 86400000);
  const toUtc = (d) => zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0);
  return {
    weekStartKey: lastMondayLocal.toISOString().slice(0, 10), // the week being reported on
    start: toUtc(lastMondayLocal), end: toUtc(thisMondayLocal),
    dayOfWeek: dow, hour: parseInt(parts.hour, 10) % 24
  };
}

async function buildWeeklySummary(tenantId, { start, end }) {
  const one = async (sql, params) => (await query(sql, params)).rows[0];
  const leads = await one(
    `SELECT COUNT(*)::int AS n FROM crm_deals d WHERE d.tenant_id = $1 AND d.created_at >= $2 AND d.created_at < $3 AND ${INBOUND_SQL}`, [tenantId, start, end]);
  const responses = (await query(
    `SELECT EXTRACT(EPOCH FROM (d.first_response_at - d.created_at)) / 60 AS mins FROM crm_deals d
     WHERE d.tenant_id = $1 AND d.created_at >= $2 AND d.created_at < $3 AND ${INBOUND_SQL} AND d.first_response_at IS NOT NULL`, [tenantId, start, end])).rows.map(r => Number(r.mins));
  const sent = await one(`SELECT COUNT(*)::int AS n FROM crm_playbook_sends WHERE tenant_id = $1 AND status = 'sent' AND sent_at >= $2 AND sent_at < $3`, [tenantId, start, end]);
  const leadEmails = await one(`SELECT COUNT(*)::int AS n FROM lead_sequence_sends WHERE tenant_id = $1 AND status = 'sent' AND sent_at >= $2 AND sent_at < $3`, [tenantId, start, end]);
  const replies = await one(`SELECT COUNT(*)::int AS n FROM crm_activities WHERE tenant_id = $1 AND kind = 'reply' AND created_at >= $2 AND created_at < $3`, [tenantId, start, end]);
  const moves = await one(`SELECT COUNT(*)::int AS n FROM crm_activities WHERE tenant_id = $1 AND kind = 'stage' AND created_at >= $2 AND created_at < $3`, [tenantId, start, end]);
  const signed = await one(
    `SELECT COUNT(DISTINCT deal_id)::int AS n, COALESCE(SUM(d.value), 0)::float AS value FROM crm_activities a JOIN crm_deals d ON d.id = a.deal_id
     WHERE a.tenant_id = $1 AND a.kind = 'stage' AND a.meta->>'to' = 'signed' AND a.created_at >= $2 AND a.created_at < $3`, [tenantId, start, end]);
  const pipeline = await listPipeline(tenantId);
  const openItems = (await listInbox(tenantId)).length;
  return {
    newLeads: leads.n, respondedCount: responses.length, medianResponseMinutes: median(responses),
    automatedEmails: sent.n + leadEmails.n, replies: replies.n, stageMoves: moves.n,
    signedCount: signed.n, signedValue: signed.value, openPipelineValue: pipeline.openValue,
    openDeals: pipeline.deals.filter(d => STAGE_BY_KEY[d.stage].open).length, needsYou: openItems
  };
}

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
function formatMinutes(m) {
  if (m == null) return '—';
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 48 * 60) return `${(m / 60).toFixed(1).replace(/\.0$/, '')} hours`;
  return `${Math.round(m / 1440)} days`;
}

function renderWeeklySummaryEmail({ companyName, s, weekLabel }) {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rows = [
    ['New leads', s.newLeads],
    ['How fast they were picked up (median)', s.respondedCount ? formatMinutes(s.medianResponseMinutes) : (s.newLeads ? 'Not picked up yet' : '—')],
    ['Automatic emails Eagle I sent for you', s.automatedEmails],
    ['Replies to those emails', s.replies],
    ['Deals moved to a new stage', s.stageMoves],
    ['Contracts signed', s.signedCount ? `${s.signedCount} (${money(s.signedValue)})` : 0],
    ['Open pipeline value', money(s.openPipelineValue)],
    ['Waiting for you in “Needs you”', s.needsYou]
  ];
  const text = `${companyName}: your week in Eagle I (${weekLabel})\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\nThese are counts from your real records. Open Eagle I → Pipeline to see the details.\nTo stop this email, switch off the weekly summary in Pipeline → Automations.`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b2333;max-width:560px">
<h2 style="font-size:18px;margin:0 0 4px">Your week in Eagle I</h2><div style="color:#5b6472;margin-bottom:14px">${esc(companyName)} · ${esc(weekLabel)}</div>
<table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:7px 0;border-bottom:1px solid #e5e1d8">${esc(k)}</td><td style="padding:7px 0;border-bottom:1px solid #e5e1d8;text-align:right;font-weight:bold">${esc(v)}</td></tr>`).join('')}</table>
<p style="color:#5b6472;font-size:12px;margin-top:14px">These are counts from your real records. Open Eagle I → Pipeline to see the details. To stop this email, switch off the weekly summary in Pipeline → Automations.</p></div>`;
  return { subject: `Your week in Eagle I: ${s.newLeads} new lead${s.newLeads === 1 ? '' : 's'}, ${s.automatedEmails} automatic email${s.automatedEmails === 1 ? '' : 's'}`, html, text };
}

// Monday from 8am Central: one summary per company that has a pipeline, for the week just ended.
async function processWeeklySummaries({ now = new Date(), send = sendEmail } = {}) {
  const b = weekBounds(now);
  const result = { checked: 0, sent: 0 };
  if (b.dayOfWeek !== 0 || b.hour < 8) return result;
  const tenants = (await query(
    `SELECT DISTINCT d.tenant_id, t.company_name, bp.email AS profile_email, bp.crm_settings
     FROM crm_deals d JOIN tenants t ON t.id = d.tenant_id LEFT JOIN business_profile bp ON bp.tenant_id = d.tenant_id
     WHERE NOT EXISTS (SELECT 1 FROM crm_weekly_summaries w WHERE w.tenant_id = d.tenant_id AND w.week_start = $1)`, [b.weekStartKey])).rows;
  for (const t of tenants) {
    result.checked++;
    if (!normalizeSettings(t.crm_settings).weeklySummary) continue;
    // Claim first, so two overlapping ticks can never send it twice.
    const claimed = await query(`INSERT INTO crm_weekly_summaries (tenant_id, week_start) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING tenant_id`, [t.tenant_id, b.weekStartKey]);
    if (!claimed.rows.length) continue;
    try {
      const owner = (await query('SELECT email FROM users WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1', [t.tenant_id])).rows[0];
      const to = [t.profile_email, owner && owner.email].find(e => EMAIL_RE.test(String(e || '').trim()));
      if (!to) continue;
      const s = await buildWeeklySummary(t.tenant_id, b);
      const weekLabel = `week of ${new Date(b.weekStartKey + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      const { subject, html, text } = renderWeeklySummaryEmail({ companyName: t.company_name, s, weekLabel });
      await send({ to: to.trim(), subject, html, text });
      result.sent++;
    } catch (err) {
      // Release the claim so the next tick can try again.
      await query('DELETE FROM crm_weekly_summaries WHERE tenant_id = $1 AND week_start = $2', [t.tenant_id, b.weekStartKey]).catch(() => {});
      console.error('[crm] weekly summary failed:', err.message);
    }
  }
  return result;
}

module.exports = {
  STAGES, STAGE_BY_KEY, WON_STAGES, SOURCES, SOURCE_LABELS, sourceLabel, INBOUND_SQL, isStage, stageLabel,
  phoneDigits, extractZip, parseValue, stageForLeadStatus, leadStatusForStage, median, normalizeSettings, defaultTitle,
  weekBounds, formatMinutes, renderWeeklySummaryEmail,
  hasCrm, getSettings, saveSettings, stagesFor, HIDEABLE_STAGES, logActivity, findOrCreateContact, createDeal, createDealFromLead, backfillLeads, ensureBackfilled,
  getDeal, changeStage, syncFromLeadStatus, updateDeal, addNote, deleteDeal, listPipeline, dealTimeline,
  addInboxItem, resolveInbox, listInbox, actOnInbox, scanExceptions, buildWeeklySummary, processWeeklySummaries
};
