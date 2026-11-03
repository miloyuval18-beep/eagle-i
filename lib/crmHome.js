// Home: the first screen of Eagle I CRM, one person's whole picture on one page.
//
//  - Needs you: what's flagged for them (urgent first), tasks that are overdue or due
//    today, and emails waiting on their reply.
//  - Reminders: the next few days: site visits, tasks, job phases starting, orders to
//    send and permits still waiting.
//  - Updates: what happened lately on their projects: activity, today's check-ins,
//    customers' and subs' emails, payments.
//  - The numbers for the tiles that jump to each tab.
// Each person sees only their own projects unless they can see all of them (lib/crmTeam.js).
const { query } = require('../db');
const crm = require('./crm');
const team = require('./crmTeam');

const DAY = 86400000;
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

async function home(user, { now = new Date() } = {}) {
  const t = user.tenant_id;
  const scope = await team.projectScope(t, user).catch(() => null); // null: every project
  const ids = scope ? [...scope] : null;
  const money = team.can(user, 'money');
  const inScope = (dealId) => !ids || !dealId || scope.has(dealId);

  const [inbox, tasks, visits, mail, fyi, phases, orders, permits, acts, checkins, mails, paid, counts] = await Promise.all([
    crm.listInbox(t, { now, user }),
    query(`SELECT k.id, k.title, k.due_at, k.deal_id, d.title AS deal FROM crm_tasks k LEFT JOIN crm_deals d ON d.id = k.deal_id
           WHERE k.tenant_id = $1 AND k.done_at IS NULL AND (k.assignee_user_id = $2 OR (k.assignee_user_id IS NULL AND $3::boolean))
             AND (k.due_at IS NULL OR k.due_at < $4::timestamptz + interval '4 days') ORDER BY k.due_at NULLS LAST LIMIT 40`, [t, user.id, team.isManager(user.role), now]).then(r => r.rows),
    query(`SELECT d.id, d.title, d.site_visit_at, c.name AS contact, p.address FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id
           WHERE d.tenant_id = $1 AND d.site_visit_at BETWEEN $3::timestamptz - interval '2 hours' AND $3::timestamptz + interval '7 days' AND d.stage NOT IN ('lost', 'complete')
             AND (COALESCE(d.site_visit_user_id, d.owner_user_id, $2) = $2 OR $4::boolean) ORDER BY d.site_visit_at LIMIT 10`, [t, user.id, now, team.can(user, 'see_all')]).then(r => r.rows),
    require('./crmEmailWatch').digestFor(user).catch(() => ({ toReply: [], waiting: 0, followups: 0 })),
    query(`SELECT COUNT(*)::int AS n FROM crm_mail_loop WHERE tenant_id = $1 AND user_id = $2 AND last_at > $3::timestamptz - interval '2 days'`, [t, user.id, now]).then(r => r.rows[0].n).catch(() => 0),
    query(`SELECT i.id, i.title, i.start_date, i.deal_id, d.title AS deal FROM crm_job_items i JOIN crm_deals d ON d.id = i.deal_id
           WHERE i.tenant_id = $1 AND i.status = 'todo' AND i.start_date BETWEEN ($2::timestamptz)::date AND ($2::timestamptz)::date + 7 AND d.stage NOT IN ('lost', 'complete')
             AND ($3::uuid[] IS NULL OR d.id = ANY($3::uuid[]) OR i.assignee_user_id = $4) ORDER BY i.start_date LIMIT 10`, [t, now, ids, user.id]).then(r => r.rows),
    team.can(user, 'subs') ? query(`SELECT o.id, o.title, o.order_by, o.deal_id, d.title AS deal, v.name AS vendor FROM crm_purchase_orders o JOIN crm_deals d ON d.id = o.deal_id LEFT JOIN crm_vendors v ON v.id = o.vendor_id
           WHERE o.tenant_id = $1 AND o.sent_at IS NULL AND o.status = 'draft' AND o.order_by IS NOT NULL AND o.order_by <= ($2::timestamptz)::date + 5
             AND ($3::uuid[] IS NULL OR d.id = ANY($3::uuid[])) ORDER BY o.order_by LIMIT 8`, [t, now, ids]).then(r => r.rows).catch(() => []) : [],
    query(`SELECT p.id, p.title, p.status, p.deal_id, d.title AS deal FROM crm_permits p JOIN crm_deals d ON d.id = p.deal_id
           WHERE p.tenant_id = $1 AND p.status IN ('needed', 'submitted', 'corrections') AND d.stage IN ('signed', 'production')
             AND ($2::uuid[] IS NULL OR d.id = ANY($2::uuid[])) ORDER BY p.status_changed_at NULLS FIRST LIMIT 8`, [t, ids]).then(r => r.rows).catch(() => []),
    query(`SELECT a.id, a.kind, a.actor, a.body, a.created_at, a.deal_id, d.title AS deal, u.name AS person FROM crm_activities a JOIN crm_deals d ON d.id = a.deal_id LEFT JOIN users u ON u.id = a.user_id
           WHERE a.tenant_id = $1 AND a.created_at > $2::timestamptz - interval '3 days' AND a.created_at <= $2 AND ($3::uuid[] IS NULL OR a.deal_id = ANY($3::uuid[]))
             -- History brought in (from Drive, an import, numbers entered after the fact): not news. A person's own notes are.
             AND NOT (a.kind = 'note' AND a.actor = 'owner' AND a.user_id IS NULL)
           ORDER BY a.created_at DESC LIMIT 25`, [t, now, ids]).then(r => r.rows),
    team.isManager(user.role) || team.can(user, 'reports') ? query(`SELECT c.id, c.summary, c.completed_at AS updated_at, u.name AS person FROM crm_checkins c JOIN users u ON u.id = c.user_id
           WHERE c.tenant_id = $1 AND c.status = 'done' AND c.day = ($2::timestamptz AT TIME ZONE 'America/Chicago')::date ORDER BY c.completed_at DESC NULLS LAST LIMIT 10`, [t, now]).then(r => r.rows).catch(() => []) : [],
    query(`SELECT t.id, t.counterpart_name, t.counterpart_email, t.subject, t.last_at, t.deal_id, d.title AS deal FROM crm_mail_threads t LEFT JOIN crm_deals d ON d.id = t.deal_id
           WHERE t.tenant_id = $1 AND t.user_id = $2 AND t.last_dir = 'in' AND t.last_at > $3::timestamptz - interval '2 days' AND (t.contact_id IS NOT NULL OR t.vendor_id IS NOT NULL OR t.deal_id IS NOT NULL)
           ORDER BY t.last_at DESC LIMIT 8`, [t, user.id, now]).then(r => r.rows).catch(() => []),
    money ? query(`SELECT i.id, i.title, i.amount, i.paid_at, i.deal_id, d.title AS deal FROM crm_invoices i JOIN crm_deals d ON d.id = i.deal_id
           WHERE i.tenant_id = $1 AND i.status = 'paid' AND i.paid_at > $2::timestamptz - interval '7 days' AND i.paid_at >= i.created_at - interval '1 hour' AND ($3::uuid[] IS NULL OR d.id = ANY($3::uuid[])) ORDER BY i.paid_at DESC LIMIT 5`, [t, now, ids]).then(r => r.rows).catch(() => []) : [],
    query(`SELECT COUNT(*) FILTER (WHERE stage NOT IN ('signed', 'production', 'complete', 'lost'))::int AS selling,
             COALESCE(SUM(value) FILTER (WHERE stage NOT IN ('signed', 'production', 'complete', 'lost')), 0)::float AS selling_value,
             COUNT(*) FILTER (WHERE stage IN ('signed', 'production'))::int AS jobs,
             COUNT(*) FILTER (WHERE stage = 'new' AND created_at > $2::timestamptz - interval '7 days')::int AS new_leads
           FROM crm_deals WHERE tenant_id = $1 AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`, [t, now, ids]).then(r => r.rows[0])
  ]);

  const today = new Date(now.getTime());
  const [y, m, d] = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }).split('-').map(Number);
  const endToday = new Date(require('./outreachQueue').zonedToUtc(y, m, d, 23, 59).getTime() + 59999);
  const overdue = tasks.filter(k => k.due_at && new Date(k.due_at) < today);
  const dueToday = tasks.filter(k => k.due_at && new Date(k.due_at) >= today && new Date(k.due_at) <= endToday);
  const soon = tasks.filter(k => k.due_at && new Date(k.due_at) > endToday);
  const URGENT = /^(negative_reply|unhappy|checkin_problem)$/;
  const flagged = inbox.filter(i => inScope(i.deal_id)).map(i => ({ id: i.id, kind: i.kind, title: i.title, detail: clip(i.detail, 240), dealId: i.deal_id, deal: i.deal_title, at: i.created_at,
    urgent: URGENT.test(i.kind) || /^Urgent/.test(i.title) }));
  flagged.sort((a, b) => (b.urgent - a.urgent) || new Date(b.at) - new Date(a.at));

  // What happened: newest first, the noise left out.
  const updates = [
    ...acts.filter(a => !/^(system)$/.test(a.kind) || /stage|signed|accepted|paid/i.test(a.body || '')).map(a => ({ at: a.created_at, icon: { lead_in: 'lead', email: 'mail', payment: 'money', stage: 'stage', note: 'note', file: 'file' }[a.kind] || 'note', text: clip(a.body, 200), who: a.actor === 'contact' ? 'Customer' : a.actor === 'eagle_i' ? 'Eagle I' : a.person || null, dealId: a.deal_id, deal: a.deal })),
    ...checkins.map(c => ({ at: c.updated_at, icon: 'checkin', text: clip((c.summary || {}).headline || 'Checked in', 200), who: c.person, link: 'checkin/team' })),
    ...mails.map(m => ({ at: m.last_at, icon: 'mail', text: `${clip(m.counterpart_name || m.counterpart_email, 80)} emailed: “${clip(m.subject, 120)}”`, dealId: m.deal_id, deal: m.deal })),
    ...paid.map(p => ({ at: p.paid_at, icon: 'money', text: `Paid: ${clip(p.title, 100)} · $${Math.round(Number(p.amount)).toLocaleString('en-US')}`, dealId: p.deal_id, deal: p.deal }))
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 14);

  return {
    needs: {
      flagged: flagged.slice(0, 8), flaggedTotal: flagged.length,
      overdue: overdue.slice(0, 6).map(k => ({ id: k.id, title: k.title, due: k.due_at, dealId: k.deal_id, deal: k.deal })), overdueTotal: overdue.length,
      today: dueToday.slice(0, 6).map(k => ({ id: k.id, title: k.title, due: k.due_at, dealId: k.deal_id, deal: k.deal })),
      toReply: (mail.toReply || []).slice(0, 4).map(x => ({ id: x.id, who: x.who, subject: x.subject, reason: x.reason, urgent: x.importance === 'urgent', days: x.days })), toReplyTotal: (mail.toReply || []).length,
      followups: mail.followups || 0
    },
    reminders: {
      visits: visits.map(v => ({ dealId: v.id, title: v.title, at: v.site_visit_at, contact: v.contact, address: v.address })),
      tasks: soon.slice(0, 6).map(k => ({ id: k.id, title: k.title, due: k.due_at, dealId: k.deal_id, deal: k.deal })),
      phases: phases.map(p => ({ title: p.title, start: p.start_date, dealId: p.deal_id, deal: p.deal })),
      orders: orders.map(o => ({ id: o.id, title: o.title, orderBy: o.order_by, vendor: o.vendor, dealId: o.deal_id, deal: o.deal })),
      permits: permits.map(p => ({ title: p.title, status: p.status, dealId: p.deal_id, deal: p.deal }))
    },
    updates,
    counts: { selling: counts.selling, sellingValue: money ? counts.selling_value : null, jobs: counts.jobs, newLeads: counts.new_leads, needsYou: flagged.length + overdue.length, toReply: (mail.toReply || []).length, fyi }
  };
}

module.exports = { home };
