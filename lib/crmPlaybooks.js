// Playbooks: automatic emails tied to a pipeline stage. When a deal enters a
// stage, the playbook for that stage schedules its emails (for example, a
// proposal follow-up 3, 7 and 14 days later).
//
// "Approve once, run forever": every playbook starts switched off. The owner
// reads the exact wording and approves it; from then on it runs by itself for
// every deal that enters the stage. Changing the wording withdraws the
// approval (and switches it off) until the new wording is approved, and every
// send re-checks that the wording it is about to use is the approved wording.
//
// What keeps it from doing something the owner wouldn't want:
//  - emails for a stage stop the moment the deal leaves that stage;
//  - a reply from the person stops everything still waiting for that deal;
//  - unsubscribed, bounced and spam-reporting addresses are never emailed;
//  - every email carries the company's address and an unsubscribe link;
//  - anything after the first day only goes out weekdays 9am-5pm Central;
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
const ALLOWED_TOKENS = new Set(['name', 'company', 'phone', 'email', 'founder']);

const DEFAULT_PLAYBOOKS = [
  {
    key: 'site_visit_prep', name: 'Getting ready for the site visit', stage: 'site_visit',
    steps: [{
      days: 0, subject: 'Getting ready for our visit',
      message: 'Hi {name},\n\nThanks for setting up a visit with {company}. To make the most of our time together, it helps to have:\n\n- A few photos or links of styles you like\n- A rough budget range you are comfortable with\n- Everyone who will be part of the decision there, if possible\n\nIf anything changes, reply here or call {phone}.'
    }]
  },
  {
    key: 'design_agreement_follow_up', name: 'Design agreement follow-up', stage: 'design_agreement',
    steps: [
      { days: 3, subject: 'Any questions about the design agreement?', message: 'Hi {name},\n\nI wanted to check whether you had a chance to look over the design agreement from {company}, and whether any questions came up.\n\nHappy to walk through it on a quick call. Just reply here or call {phone}.' },
      { days: 7, subject: 'Next step on your project', message: 'Hi {name},\n\nWhenever you are ready to move ahead, signing the design agreement lets us start on drawings and pricing for your project.\n\nIf the timing or anything else has changed, just let me know. No pressure at all.' }
    ]
  },
  {
    key: 'proposal_follow_up', name: 'Proposal follow-up', stage: 'proposal',
    steps: [
      { days: 3, subject: 'Your proposal from {company}', message: 'Hi {name},\n\nI wanted to make sure the proposal came through and see if any questions came up as you looked it over.\n\nReply here or call {phone} and we can go through it together.' },
      { days: 7, subject: 'Checking in on your proposal', message: 'Hi {name},\n\nJust checking in on the proposal. If anything in the scope or the numbers needs another look, we are glad to adjust it.\n\nWhat would be most helpful for your decision?' },
      { days: 14, subject: 'Still planning your project?', message: 'Hi {name},\n\nI do not want to crowd your inbox, so this is my last note on the proposal for now. If your plans have changed, no problem at all. If you are still thinking it over, we are here whenever you are ready.' }
    ]
  },
  {
    key: 'welcome_aboard', name: 'Welcome aboard', stage: 'signed',
    steps: [{
      days: 0, subject: 'Welcome to {company}',
      message: 'Hi {name},\n\nThank you for choosing {company}. We are excited to get started on your project.\n\nOver the next few days we will reach out to set up a kickoff meeting, where we go over the schedule, who your main contact will be, and what to expect each week.\n\nAny questions in the meantime, reply here or call {phone}.'
    }]
  },
  {
    key: 'job_complete', name: 'Job complete: thank-you and check-in', stage: 'complete',
    steps: [
      { days: 3, subject: 'Thank you from {company}', message: 'Hi {name},\n\nThank you again for trusting {company} with your home. It was a pleasure working with you.\n\nIf anything at all needs attention as you settle in, reply here or call {phone} and we will take care of it.' },
      { days: 30, subject: 'How is everything holding up?', message: 'Hi {name},\n\nIt has been about a month since we finished, so I wanted to check in. How is everything holding up?\n\nIf a friend or neighbor is thinking about a project, we would be grateful for the introduction.' }
    ]
  },
  {
    key: 'lost_check_back', name: 'Check back on a lost deal', stage: 'lost',
    steps: [{
      days: 180, subject: 'Still thinking about your project?',
      message: 'Hi {name},\n\nIt has been a while since we talked about your project, and I wanted to check in. If it is back on your mind, {company} would be glad to help.\n\nIf not, no reply needed. Wishing you all the best.'
    }]
  }
];

// ---------- pure helpers ----------

function normalizeSteps(steps) {
  return (Array.isArray(steps) ? steps : []).slice(0, MAX_STEPS).map(s => ({
    days: parseInt(s && s.days, 10), subject: outreach.cleanSubject(s && s.subject), message: String((s && s.message) || '').trim()
  }));
}

// The fingerprint of exactly what the owner approved: the stage and every word of every email.
function playbookHash(stage, steps) {
  return crypto.createHash('sha256').update(JSON.stringify({ stage, steps: normalizeSteps(steps) })).digest('hex');
}

const isApproved = (pb) => !!pb.approved_hash && pb.approved_hash === playbookHash(pb.stage, pb.steps);

// Returns an error message, or null when the steps are safe to save.
function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) return `A playbook has 1 to ${MAX_STEPS} emails.`;
  let last = -1;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] || {};
    const label = `Email ${i + 1}`;
    const days = parseInt(st.days, 10);
    if (!(days >= 0 && days <= MAX_DAYS)) return `${label} must be sent 0 to ${MAX_DAYS} days after the deal enters the stage.`;
    if (days <= last) return `${label} has to come after the previous email.`;
    last = days;
    const subject = outreach.cleanSubject(st.subject);
    const message = String(st.message || '').trim();
    if (!subject) return `${label} needs a subject.`;
    if (!message || message.length > MAX_MESSAGE) return `${label} needs a message of up to ${MAX_MESSAGE} characters.`;
    for (const text of [subject, message]) {
      for (const m of text.matchAll(/\{([a-z_]+)\}/g)) {
        if (!ALLOWED_TOKENS.has(m[1])) return `${label} uses {${m[1]}}, which is not available. You can use {name}, {company}, {phone}, {email} and {founder}.`;
      }
    }
  }
  return null;
}

function renderStep(step, { ctx, contactName }) {
  const vars = { company: ctx.companyName, phone: ctx.profile.phone || '', email: ctx.profile.email || '', founder: ctx.profile.founder_name || '' };
  const fill = (t) => tpl.fillName(tpl.renderTemplate(t, vars), leadFirstName(contactName));
  return { subject: outreach.cleanSubject(fill(step.subject)) || `A note from ${ctx.companyName}`, message: fill(step.message) };
}

const entryKey = (stageEnteredAt) => String(new Date(stageEnteredAt).getTime());
const isEmail = (e) => outreach.EMAIL_RE.test(String(e || '').trim());

// ---------- playbook records ----------

async function ensurePlaybooks(tenantId) {
  for (const pb of DEFAULT_PLAYBOOKS) {
    await query(
      `INSERT INTO crm_playbooks (tenant_id, key, name, stage, steps) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, key) DO NOTHING`, [tenantId, pb.key, pb.name, pb.stage, JSON.stringify(pb.steps)]);
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
  return rows.sort((a, b) => order[a.stage] - order[b.stage]).map(p => ({
    id: p.id, key: p.key, name: p.name, stage: p.stage, stageLabel: crm.stageLabel(p.stage), steps: p.steps,
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
  const err = validateSteps(steps);
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  const clean = normalizeSteps(steps);
  const nm = String(name == null ? pb.name : name).trim().slice(0, 80) || pb.name;
  const changed = playbookHash(pb.stage, clean) !== playbookHash(pb.stage, pb.steps);
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
  const err = validateSteps(pb.steps);
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  await query(`UPDATE crm_playbooks SET approved_hash = $3, approved_at = now(), enabled = true, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId, playbookHash(pb.stage, pb.steps)]);
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

// A deal just entered `deal.stage`: queue that stage's approved, switched-on playbooks.
async function scheduleForDeal(deal, baseUrl = '') {
  if (!deal) return { scheduled: 0 };
  const contact = (await query('SELECT email FROM crm_contacts WHERE id = $1', [deal.contact_id])).rows[0];
  if (!contact || !isEmail(contact.email)) return { scheduled: 0, reason: 'no_email' };
  const sup = await query('SELECT 1 FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)', [deal.tenant_id, contact.email.trim()]);
  if (sup.rows.length) return { scheduled: 0, reason: 'opted_out' };
  await ensurePlaybooks(deal.tenant_id);
  const pbs = (await query('SELECT * FROM crm_playbooks WHERE tenant_id = $1 AND stage = $2 AND enabled = true', [deal.tenant_id, deal.stage])).rows.filter(isApproved);
  let n = 0;
  for (const pb of pbs) {
    const steps = normalizeSteps(pb.steps);
    for (let i = 0; i < steps.length; i++) {
      const r = await query(
        `INSERT INTO crm_playbook_sends (id, tenant_id, playbook_id, deal_id, step, entry_key, due_at, base_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz + ($8 || ' days')::interval, $9)
         ON CONFLICT (playbook_id, deal_id, step, entry_key) DO NOTHING RETURNING id`,
        [crypto.randomUUID(), deal.tenant_id, pb.id, deal.id, i + 1, entryKey(deal.stage_entered_at), deal.stage_entered_at, String(steps[i].days), baseUrl || '']);
      if (r.rows.length) n++;
    }
  }
  return { scheduled: n };
}

async function cancelForDeal(dealId, reason) {
  return (await query(`UPDATE crm_playbook_sends SET status = 'cancelled', cancel_reason = $2 WHERE deal_id = $1 AND status = 'pending'`, [dealId, reason])).rowCount;
}

async function cancelForEmail(tenantId, email, reason) {
  return (await query(
    `UPDATE crm_playbook_sends SET status = 'cancelled', cancel_reason = $3
     WHERE tenant_id = $1 AND status = 'pending'
       AND deal_id IN (SELECT d.id FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE d.tenant_id = $1 AND LOWER(c.email) = LOWER($2))`,
    [tenantId, email, reason])).rowCount;
}

async function sentToday(tenantId) {
  return (await query("SELECT COUNT(*)::int AS n FROM crm_playbook_sends WHERE tenant_id = $1 AND status = 'sent' AND sent_at > now() - interval '24 hours'", [tenantId])).rows[0].n;
}

// Sends what is due. `onlyDealId` lets a same-day email go out right away
// (for example the welcome email the moment a contract is marked signed).
async function processDueSends({ now = new Date(), send = sendEmail, limit = 40, onlyDealId = null } = {}) {
  const summary = { claimed: 0, sent: 0, cancelled: 0, deferred: 0, failed: 0 };
  const inWindow = followUps.inSendWindow(now);
  // Same-day emails go out at once (the owner just did something); later ones wait for business hours.
  const claimed = (await query(
    `UPDATE crm_playbook_sends SET status = 'sending'
     WHERE id IN (SELECT s.id FROM crm_playbook_sends s JOIN crm_playbooks p ON p.id = s.playbook_id
                  WHERE s.status = 'pending' AND s.due_at <= $1 AND ($3::uuid IS NULL OR s.deal_id = $3::uuid)
                    AND ($4::boolean OR COALESCE((p.steps -> (s.step - 1) ->> 'days')::int, 1) = 0)
                  ORDER BY s.due_at ASC LIMIT $2 FOR UPDATE OF s SKIP LOCKED)
     RETURNING *`, [now, limit, onlyDealId, inWindow])).rows;
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
      // Still the same visit to the same stage? If the deal moved on (or left and came back), this email no longer fits.
      if (deal.stage !== pb.stage || entryKey(deal.stage_entered_at) !== row.entry_key) { await cancel(row, 'stage_changed'); continue; }
      if (!isEmail(deal.contact_email)) { await cancel(row, 'no_email'); continue; }
      const to = deal.contact_email.trim();
      const sup = await query('SELECT 1 FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)', [row.tenant_id, to]);
      if (sup.rows.length) { await cancel(row, 'opted_out'); continue; }
      if ((c.ctx.profile.address || '').trim().length < 8) { await cancel(row, 'no_address'); continue; }
      if ((await sentToday(row.tenant_id)) >= MAX_PER_DAY) { await defer(row); continue; }

      const step = normalizeSteps(pb.steps)[row.step - 1];
      if (!step) { await cancel(row, 'no_such_step'); continue; }
      const { subject, message } = renderStep(step, { ctx: c.ctx, contactName: deal.contact_name });
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
  await cancelForDeal(row.deal_id, 'replied');
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
  const { subject, message } = renderStep(steps[step - 1] || steps[0], { ctx, contactName: 'Alex Sample' });
  const unsubscribeUrl = outreach.buildUnsubscribeUrl(baseUrl, tenantId, to);
  const { html, text } = outreach.composeEmail({ message, companyName: ctx.companyName, profile: ctx.profile, unsubscribeUrl });
  await send({ to: to.trim(), subject: `[Preview] ${subject}`, html, text, fromName: ctx.companyName, fromAddress: ctx.fromAddress });
  return { to: to.trim() };
}

module.exports = {
  MAX_STEPS, MAX_DAYS, MAX_PER_DAY, DEFAULT_PLAYBOOKS, normalizeSteps, playbookHash, isApproved, validateSteps, renderStep, entryKey,
  ensurePlaybooks, listPlaybooks, savePlaybook, approvePlaybook, setEnabled, resetPlaybook,
  scheduleForDeal, cancelForDeal, cancelForEmail, processDueSends, recordReply, processDeliveryEvent, sendPreview
};
