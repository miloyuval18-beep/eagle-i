// The CRM in the team's day, in Eagle I CRM.
//
//  - Calendar link: each person has a private address their Google or Apple
//    Calendar subscribes to: their site visits, the job phases they're on and
//    their tasks with a due date, meetings and inspections, deliveries and
//    payments due (owners and admins: everyone's).
//  - Morning email: at 7am Central, Monday to Saturday, each person gets what's
//    theirs today: visits (with the address and the pre-visit brief), tasks due
//    or overdue, phases starting, and how much is waiting in Needs you. Nothing
//    to say, no email. Anyone can switch theirs off.
//  - Rain: every morning, for each job with outdoor work (roofing, framing,
//    concrete, siding, decks...) in the next three days, the National Weather
//    Service forecast for the house. A 60%+ chance of rain lands in Needs you.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('./email');
const crm = require('./crm');

const TZ = 'America/Chicago';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let httpOverride = null;
function setHttp(h) { httpOverride = h; }
const http = (...a) => (httpOverride || fetch)(...a);
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const localDay = (now) => now.toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

// ---------- calendar link ----------

async function calendarToken(userId) {
  const u = (await query('SELECT crm_calendar_token FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) return null;
  if (u.crm_calendar_token) return u.crm_calendar_token;
  await query('UPDATE users SET crm_calendar_token = COALESCE(crm_calendar_token, $2) WHERE id = $1', [userId, crypto.randomBytes(24).toString('hex')]);
  return (await query('SELECT crm_calendar_token FROM users WHERE id = $1', [userId])).rows[0].crm_calendar_token;
}
async function resetCalendarToken(userId) {
  await query('UPDATE users SET crm_calendar_token = $2 WHERE id = $1', [userId, crypto.randomBytes(24).toString('hex')]);
  return calendarToken(userId);
}

// iCalendar text: escaped, lines folded at 75 octets.
const icsText = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = []; let cur = '';
  for (const ch of line) { if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch; }
  out.push(cur);
  return out.join('\r\n');
}
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function buildIcs({ name, events }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Eagle I//CRM//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(name)}`, 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@eaglei`, `DTSTAMP:${stamp(new Date())}`);
    if (e.allDay) { lines.push(`DTSTART;VALUE=DATE:${e.start.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(e.end || e.start, 1).replace(/-/g, '')}`); }
    else { lines.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`); }
    lines.push(`SUMMARY:${icsText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

async function calendarFor(token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  const u = (await query(`SELECT u.id, u.tenant_id, u.role, u.permissions, t.company_name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.crm_calendar_token = $1 AND 'crm' = ANY(t.products)`, [token])).rows[0];
  if (!u) return null;
  const all = require('./crmTeam').can(u, 'see_all');
  const since = new Date(Date.now() - 30 * 86400000);
  const visits = (await query(
    `SELECT d.id, d.title, d.site_visit_at, d.brief, c.name, c.phone, p.address FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id
     WHERE d.tenant_id = $1 AND d.site_visit_at > $2 AND d.stage <> 'lost' AND ($3::boolean OR COALESCE(d.site_visit_user_id, d.owner_user_id) = $4)`, [u.tenant_id, since, all, u.id])).rows;
  const phases = (await query(
    `SELECT i.id, i.title, i.start_date, i.end_date, d.title AS job, p.address FROM crm_job_items i JOIN crm_deals d ON d.id = i.deal_id LEFT JOIN crm_properties p ON p.id = d.property_id
     WHERE i.tenant_id = $1 AND i.start_date IS NOT NULL AND COALESCE(i.end_date, i.start_date) >= $2::date AND d.stage IN ('signed', 'production') AND i.status <> 'done'
       AND ($3::boolean OR i.assignee_user_id = $4 OR d.owner_user_id = $4)`, [u.tenant_id, ymd(since), all, u.id])).rows;
  const tasks = (await query(
    `SELECT t.id, t.title, t.due_at, d.title AS deal FROM crm_tasks t LEFT JOIN crm_deals d ON d.id = t.deal_id
     WHERE t.tenant_id = $1 AND t.done_at IS NULL AND t.due_at IS NOT NULL AND (t.assignee_user_id = $2 OR ($3::boolean AND t.assignee_user_id IS NULL))`, [u.tenant_id, u.id, all])).rows;
  const events = [
    ...visits.map(v => ({ uid: `visit-${v.id}-${new Date(v.site_visit_at).getTime()}`, start: v.site_visit_at, end: new Date(new Date(v.site_visit_at).getTime() + 3600000), title: `Site visit: ${v.name}`, location: v.address, description: [v.title, v.phone, v.brief].filter(Boolean).join('\n') })),
    ...phases.map(i => ({ uid: `phase-${i.id}`, allDay: true, start: ymd(i.start_date), end: ymd(i.end_date || i.start_date), title: `${i.title} · ${i.job}`, location: i.address })),
    ...tasks.map(t => ({ uid: `task-${t.id}`, allDay: true, start: new Date(t.due_at).toLocaleDateString('en-CA', { timeZone: TZ }), title: `To do: ${t.title}`, description: t.deal || '' }))
  ];
  // Meetings and inspections, deliveries, payments, selections and bids due (lib/crmCalendar.js).
  const more = await require('./crmCalendar').range({ tenantId: u.tenant_id, viewer: u, who: all ? 'all' : 'me', from: ymd(since), to: addDays(localDay(new Date()), 120), maxDays: 160, google: false,
    types: ['event', 'delivery', 'money', 'selection', 'bid', 'compliance'] }).catch(e => { console.error('[crmDaily] calendar extras failed:', e.message); return { items: [] }; });
  for (const i of more.items) {
    if (i.done) continue;
    events.push({ uid: i.key, allDay: i.allDay, start: i.start, end: i.end, title: i.title, location: i.location || '', description: [i.sub, i.notes, i.warn].filter(Boolean).join('\n') });
  }
  return buildIcs({ name: `${u.company_name} · Eagle I`, events });
}

// ---------- morning email ----------

async function digestFor(user, now = new Date()) {
  const today = localDay(now);
  const manager = require('./crmTeam').can(user, 'see_all');
  const dayStart = require('./outreachQueue').zonedToUtc(...today.split('-').map(Number), 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const visits = (await query(
    `SELECT d.title, d.site_visit_at, d.brief, c.name, c.phone, p.address FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id
     WHERE d.tenant_id = $1 AND d.site_visit_at >= $2 AND d.site_visit_at < $3 AND d.stage <> 'lost' AND COALESCE(d.site_visit_user_id, d.owner_user_id, $4) = $4 ORDER BY d.site_visit_at`,
    [user.tenant_id, dayStart, dayEnd, user.id])).rows;
  const tasks = (await query(
    `SELECT t.title, t.due_at, d.title AS deal FROM crm_tasks t LEFT JOIN crm_deals d ON d.id = t.deal_id
     WHERE t.tenant_id = $1 AND t.done_at IS NULL AND t.due_at < $2 AND (t.assignee_user_id = $3 OR ($4::boolean AND t.assignee_user_id IS NULL)) ORDER BY t.due_at LIMIT 20`,
    [user.tenant_id, dayEnd, user.id, manager])).rows;
  const phases = (await query(
    `SELECT i.title, d.title AS job FROM crm_job_items i JOIN crm_deals d ON d.id = i.deal_id
     WHERE i.tenant_id = $1 AND i.start_date = $2::date AND i.status = 'todo' AND (i.assignee_user_id = $3 OR d.owner_user_id = $3 OR ($4::boolean AND i.assignee_user_id IS NULL AND d.owner_user_id IS NULL))`,
    [user.tenant_id, today, user.id, manager])).rows;
  const inbox = (await crm.listInbox(user.tenant_id, { now })).filter(i => manager || !i.deal_owner_user_id || i.deal_owner_user_id === user.id).length;
  const mail = await require('./crmEmailWatch').digestFor(user).catch(() => ({ toReply: [], waiting: 0, followups: 0 }));
  // Emails they were only copied on, to keep them in the loop.
  let loop = await require('./crmEmailWatch').loopDigest(user, now).catch(() => ({ count: 0, groups: [] }));
  if (!require('./crmTeam').can(user, 'money')) loop = require('./crmTeam').hideMoney(loop);
  return { visits, tasks, phases, inbox, mail, loop, overdue: tasks.filter(t => new Date(t.due_at) < dayStart).length };
}

function renderDigest({ name, company, d, appUrl, now = new Date() }) {
  const time = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const dayName = now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
  const parts = [], text = [];
  if (d.visits.length) {
    parts.push(`<h3 style="margin:18px 0 6px;font-size:17px">Site visits</h3>${d.visits.map(v => `<p style="margin:0 0 10px"><b>${esc(time(v.site_visit_at))} · ${esc(v.name)}</b><br>${esc(v.address || '')}${v.phone ? ` · ${esc(v.phone)}` : ''}${v.brief ? `<br><span style="color:#55636f;white-space:pre-wrap">${esc(v.brief.slice(0, 600))}</span>` : ''}</p>`).join('')}`);
    text.push('SITE VISITS', ...d.visits.map(v => `${time(v.site_visit_at)} · ${v.name} · ${v.address || ''}${v.phone ? ` · ${v.phone}` : ''}`), '');
  }
  if (d.phases.length) {
    parts.push(`<h3 style="margin:18px 0 6px;font-size:17px">Starting today</h3><ul style="margin:0;padding-left:18px">${d.phases.map(p => `<li>${esc(p.title)} · ${esc(p.job)}</li>`).join('')}</ul>`);
    text.push('STARTING TODAY', ...d.phases.map(p => `- ${p.title} · ${p.job}`), '');
  }
  if (d.tasks.length) {
    parts.push(`<h3 style="margin:18px 0 6px;font-size:17px">To do${d.overdue ? ` (${d.overdue} overdue)` : ''}</h3><ul style="margin:0;padding-left:18px">${d.tasks.map(t => `<li>${esc(t.title)}${t.deal ? ` · ${esc(t.deal)}` : ''}</li>`).join('')}</ul>`);
    text.push(`TO DO${d.overdue ? ` (${d.overdue} overdue)` : ''}`, ...d.tasks.map(t => `- ${t.title}${t.deal ? ` · ${t.deal}` : ''}`), '');
  }
  const m = d.mail || { toReply: [], waiting: 0, followups: 0 };
  if (m.toReply.length || m.followups) {
    const ago = (x) => x.days ? `${x.days} business day${x.days === 1 ? '' : 's'}` : 'today';
    parts.push(`<h3 style="margin:18px 0 6px;font-size:17px">Email</h3>${m.toReply.length ? `<p style="margin:0 0 4px">Waiting for your reply:</p><ul style="margin:0 0 8px;padding-left:18px">${m.toReply.map(x => `<li>${x.importance === 'urgent' ? '<b>Urgent</b> · ' : ''}<b>${esc(x.who)}</b>: ${esc(x.subject || '')}${x.reason ? ` <span style="color:#55636f">(${esc(x.reason)})</span>` : ''} · ${esc(ago(x))}</li>`).join('')}</ul>` : ''}${m.followups ? `<p style="margin:0">${m.followups} email${m.followups === 1 ? '' : 's'} you sent ${m.followups === 1 ? 'has' : 'have'} had no reply; follow-ups are written and ready in Needs you.</p>` : ''}${m.waiting > m.followups ? `<p style="margin:4px 0 0;color:#55636f">${m.waiting - m.followups} more waiting on others.</p>` : ''}`);
    text.push('EMAIL', ...m.toReply.map(x => `- Reply to ${x.who}: ${x.subject || ''}${x.reason ? ` (${x.reason})` : ''} · ${ago(x)}`), ...(m.followups ? [`- ${m.followups} sent email${m.followups === 1 ? '' : 's'} with no reply: follow-ups ready in Needs you`] : []), '');
  }
  const lp = d.loop || { count: 0, groups: [] };
  if (lp.count) {
    const line = (x) => `${x.from}${x.to ? ` to ${x.to}` : ''}: “${x.subject || '(no subject)'}”${x.messages > 1 ? ` (${x.messages} emails)` : ''}`;
    parts.push(`<h3 style="margin:18px 0 6px;font-size:17px">Kept in the loop: no action needed</h3><p style="margin:0 0 6px;color:#55636f">Emails you were copied on. They weren’t sent to you and don’t use your name, so nobody is waiting on you.</p>${lp.groups.map(g => `<p style="margin:8px 0 2px"><b>${esc(g.deal || 'Not on a project')}</b></p><ul style="margin:0;padding-left:18px">${g.items.map(x => `<li>${esc(line(x))}${x.snippet ? `<br><span style="color:#55636f">${esc(x.snippet.slice(0, 160))}</span>` : ''}<br><span style="color:#1d7a46;font-weight:bold">No action needed</span></li>`).join('')}</ul>`).join('')}`);
    text.push('KEPT IN THE LOOP: NO ACTION NEEDED', 'Emails you were copied on. Nobody is waiting on you.', ...lp.groups.flatMap(g => [`${g.deal || 'Not on a project'}:`, ...g.items.map(x => `- ${line(x)} · No action needed`)]), '');
  }
  if (d.inbox) { parts.push(`<p style="margin-top:18px">${d.inbox} item${d.inbox === 1 ? '' : 's'} waiting in Needs you.</p>`); text.push(`${d.inbox} item${d.inbox === 1 ? '' : 's'} waiting in Needs you.`, ''); }
  const first = String(name || '').split(/[\s@]/)[0];
  return {
    subject: `Your ${dayName}${d.visits.length ? `: ${d.visits.length} visit${d.visits.length === 1 ? '' : 's'}` : ''}${d.tasks.length ? `, ${d.tasks.length} to do` : ''}${m.toReply.length ? `, ${m.toReply.length} email${m.toReply.length === 1 ? '' : 's'} to answer` : ''}`.slice(0, 150),
    html: `<div style="font-family:Arial,sans-serif;font-size:17px;color:#14202b;max-width:560px;line-height:1.5"><p>Good morning${first ? ' ' + esc(first) : ''}, here’s your ${esc(dayName)} at ${esc(company)}.</p>${parts.join('')}<p style="margin-top:22px"><a href="${appUrl}/crm#needs">Open Eagle I CRM</a></p><p style="color:#55636f;font-size:14px">You can switch this email off from the Account menu in Eagle I CRM.</p></div>`,
    text: `Good morning${first ? ' ' + first : ''}, here’s your ${dayName} at ${company}.\n\n${text.join('\n')}\nOpen Eagle I CRM: ${appUrl}/crm\n\nYou can switch this email off from the Account menu.`
  };
}

async function processDigests({ now = new Date(), send = sendEmail, appUrl = require('./appUrl').appUrl() } = {}) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now).map(x => [x.type, x.value]));
  const hour = +p.hour % 24;
  if (p.weekday === 'Sun' || hour < 7 || hour >= 11) return { sent: 0 };
  const today = localDay(now);
  const users = (await query(
    `SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.permissions, u.crm_loop_digest_at, t.company_name FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE 'crm' = ANY(t.products) AND u.crm_digest_off = false AND (u.crm_digest_sent_on IS NULL OR u.crm_digest_sent_on < $1::date) LIMIT 200`, [today])).rows;
  let sent = 0;
  for (const u of users) {
    await query('UPDATE users SET crm_digest_sent_on = $2 WHERE id = $1', [u.id, today]);
    if (!EMAIL_RE.test(String(u.email || ''))) continue;
    try {
      const d = await digestFor(u, now);
      if (!d.visits.length && !d.tasks.length && !d.phases.length && !d.inbox && !(d.mail && (d.mail.toReply.length || d.mail.followups)) && !(d.loop && d.loop.count)) continue;
      await send({ to: u.email, ...renderDigest({ name: u.name || u.email, company: u.company_name, d, appUrl, now }) });
      if (d.loop && d.loop.count) await require('./crmEmailWatch').loopDigested(u.id, now);
      sent++;
    } catch (e) { console.error('[crmDaily] digest failed:', e.message); }
  }
  return { sent };
}
async function setDigest(userId, on) { await query('UPDATE users SET crm_digest_off = $2 WHERE id = $1', [userId, !on]); return { on: !!on }; }

// ---------- rain on outdoor work ----------

const OUTDOOR = /roof|framing|frame|concrete|foundation|slab|pour|siding|exterior|deck|patio|pergola|pool|landscap|grading|excavat|gutter|fence|driveway|stucco|masonry|brick|outdoor|demo/i;

async function geocode(prop) {
  if (prop.lat != null && prop.lon != null) return { lat: Number(prop.lat), lon: Number(prop.lon) };
  if (prop.geocoded_at && Date.now() - new Date(prop.geocoded_at) < 30 * 86400000) return null; // tried recently, nothing found
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(prop.address)}&benchmark=Public_AR_Current&format=json`;
  let at = null;
  try {
    const r = await http(url, { headers: { 'User-Agent': 'EagleI-CRM (weather alerts)' } });
    const j = await r.json();
    const m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
    if (m && m.coordinates) at = { lat: Math.round(m.coordinates.y * 1e6) / 1e6, lon: Math.round(m.coordinates.x * 1e6) / 1e6 };
  } catch (e) { console.error('[crmDaily] geocode failed:', e.message); return null; }
  await query('UPDATE crm_properties SET lat = $2, lon = $3, geocoded_at = now() WHERE id = $1', [prop.id, at && at.lat, at && at.lon]);
  return at;
}

// Daytime chance of rain by local day, from the NWS forecast for a point.
async function rainByDay({ lat, lon }) {
  const ua = { headers: { 'User-Agent': 'EagleI-CRM (weather alerts)', Accept: 'application/geo+json' } };
  const pt = await (await http(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, ua)).json();
  const url = pt && pt.properties && pt.properties.forecast;
  if (!url) return {};
  const fc = await (await http(url, ua)).json();
  const out = {};
  for (const per of (fc && fc.properties && fc.properties.periods) || []) {
    if (per.isDaytime === false) continue;
    const day = String(per.startTime).slice(0, 10);
    const pop = per.probabilityOfPrecipitation && per.probabilityOfPrecipitation.value;
    if (pop != null) out[day] = { chance: pop, words: per.shortForecast || '' };
  }
  return out;
}

let weatherDoneFor = null; // once a morning per server
async function scanWeather({ now = new Date(), days = 3, threshold = 60, force = false } = {}) {
  const hour = +new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(now) % 24;
  if (!force && (hour < 5 || hour >= 9)) return { flagged: 0 };
  const today = localDay(now), until = addDays(today, days);
  if (!force && weatherDoneFor === today) return { flagged: 0 };
  weatherDoneFor = today;
  const items = (await query(
    `SELECT i.id, i.title, i.start_date, i.end_date, d.id AS deal_id, d.tenant_id, d.title AS job, p.id AS prop_id, p.address, p.lat, p.lon, p.geocoded_at
     FROM crm_job_items i JOIN crm_deals d ON d.id = i.deal_id JOIN tenants t ON t.id = d.tenant_id JOIN crm_properties p ON p.id = d.property_id
     WHERE i.status <> 'done' AND i.start_date IS NOT NULL AND i.start_date <= $2::date AND COALESCE(i.end_date, i.start_date) >= $1::date
       AND d.stage IN ('signed', 'production') AND 'crm' = ANY(t.products) AND p.address IS NOT NULL LIMIT 300`, [today, until])).rows
    .filter(i => OUTDOOR.test(i.title));
  const forecasts = new Map();
  let flagged = 0;
  for (const it of items) {
    const at = await geocode({ id: it.prop_id, address: it.address, lat: it.lat, lon: it.lon, geocoded_at: it.geocoded_at });
    if (!at) continue;
    const key = `${at.lat.toFixed(2)},${at.lon.toFixed(2)}`;
    if (!forecasts.has(key)) { try { forecasts.set(key, await rainByDay(at)); } catch (e) { forecasts.set(key, {}); console.error('[crmDaily] forecast failed:', e.message); } }
    const fc = forecasts.get(key);
    const from = ymd(it.start_date) > today ? ymd(it.start_date) : today;
    const to = ymd(it.end_date || it.start_date) < until ? ymd(it.end_date || it.start_date) : until;
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const f = fc[day];
      if (!f || f.chance < threshold) continue;
      const label = new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
      const added = await crm.addInboxItem({ tenantId: it.tenant_id, dealId: it.deal_id, kind: 'weather', dedupeKey: `rain:${it.id}:${day}`, title: `${f.chance}% chance of rain ${label} during ${it.title} (${it.job})`, detail: `${f.words}. Worth a look at the schedule, and a heads-up to the crew and the homeowner if it moves.` });
      if (added) flagged++;
      break; // one alert per phase per morning
    }
  }
  return { flagged };
}

module.exports = { calendarToken, resetCalendarToken, buildIcs, calendarFor, digestFor, renderDigest, processDigests, setDigest, OUTDOOR, geocode, rainByDay, scanWeather, setHttp };
