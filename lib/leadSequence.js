// An optional automatic email sequence for people who fill out a landing-page
// form: a quick acknowledgement, then up to two follow-ups if nobody has picked
// the lead up. It is OFF until the owner switches it on, and the owner sees and
// edits the exact wording first.
//
// What keeps it from being a nuisance or a way to spam someone:
//  - it stops the moment the owner changes the lead's status (contacted, won,
//    lost) or deletes it, and if the sequence is switched off;
//  - anyone who has unsubscribed from this company is never emailed;
//  - every email carries the company's address and an unsubscribe link;
//  - follow-ups only go out on weekdays 9am-5pm Central;
//  - at most MAX_PER_DAY emails a day per company, because the form is public
//    and someone could type another person's address into it.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail, buildReplyToAddress } = require('./email');
const outreach = require('./vendorOutreach');
const followUps = require('./followUps');
const tpl = require('./outreachTemplate');

const MAX_STEPS = 3;
const MAX_PER_DAY = 40;
const MAX_MESSAGE = 1500;
const ALLOWED_TOKENS = new Set(['name', 'company', 'phone', 'email', 'founder']);

function defaultSteps() {
  return [
    {
      days: 0, subject: 'Thanks for contacting {company}',
      message: 'Hi {name},\n\nThanks for reaching out to {company}. We received your message and someone will be in touch soon, usually within one business day.\n\nIf it is urgent, call us at {phone}.'
    },
    {
      days: 2, subject: 'Following up on your inquiry with {company}',
      message: 'Hi {name},\n\nI wanted to follow up on your inquiry with {company}. Do you have a few minutes this week to talk through what you have in mind?\n\nReply to this email or call {phone} and we will find a time.'
    },
    {
      days: 5, subject: 'Still thinking about your project?',
      message: 'Hi {name},\n\nOne last note from {company}. If you are still planning your project, we would be glad to help. If your plans have changed, no problem at all.\n\nYou can reply here or call {phone} any time.'
    }
  ];
}

function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const steps = Array.isArray(s.steps) && s.steps.length ? s.steps : defaultSteps();
  return { enabled: !!s.enabled, steps: steps.slice(0, MAX_STEPS).map((x, i) => ({ days: i === 0 ? 0 : Math.min(14, Math.max(1, parseInt(x.days, 10) || i * 2)), subject: String(x.subject || ''), message: String(x.message || '') })) };
}

// Returns an error message, or null when the settings are safe to save.
function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) return `A sequence has 1 to ${MAX_STEPS} emails.`;
  let lastDays = -1;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] || {};
    const label = `Email ${i + 1}`;
    const subject = outreach.cleanSubject(st.subject);
    const message = String(st.message || '').trim();
    if (!subject) return `${label} needs a subject.`;
    if (!message || message.length > MAX_MESSAGE) return `${label} needs a message of up to ${MAX_MESSAGE} characters.`;
    for (const text of [subject, message]) {
      for (const m of text.matchAll(/\{([a-z_]+)\}/g)) if (!ALLOWED_TOKENS.has(m[1])) return `${label} uses {${m[1]}}, which is not available. You can use {name}, {company}, {phone}, {email} and {founder}.`;
    }
    const days = i === 0 ? 0 : parseInt(st.days, 10);
    if (i > 0 && !(days >= 1 && days <= 14)) return `${label} must be sent 1 to 14 days after the lead comes in.`;
    if (i > 0 && days <= lastDays) return `${label} has to come after the previous email.`;
    lastDays = days;
  }
  return null;
}

async function loadSettings(tenantId) {
  const r = await query('SELECT lead_sequence FROM business_profile WHERE tenant_id = $1', [tenantId]);
  return normalizeSettings(r.rows[0] && r.rows[0].lead_sequence);
}

async function saveSettings(tenantId, { enabled, steps }) {
  const err = validateSteps(steps);
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  const clean = { enabled: !!enabled, steps: steps.map((s, i) => ({ days: i === 0 ? 0 : parseInt(s.days, 10), subject: outreach.cleanSubject(s.subject), message: String(s.message).trim() })) };
  await query('UPDATE business_profile SET lead_sequence = $1 WHERE tenant_id = $2', [JSON.stringify(clean), tenantId]);
  return clean;
}

// The lead's first name, cased sensibly; falls back to a friendly "there".
function leadFirstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  if (!first || first.length > 30 || /[0-9@]/.test(first)) return 'there';
  // All-lower or all-caps typing ("alex", "ALEX") is cased as a name; anything mixed ("McDonald", "DeShawn") is kept as typed.
  if (first === first.toLowerCase() || first === first.toUpperCase()) {
    return first.toLowerCase().replace(/(^|[-'])([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
  }
  return first;
}

function renderStep(step, { ctx, leadName }) {
  const vars = {
    company: ctx.companyName, phone: ctx.profile.phone || '', email: ctx.profile.email || '', founder: ctx.profile.founder_name || ''
  };
  const fill = (t) => tpl.fillName(tpl.renderTemplate(t, vars), leadFirstName(leadName));
  return { subject: outreach.cleanSubject(fill(step.subject)) || `Thanks for contacting ${ctx.companyName}`, message: fill(step.message) };
}

const isEmail = (e) => outreach.EMAIL_RE.test(String(e || '').trim());

// Called right after a lead is saved. Schedules the sequence if the owner turned it on.
async function scheduleForLead({ tenantId, leadId, email, baseUrl }) {
  if (!isEmail(email)) return { scheduled: 0, reason: 'no_email' };
  const settings = await loadSettings(tenantId);
  if (!settings.enabled) return { scheduled: 0, reason: 'disabled' };
  const sup = await query('SELECT 1 FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)', [tenantId, email.trim()]);
  if (sup.rows.length) return { scheduled: 0, reason: 'opted_out' };
  let n = 0;
  for (let i = 0; i < settings.steps.length; i++) {
    const r = await query(
      `INSERT INTO lead_sequence_sends (id, tenant_id, lead_id, step, due_at, base_url)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval, $6)
       ON CONFLICT (lead_id, step) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), tenantId, leadId, i + 1, String(settings.steps[i].days), baseUrl || '']);
    if (r.rows.length) n++;
  }
  return { scheduled: n };
}

async function cancelForLead(leadId, reason) {
  return (await query(
    `UPDATE lead_sequence_sends SET status = 'cancelled', cancel_reason = $2
     WHERE lead_id = $1 AND status = 'pending'`, [leadId, reason])).rowCount;
}

async function cancelForEmail(tenantId, email, reason) {
  return (await query(
    `UPDATE lead_sequence_sends SET status = 'cancelled', cancel_reason = $3
     WHERE tenant_id = $1 AND status = 'pending' AND lead_id IN (SELECT id FROM leads WHERE tenant_id = $1 AND LOWER(email) = LOWER($2))`,
    [tenantId, email, reason])).rowCount;
}

async function sentToday(tenantId) {
  return (await query("SELECT COUNT(*)::int AS n FROM lead_sequence_sends WHERE tenant_id = $1 AND status = 'sent' AND sent_at > now() - interval '24 hours'", [tenantId])).rows[0].n;
}

async function sendOne({ ctx, settings, step, lead, baseUrl, send }) {
  const def = settings.steps[step - 1];
  if (!def) return { ok: false, reason: 'no_such_step' };
  const { subject, message } = renderStep(def, { ctx, leadName: lead.name });
  const unsubscribeUrl = outreach.buildUnsubscribeUrl(baseUrl || '', lead.tenant_id, lead.email);
  const { html, text } = outreach.composeEmail({ message, companyName: ctx.companyName, profile: ctx.profile, unsubscribeUrl });
  const replyTo = ctx.profile.email && isEmail(ctx.profile.email) ? ctx.profile.email : undefined;
  await send({
    to: lead.email.trim(), subject, html, text, replyTo, fromName: ctx.companyName, fromAddress: ctx.fromAddress,
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  });
  return { ok: true, subject };
}

// Sends what is due. `onlyLeadId` lets a brand-new lead's first email go out at
// once instead of waiting for the next background tick.
async function processDueLeadSequence({ now = new Date(), send = sendEmail, limit = 30, onlyLeadId = null } = {}) {
  const summary = { claimed: 0, sent: 0, cancelled: 0, deferred: 0, failed: 0 };
  const inWindow = followUps.inSendWindow(now);
  // The acknowledgement (step 1) goes out any time of day; follow-ups wait for business hours.
  const claimed = (await query(
    `UPDATE lead_sequence_sends SET status = 'sending'
     WHERE id IN (SELECT id FROM lead_sequence_sends
                  WHERE status = 'pending' AND due_at <= $1 AND ($3::uuid IS NULL OR lead_id = $3::uuid) AND ($4::boolean OR step = 1)
                  ORDER BY due_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [now, limit, onlyLeadId, inWindow])).rows;
  summary.claimed = claimed.length;
  const finish = (id, status, extra = {}) => query(
    'UPDATE lead_sequence_sends SET status = $2::varchar, cancel_reason = $3, error = $4, sent_at = CASE WHEN $2::text = \'sent\' THEN now() ELSE sent_at END WHERE id = $1',
    [id, status, extra.reason || null, extra.error || null]);
  const cache = new Map();

  for (const row of claimed) {
    try {
      const lead = (await query('SELECT * FROM leads WHERE id = $1', [row.lead_id])).rows[0];
      if (!lead) { await finish(row.id, 'cancelled', { reason: 'lead_deleted' }); summary.cancelled++; continue; }
      if (lead.status !== 'new') { await finish(row.id, 'cancelled', { reason: 'lead_handled' }); summary.cancelled++; continue; }
      if (!isEmail(lead.email)) { await finish(row.id, 'cancelled', { reason: 'no_email' }); summary.cancelled++; continue; }
      const sup = await query('SELECT 1 FROM outreach_suppressions WHERE tenant_id = $1 AND LOWER(email) = LOWER($2)', [row.tenant_id, lead.email.trim()]);
      if (sup.rows.length) { await finish(row.id, 'cancelled', { reason: 'opted_out' }); summary.cancelled++; continue; }

      let c = cache.get(row.tenant_id);
      if (!c) {
        const ctx = await outreach.getSenderContext(row.tenant_id);
        c = { ctx, settings: ctx ? await loadSettings(row.tenant_id) : null };
        cache.set(row.tenant_id, c);
      }
      if (!c.ctx || !c.settings.enabled) { await finish(row.id, 'cancelled', { reason: 'switched_off' }); summary.cancelled++; continue; }
      if ((c.ctx.profile.address || '').trim().length < 8) { await finish(row.id, 'cancelled', { reason: 'no_address' }); summary.cancelled++; continue; }
      if ((await sentToday(row.tenant_id)) >= MAX_PER_DAY) {
        await query("UPDATE lead_sequence_sends SET status = 'pending' WHERE id = $1", [row.id]); summary.deferred++; continue;
      }
      const res = await sendOne({ ctx: c.ctx, settings: c.settings, step: row.step, lead, baseUrl: row.base_url, send });
      if (res.ok) { await finish(row.id, 'sent'); summary.sent++; }
      else { await finish(row.id, 'cancelled', { reason: res.reason }); summary.cancelled++; }
    } catch (err) {
      await finish(row.id, 'failed', { error: err.message }).catch(() => {});
      summary.failed++;
      console.error('[leadSequence] send failed:', err.message);
    }
  }
  return summary;
}

async function stats(tenantId) {
  const r = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE status = 'pending')::int AS waiting
     FROM lead_sequence_sends WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0];
}

// A preview goes ONLY to the owner's own address, with a sample name.
async function sendPreview({ tenantId, step, baseUrl, send = sendEmail }) {
  const ctx = await outreach.getSenderContext(tenantId);
  if (!ctx) { const e = new Error('Tenant not found.'); e.status = 404; throw e; }
  const to = [ctx.profile.email, (await query('SELECT u.email FROM users u WHERE u.tenant_id = $1 ORDER BY u.created_at ASC LIMIT 1', [tenantId])).rows[0]?.email].find(isEmail);
  if (!to) { const e = new Error('Add an email address to your Company Profile first.'); e.status = 400; throw e; }
  if ((ctx.profile.address || '').trim().length < 8) { const e = new Error('Add your business address to your Company Profile first; it goes in the footer.'); e.status = 400; throw e; }
  const settings = await loadSettings(tenantId);
  const { subject, message } = renderStep(settings.steps[(step || 1) - 1] || settings.steps[0], { ctx, leadName: 'Alex Sample' });
  const unsubscribeUrl = outreach.buildUnsubscribeUrl(baseUrl || '', tenantId, to);
  const { html, text } = outreach.composeEmail({ message, companyName: ctx.companyName, profile: ctx.profile, unsubscribeUrl });
  await send({ to: to.trim(), subject: `[Preview] ${subject}`, html, text, fromName: ctx.companyName, fromAddress: ctx.fromAddress });
  return { to: to.trim() };
}

module.exports = {
  MAX_STEPS, MAX_PER_DAY, defaultSteps, normalizeSettings, validateSteps, loadSettings, saveSettings, leadFirstName, renderStep,
  scheduleForLead, cancelForLead, cancelForEmail, processDueLeadSequence, stats, sendPreview
};
