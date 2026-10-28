// End-of-day check-ins in Eagle I CRM: "what did you get done today?"
//
// Weekdays from 5pm Central, everyone on the team gets a one-line email. They
// reply in their own words (or tell the assistant in the app). With AI on, the
// assistant files the reply as that person: site logs on the right jobs,
// phases started or finished, tasks for what's next. Without it, the reply is
// still kept, and shows up whenever someone asks what that person did.
// Only replies from the person's own address are accepted.
const { query } = require('../db');
const { sendEmail, buildReplyToAddress } = require('./email');

const TZ = 'America/Chicago';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const localDay = (now) => now.toLocaleDateString('en-CA', { timeZone: TZ });

// The new daily check-in starts Thursday Oct 29 2026; nothing goes out before then.
const START_DAY = '2026-10-29';
// Test and placeholder addresses never get email.
const TEST_ADDR = /@(eagle-i-test\.com|example\.(com|org|net)|[^@]*\.(test|example|invalid|localhost))$/i;

async function processCheckins({ now = new Date(), send = sendEmail, appUrl = require('./appUrl').appUrl() } = {}) {
  if (localDay(now) < START_DAY) return { sent: 0, notYet: true };
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now).map(x => [x.type, x.value]));
  const hour = +p.hour % 24;
  if (['Sat', 'Sun'].includes(p.weekday) || hour < 17 || hour >= 20) return { sent: 0 };
  const day = localDay(now);
  const users = (await query(
    `SELECT u.id, u.tenant_id, u.email, u.name, t.company_name FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE 'crm' = ANY(t.products) AND u.crm_checkin_off = false
       AND NOT EXISTS (SELECT 1 FROM crm_checkins c WHERE c.user_id = u.id AND c.day = $1::date) LIMIT 200`, [day])).rows;
  let sent = 0;
  for (const u of users) {
    const row = (await query(`INSERT INTO crm_checkins (tenant_id, user_id, day, sent_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, day) DO NOTHING RETURNING id`, [u.tenant_id, u.id, day, now])).rows[0];
    if (!row || !EMAIL_RE.test(String(u.email || '')) || TEST_ADDR.test(String(u.email))) continue;
    const replyTo = buildReplyToAddress('day', row.id);
    const first = String(u.name || '').split(/\s+/)[0];
    const how = replyTo ? 'Just reply to this email with a few lines' : `Tell Eagle I in the app (${appUrl}/crm#ask)`;
    try {
      await send({
        to: u.email, replyTo: replyTo || undefined,
        subject: `What did you get done today${first ? `, ${first}` : ''}?`,
        html: `<div style="font-family:Arial,sans-serif;font-size:17px;color:#14202b;max-width:560px;line-height:1.5"><p>${first ? `Hi ${first.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}, q` : 'Q'}uick one before you wrap up: what got done today, and what’s next?</p><p>${how}: jobs you worked on, what you finished, anything that’s stuck. Eagle I puts it on the right jobs for you.</p><p style="color:#55636f;font-size:15px">e.g. “Garcia kitchen: cabinets set, countertop template Thursday. Lee bath: tile is backordered a week.”</p><p style="color:#55636f;font-size:14px">${u.company_name} · switch these off from the Account menu in Eagle I CRM.</p></div>`,
        text: `${first ? `Hi ${first}, q` : 'Q'}uick one before you wrap up: what got done today, and what's next?\n\n${how}: jobs you worked on, what you finished, anything that's stuck. Eagle I puts it on the right jobs for you.\n\ne.g. "Garcia kitchen: cabinets set, countertop template Thursday. Lee bath: tile is backordered a week."`
      });
      sent++;
    } catch (e) { console.error('[crmCheckins] send failed:', e.message); }
  }
  return { sent };
}

// The reply, without the quoted email below it.
function replyBody(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*>/.test(line)) break;
    if (/^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim()) || /^From: /.test(line.trim())) break;
    out.push(line);
  }
  return out.join('\n').trim().slice(0, 6000);
}

async function handleReply({ checkinId, fromEmail, text }) {
  const c = (await query(`SELECT c.*, u.email, u.name, u.role, u.permissions FROM crm_checkins c JOIN users u ON u.id = c.user_id WHERE c.id = $1`, [checkinId])).rows[0];
  if (!c) return { ok: false, reason: 'unknown' };
  if (String(fromEmail || '').trim().toLowerCase() !== String(c.email || '').trim().toLowerCase()) return { ok: false, reason: 'not_from_them' };
  const body = replyBody(text);
  if (!body) return { ok: false, reason: 'empty' };
  await query('UPDATE crm_checkins SET reply_text = $2, replied_at = now() WHERE id = $1', [c.id, body]);
  if (!process.env.ANTHROPIC_API_KEY) return { ok: true, filed: false };
  return fileWithAssistant(c, body);
}

async function fileWithAssistant(c, body) {
  const assistant = require('./crmAssistant');
  const team = require('./crmTeam');
  const ctx = { tenantId: c.tenant_id, userId: c.user_id, name: c.name || c.email, role: c.role, manager: team.isManager(c.role), perms: team.permsOf(c), baseUrl: require('./appUrl').appUrl(),
    extra: 'This message is the person’s end-of-day update, sent by email. File each piece with log_work on the right job (search for jobs by name), mark phases they say started or finished, and add tasks for what they say is next. Do not prepare anything that goes outside the company. Finish with a two-line summary of what you filed.' };
  let thread = (await query(`SELECT id FROM crm_ai_threads WHERE user_id = $1 AND title = 'End-of-day updates'`, [c.user_id])).rows[0];
  if (!thread) thread = await assistant.createThread(ctx, 'End-of-day updates');
  try {
    const r = await assistant.runTurn(ctx, { threadId: thread.id, text: `My update for ${String(c.day instanceof Date ? c.day.toISOString() : c.day).slice(0, 10)}:\n\n${body}`, allowTools: (name, tool) => !tool.confirm });
    await query('UPDATE crm_checkins SET filed = $2 WHERE id = $1', [c.id, JSON.stringify({ text: r.text, steps: r.steps })]);
    return { ok: true, filed: true, text: r.text };
  } catch (e) {
    console.error('[crmCheckins] filing failed:', e.message);
    return { ok: true, filed: false };
  }
}

async function setCheckin(userId, on) { await query('UPDATE users SET crm_checkin_off = $2 WHERE id = $1', [userId, !on]); return { on: !!on }; }

module.exports = { processCheckins, replyBody, handleReply, fileWithAssistant, setCheckin };
