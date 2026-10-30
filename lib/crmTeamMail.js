// One email a day for each person on the team, in Eagle I CRM.
//
// The update emails a person would have had one by one (a new lead, a customer's
// reply or message, an estimate accepted, a payment, an order to send, a permit
// holding up a phase, an inspection due, prices in, an urgent check-in problem, and
// for owners and admins the day's check-ins) wait here (later()) and go out together
// at the end of the day (6pm Central): one email per person, with only what was for
// them, the things that need them first. Nobody gets anyone else's; nobody with
// nothing gets an email. Everything is in Today → Needs you straight away as before.
//
// Not held: emails to customers and vendors, sign-in codes, password resets,
// invitations and join requests, and security alerts; and the scheduled ones that are
// already a single email (the 7am plan, the 3:30 check-in, weekly reports).
const { query } = require('../db');
const { sendEmail } = require('./email');

const TZ = 'America/Chicago';
const SEND_HOUR = 18;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ['lead', 'customer', 'job', 'pricing', 'checkins', 'other'];
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
// Pure: an email's words without its markup.
function textOf(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
}

// Held for the end of the day, for each person it was for.
async function later({ tenantId, to, subject, text = null, html = null, kind = 'other', dealId = null, link = null, urgent = false, replyTo = null, sectionHtml = null }) {
  const list = (Array.isArray(to) ? to : [to]).map(e => String(e || '').trim().toLowerCase()).filter(e => EMAIL_RE.test(e));
  if (!tenantId || !list.length) return 0;
  const body = clip(text != null ? text : textOf(html), 6000) || null;
  for (const e of [...new Set(list)]) {
    await query(`INSERT INTO crm_team_mail (tenant_id, to_email, kind, urgent, deal_id, subject, body, section_html, link, reply_to) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tenantId, e, KINDS.includes(kind) ? kind : 'other', !!urgent, dealId || null, clip(subject, 200) || 'Update', body, sectionHtml, clip(link, 500) || null, EMAIL_RE.test(String(replyTo || '')) ? String(replyTo).trim() : null]);
  }
  return list.length;
}

// A drop-in for sendEmail at the places that emailed the team: holds it instead.
const holder = (tenantId, opts = {}) => async (m) => { await later({ tenantId, to: m.to, subject: m.subject, text: m.text, html: m.html, replyTo: opts.replyTo || null, ...opts }); return { held: true }; };

const SECTIONS = [
  ['urgent', 'Needs you first'], ['lead', 'New leads'], ['customer', 'From customers'], ['job', 'Jobs, orders and permits'],
  ['pricing', 'Pricing'], ['other', 'Other updates'], ['checkins', 'Today’s check-ins']
];

// Pure: one person's email from their items.
function compose({ name, company, items, appUrl }) {
  const first = String(name || '').trim().split(/\s+/)[0];
  const urgentN = items.filter(i => i.urgent).length;
  const n = items.length;
  const groups = SECTIONS.map(([k, label]) => [label, items.filter(i => k === 'urgent' ? i.urgent : !i.urgent && i.kind === k)]).filter(([, l]) => l.length);
  const open = (i) => i.link || `${appUrl}/crm/app#needs`;
  const item = (i) => i.section_html ? `<div style="margin:8px 0 16px"><div style="font-weight:bold;font-size:18px">${esc(i.subject)}</div>${i.section_html}</div>` : `<div style="border-left:4px solid ${i.urgent ? '#c01b1b' : '#c9a24a'};background:#f8f6f1;border-radius:6px;padding:10px 14px;margin:10px 0">
<div style="font-weight:bold;font-size:18px">${esc(i.subject)}</div>${i.body ? `<div style="white-space:pre-wrap;margin-top:4px">${esc(clip(i.body, 2500))}</div>` : ''}
<div style="margin-top:8px"><a href="${esc(open(i))}" style="color:#163a6b;font-weight:bold">Open in Eagle I</a>${i.reply_to ? ` &nbsp;·&nbsp; <a href="mailto:${esc(i.reply_to)}?subject=${encodeURIComponent('Re: ' + i.subject)}" style="color:#163a6b;font-weight:bold">Reply to them</a>` : ''}</div></div>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:17px;color:#14202b;max-width:640px;line-height:1.5">
<p>Hi${first ? ' ' + esc(first) : ''},</p><p>Here’s everything from today at ${esc(company)} in one email${urgentN ? `. <b>${urgentN === 1 ? 'One thing needs' : urgentN + ' things need'} you first.</b>` : '.'}</p>
${groups.map(([label, list]) => `<h3 style="margin:22px 0 4px;font-size:19px;color:${label === 'Needs you first' ? '#c01b1b' : '#14202b'}">${esc(label)}</h3>${list.map(item).join('')}`).join('\n')}
<p style="margin-top:24px"><a href="${esc(appUrl)}/crm/app#needs" style="background:#163a6b;color:#fff;padding:13px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Open Eagle I</a></p>
<p style="color:#55636f;font-size:15px">Everything here was also in Eagle I under Today → Needs you as it happened.</p></div>`;
  const text = `Hi${first ? ' ' + first : ''},\n\nEverything from today at ${company}:\n\n${groups.map(([label, list]) => `${label.toUpperCase()}\n${list.map(i => i.section_html ? `${i.subject}\n${textOf(i.section_html)}` : `- ${i.subject}${i.body ? `\n  ${clip(i.body, 1500).replace(/\n/g, '\n  ')}` : ''}${i.reply_to ? `\n  Reply to them: ${i.reply_to}` : ''}`).join('\n')}`).join('\n\n')}\n\nOpen Eagle I: ${appUrl}/crm/app#needs`;
  const subject = `Your day at ${company}: ${n} update${n === 1 ? '' : 's'}${urgentN ? `, ${urgentN} need${urgentN === 1 ? 's' : ''} you first` : ''}`.slice(0, 150);
  return { subject, html, text };
}

// The end of the day: each person's one email.
async function processEndOfDay({ now = new Date(), send = sendEmail, appUrl = require('./appUrl').appUrl(), tenantId = null, force = false } = {}) {
  const hour = +new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(now) % 24;
  if (!force && hour < SEND_HOUR) return { sent: 0 };
  const people = (await query(`SELECT DISTINCT m.tenant_id, m.to_email, t.company_name FROM crm_team_mail m JOIN tenants t ON t.id = m.tenant_id
    WHERE m.sent_at IS NULL AND ($1::uuid IS NULL OR m.tenant_id = $1) LIMIT 500`, [tenantId])).rows;
  const TEST = require('./crmCheckins').TEST_ADDR;
  const out = { sent: 0, people: 0 };
  for (const p of people) {
    // Claimed first, so two overlapping ticks can never send it twice.
    const items = (await query(`UPDATE crm_team_mail SET sent_at = now() WHERE tenant_id = $1 AND to_email = $2 AND sent_at IS NULL RETURNING *`, [p.tenant_id, p.to_email])).rows
      .sort((a, b) => Number(a.id) - Number(b.id));
    if (!items.length) continue;
    if (TEST.test(p.to_email)) continue; // made-up test addresses never get email
    const u = (await query(`SELECT name FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 LIMIT 1`, [p.tenant_id, p.to_email])).rows[0];
    const mail = compose({ name: u && u.name, company: p.company_name, items, appUrl });
    try {
      await send({ to: p.to_email, ...mail });
      out.sent++; out.people++;
    } catch (e) {
      console.error('[crmTeamMail] end-of-day email failed:', e.message);
      // Not sent after all: tried again on the next round.
      await query(`UPDATE crm_team_mail SET sent_at = NULL WHERE id = ANY($1::bigint[])`, [items.map(i => i.id)]).catch(() => {});
    }
  }
  // Kept a month after sending, then cleared.
  await query(`DELETE FROM crm_team_mail WHERE sent_at < now() - interval '30 days'`).catch(() => {});
  return out;
}

module.exports = { SEND_HOUR, textOf, later, holder, compose, processEndOfDay };
