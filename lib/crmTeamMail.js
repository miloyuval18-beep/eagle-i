// One email a day for each person on the team, in Eagle I CRM.
//
// The update emails a person would have had one by one (a new lead, a customer's
// reply or message, an estimate accepted, a payment, an order to send, a permit
// holding up a phase, an inspection due, prices in, an urgent check-in problem, and
// for owners and admins the day's check-ins) wait here (later()) and go out together
// at the end of the work day (4pm Central): one email per person, with only what was
// for them, the things that need them first. Nobody gets anyone else's; nobody with
// nothing gets an email. Everything is in Today → Needs you straight away as before.
//
// Only what still matters when it goes: a reminder about an email that was answered,
// closed or snoozed since is left out, and the same thing twice is in it once. At the
// end, "For your information": the emails they were kept in the loop on that day
// (no reply needed from them). After 4pm, something urgent goes out straight away;
// the rest waits for tomorrow's.
//
// Not held: emails to customers and vendors, sign-in codes, password resets,
// invitations and join requests, and security alerts; and the scheduled ones that are
// already a single email (the 7am plan, the 3:30 check-in, the 6pm check-in summary
// for owners and admins, weekly reports).
const { query } = require('../db');
const { sendEmail } = require('./email');

const TZ = 'America/Chicago';
const SEND_HOUR = 16;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ['lead', 'customer', 'job', 'pricing', 'checkins', 'other'];
const FYI_MAX = 12;
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
// Pure: an email's words without its markup.
function textOf(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
}

// Held for the end of the day, for each person it was for.
async function later({ tenantId, to, subject, text = null, html = null, kind = 'other', dealId = null, link = null, urgent = false, replyTo = null, sectionHtml = null, ref = null }) {
  const list = (Array.isArray(to) ? to : [to]).map(e => String(e || '').trim().toLowerCase()).filter(e => EMAIL_RE.test(e));
  if (!tenantId || !list.length) return 0;
  const body = clip(text != null ? text : textOf(html), 6000) || null;
  for (const e of [...new Set(list)]) {
    await query(`INSERT INTO crm_team_mail (tenant_id, to_email, kind, urgent, deal_id, subject, body, section_html, link, reply_to, ref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [tenantId, e, KINDS.includes(kind) ? kind : 'other', !!urgent, dealId || null, clip(subject, 200) || 'Update', body, sectionHtml, clip(link, 500) || null, EMAIL_RE.test(String(replyTo || '')) ? String(replyTo).trim() : null, clip(ref, 100) || null]);
  }
  return list.length;
}

// A drop-in for sendEmail at the places that emailed the team: holds it instead.
const holder = (tenantId, opts = {}) => async (m) => { await later({ tenantId, to: m.to, subject: m.subject, text: m.text, html: m.html, replyTo: opts.replyTo || null, ...opts }); return { held: true }; };

const SECTIONS = [
  ['urgent', 'Needs you first'], ['lead', 'New leads'], ['customer', 'From customers'], ['job', 'Jobs, orders and permits'],
  ['pricing', 'Pricing'], ['other', 'Other updates'], ['checkins', 'Today’s check-ins']
];

// Pure: one person's email from their items, and the emails they were kept in the loop on ({count, groups}).
function compose({ name, company, items, appUrl, fyi = null }) {
  const first = String(name || '').trim().split(/\s+/)[0];
  const urgentN = items.filter(i => i.urgent).length;
  const n = items.length;
  const fyiN = fyi ? fyi.count : 0;
  const fyiList = fyi ? fyi.groups.flatMap(g => g.items.map(i => ({ ...i, deal: g.deal }))).slice(0, FYI_MAX) : [];
  const groups = SECTIONS.map(([k, label]) => [label, items.filter(i => k === 'urgent' ? i.urgent : !i.urgent && i.kind === k)]).filter(([, l]) => l.length);
  const open = (i) => i.link || `${appUrl}/crm/app#needs`;
  const item = (i) => i.section_html ? `<div style="margin:8px 0 16px"><div style="font-weight:bold;font-size:18px">${esc(i.subject)}</div>${i.section_html}</div>` : `<div style="border-left:4px solid ${i.urgent ? '#c01b1b' : '#c9a24a'};background:#f8f6f1;border-radius:6px;padding:10px 14px;margin:10px 0">
<div style="font-weight:bold;font-size:18px">${esc(i.subject)}</div>${i.body ? `<div style="white-space:pre-wrap;margin-top:4px">${esc(clip(i.body, 2500))}</div>` : ''}
<div style="margin-top:8px"><a href="${esc(open(i))}" style="color:#163a6b;font-weight:bold">Open in Eagle I</a>${i.reply_to ? ` &nbsp;·&nbsp; <a href="mailto:${esc(i.reply_to)}?subject=${encodeURIComponent('Re: ' + i.subject)}" style="color:#163a6b;font-weight:bold">Reply to them</a>` : ''}</div></div>`;
  const why = (i) => i.why === 'fyi' ? 'nothing to answer' : i.why === 'for' ? (i.to ? `for ${i.to}` : 'for a teammate') : 'you were copied';
  const fyiOne = (i) => `<li style="margin:6px 0"><b>${esc(i.from || '')}</b>: ${esc(i.subject || '')} <span style="color:#55636f">(${esc(why(i))}${i.deal ? ` · ${esc(i.deal)}` : ''})</span>${i.gmail ? ` &nbsp;<a href="${esc(i.gmail)}" style="color:#163a6b">Read it</a>` : ''}</li>`;
  const fyiHtml = fyiN ? `<h3 style="margin:22px 0 4px;font-size:19px;color:#14202b">For your information</h3>
<p style="margin:0 0 6px;color:#55636f">${fyiN === 1 ? 'An email' : `${fyiN} emails`} from today that need${fyiN === 1 ? 's' : ''} nothing from you: you were only copied, it was for someone else, or there’s nothing to answer. Worth knowing about.</p>
<ul style="margin:0;padding-left:20px">${fyiList.map(fyiOne).join('')}</ul>${fyiN > fyiList.length ? `<p style="margin:6px 0 0"><a href="${esc(appUrl)}/crm/app#needs" style="color:#163a6b">${fyiN - fyiList.length} more in Eagle I (Today → For your information)</a></p>` : ''}` : '';
  const intro = n ? `Here’s everything from today at ${esc(company)} in one email${urgentN ? `. <b>${urgentN === 1 ? 'One thing needs' : urgentN + ' things need'} you first.</b>` : '.'}` : `Nothing needs you today at ${esc(company)}. Here are today’s emails for your information.`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:17px;color:#14202b;max-width:640px;line-height:1.5">
<p>Hi${first ? ' ' + esc(first) : ''},</p><p>${intro}</p>
${groups.map(([label, list]) => `<h3 style="margin:22px 0 4px;font-size:19px;color:${label === 'Needs you first' ? '#c01b1b' : '#14202b'}">${esc(label)}</h3>${list.map(item).join('')}`).join('\n')}
${fyiHtml}
<p style="margin-top:24px"><a href="${esc(appUrl)}/crm/app#needs" style="background:#163a6b;color:#fff;padding:13px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Open Eagle I</a></p>
<p style="color:#55636f;font-size:15px">Everything here was also in Eagle I under Today → Needs you as it happened.</p></div>`;
  const fyiText = fyiN ? `FOR YOUR INFORMATION (nothing needed from you)\n${fyiList.map(i => `- ${i.from || ''}: ${i.subject || ''} (${why(i)}${i.deal ? ' · ' + i.deal : ''})`).join('\n')}${fyiN > fyiList.length ? `\n- and ${fyiN - fyiList.length} more in Eagle I` : ''}` : '';
  const text = `Hi${first ? ' ' + first : ''},\n\n${n ? `Everything from today at ${company}:` : `Nothing needs you today at ${company}.`}\n\n${[...groups.map(([label, list]) => `${label.toUpperCase()}\n${list.map(i => i.section_html ? `${i.subject}\n${textOf(i.section_html)}` : `- ${i.subject}${i.body ? `\n  ${clip(i.body, 1500).replace(/\n/g, '\n  ')}` : ''}${i.reply_to ? `\n  Reply to them: ${i.reply_to}` : ''}`).join('\n')}`), fyiText].filter(Boolean).join('\n\n')}\n\nOpen Eagle I: ${appUrl}/crm/app#needs`;
  const fyiBit = fyiN ? `${fyiN} for your information` : '';
  const subject = (n
    ? `Your day at ${company}: ${n} update${n === 1 ? '' : 's'}${urgentN ? `, ${urgentN} need${urgentN === 1 ? 's' : ''} you first` : ''}${fyiBit ? ` · ${fyiBit}` : ''}`
    : `Your day at ${company}: ${fyiN} email${fyiN === 1 ? '' : 's'} for your information`).slice(0, 150);
  return { subject, html, text };
}

// Pure: what still belongs in it. The same thing twice is in it once (the latest).
function dedupe(items) {
  const seen = new Map();
  for (const i of items) seen.set(i.ref || `${i.kind}|${String(i.subject).toLowerCase()}|${i.body || ''}`, i);
  return [...seen.values()].sort((a, b) => Number(a.id) - Number(b.id));
}
// A reminder about an email: only if it's still waiting on someone.
async function stillOpen(items) {
  const ids = [...new Set(items.map(i => /^mw:(\d{1,18})$/.exec(i.ref || '')).filter(Boolean).map(m => m[1]))];
  if (!ids.length) return items;
  const open = new Set((await query(`SELECT id::text FROM crm_mail_threads WHERE id = ANY($1::bigint[]) AND status = 'open' AND state IN ('to_reply', 'waiting')
    AND (snooze_until IS NULL OR snooze_until <= now())`, [ids])).rows.map(r => r.id));
  return items.filter(i => { const m = /^mw:(\d{1,18})$/.exec(i.ref || ''); return !m || open.has(m[1]); });
}

// The end of the work day (4pm Central): each person's one email.
async function processEndOfDay({ now = new Date(), send = sendEmail, appUrl = require('./appUrl').appUrl(), tenantId = null, force = false } = {}) {
  const hour = +new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(now) % 24;
  if (!force && hour < SEND_HOUR) return { sent: 0 };
  // Today's 4pm: what came in after it waits for tomorrow's email, unless it's urgent.
  const cutoff = force ? new Date(now.getTime() + 1000) : (await query(`SELECT ((date_trunc('day', $1::timestamptz AT TIME ZONE '${TZ}') + interval '${SEND_HOUR} hours') AT TIME ZONE '${TZ}') AS c`, [now])).rows[0].c;
  const people = (await query(`SELECT DISTINCT m.tenant_id, m.to_email, t.company_name FROM crm_team_mail m JOIN tenants t ON t.id = m.tenant_id
    WHERE m.sent_at IS NULL AND (m.urgent OR m.created_at <= $2::timestamptz) AND ($1::uuid IS NULL OR m.tenant_id = $1) LIMIT 500`, [tenantId, cutoff])).rows;
  // And those with only emails they were kept in the loop on: once a day, in this email.
  const looped = (await query(`SELECT DISTINCT l.tenant_id, LOWER(u.email) AS to_email, t.company_name FROM crm_mail_loop l JOIN users u ON u.id = l.user_id JOIN tenants t ON t.id = l.tenant_id
    WHERE u.disabled_at IS NULL AND (u.crm_loop_digest_at IS NULL OR u.crm_loop_digest_at < $2::timestamptz) AND l.last_at > COALESCE(u.crm_loop_digest_at, $3::timestamptz - interval '1 day')
      AND l.last_at > $3::timestamptz - interval '3 days' AND ($1::uuid IS NULL OR l.tenant_id = $1) LIMIT 500`, [tenantId, cutoff, now]).catch((e) => { console.error('[crmTeamMail] kept in the loop:', e.message); return { rows: [] }; })).rows;
  for (const p of looped) if (!people.some(x => x.tenant_id === p.tenant_id && x.to_email === p.to_email)) people.push(p);
  const TEST = require('./crmCheckins').TEST_ADDR;
  const watch = require('./crmEmailWatch');
  const out = { sent: 0, people: 0, dropped: 0 };
  for (const p of people) {
    // Claimed first, so two overlapping ticks can never send it twice.
    const claimed = (await query(`UPDATE crm_team_mail SET sent_at = now() WHERE tenant_id = $1 AND to_email = $2 AND sent_at IS NULL AND (urgent OR created_at <= $3::timestamptz) RETURNING *`, [p.tenant_id, p.to_email, cutoff])).rows;
    const items = dedupe(await stillOpen(claimed));
    out.dropped += claimed.length - items.length;
    if (TEST.test(p.to_email)) continue; // made-up test addresses never get email
    const u = (await query(`SELECT id, tenant_id, name, crm_loop_digest_at FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 AND disabled_at IS NULL LIMIT 1`, [p.tenant_id, p.to_email])).rows[0];
    const fyiDue = u && (!u.crm_loop_digest_at || new Date(u.crm_loop_digest_at) < new Date(cutoff));
    const fyi = fyiDue ? await watch.loopDigest(u, force ? cutoff : now).catch(() => null) : null;
    if (!items.length && !(fyi && fyi.count)) continue;
    const mail = compose({ name: u && u.name, company: p.company_name, items, appUrl, fyi });
    try {
      await send({ to: p.to_email, ...mail });
      if (fyiDue) await watch.loopDigested(u.id, force ? cutoff : now).catch(() => {});
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

module.exports = { SEND_HOUR, textOf, later, holder, compose, dedupe, processEndOfDay };
