// Playbooks: automatic emails. Each has a trigger:
//  - stage: when a deal enters a stage (for example, a proposal follow-up 3, 7
//    and 14 days later);
//  - meeting: a set number of days before a deal's site visit (a reminder);
//  - estimate_expiry: a set number of days before a sent estimate expires.
//
// "Approve once, run forever": every playbook starts switched off. The owner
// reads the exact wording and approves it; from then on it runs by itself for
// every deal that enters the stage. Changing the wording withdraws the
// approval (and switches it off) until the new wording is approved, and every
// send re-checks that the wording it is about to use is the approved wording.
//
// What keeps it from doing something the owner wouldn't want:
//  - emails for a stage stop the moment the deal leaves that stage; reminders
//    stop when the visit is moved or the estimate is answered or changed;
//  - a reply from the person stops the sales follow-ups for that deal (a
//    site-visit reminder still goes, since it's logistics, not a nudge);
//  - unsubscribed, bounced and spam-reporting addresses are never emailed;
//  - every email carries the company's address and an unsubscribe link;
//  - follow-ups after the first day only go out weekdays 9am-5pm Central;
//    reminders go out 8am-8pm Central any day, and never after the visit;
//  - at most MAX_PER_DAY a day per company, and one switch pauses it all;
//  - approving a playbook never emails deals already sitting in that stage.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail, buildReplyToAddress } = require('./email');
const outreach = require('./vendorOutreach');
const followUps = require('./followUps');
const tpl = require('./outreachTemplate');
const crm = require('./crm');
const { leadFirstName } = require('./leadSequence');

const MAX_STEPS = 3;
const MAX_DAYS = 365;
const MAX_MESSAGE = 2000;
const MAX_PER_DAY = 60;
const BASE_TOKENS = ['name', 'company', 'phone', 'email', 'founder'];
// What each kind of playbook may say, and when its emails may be timed.
const TRIGGERS = {
  stage: { minDays: 0, maxDays: MAX_DAYS, tokens: [...BASE_TOKENS, 'portal_link', 'qualify_link', 'booking_link', 'review_link', 'referral_link'], when: 'after the deal enters the stage' },
  meeting: { minDays: -14, maxDays: -1, tokens: [...BASE_TOKENS, 'visit_date', 'visit_time', 'address', 'portal_link'], when: 'before the site visit' },
  estimate_expiry: { minDays: -14, maxDays: -1, tokens: [...BASE_TOKENS, 'estimate_link', 'estimate_total', 'expires'], when: 'before the estimate expires' },
  invoice_due: { minDays: -7, maxDays: 30, tokens: [...BASE_TOKENS, 'invoice_link', 'invoice_amount', 'invoice_number', 'due_date'], when: 'from the invoice’s due date (negative = before)' },
  // From the home file (lib/crmLifetime.js): an item's care date, and the end of its warranty.
  home_care: { minDays: 0, maxDays: 14, tokens: [...BASE_TOKENS, 'item', 'care_note', 'portal_link', 'referral_link', 'review_link'], when: 'after an item in the home file is due for care' },
  warranty_end: { minDays: -60, maxDays: -1, tokens: [...BASE_TOKENS, 'item', 'warranty_end', 'portal_link'], when: 'before a warranty ends' }
};
const TRIGGER_LABELS = { meeting: 'Before a site visit', estimate_expiry: 'Before an estimate expires', invoice_due: 'Around an invoice’s due date', home_care: 'Home care reminders', warranty_end: 'Before a warranty ends' };

const DEFAULT_PLAYBOOKS = [
  {
    key: 'new_lead_reply', name: 'Instant reply to new leads', trigger: 'stage', stage: 'new',
    steps: [
      { days: 0, subject: 'Thanks for reaching out to {company}', message: 'Hi {name},\n\nThanks for getting in touch with {company}. We got your message and someone from our team will contact you shortly, usually the same business day.\n\nIf you have two minutes, tell us a little about your project and pick a time for us to come out:\n{qualify_link}\n\nTalk soon,\n{founder}\n{phone}' },
      { days: 2, subject: 'Following up from {company}', message: 'Hi {name},\n\nI wanted to make sure we connected about your project. When is a good time for a quick call?\n\nYou can reply here or call {phone}.' }
    ]
  },
  {
    key: 'site_visit_reminder', name: 'Site visit reminder', trigger: 'meeting', stage: null,
    steps: [{
      days: -1, subject: 'See you {visit_date}',
      message: 'Hi {name},\n\nA quick reminder that we will see you {visit_date} at {visit_time} at {address}.\n\nIf you need to change the time, just reply or call {phone}.'
    }]
  },
  {
    key: 'estimate_expiring', name: 'Estimate about to expire', trigger: 'estimate_expiry', stage: null,
    steps: [{
      days: -3, subject: 'Your estimate from {company} expires {expires}',
      message: 'Hi {name},\n\nA heads-up that your estimate for {estimate_total} is good until {expires}. You can review and accept it here:\n\n{estimate_link}\n\nIf you have questions or want to adjust anything, just reply.'
    }]
  },
  {
    key: 'invoice_reminder', name: 'Invoice reminders', trigger: 'invoice_due', stage: null,
    steps: [
      { days: -2, subject: 'Invoice #{invoice_number} is due {due_date}', message: 'Hi {name},\n\nA friendly reminder that invoice #{invoice_number} for {invoice_amount} is due {due_date}. You can pay online here:\n\n{invoice_link}\n\nThank you!' },
      { days: 3, subject: 'Invoice #{invoice_number} is past due', message: 'Hi {name},\n\nOur records show invoice #{invoice_number} for {invoice_amount} is still open. You can pay online here:\n\n{invoice_link}\n\nIf you’ve already sent payment, thank you, and please ignore this note. Questions? Reply here or call {phone}.' }
    ]
  },
  {
    trigger: 'stage', key: 'site_visit_prep', name: 'Getting ready for the site visit', stage: 'site_visit',
    steps: [{
      days: 0, subject: 'Getting ready for our visit',
      message: 'Hi {name},\n\nThanks for setting up a visit with {company}. To make the most of our time together, it helps to have:\n\n- A few photos or links of styles you like\n- A rough budget range you are comfortable with\n- Everyone who will be part of the decision there, if possible\n\nIf anything changes, reply here or call {phone}.'
    }]
  },
  {
    trigger: 'stage', key: 'design_agreement_follow_up', name: 'Design agreement follow-up', stage: 'design_agreement',
    steps: [
      { days: 3, subject: 'Any questions about the design agreement?', message: 'Hi {name},\n\nI wanted to check whether you had a chance to look over the design agreement from {company}, and whether any questions came up.\n\nHappy to walk through it on a quick call. Just reply here or call {phone}.' },
      { days: 7, subject: 'Next step on your project', message: 'Hi {name},\n\nWhenever you are ready to move ahead, signing the design agreement lets us start on drawings and pricing for your project.\n\nIf the timing or anything else has changed, just let me know. No pressure at all.' }
    ]
  },
  {
    trigger: 'stage', key: 'proposal_follow_up', name: 'Proposal follow-up', stage: 'proposal',
    steps: [
      { days: 3, subject: 'Your proposal from {company}', message: 'Hi {name},\n\nI wanted to make sure the proposal came through and see if any questions came up as you looked it over.\n\nReply here or call {phone} and we can go through it together.' },
      { days: 7, subject: 'Checking in on your proposal', message: 'Hi {name},\n\nJust checking in on the proposal. If anything in the scope or the numbers needs another look, we are glad to adjust it.\n\nWhat would be most helpful for your decision?' },
      { days: 14, subject: 'Still planning your project?', message: 'Hi {name},\n\nI do not want to crowd your inbox, so this is my last note on the proposal for now. If your plans have changed, no problem at all. If you are still thinking it over, we are here whenever you are ready.' }
    ]
  },
  {
    trigger: 'stage', key: 'welcome_aboard', name: 'Welcome aboard', stage: 'signed',
    steps: [{
      days: 0, subject: 'Welcome to {company}',
      message: 'Hi {name},\n\nThank you for choosing {company}. We are excited to get started on your project.\n\nOver the next few days we will reach out to set up a kickoff meeting, where we go over the schedule, who your main contact will be, and what to expect each week.\n\nYou can follow your project, see photos and send us a message any time here:\n{portal_link}\n\nAny questions in the meantime, reply here or call {phone}.'
    }]
  },
  {
    trigger: 'stage', key: 'job_complete', name: 'Job complete: thank-you and check-in', stage: 'complete',
    steps: [
      { days: 3, subject: 'Thank you from {company}', message: 'Hi {name},\n\nThank you again for trusting {company} with your home. It was a pleasure working with you.\n\nIf anything at all needs attention as you settle in, reply here or call {phone} and we will take care of it.' },
      { days: 30, subject: 'How is everything holding up?', message: 'Hi {name},\n\nIt has been about a month since we finished, so I wanted to check in. How is everything holding up?\n\nIf a friend or neighbor is thinking about a project, we would be grateful for the introduction. This is your personal link to share, so we know to thank you:\n{referral_link}' }
    ]
  },
  {
    trigger: 'stage', key: 'review_request', name: 'Ask for a review', stage: 'complete',
    steps: [{
      days: 7, subject: 'Would you share a few words about {company}?',
      message: 'Hi {name},\n\nNow that you have had a week in your finished space, would you take two minutes to share how it went? Reviews are how other families find a builder they can trust.\n\n{review_link}\n\nThank you,\n{founder}'
    }]
  },
  {
    trigger: 'home_care', key: 'home_care_reminder', name: 'Home care reminders', stage: null,
    steps: [{
      days: 0, subject: 'A quick reminder about your {item}',
      message: 'Hi {name},\n\nIt is time for a little care on your {item}:\n{care_note}\n\nEverything about your home, including warranties and what went into it, is here:\n{portal_link}\n\nIf you would like us to take care of it, just reply or call {phone}.'
    }]
  },
  {
    trigger: 'warranty_end', key: 'warranty_ending', name: 'Warranty check-in', stage: null,
    steps: [{
      days: -30, subject: 'Your warranty with {company} ends {warranty_end}',
      message: 'Hi {name},\n\nThe warranty on your {item} runs through {warranty_end}. Before it ends, we would be glad to come by and look everything over, at no charge.\n\nReply with a few times that work, or call {phone}.'
    }]
  },
  {
    trigger: 'stage', key: 'lost_check_back', name: 'Check back on a lost deal', stage: 'lost',
    steps: [{
      days: 180, subject: 'Still thinking about your project?',
      message: 'Hi {name},\n\nIt has been a while since we talked about your project, and I wanted to check in. If it is back on your mind, {company} would be glad to help.\n\nIf not, no reply needed. Wishing you all the best.'
    }]
  }
];

// ---------- pure helpers ----------

// A step is an email unless `channel` is 'sms'. (The channel is only kept for
// texts, so the fingerprint of every email-only playbook stays what it was.)
function normalizeSteps(steps) {
  return (Array.isArray(steps) ? steps : []).slice(0, MAX_STEPS).map(s => {
    const out = { days: parseInt(s && s.days, 10), subject: outreach.cleanSubject(s && s.subject), message: String((s && s.message) || '').trim() };
    if (s && s.channel === 'sms') { out.channel = 'sms'; out.subject = ''; }
    return out;
  });
}

// The fingerprint of exactly what the owner approved: the trigger and every
// word of every email. (Stage playbooks keep their original fingerprint, so
// approvals given before triggers existed stay valid.)
function playbookHash(stage, steps, trigger = 'stage') {
  const body = trigger === 'stage' ? { stage, steps: normalizeSteps(steps) } : { trigger, steps: normalizeSteps(steps) };
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

const isApproved = (pb) => !!pb.approved_hash && pb.approved_hash === playbookHash(pb.stage, pb.steps, pb.trigger || 'stage');

// Returns an error message, or null when the steps are safe to save.
function validateSteps(steps, trigger = 'stage') {
  const t = TRIGGERS[trigger] || TRIGGERS.stage;
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) return `A playbook has 1 to ${MAX_STEPS} emails.`;
  let last = -Infinity;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] || {};
    const label = `Email ${i + 1}`;
    const days = parseInt(st.days, 10);
    if (!(days >= t.minDays && days <= t.maxDays)) {
      if (trigger === 'stage') return `${label} must be sent 0 to ${MAX_DAYS} days after the deal enters the stage.`;
      if (trigger === 'invoice_due') return `${label} must be sent between ${-t.minDays} days before and ${t.maxDays} days after the due date (enter -${-t.minDays} to ${t.maxDays}).`;
      if (t.minDays >= 0) return `${label} must be sent ${t.minDays} to ${t.maxDays} days ${t.when}.`;
      return `${label} must be sent 1 to ${-t.minDays} days ${t.when} (enter it as -1 to -${-t.minDays}).`;
    }
    if (days <= last) return `${label} has to come after the previous email.`;
    last = days;
    const sms = st.channel === 'sms';
    const subject = sms ? '' : outreach.cleanSubject(st.subject);
    const message = String(st.message || '').trim();
    if (!sms && !subject) return `${label} needs a subject.`;
    if (sms && (!message || message.length > 480)) return `${label} is a text: keep it under 480 characters.`;
    if (!message || message.length > MAX_MESSAGE) return `${label} needs a message of up to ${MAX_MESSAGE} characters.`;
    for (const text of [subject, message]) {
      for (const m of text.matchAll(/\{([a-z_]+)\}/g)) {
        if (!t.tokens.includes(m[1])) return `${label} uses {${m[1]}}, which is not available here. You can use ${t.tokens.map(x => `{${x}}`).join(', ')}.`;
      }
    }
  }
  return null;
}

function renderStep(step, { ctx, contactName, extra = {} }) {
  const vars = { company: ctx.companyName, phone: ctx.profile.phone || '', email: ctx.profile.email || '', founder: ctx.profile.founder_name || '', ...extra };
  const fill = (t) => tpl.fillName(tpl.renderTemplate(t, vars), leadFirstName(contactName));
  return { subject: outreach.cleanSubject(fill(step.subject)) || `A note from ${ctx.companyName}`, message: fill(step.message) };
}

const entryKey = (stageEnteredAt) => String(new Date(stageEnteredAt).getTime());
const meetingKey = (at) => 'm' + new Date(at).getTime();
const estimateKey = (est) => 'e' + String(est.id).slice(0, 8) + String(est.valid_until instanceof Date ? est.valid_until.toISOString() : est.valid_until).slice(0, 10).replace(/-/g, '');
const TZ = 'America/Chicago';
const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
const fmtTime = (d) => new Date(d).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
// Reminders go out 8am-8pm Central, any day of the week.
function inDaytime(date = new Date()) {
  const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(date), 10) % 24;
  return h >= 8 && h < 20;
}
// The moment an estimate stops being valid: the end of its valid-until day, Central time.
function estimateExpiresAt(validUntil) {
  const d = String(validUntil instanceof Date ? validUntil.toISOString() : validUntil).slice(0, 10).split('-').map(Number);
  return new Date(require('./outreachQueue').zonedToUtc(d[0], d[1], d[2] + 1, 0, 0).getTime() - 60000);
}
const isEmail = (e) => outreach.EMAIL_RE.test(String(e || '').trim());

// ---------- playbook records ----------

async function ensurePlaybooks(tenantId) {
  for (const pb of DEFAULT_PLAYBOOKS) {
    await query(
      `INSERT INTO crm_playbooks (tenant_id, key, name, stage, trigger, steps) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, key) DO NOTHING`, [tenantId, pb.key, pb.name, pb.stage, pb.trigger, JSON.stringify(pb.steps)]);
  }
}

async function listPlaybooks(tenantId) {
  await ensurePlaybooks(tenantId);
  const rows = (await query(
    `SELECT p.*,
            (SELECT COUNT(*)::int FROM crm_playbook_sends s WHERE s.playbook_id = p.id AND s.status = 'pending') AS waiting,
            (SELECT COUNT(*)::int FROM crm_playbook_sends s WHERE s.playbook_id = p.id AND s.status = 'sent') AS sent
     FROM crm_playbooks p WHERE p.tenant_id = $1`, [tenantId])).rows;
  const order = Object.fromEntries(crm.STAGES.map((s, i) => [s.key, i]));
  const rank = (p) => (p.trigger === 'meeting' ? 2.5 : p.trigger === 'estimate_expiry' ? 5.5 : p.trigger === 'invoice_due' ? 6.5
    : p.trigger === 'home_care' ? order.complete + 0.3 : p.trigger === 'warranty_end' ? order.complete + 0.6 : order[p.stage] + (p.key === 'review_request' ? 0.1 : 0));
  return rows.sort((a, b) => rank(a) - rank(b)).map(p => ({
    id: p.id, key: p.key, name: p.name, trigger: p.trigger || 'stage', stage: p.stage,
    stageLabel: p.trigger && p.trigger !== 'stage' ? TRIGGER_LABELS[p.trigger] : crm.stageLabel(p.stage),
    when: (TRIGGERS[p.trigger] || TRIGGERS.stage).when, tokens: (TRIGGERS[p.trigger] || TRIGGERS.stage).tokens, steps: p.steps,
    enabled: p.enabled, approved: isApproved(p), approvedAt: p.approved_at, waiting: p.waiting, sent: p.sent
  }));
}

async function getPlaybook(tenantId, id) {
  return (await query('SELECT * FROM crm_playbooks WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0] || null;
}

function notFound() { const e = new Error('Playbook not found.'); e.status = 404; return e; }

async function cancelForPlaybook(playbookId, reason) {
  return (await query(`UPDATE crm_playbook_sends SET status = 'cancelled', cancel_reason = $2 WHERE playbook_id = $1 AND status = 'pending'`, [playbookId, reason])).rowCount;
}

// New wording withdraws the approval: nothing goes out until the owner approves the new text.
async function savePlaybook({ tenantId, id, name, steps }) {
  const pb = await getPlaybook(tenantId, id);
  if (!pb) throw notFound();
  const err = validateSteps(steps, pb.trigger);
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  const clean = normalizeSteps(steps);
  const nm = String(name == null ? pb.name : name).trim().slice(0, 80) || pb.name;
  const changed = playbookHash(pb.stage, clean, pb.trigger) !== playbookHash(pb.stage, pb.steps, pb.trigger);
  await query(
    `UPDATE crm_playbooks SET name = $3, steps = $4, updated_at = now(),
       enabled = CASE WHEN $5 THEN false ELSE enabled END,
       approved_hash = CASE WHEN $5 THEN NULL ELSE approved_hash END,
       approved_at = CASE WHEN $5 THEN NULL ELSE approved_at END
     WHERE id = $1 AND tenant_id = $2`, [id, tenantId, nm, JSON.stringify(clean), changed]);
  if (changed) await cancelForPlaybook(id, 'edited');
  return { changed };
}

async function approvePlaybook({ tenantId, id }) {
  const pb = await getPlaybook(tenantId, id);
  if (!pb) throw notFound();
  const err = validateSteps(pb.steps, pb.trigger);
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  await query(`UPDATE crm_playbooks SET approved_hash = $3, approved_at = now(), enabled = true, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId, playbookHash(pb.stage, pb.steps, pb.trigger)]);
}

async function setEnabled({ tenantId, id, enabled }) {
  const pb = await getPlaybook(tenantId, id);
  if (!pb) throw notFound();
  if (enabled && !isApproved(pb)) { const e = new Error('Approve the wording first.'); e.status = 400; throw e; }
  await query('UPDATE crm_playbooks SET enabled = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2', [id, tenantId, !!enabled]);
  if (!enabled) await cancelForPlaybook(id, 'switched_off');
}

async function resetPlaybook({ tenantId, id }) {
  const pb = await getPlaybook(tenantId, id);
  if (!pb) throw notFound();
  const def = DEFAULT_PLAYBOOKS.find(d => d.key === pb.key);
  if (!def) { const e = new Error('This playbook has no original wording to go back to.'); e.status = 400; throw e; }
  return savePlaybook({ tenantId, id, name: def.name, steps: def.steps });
}

// ---------- scheduling ----------

// Whether a deal's contact can get automatic emails and/or texts.
async function reachable(deal) {
  const contact = (await query('SELECT email, phone, sms_consent, sms_opt_out FROM crm_contacts WHERE id = $1', [deal.contact_id])).rows[0];
  if (!contact) return { ok: false, reason: 'no_contact' };
  let email = isEmail(contact.email);
  if (email && (await query('SELECT 1 FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)', [deal.tenant_id, contact.email.trim()])).rows.length) email = false;
  const sms = !!(contact.sms_consent && !contact.sms_opt_out && require('./crmSms').e164(contact.phone));
  return email || sms ? { ok: true, email, sms } : { ok: false, reason: 'no_email' };
}

async function queueSteps({ pb, deal, key, base, baseUrl, estimateId = null, homeItemId = null, notBefore = null }) {
  let n = 0;
  const steps = normalizeSteps(pb.steps);
  for (let i = 0; i < steps.length; i++) {
    const due = new Date(new Date(base).getTime() + steps[i].days * 86400000);
    if (notBefore && due < notBefore) continue; // too late for this reminder already
    const r = await query(
      `INSERT INTO crm_playbook_sends (id, tenant_id, playbook_id, deal_id, step, entry_key, due_at, base_url, estimate_id, home_item_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (playbook_id, deal_id, step, entry_key) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), deal.tenant_id, pb.id, deal.id, i + 1, key, due, baseUrl || '', estimateId, homeItemId]);
    if (r.rows.length) n++;
  }
  return n;
}

async function approvedFor(tenantId, trigger, stage = null) {
  await ensurePlaybooks(tenantId);
  return (await query(
    `SELECT * FROM crm_playbooks WHERE tenant_id = $1 AND enabled = true AND COALESCE(trigger, 'stage') = $2 AND ($3::text IS NULL OR stage = $3)`,
    [tenantId, trigger, stage])).rows.filter(isApproved);
}

// A deal just entered `deal.stage`: queue that stage's approved, switched-on playbooks.
async function scheduleForDeal(deal, baseUrl = '') {
  if (!deal) return { scheduled: 0 };
  const can = await reachable(deal);
  if (!can.ok) return { scheduled: 0, reason: can.reason };
  // A landing-page lead already gets Eagle I marketing's own new-lead emails when
  // those are switched on; don't send two welcomes.
  // "Thanks for reaching out" only fits people who reached out: not a deal the
  // team typed in after already talking to them.
  if (deal.stage === 'new' && deal.first_response_at) return { scheduled: 0, reason: 'added_by_team' };
  if (deal.stage === 'new' && deal.lead_id) {
    const ls = (await query('SELECT lead_sequence FROM business_profile WHERE tenant_id = $1', [deal.tenant_id])).rows[0];
    if (ls && ls.lead_sequence && ls.lead_sequence.enabled) return { scheduled: 0, reason: 'lead_sequence' };
  }
  let n = 0;
  for (const pb of await approvedFor(deal.tenant_id, 'stage', deal.stage)) {
    n += await queueSteps({ pb, deal, key: entryKey(deal.stage_entered_at), base: deal.stage_entered_at, baseUrl });
  }
  return { scheduled: n };
}

// A deal's site visit was set or moved: replace its reminders.
async function scheduleMeeting(deal, baseUrl = '', now = new Date()) {
  await query(
    `UPDATE crm_playbook_sends s SET status = 'cancelled', cancel_reason = 'rescheduled' FROM crm_playbooks p
     WHERE p.id = s.playbook_id AND p.trigger = 'meeting' AND s.deal_id = $1 AND s.status = 'pending'`, [deal.id]);
  if (!deal.site_visit_at || new Date(deal.site_visit_at) <= now || ['lost', 'complete'].includes(deal.stage)) return { scheduled: 0 };
  const can = await reachable(deal);
  if (!can.ok) return { scheduled: 0, reason: can.reason };
  let n = 0;
  for (const pb of await approvedFor(deal.tenant_id, 'meeting')) {
    n += await queueSteps({ pb, deal, key: meetingKey(deal.site_visit_at), base: deal.site_visit_at, baseUrl, notBefore: now });
  }
  return { scheduled: n };
}

// A home-file item is due for care, or its warranty is ending (lib/crmLifetime.js
// finds them): queue that playbook's emails from 9am Central on the date.
const homeKey = (item, kind, ymd) => (kind === 'home_care' ? 'c' : 'w') + String(item.id).slice(0, 8) + String(ymd).replace(/-/g, '');
function dayAt9(ymd) {
  const d = String(ymd instanceof Date ? ymd.toISOString() : ymd).slice(0, 10).split('-').map(Number);
  return require('./outreachQueue').zonedToUtc(d[0], d[1], d[2], 9, 0);
}
async function scheduleHomeItem({ item, kind, date, baseUrl = '', now = new Date() }) {
  const deal = (await query('SELECT * FROM crm_deals WHERE id = $1', [item.deal_id])).rows[0];
  if (!deal || deal.stage === 'lost') return { scheduled: 0 };
  const can = await reachable(deal);
  if (!can.ok) return { scheduled: 0, reason: can.reason };
  let n = 0;
  for (const pb of await approvedFor(deal.tenant_id, kind)) {
    // Late is fine for care (the tick may have been down); never more than a week late.
    n += await queueSteps({ pb, deal, key: homeKey(item, kind, date), base: dayAt9(date), baseUrl, homeItemId: item.id, notBefore: new Date(now.getTime() - 7 * 86400000) });
  }
  return { scheduled: n };
}

// An estimate was sent (or resent): queue its "about to expire" reminder.
async function scheduleEstimateExpiry(estimate, baseUrl = '', now = new Date()) {
  await cancelForEstimate(estimate.id, 'estimate_changed');
  if (estimate.status !== 'sent' || !estimate.valid_until) return { scheduled: 0 };
  const deal = (await query('SELECT * FROM crm_deals WHERE id = $1', [estimate.deal_id])).rows[0];
  if (!deal) return { scheduled: 0 };
  const can = await reachable(deal);
  if (!can.ok) return { scheduled: 0, reason: can.reason };
  let n = 0;
  for (const pb of await approvedFor(deal.tenant_id, 'estimate_expiry')) {
    n += await queueSteps({ pb, deal, key: estimateKey(estimate), base: estimateExpiresAt(estimate.valid_until), baseUrl, estimateId: estimate.id, notBefore: now });
  }
  return { scheduled: n };
}

const invoiceKey = (inv) => 'v' + String(inv.id).slice(0, 8) + String(inv.due_date instanceof Date ? inv.due_date.toISOString() : inv.due_date).slice(0, 10).replace(/-/g, '');
// An invoice's due moment: 9am Central on its due date.
function invoiceDueAt(dueDate) {
  const d = String(dueDate instanceof Date ? dueDate.toISOString() : dueDate).slice(0, 10).split('-').map(Number);
  return require('./outreachQueue').zonedToUtc(d[0], d[1], d[2], 9, 0);
}

// An invoice was sent: replace its queued reminders.
async function scheduleInvoiceReminders(inv, baseUrl = '', now = new Date()) {
  await cancelForInvoice(inv.id, 'invoice_changed');
  if (inv.status !== 'sent' || !inv.due_date) return { scheduled: 0 };
  const deal = (await query('SELECT * FROM crm_deals WHERE id = $1', [inv.deal_id])).rows[0];
  if (!deal) return { scheduled: 0 };
  const can = await reachable(deal);
  if (!can.ok) return { scheduled: 0, reason: can.reason };
  let n = 0;
  for (const pb of await approvedFor(deal.tenant_id, 'invoice_due')) {
    const steps = normalizeSteps(pb.steps);
    for (let i = 0; i < steps.length; i++) {
      const due = new Date(invoiceDueAt(inv.due_date).getTime() + steps[i].days * 86400000);
      if (due < now) continue;
      const r = await query(
        `INSERT INTO crm_playbook_sends (id, tenant_id, playbook_id, deal_id, step, entry_key, due_at, base_url, invoice_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (playbook_id, deal_id, step, entry_key) DO NOTHING RETURNING id`,
        [crypto.randomUUID(), deal.tenant_id, pb.id, deal.id, i + 1, invoiceKey(inv), due, baseUrl || '', inv.id]);
      if (r.rows.length) n++;
    }
  }
  return { scheduled: n };
}

async function cancelForInvoice(invoiceId, reason) {
  return (await query(`UPDATE crm_playbook_sends SET status = 'cancelled', cancel_reason = $2 WHERE invoice_id = $1 AND status = 'pending'`, [invoiceId, reason])).rowCount;
}

async function cancelForEstimate(estimateId, reason) {
  return (await query(`UPDATE crm_playbook_sends SET status = 'cancelled', cancel_reason = $2 WHERE estimate_id = $1 AND status = 'pending'`, [estimateId, reason])).rowCount;
}

// `trigger`: only cancel that kind (for example only the stage follow-ups when
// a deal moves on, so its site-visit reminder still goes out).
async function cancelForDeal(dealId, reason, { trigger = null } = {}) {
  return (await query(
    `UPDATE crm_playbook_sends s SET status = 'cancelled', cancel_reason = $2 FROM crm_playbooks p
     WHERE p.id = s.playbook_id AND s.deal_id = $1 AND s.status = 'pending' AND ($3::text IS NULL OR COALESCE(p.trigger, 'stage') = $3)`,
    [dealId, reason, trigger])).rowCount;
}

// Someone texted STOP: nothing automatic goes to them any more, by text or email.
async function cancelForPhone(tenantId, digits, reason) {
  if (!digits) return 0;
  return (await query(
    `UPDATE crm_playbook_sends SET status = 'cancelled', cancel_reason = $3
     WHERE tenant_id = $1 AND status = 'pending'
       AND deal_id IN (SELECT d.id FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE d.tenant_id = $1 AND c.phone_digits = $2)`,
    [tenantId, digits, reason])).rowCount;
}

async function cancelForEmail(tenantId, email, reason) {
  return (await query(
    `UPDATE crm_playbook_sends SET status = 'cancelled', cancel_reason = $3
     WHERE tenant_id = $1 AND status = 'pending'
       AND deal_id IN (SELECT d.id FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE d.tenant_id = $1 AND LOWER(c.email) = LOWER($2))`,
    [tenantId, email, reason])).rowCount;
}

// The homeowner's links (portal, questionnaire, booking), all on the deal's
// private portal token, made on first use.
async function linkExtras(step, extra, row, deal) {
  const text = `${step.subject || ''} ${step.message}`;
  const base = row.base_url || '';
  if (/\{(portal|qualify|booking)_link\}/.test(text)) {
    const token = await require('./crmPortal').portalToken(row.tenant_id, deal.id);
    Object.assign(extra, { portal_link: `${base}/p/${token}`, qualify_link: `${base}/q/${token}`, booking_link: `${base}/b/${token}` });
  }
  const life = require('./crmLifetime');
  if (/\{referral_link\}/.test(text) && deal.contact_id) extra.referral_link = `${base}/r/${await life.contactCode(row.tenant_id, deal.contact_id)}`;
  if (/\{review_link\}/.test(text)) extra.review_link = (await life.lifetimeSettings(row.tenant_id)).reviewUrl || '';
  return extra;
}

async function sentToday(tenantId) {
  return (await query("SELECT COUNT(*)::int AS n FROM crm_playbook_sends WHERE tenant_id = $1 AND status = 'sent' AND sent_at > now() - interval '24 hours'", [tenantId])).rows[0].n;
}

// Sends what is due. `onlyDealId` lets a same-day email go out right away
// (for example the welcome email the moment a contract is marked signed).
async function processDueSends({ now = new Date(), send = sendEmail, limit = 40, onlyDealId = null } = {}) {
  const summary = { claimed: 0, sent: 0, cancelled: 0, deferred: 0, failed: 0 };
  const inWindow = followUps.inSendWindow(now);
  // Same-day stage emails go out at once (the owner just did something); later
  // follow-ups wait for business hours; reminders go out during the day, any day.
  const claimed = (await query(
    `UPDATE crm_playbook_sends SET status = 'sending'
     WHERE id IN (SELECT s.id FROM crm_playbook_sends s JOIN crm_playbooks p ON p.id = s.playbook_id
                  WHERE s.status = 'pending' AND s.due_at <= $1 AND ($3::uuid IS NULL OR s.deal_id = $3::uuid)
                    AND ((COALESCE(p.trigger, 'stage') = 'stage' AND ($4::boolean OR COALESCE((p.steps -> (s.step - 1) ->> 'days')::int, 1) = 0))
                         OR (COALESCE(p.trigger, 'stage') <> 'stage' AND $5::boolean))
                  ORDER BY s.due_at ASC LIMIT $2 FOR UPDATE OF s SKIP LOCKED)
     RETURNING *`, [now, limit, onlyDealId, inWindow, inDaytime(now)])).rows;
  summary.claimed = claimed.length;
  const finish = (id, status, extra = {}) => query(
    `UPDATE crm_playbook_sends SET status = $2::varchar, cancel_reason = $3, error = $4, to_email = COALESCE($5, to_email), subject = COALESCE($6, subject),
       resend_email_id = COALESCE($7, resend_email_id), sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE sent_at END WHERE id = $1`,
    [id, status, extra.reason || null, extra.error || null, extra.to || null, extra.subject || null, extra.resendId || null]);
  const cancel = async (row, reason) => { await finish(row.id, 'cancelled', { reason }); summary.cancelled++; };
  const defer = async (row) => { await query("UPDATE crm_playbook_sends SET status = 'pending' WHERE id = $1", [row.id]); summary.deferred++; };
  const cache = new Map();

  for (const row of claimed) {
    try {
      let c = cache.get(row.tenant_id);
      if (!c) {
        const ctx = await outreach.getSenderContext(row.tenant_id);
        c = { ctx, settings: await crm.getSettings(row.tenant_id) };
        cache.set(row.tenant_id, c);
      }
      if (!c.ctx) { await cancel(row, 'no_company'); continue; }
      if (c.settings.paused) { await defer(row); continue; } // paused, not cancelled: resumes when switched back on
      const pb = (await query('SELECT * FROM crm_playbooks WHERE id = $1', [row.playbook_id])).rows[0];
      if (!pb || !pb.enabled) { await cancel(row, 'switched_off'); continue; }
      if (!isApproved(pb)) { await cancel(row, 'not_approved'); continue; }
      const deal = (await query(
        `SELECT d.*, c.name AS contact_name, c.email AS contact_email FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE d.id = $1`, [row.deal_id])).rows[0];
      if (!deal) { await cancel(row, 'deal_deleted'); continue; }
      // Does this email still fit? Each trigger has its own test.
      const trigger = pb.trigger || 'stage';
      const extra = {};
      if (trigger === 'stage') {
        // Same visit to the same stage? If the deal moved on (or left and came back), it no longer fits.
        if (deal.stage !== pb.stage || entryKey(deal.stage_entered_at) !== row.entry_key) { await cancel(row, 'stage_changed'); continue; }
      } else if (trigger === 'meeting') {
        if (!deal.site_visit_at || meetingKey(deal.site_visit_at) !== row.entry_key) { await cancel(row, 'rescheduled'); continue; }
        if (new Date(deal.site_visit_at) <= now) { await cancel(row, 'too_late'); continue; }
        const prop = (await query('SELECT address FROM crm_properties WHERE id = $1', [deal.property_id])).rows[0];
        Object.assign(extra, { visit_date: fmtDate(deal.site_visit_at), visit_time: fmtTime(deal.site_visit_at), address: (prop && prop.address) || '' });
      } else if (trigger === 'invoice_due') {
        const inv = row.invoice_id && (await query('SELECT * FROM crm_invoices WHERE id = $1', [row.invoice_id])).rows[0];
        if (!inv || inv.status !== 'sent' || invoiceKey(inv) !== row.entry_key) { await cancel(row, 'invoice_changed'); continue; }
        Object.assign(extra, {
          invoice_link: `${row.base_url || ''}/i/${inv.public_token}`, invoice_number: String(inv.number),
          invoice_amount: '$' + Number(inv.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          due_date: fmtDate(invoiceDueAt(inv.due_date))
        });
      } else if (trigger === 'home_care' || trigger === 'warranty_end') {
        const item = row.home_item_id && (await query('SELECT * FROM crm_home_items WHERE id = $1', [row.home_item_id])).rows[0];
        if (!item) { await cancel(row, 'item_removed'); continue; }
        if (deal.stage === 'lost') { await cancel(row, 'deal_closed'); continue; }
        if (trigger === 'warranty_end' && (!item.warranty_until || homeKey(item, 'warranty_end', String(item.warranty_until instanceof Date ? item.warranty_until.toISOString() : item.warranty_until).slice(0, 10)) !== row.entry_key)) { await cancel(row, 'warranty_changed'); continue; }
        Object.assign(extra, { item: item.name.toLowerCase().startsWith('workmanship') ? item.name.toLowerCase() : item.name, care_note: item.care_note || '' });
        if (item.warranty_until) extra.warranty_end = fmtDate(dayAt9(item.warranty_until));
      } else if (trigger === 'estimate_expiry') {
        const est = row.estimate_id && (await query('SELECT * FROM crm_estimates WHERE id = $1', [row.estimate_id])).rows[0];
        if (!est || est.status !== 'sent' || estimateKey(est) !== row.entry_key) { await cancel(row, 'estimate_changed'); continue; }
        if (estimateExpiresAt(est.valid_until) <= now) { await cancel(row, 'too_late'); continue; }
        Object.assign(extra, {
          estimate_link: `${row.base_url || ''}/e/${est.public_token}`,
          estimate_total: '$' + Number(est.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          expires: fmtDate(estimateExpiresAt(est.valid_until))
        });
      }
      const stepDef = normalizeSteps(pb.steps)[row.step - 1];
      // A review request with no review page set up would send an empty link.
      if (stepDef && /\{review_link\}/.test(`${stepDef.subject || ''} ${stepDef.message}`) && !(await require('./crmLifetime').lifetimeSettings(row.tenant_id)).reviewUrl) { await cancel(row, 'no_review_link'); continue; }
      if (stepDef && stepDef.channel === 'sms') {
        // A text: same "does it still fit" checks above, then the texting rules in lib/crmSms.js.
        if ((await sentToday(row.tenant_id)) >= MAX_PER_DAY) { await defer(row); continue; }
        const { message } = renderStep({ subject: 'x', message: stepDef.message }, { ctx: c.ctx, contactName: deal.contact_name, extra: await linkExtras(stepDef, extra, row, deal) });
        try {
          await require('./crmSms').sendSms({ tenantId: row.tenant_id, contactId: deal.contact_id, dealId: deal.id, body: message, automated: true });
          await finish(row.id, 'sent', { to: 'sms', subject: message.slice(0, 120) });
          summary.sent++;
        } catch (e) {
          if (e.status === 400 || e.status === 503) { await cancel(row, /STOP/.test(e.message) ? 'opted_out' : /agreed/.test(e.message) ? 'no_consent' : 'cannot_text'); }
          else throw e;
        }
        continue;
      }
      if (!isEmail(deal.contact_email)) { await cancel(row, 'no_email'); continue; }
      const to = deal.contact_email.trim();
      const sup = await query('SELECT 1 FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)', [row.tenant_id, to]);
      if (sup.rows.length) { await cancel(row, 'opted_out'); continue; }
      if ((c.ctx.profile.address || '').trim().length < 8) { await cancel(row, 'no_address'); continue; }
      if ((await sentToday(row.tenant_id)) >= MAX_PER_DAY) { await defer(row); continue; }

      const step = normalizeSteps(pb.steps)[row.step - 1];
      if (!step) { await cancel(row, 'no_such_step'); continue; }
      await linkExtras(step, extra, row, deal);
      const { subject, message } = renderStep(step, { ctx: c.ctx, contactName: deal.contact_name, extra });
      const unsubscribeUrl = outreach.buildUnsubscribeUrl(row.base_url || '', row.tenant_id, to);
      const { html, text } = outreach.composeEmail({ message, companyName: c.ctx.companyName, profile: c.ctx.profile, unsubscribeUrl });
      const replyTo = buildReplyToAddress('crm', row.id) || (isEmail(c.ctx.profile.email) ? c.ctx.profile.email : undefined);
      const sent = await send({
        to, subject, html, text, replyTo, fromName: c.ctx.companyName, fromAddress: c.ctx.fromAddress,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      });
      await finish(row.id, 'sent', { to, subject, resendId: sent && sent.id });
      await crm.logActivity({ tenantId: row.tenant_id, dealId: deal.id, kind: 'email', actor: 'eagle_i', body: subject, meta: { playbook: pb.name, step: row.step, to } });
      summary.sent++;
    } catch (err) {
      await finish(row.id, 'failed', { error: err.message }).catch(() => {});
      summary.failed++;
      console.error('[crmPlaybooks] send failed:', err.message);
      // A failed send is never silent: the owner sees it and can follow up by hand.
      await crm.addInboxItem({
        tenantId: row.tenant_id, dealId: row.deal_id, kind: 'send_failed', dedupeKey: `send_failed:${row.id}`,
        title: 'An automatic email could not be sent', detail: String(err.message || '').slice(0, 300)
      }).catch(() => {});
      await crm.logActivity({ tenantId: row.tenant_id, dealId: row.deal_id, kind: 'system', actor: 'eagle_i', body: `An automatic email could not be sent: ${String(err.message || '').slice(0, 200)}` }).catch(() => {});
    }
  }
  return summary;
}

// A person answered one of the automatic emails (routes/inboundEmail.js).
// Everything still waiting for that deal stops, the reply goes on the deal's
// timeline, and it lands in "Needs you" — flagged if it reads as a "no".
async function recordReply({ sendId, text, html, category }) {
  const row = (await query(
    `SELECT s.*, d.title, c.name AS contact_name, c.email AS contact_email FROM crm_playbook_sends s
     JOIN crm_deals d ON d.id = s.deal_id JOIN crm_contacts c ON c.id = d.contact_id WHERE s.id = $1`, [sendId])).rows[0];
  if (!row) return null;
  if (category === 'auto_reply') return { tenantId: row.tenant_id, autoReply: true, row };
  await cancelForDeal(row.deal_id, 'replied', { trigger: 'stage' });
  const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600) || '(no text)';
  await crm.logActivity({ tenantId: row.tenant_id, dealId: row.deal_id, kind: 'reply', actor: 'contact', body: snippet, meta: { category, subject: row.subject } });
  const negative = category === 'not_now' || category === 'unsubscribe';
  await crm.addInboxItem({
    tenantId: row.tenant_id, dealId: row.deal_id, kind: negative ? 'negative_reply' : 'reply', dedupeKey: `reply:${sendId}`,
    title: negative ? `${row.contact_name} replied with a “no” or “not now”` : `${row.contact_name} replied`,
    detail: snippet
  });
  return { tenantId: row.tenant_id, row, negative };
}

// A bounce or spam complaint on one of these emails (lib/deliveryEvents.js).
async function processDeliveryEvent(event, isHardBounce) {
  const data = event.data || {};
  const row = (await query('SELECT id, tenant_id, to_email FROM crm_playbook_sends WHERE resend_email_id = $1', [data.email_id])).rows[0];
  if (!row) return { handled: false, reason: 'not a known email' };
  const complained = event.type === 'email.complained';
  const hard = !complained && isHardBounce(data.bounce);
  const status = complained ? 'complained' : hard ? 'bounced' : 'soft_bounce';
  await query('UPDATE crm_playbook_sends SET delivery_status = $1 WHERE id = $2', [status, row.id]);
  if ((complained || hard) && row.to_email) {
    await query(
      `INSERT INTO outreach_suppressions (tenant_id, email, reason) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, lower(email)) DO NOTHING`, [row.tenant_id, row.to_email, status]);
    await cancelForEmail(row.tenant_id, row.to_email, status);
    await require('./leadSequence').cancelForEmail(row.tenant_id, row.to_email, status);
  }
  return { handled: true, status, tenantId: row.tenant_id, email: row.to_email };
}

// A preview goes ONLY to the owner's own address, with a sample name.
async function sendPreview({ tenantId, id, step = 1, baseUrl = '', send = sendEmail }) {
  const pb = await getPlaybook(tenantId, id);
  if (!pb) throw notFound();
  const ctx = await outreach.getSenderContext(tenantId);
  if (!ctx) throw notFound();
  const owner = (await query('SELECT email FROM users WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1', [tenantId])).rows[0];
  const to = [ctx.profile.email, owner && owner.email].find(isEmail);
  if (!to) { const e = new Error('Add an email address to your Company Profile first.'); e.status = 400; throw e; }
  if ((ctx.profile.address || '').trim().length < 8) { const e = new Error('Add your business address to your Company Profile first; it goes in the footer.'); e.status = 400; throw e; }
  const steps = normalizeSteps(pb.steps);
  const sampleAt = new Date(Date.now() + 2 * 86400000);
  const extra = { visit_date: fmtDate(sampleAt), visit_time: '10:00 AM', address: '123 Sample St, Houston TX', estimate_link: `${baseUrl}/e/sample`, estimate_total: '$48,500.00', expires: fmtDate(sampleAt), portal_link: `${baseUrl}/p/sample`, qualify_link: `${baseUrl}/q/sample`, booking_link: `${baseUrl}/b/sample`, invoice_link: `${baseUrl}/i/sample`, invoice_amount: '$4,850.00', invoice_number: '2001', due_date: fmtDate(sampleAt), review_link: 'https://g.page/r/your-review-page', referral_link: `${baseUrl}/r/sample`, item: 'quartz countertops', care_note: 'Reseal the grout lines once a year.', warranty_end: fmtDate(sampleAt) };
  const { subject, message } = renderStep(steps[step - 1] || steps[0], { ctx, contactName: 'Alex Sample', extra });
  const unsubscribeUrl = outreach.buildUnsubscribeUrl(baseUrl, tenantId, to);
  const { html, text } = outreach.composeEmail({ message, companyName: ctx.companyName, profile: ctx.profile, unsubscribeUrl });
  await send({ to: to.trim(), subject: `[Preview] ${subject}`, html, text, fromName: ctx.companyName, fromAddress: ctx.fromAddress });
  return { to: to.trim() };
}

module.exports = {
  MAX_STEPS, MAX_DAYS, MAX_PER_DAY, DEFAULT_PLAYBOOKS, normalizeSteps, playbookHash, isApproved, validateSteps, renderStep, entryKey,
  ensurePlaybooks, listPlaybooks, savePlaybook, approvePlaybook, setEnabled, resetPlaybook,
  TRIGGERS, inDaytime, estimateExpiresAt, meetingKey, estimateKey,
  scheduleForDeal, scheduleMeeting, scheduleEstimateExpiry, cancelForEstimate, scheduleInvoiceReminders, cancelForInvoice, invoiceDueAt, cancelForPhone, cancelForDeal, cancelForEmail, processDueSends, recordReply, processDeliveryEvent, sendPreview, linkExtras, scheduleHomeItem, homeKey
};
