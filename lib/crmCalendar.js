// The team calendar, in Eagle I CRM.
//
// Nobody has to keep it up to date: it's read from everything that already
// has a date in Eagle I:
//  - site visits, job phases (with the sub, whether they confirmed, and rain
//    in the forecast), tasks;
//  - deliveries (purchase orders' "needed by"), invoices due, selections the
//    homeowner has to make, bids due from subs, estimates about to expire,
//    automatic emails about to go out, follow-ups due on emails nobody has
//    answered, sub insurance running out, warranties ending and home care due;
//  - meetings, inspections and other appointments: added by hand or by the
//    assistant, or found in the team's email by Eagle I (lib/crmEmailWatch.js);
//  - and, for anyone who switches it on, their own Google Calendar.
// Two things at the same time for one person, or a sub booked on two jobs at
// once, are flagged.
//
// Who sees what: everyone sees their own (what they're on, what's on their
// deals, and company-wide appointments); the owner and admins can look at
// everyone's or one person's. A Google Calendar is only ever shown to its owner.
const { query } = require('../db');

const TZ = 'America/Chicago';
const DAY_RE = require('./day'); // real days only (not 2026-02-30)
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const KINDS = ['meeting', 'inspection', 'delivery', 'walkthrough', 'other'];
const MAX_DAYS = 62;
const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';

function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const localDay = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: TZ });
// DATE columns arrive as midnight in the server's own time zone.
const dateOnly = (d) => !d ? null : d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10);
const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const zoned = (day, h = 0, m = 0) => require('./outreachQueue').zonedToUtc(...day.split('-').map(Number), h, m);
const dayOf = (t) => localDay(new Date(t));
const iso = (t) => new Date(t).toISOString();
function addBusinessDays(day, n) {
  let d = day, left = n;
  for (let i = 0; i < 40 && left > 0; i++) { d = addDays(d, 1); const w = new Date(d + 'T12:00:00Z').getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return d;
}

// Every kind of thing on the calendar, in the order the filters show them.
const TYPES = {
  visit: 'Site visits', event: 'Meetings & inspections', phase: 'Job schedule', task: 'Tasks', delivery: 'Deliveries',
  money: 'Payments due', selection: 'Selections due', bid: 'Bids due', estimate: 'Estimates expiring',
  email: 'Automatic emails', followup: 'Email follow-ups', compliance: 'Insurance & warranties', google: 'Google Calendar'
};

// Whose calendar: { pid } is one person (null = everyone), { manager } if the viewer may see everyone.
async function scope({ tenantId, viewer, who }) {
  const manager = require('./crmTeam').isManager(viewer.role);
  const w = String(who || 'me');
  if (w === 'me' || w === viewer.id) return { pid: viewer.id, manager, mine: true };
  if (!manager) throw err('Only the owner or an admin can look at other people’s calendars.', 403);
  if (w === 'all') return { pid: null, manager, mine: false };
  const u = (await query('SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [/^[0-9a-f-]{36}$/.test(w) ? w : null, tenantId])).rows[0];
  if (!u) throw err('No one on the team with that id.', 404);
  return { pid: u.id, manager, mine: false };
}

function span(from, to, maxDays = MAX_DAYS) {
  const today = localDay();
  const f = DAY_RE.test(String(from || '')) ? from : today;
  let t = DAY_RE.test(String(to || '')) ? to : addDays(f, 6);
  if (t < f) throw err('The end of the range is before the start.');
  if ((new Date(t) - new Date(f)) / 86400000 > maxDays) t = addDays(f, maxDays);
  return { from: f, to: t, start: zoned(f), end: zoned(addDays(t, 1)) };
}

async function range({ tenantId, viewer, from, to, who = 'me', types = null, maxDays = MAX_DAYS, google = true, http = fetch }) {
  const { pid, manager, mine } = await scope({ tenantId, viewer, who });
  const w = span(from, to, maxDays);
  const want = (t) => !types || types.includes(t);
  // For "my calendar", an owner or admin also gets what's on nobody's plate.
  const orphans = mine && manager;
  const P = [tenantId, w.start, w.end, w.from, w.to, pid, orphans];
  // A deal is "mine" when I own it (or, for a manager looking at their own, nobody does).
  const DEAL_MINE = `($6::uuid IS NULL OR d.owner_user_id = $6 OR ($7::boolean AND d.owner_user_id IS NULL))`;
  const items = [];
  const push = (x) => items.push({ warn: null, done: false, ...x });
  // Each query gets only the parameters it uses, renumbered.
  const run = (sql) => {
    const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
    return query(sql.replace(/\$(\d+)/g, (m, n) => '$' + (used.indexOf(Number(n)) + 1)), used.map(n => P[n - 1]));
  };

  const jobs = [];
  if (want('visit')) jobs.push(run(
    `SELECT d.id, d.title, d.site_visit_at, d.stage, c.name, c.phone, p.address, u.id AS uid, COALESCE(u.name, u.email) AS who
     FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id LEFT JOIN users u ON u.id = COALESCE(d.site_visit_user_id, d.owner_user_id)
     WHERE d.tenant_id = $1 AND d.site_visit_at >= $2 AND d.site_visit_at < $3 AND d.stage <> 'lost'
       AND ($6::uuid IS NULL OR COALESCE(d.site_visit_user_id, d.owner_user_id) = $6 OR ($7::boolean AND COALESCE(d.site_visit_user_id, d.owner_user_id) IS NULL))`).then(r => r.rows.forEach(v => push({
    key: `visit-${v.id}-${new Date(v.site_visit_at).getTime()}`, type: 'visit', id: v.id, title: `Site visit: ${v.name}`, sub: v.title,
    start: iso(v.site_visit_at), end: iso(new Date(v.site_visit_at).getTime() + 3600000), allDay: false, dealId: v.id, deal: v.title,
    location: v.address, phone: v.phone, who: v.who, whoId: v.uid, edit: 'visit'
  }))));
  if (want('phase')) jobs.push(run(
    `SELECT i.id, i.title, i.start_date, i.end_date, i.status, i.vendor_id, i.confirm_status, i.confirm_note, d.id AS deal_id, d.title AS job, p.address, v.name AS sub, v.phone AS sub_phone,
            u.id AS uid, COALESCE(u.name, u.email) AS who
     FROM crm_job_items i JOIN crm_deals d ON d.id = i.deal_id LEFT JOIN crm_properties p ON p.id = d.property_id LEFT JOIN crm_vendors v ON v.id = i.vendor_id
       LEFT JOIN users u ON u.id = COALESCE(i.assignee_user_id, d.owner_user_id)
     WHERE i.tenant_id = $1 AND i.start_date IS NOT NULL AND i.start_date <= $5::date AND COALESCE(i.end_date, i.start_date) >= $4::date AND d.stage IN ('signed', 'production', 'complete')
       AND ($6::uuid IS NULL OR i.assignee_user_id = $6 OR d.owner_user_id = $6 OR ($7::boolean AND i.assignee_user_id IS NULL AND d.owner_user_id IS NULL))`).then(r => r.rows.forEach(i => push({
    key: `phase-${i.id}`, type: 'phase', id: i.id, title: i.title, sub: [i.job, i.sub].filter(Boolean).join(' · '),
    start: dateOnly(i.start_date), end: dateOnly(i.end_date || i.start_date), allDay: true, dealId: i.deal_id, deal: i.job, location: i.address,
    who: i.who, whoId: i.uid, vendorId: i.vendor_id, vendor: i.sub, vendorPhone: i.sub_phone, status: i.status, done: i.status === 'done',
    confirm: i.confirm_status || null, edit: 'phase',
    warn: i.status === 'done' ? null : i.confirm_status === 'conflict' ? `${i.sub || 'The sub'} can’t make these dates${i.confirm_note ? `: “${clip(i.confirm_note, 120)}”` : ''}` : null
  }))));
  if (want('task')) jobs.push(run(
    `SELECT t.id, t.title, t.due_at, t.done_at, t.source, d.id AS deal_id, d.title AS deal, u.id AS uid, COALESCE(u.name, u.email) AS who
     FROM crm_tasks t LEFT JOIN crm_deals d ON d.id = t.deal_id LEFT JOIN users u ON u.id = t.assignee_user_id
     WHERE t.tenant_id = $1 AND t.due_at >= $2 AND t.due_at < $3 AND (t.done_at IS NULL OR t.done_at > now() - interval '14 days')
       AND ($6::uuid IS NULL OR t.assignee_user_id = $6 OR ($7::boolean AND t.assignee_user_id IS NULL))`).then(r => r.rows.forEach(t => push({
    key: `task-${t.id}`, type: 'task', id: t.id, title: t.title, sub: t.deal, start: iso(t.due_at), end: iso(t.due_at), allDay: false, point: true,
    dealId: t.deal_id, deal: t.deal, who: t.who, whoId: t.uid, done: !!t.done_at, edit: 'task', auto: t.source === 'auto',
    warn: !t.done_at && new Date(t.due_at) < new Date() ? 'Overdue' : null
  }))));
  if (want('event')) jobs.push(run(
    `SELECT e.*, d.title AS deal, u.id AS uid, COALESCE(u.name, u.email) AS who FROM crm_events e LEFT JOIN crm_deals d ON d.id = e.deal_id LEFT JOIN users u ON u.id = e.user_id
     WHERE e.tenant_id = $1 AND e.starts_at < $3 AND e.ends_at > $2 AND ($6::uuid IS NULL OR e.user_id = $6 OR e.user_id IS NULL)`).then(r => r.rows.forEach(e => push({
    key: `event-${e.id}`, type: 'event', kind: e.kind, id: e.id, title: e.title, sub: e.deal || null,
    start: e.all_day ? dayOf(e.starts_at) : iso(e.starts_at), end: e.all_day ? dayOf(new Date(e.ends_at).getTime() - 1) : iso(e.ends_at), allDay: e.all_day,
    dealId: e.deal_id, deal: e.deal, location: e.location, notes: e.notes, who: e.uid ? e.who : 'Everyone', whoId: e.uid, source: e.source, edit: 'event',
    fromEmail: e.source === 'email' ? e.mail_thread_id : null
  }))));
  if (want('delivery')) jobs.push(run(
    `SELECT po.id, po.number, po.title, po.needed_by, po.status, d.id AS deal_id, d.title AS deal, p.address, v.name AS vendor
     FROM crm_purchase_orders po JOIN crm_deals d ON d.id = po.deal_id LEFT JOIN crm_properties p ON p.id = d.property_id LEFT JOIN crm_vendors v ON v.id = po.vendor_id
     WHERE po.tenant_id = $1 AND po.needed_by BETWEEN $4::date AND $5::date AND po.status IN ('draft', 'sent', 'received') AND ${DEAL_MINE}`).then(r => r.rows.forEach(o => push({
    key: `po-${o.id}`, type: 'delivery', id: o.id, title: `Delivery: ${o.title}`, sub: [o.vendor, o.deal].filter(Boolean).join(' · '), start: dateOnly(o.needed_by), end: dateOnly(o.needed_by), allDay: true,
    dealId: o.deal_id, deal: o.deal, location: o.address, done: o.status === 'received',
    warn: o.status === 'draft' ? `PO #${o.number} hasn’t been sent to ${o.vendor || 'the supplier'} yet` : null
  }))));
  if (want('money')) jobs.push(run(
    `SELECT i.id, i.number, i.title, i.amount, i.due_date, i.status, d.id AS deal_id, d.title AS deal, c.name
     FROM crm_invoices i JOIN crm_deals d ON d.id = i.deal_id JOIN crm_contacts c ON c.id = d.contact_id
     WHERE i.tenant_id = $1 AND i.due_date BETWEEN $4::date AND $5::date AND i.status IN ('draft', 'sent', 'paid') AND ${DEAL_MINE}`).then(r => r.rows.forEach(i => push({
    key: `inv-${i.id}`, type: 'money', id: i.id, title: `Payment due: $${Number(i.amount).toLocaleString('en-US', { maximumFractionDigits: 0 })} from ${i.name}`, sub: `Invoice #${i.number} · ${i.title}`,
    start: dateOnly(i.due_date), end: dateOnly(i.due_date), allDay: true, dealId: i.deal_id, deal: i.deal, done: i.status === 'paid',
    warn: i.status === 'draft' ? 'Not sent yet' : i.status === 'sent' && dateOnly(i.due_date) < localDay() ? 'Past due' : null
  }))));
  if (want('selection')) jobs.push(run(
    `SELECT s.id, s.category, s.due_date, s.chosen_index, d.id AS deal_id, d.title AS deal, c.name FROM crm_selections s JOIN crm_deals d ON d.id = s.deal_id JOIN crm_contacts c ON c.id = d.contact_id
     WHERE s.tenant_id = $1 AND s.due_date BETWEEN $4::date AND $5::date AND d.stage NOT IN ('lost') AND ${DEAL_MINE}`).then(r => r.rows.forEach(s => push({
    key: `sel-${s.id}`, type: 'selection', id: s.id, title: `${s.name} picks ${s.category}`, sub: s.deal, start: dateOnly(s.due_date), end: dateOnly(s.due_date), allDay: true,
    dealId: s.deal_id, deal: s.deal, done: s.chosen_index != null, warn: s.chosen_index == null && dateOnly(s.due_date) < localDay() ? 'Still not chosen' : null
  }))));
  if (want('bid')) jobs.push(run(
    `SELECT b.id, b.due_date, b.status, b.scope, v.name AS vendor, d.id AS deal_id, d.title AS deal FROM crm_bid_requests b JOIN crm_vendors v ON v.id = b.vendor_id JOIN crm_deals d ON d.id = b.deal_id
     WHERE b.tenant_id = $1 AND b.due_date BETWEEN $4::date AND $5::date AND b.status IN ('sent', 'viewed', 'submitted', 'awarded') AND ${DEAL_MINE}`).then(r => r.rows.forEach(b => push({
    key: `bid-${b.id}`, type: 'bid', id: b.id, title: `Bid due: ${b.vendor}`, sub: [clip(b.scope, 60), b.deal].filter(Boolean).join(' · '), start: dateOnly(b.due_date), end: dateOnly(b.due_date), allDay: true,
    dealId: b.deal_id, deal: b.deal, done: ['submitted', 'awarded'].includes(b.status), warn: ['sent', 'viewed'].includes(b.status) && dateOnly(b.due_date) < localDay() ? 'No price yet' : null
  }))));
  if (want('estimate')) jobs.push(run(
    `SELECT e.id, e.number, e.title, e.valid_until, e.total, d.id AS deal_id, d.title AS deal, c.name FROM crm_estimates e JOIN crm_deals d ON d.id = e.deal_id JOIN crm_contacts c ON c.id = d.contact_id
     WHERE e.tenant_id = $1 AND e.valid_until BETWEEN $4::date AND $5::date AND e.status = 'sent' AND d.stage <> 'lost' AND ${DEAL_MINE}`).then(r => r.rows.forEach(e => push({
    key: `est-${e.id}`, type: 'estimate', id: e.id, title: `Estimate expires: ${e.name}`, sub: `#${e.number} · ${e.title}`, start: dateOnly(e.valid_until), end: dateOnly(e.valid_until), allDay: true,
    dealId: e.deal_id, deal: e.deal
  }))));
  if (want('email')) jobs.push(run(
    `SELECT s.id, s.due_at, s.step, pb.name AS playbook, pb.steps, d.id AS deal_id, d.title AS deal, c.name
     FROM crm_playbook_sends s JOIN crm_playbooks pb ON pb.id = s.playbook_id JOIN crm_deals d ON d.id = s.deal_id JOIN crm_contacts c ON c.id = d.contact_id
     WHERE s.tenant_id = $1 AND s.status = 'pending' AND pb.enabled AND s.due_at >= GREATEST($2, now()) AND s.due_at < $3 AND ${DEAL_MINE}`).then(r => r.rows.forEach(s => {
    const step = Array.isArray(s.steps) ? s.steps[s.step - 1] : null;
    push({ key: `send-${s.id}`, type: 'email', id: s.id, title: `Email to ${s.name}: ${clip(step && step.subject, 70) || s.playbook}`, sub: `${s.playbook} · ${s.deal}`,
      start: iso(s.due_at), end: iso(s.due_at), allDay: false, point: true, dealId: s.deal_id, deal: s.deal });
  })));
  if (want('compliance') && (manager || pid)) {
    if (manager && (pid === null || orphans)) jobs.push(run(
      `SELECT id, name, trade, insurance_expires FROM crm_vendors WHERE tenant_id = $1 AND NOT archived AND insurance_expires BETWEEN $4::date AND $5::date`).then(r => r.rows.forEach(v => push({
      key: `ins-${v.id}`, type: 'compliance', id: v.id, vendorId: v.id, title: `Insurance runs out: ${v.name}`, sub: v.trade, start: dateOnly(v.insurance_expires), end: dateOnly(v.insurance_expires), allDay: true,
      warn: dateOnly(v.insurance_expires) < localDay() ? 'Expired' : null
    }))));
    jobs.push(run(
      `SELECT h.id, h.name, h.warranty_until, h.next_care_at, h.care_note, d.id AS deal_id, d.title AS deal, c.name AS homeowner
       FROM crm_home_items h JOIN crm_deals d ON d.id = h.deal_id JOIN crm_contacts c ON c.id = d.contact_id
       WHERE h.tenant_id = $1 AND (h.warranty_until BETWEEN $4::date AND $5::date OR h.next_care_at BETWEEN $4::date AND $5::date) AND ${DEAL_MINE}`).then(r => r.rows.forEach(h => {
      const wu = dateOnly(h.warranty_until), nc = dateOnly(h.next_care_at);
      if (wu && wu >= w.from && wu <= w.to) push({ key: `war-${h.id}`, type: 'compliance', id: h.id, title: `Warranty ends: ${h.name}`, sub: `${h.homeowner} · ${h.deal}`, start: wu, end: wu, allDay: true, dealId: h.deal_id, deal: h.deal });
      if (nc && nc >= w.from && nc <= w.to) push({ key: `care-${h.id}-${nc}`, type: 'compliance', id: h.id, title: `Home care: ${h.name}`, sub: `${h.homeowner}${h.care_note ? ' · ' + clip(h.care_note, 60) : ''}`, start: nc, end: nc, allDay: true, dealId: h.deal_id, deal: h.deal });
    })));
  }
  // Emails we sent with no answer: when the follow-up is due. A person's email is only theirs to see.
  if (want('followup') && pid) jobs.push((async () => {
    const watch = require('./crmEmailWatch');
    const s = await watch.settings(tenantId);
    if (!s.on) return;
    const rows = (await query(`SELECT id, counterpart_name, counterpart_email, subject, reason, last_at, deal_id FROM crm_mail_threads WHERE tenant_id = $1 AND user_id = $2 AND state = 'waiting' AND status = 'open' AND (snooze_until IS NULL OR snooze_until < now())`, [tenantId, pid])).rows;
    for (const t of rows) {
      const due = addBusinessDays(dayOf(t.last_at), s.followUpDays);
      const day = due < localDay() ? localDay() : due;
      if (day < w.from || day > w.to) continue;
      push({ key: `fu-${t.id}`, type: 'followup', id: String(t.id), title: `Follow up: ${t.counterpart_name || t.counterpart_email}`, sub: clip(t.reason || t.subject, 90), start: day, end: day, allDay: true, dealId: t.deal_id, warn: due < localDay() ? 'No reply yet' : null });
    }
  })());
  // Rain in the forecast on outdoor work (lib/crmDaily.js's morning check).
  const rain = (await query(`SELECT dedupe_key, title FROM crm_inbox WHERE tenant_id = $1 AND kind = 'weather' AND created_at > now() - interval '10 days'`, [tenantId])).rows;
  const done = await Promise.allSettled(jobs);
  const failed = done.find(x => x.status === 'rejected');
  if (failed) throw failed.reason;

  let googleError = null;
  if (want('google') && mine && google) {
    const g = await googleEvents({ tenantId, userId: viewer.id, start: w.start, end: w.end, http }).catch(e => ({ error: e.message, events: [] }));
    for (const e of g.events) push(e);
    googleError = g.error || null;
  }
  return { from: w.from, to: w.to, today: localDay(), items: finish(items, rain), googleError };
}

// Rain, double-bookings and the order things show in.
function finish(items, rain = []) {
  for (const r of rain) {
    const m = /^rain:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/.exec(r.dedupe_key || ''); if (!m) continue;
    const it = items.find(i => i.type === 'phase' && i.id === m[1]); if (!it || it.done) continue;
    const pct = /^(\d+)%/.exec(r.title || '');
    (it.rain = it.rain || []).push({ day: m[2], chance: pct ? Number(pct[1]) : null });
  }
  // An email-found appointment that's also on their Google Calendar shows once.
  const g = items.filter(i => i.type === 'google');
  const dupe = (e) => e.type === 'event' && e.source === 'email' && g.some(x => !x.allDay && !e.allDay && x.start === e.start);
  const out = items.filter(i => !dupe(i));
  // One person in two places at once.
  const timed = out.filter(i => !i.allDay && !i.point && !i.done && i.whoId).map(i => ({ i, s: new Date(i.start).getTime(), e: new Date(i.end).getTime() }));
  for (let a = 0; a < timed.length; a++) for (let b = a + 1; b < timed.length; b++) {
    const x = timed[a], y = timed[b];
    if (!x.i.whoId || x.i.whoId !== y.i.whoId || !(x.s < y.e && y.s < x.e)) continue;
    x.i.clash = `Same time as ${y.i.title}`; y.i.clash = `Same time as ${x.i.title}`;
  }
  // A sub booked on two jobs on the same days.
  const ph = out.filter(i => i.type === 'phase' && i.vendorId && !i.done);
  for (let a = 0; a < ph.length; a++) for (let b = a + 1; b < ph.length; b++) {
    const x = ph[a], y = ph[b];
    if (x.vendorId !== y.vendorId || x.dealId === y.dealId || !(x.start <= y.end && y.start <= x.end)) continue;
    x.clash = `${x.vendor} is also on ${y.deal} (${y.title})`; y.clash = `${y.vendor} is also on ${x.deal} (${x.title})`;
  }
  const sortKey = (i) => i.allDay ? `${i.start} 0` : `${dayOf(i.start)} 1${i.start}`;
  return out.sort((a, b) => sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);
}

// ---------- the person's own Google Calendar ----------

const gcache = new Map();
async function calendarMailbox(tenantId, userId) {
  const u = (await query('SELECT email FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId])).rows[0];
  if (!u) return null;
  const conn = (await query('SELECT kind, status FROM crm_google_connections WHERE tenant_id = $1', [tenantId])).rows[0];
  const signedIn = (await query(`SELECT id, email, refresh_token_enc, scopes FROM crm_mailboxes WHERE tenant_id = $1 AND connected_by = $2 AND refresh_token_enc IS NOT NULL AND scopes LIKE '%auth/calendar%' ORDER BY id LIMIT 1`, [tenantId, userId])).rows[0];
  if (signedIn) return signedIn;
  // Through Google Workspace (once the admin allows the calendar scope for Eagle I).
  if (conn && conn.kind === 'workspace' && conn.status === 'connected' && require('./crmGoogle').serviceAccount()) {
    const box = (await query(`SELECT id, email FROM crm_mailboxes WHERE tenant_id = $1 AND lower(email) = lower($2)`, [tenantId, u.email])).rows[0];
    if (box) return { ...box, workspace: true };
  }
  return null;
}
async function googleStatus(tenantId, userId) {
  const m = await calendarMailbox(tenantId, userId);
  const google = require('./crmGoogle');
  const conn = (await query('SELECT kind FROM crm_google_connections WHERE tenant_id = $1', [tenantId])).rows[0];
  return { on: !!m, email: m ? m.email : null, workspace: !!(m && m.workspace), canSignIn: !!google.oauthClient() && !(conn && conn.kind === 'workspace') };
}
async function googleEvents({ tenantId, userId, start, end, http = fetch }) {
  const m = await calendarMailbox(tenantId, userId);
  if (!m) return { events: [] };
  const key = `${tenantId}|${userId}|${start.getTime()}|${end.getTime()}`;
  const hit = gcache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const google = require('./crmGoogle');
  const token = await google.mailboxToken(m, CAL_SCOPE, { http });
  const events = [];
  let pageToken = '';
  for (let page = 0; page < 4; page++) {
    const u = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    u.searchParams.set('timeMin', start.toISOString()); u.searchParams.set('timeMax', end.toISOString());
    u.searchParams.set('singleEvents', 'true'); u.searchParams.set('orderBy', 'startTime'); u.searchParams.set('maxResults', '250');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await http(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw err(r.status === 403 ? 'Google didn’t allow reading your calendar. Switch it on again from the Calendar page.' : `Google Calendar didn’t answer (${r.status}).`, 502);
    for (const e of body.items || []) {
      if (e.status === 'cancelled' || !e.start) continue;
      const me = (e.attendees || []).find(a => a.self);
      if (me && me.responseStatus === 'declined') continue;
      const allDay = !!e.start.date;
      events.push({
        key: `g-${e.id}`, type: 'google', id: e.id, title: clip(e.summary || '(busy)', 140), sub: null,
        start: allDay ? e.start.date : iso(e.start.dateTime), end: allDay ? addDays(e.end && e.end.date ? e.end.date : e.start.date, -1) : iso((e.end && e.end.dateTime) || e.start.dateTime),
        allDay, location: clip(e.location, 200) || null, who: 'You', whoId: userId, link: /^https:\/\/www\.google\.com\/calendar\//.test(e.htmlLink || '') ? e.htmlLink : null
      });
    }
    pageToken = body.nextPageToken || '';
    if (!pageToken) break;
  }
  const v = { events };
  gcache.set(key, { v, exp: Date.now() + 5 * 60000 });
  if (gcache.size > 500) gcache.delete(gcache.keys().next().value);
  return v;
}

// ---------- appointments ----------

async function canTouchDeal(tenantId, dealId) {
  if (!dealId) return null;
  const d = (await query('SELECT id FROM crm_deals WHERE id = $1 AND tenant_id = $2', [/^[0-9a-f-]{36}$/.test(String(dealId)) ? dealId : null, tenantId])).rows[0];
  if (!d) throw err('That deal isn’t at this company.', 404);
  return d.id;
}
// { title, kind, date, time, endTime | minutes, allDay, endDate, dealId, userId ('' = everyone), location, notes }
function timesOf(b) {
  if (!DAY_RE.test(String(b.date || ''))) throw err('Pick a day.');
  if (b.allDay || !b.time) {
    const last = DAY_RE.test(String(b.endDate || '')) && b.endDate >= b.date ? b.endDate : b.date;
    return { startsAt: zoned(b.date), endsAt: zoned(addDays(last, 1)), allDay: true };
  }
  const t = TIME_RE.exec(String(b.time)); if (!t) throw err('Pick a time like 14:30.');
  const startsAt = zoned(b.date, Number(t[1]), Number(t[2]));
  let endsAt;
  const e = TIME_RE.exec(String(b.endTime || ''));
  if (e) endsAt = zoned(b.date, Number(e[1]), Number(e[2]));
  else endsAt = new Date(startsAt.getTime() + Math.min(12 * 60, Math.max(15, parseInt(b.minutes, 10) || 60)) * 60000);
  if (endsAt <= startsAt) throw err('It ends before it starts.');
  return { startsAt, endsAt, allDay: false };
}
async function personOk(tenantId, userId) {
  if (!userId) return null;
  const u = (await query('SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [/^[0-9a-f-]{36}$/.test(String(userId)) ? userId : null, tenantId])).rows[0];
  if (!u) throw err('That person isn’t on the team.', 404);
  return u.id;
}
async function createEvent({ tenantId, actor, body, source = 'manual', sourceKey = null, mailThreadId = null }) {
  const b = body || {};
  const title = clip(b.title, 160);
  if (!title) throw err('Say what it is.');
  const kind = KINDS.includes(b.kind) ? b.kind : 'meeting';
  const { startsAt, endsAt, allDay } = timesOf(b);
  const manager = actor && require('./crmTeam').isManager(actor.role);
  // Members add their own; the owner or an admin can put it on anyone's, or everyone's.
  let userId = b.userId === undefined ? (actor ? actor.id : null) : b.userId || null;
  if (actor && !manager && userId !== actor.id) throw err('You can add to your own calendar; ask the owner or an admin to put it on someone else’s.', 403);
  userId = await personOk(tenantId, userId);
  const dealId = await canTouchDeal(tenantId, b.dealId);
  // No place given: it's at the job.
  const location = clip(b.location, 300) || (dealId ? ((await query('SELECT p.address FROM crm_deals d LEFT JOIN crm_properties p ON p.id = d.property_id WHERE d.id = $1', [dealId])).rows[0] || {}).address || null : null);
  const r = (await query(
    `INSERT INTO crm_events (tenant_id, deal_id, user_id, kind, title, starts_at, ends_at, all_day, location, notes, source, source_key, mail_thread_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (tenant_id, source_key) WHERE source_key IS NOT NULL DO NOTHING RETURNING *`,
    [tenantId, dealId, userId, kind, title, startsAt, endsAt, allDay, location, String(b.notes || '').trim().slice(0, 2000) || null, source, sourceKey, mailThreadId, actor ? actor.id : null])).rows[0];
  if (r && dealId && source !== 'email') await require('./crm').logActivity({ tenantId, dealId, kind: 'system', userId: actor ? actor.id : null, body: `On the calendar: ${title}, ${startsAt.toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', ...(allDay ? {} : { hour: 'numeric', minute: '2-digit' }) })}` }).catch(() => {});
  return r || null;
}
async function ownEvent(tenantId, actor, id) {
  const e = (await query('SELECT * FROM crm_events WHERE id = $1 AND tenant_id = $2', [/^[0-9a-f-]{36}$/.test(String(id)) ? id : null, tenantId])).rows[0];
  if (!e) throw err('That’s not on the calendar.', 404);
  if (!require('./crmTeam').isManager(actor.role) && e.user_id !== actor.id && e.created_by !== actor.id) throw err('Only the person it belongs to, the owner or an admin can change it.', 403);
  return e;
}
async function updateEvent({ tenantId, actor, id, body }) {
  const e = await ownEvent(tenantId, actor, id);
  const cur = { title: e.title, kind: e.kind, date: dayOf(e.starts_at), time: e.all_day ? null : new Date(e.starts_at).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }), minutes: Math.round((new Date(e.ends_at) - new Date(e.starts_at)) / 60000), allDay: e.all_day, endDate: e.all_day ? dayOf(new Date(e.ends_at).getTime() - 1) : null, location: e.location, notes: e.notes, dealId: e.deal_id, userId: e.user_id };
  const b = { ...cur, ...(body || {}) };
  if (body && ('date' in body || 'time' in body) && !('endTime' in body) && !('minutes' in body)) b.minutes = cur.minutes;
  if (body && 'date' in body && !('endDate' in body) && cur.allDay) b.endDate = addDays(body.date, Math.round((new Date(cur.endDate) - new Date(cur.date)) / 86400000));
  const title = clip(b.title, 160); if (!title) throw err('Say what it is.');
  const { startsAt, endsAt, allDay } = timesOf(b);
  const manager = require('./crmTeam').isManager(actor.role);
  let userId = b.userId || null;
  if (!manager && userId !== actor.id && userId !== e.user_id) throw err('Only the owner or an admin can move it to someone else.', 403);
  userId = await personOk(tenantId, userId);
  return (await query(
    `UPDATE crm_events SET title = $3, kind = $4, starts_at = $5, ends_at = $6, all_day = $7, location = $8, notes = $9, deal_id = $10, user_id = $11, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [e.id, tenantId, title, KINDS.includes(b.kind) ? b.kind : e.kind, startsAt, endsAt, allDay, clip(b.location, 300) || null, String(b.notes || '').trim().slice(0, 2000) || null, await canTouchDeal(tenantId, b.dealId), userId])).rows[0];
}
async function deleteEvent({ tenantId, actor, id }) {
  const e = await ownEvent(tenantId, actor, id);
  await query('DELETE FROM crm_events WHERE id = $1', [e.id]);
  return true;
}

// Moving something already on the calendar to another day (and time).
async function move({ tenantId, actor, type, id, date, time = null, baseUrl = '' }) {
  if (!DAY_RE.test(String(date || ''))) throw err('Pick a day.');
  if (time && !TIME_RE.test(String(time))) throw err('Pick a time like 14:30.');
  const manager = require('./crmTeam').isManager(actor.role);
  const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const at = (day, hm) => { const [h, m] = hm.split(':').map(Number); return zoned(day, h, m); };
  if (type === 'event') return updateEvent({ tenantId, actor, id, body: time ? { date, time } : { date } });
  if (type === 'task') {
    const t = (await query('SELECT * FROM crm_tasks WHERE id = $1 AND tenant_id = $2', [/^[0-9a-f-]{36}$/.test(String(id)) ? id : null, tenantId])).rows[0];
    if (!t) throw err('Task not found.', 404);
    if (!manager && t.assignee_user_id && t.assignee_user_id !== actor.id) throw err('That task is someone else’s.', 403);
    return require('./crmTasks').updateTask({ tenantId, id: t.id, patch: { dueAt: at(date, time || (t.due_at ? hhmm(t.due_at) : '17:00')).toISOString() }, userId: actor.id });
  }
  if (type === 'visit') {
    const d = (await query('SELECT id, site_visit_at, site_visit_user_id, owner_user_id FROM crm_deals WHERE id = $1 AND tenant_id = $2', [/^[0-9a-f-]{36}$/.test(String(id)) ? id : null, tenantId])).rows[0];
    if (!d || !d.site_visit_at) throw err('No site visit to move.', 404);
    const whose = d.site_visit_user_id || d.owner_user_id;
    if (!manager && whose && whose !== actor.id) throw err('That visit is someone else’s.', 403);
    const when = at(date, time || hhmm(d.site_visit_at));
    if (when < new Date()) throw err('That time has already passed.');
    await require('./crm').updateDeal({ tenantId, dealId: d.id, patch: { siteVisitAt: when.toISOString() }, baseUrl, userId: actor.id });
    return { ok: true };
  }
  if (type === 'phase') {
    const i = (await query('SELECT i.*, d.owner_user_id FROM crm_job_items i JOIN crm_deals d ON d.id = i.deal_id WHERE i.id = $1 AND i.tenant_id = $2', [/^[0-9a-f-]{36}$/.test(String(id)) ? id : null, tenantId])).rows[0];
    if (!i) throw err('Phase not found.', 404);
    if (!manager && i.assignee_user_id !== actor.id && i.owner_user_id !== actor.id) throw err('That phase isn’t yours to move.', 403);
    const s = dateOnly(i.start_date) || date, e = dateOnly(i.end_date) || s;
    const len = Math.round((new Date(e) - new Date(s)) / 86400000);
    // The sub is asked to confirm the new dates (lib/crmSubs.js).
    return require('./crmJobs').saveItem({ tenantId, dealId: i.deal_id, id: i.id, userId: actor.id, body: { title: i.title, startDate: date, endDate: addDays(date, len), status: i.status, vendorId: i.vendor_id, assigneeUserId: i.assignee_user_id, showHomeowner: i.show_homeowner } });
  }
  throw err('That can’t be moved from the calendar.');
}

// An appointment Eagle I found in an email ({title, date, time, minutes, location, kind}).
async function fromEmail({ tenantId, thread, appt }) {
  if (!appt || !DAY_RE.test(String(appt.date || '')) || appt.date < localDay()) return null;
  const time = TIME_RE.test(String(appt.time || '')) ? appt.time : null;
  const title = clip(appt.title, 140) || clip(`With ${thread.counterpart_name || thread.counterpart_email}`, 140);
  const body = { title, kind: KINDS.includes(appt.kind) ? appt.kind : 'meeting', date: appt.date, time, minutes: appt.minutes, allDay: !time, location: appt.location, dealId: thread.deal_id || null, userId: thread.user_id || null,
    notes: `Found in email with ${thread.counterpart_name ? `${thread.counterpart_name} <${thread.counterpart_email}>` : thread.counterpart_email}: “${clip(thread.subject, 160)}”` };
  return createEvent({ tenantId, actor: null, body, source: 'email', sourceKey: `mail:${thread.id}:${appt.date}${time ? 'T' + time : ''}`, mailThreadId: thread.id }).catch(e => { console.error('[crmCalendar] email event failed:', e.message); return null; });
}

module.exports = { TYPES, KINDS, CAL_SCOPE, range, finish, addBusinessDays, createEvent, updateEvent, deleteEvent, move, fromEmail, googleStatus, googleEvents };
