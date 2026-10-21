// "Download all my data": everything the company keeps in Eagle I as
// spreadsheets (CSV files that open in Excel or Google Sheets), in one .zip.
// Files and photos stay on each job (and in Google Drive when connected).
const { query } = require('../db');
const { zip } = require('./zip');

// Excel-friendly CSV: quoted, with a BOM so accents survive; formulas defused.
function csv(rows) {
  if (!rows.length) return '﻿(none)\r\n';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (v == null) return '';
    let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

const SHEETS = [
  ['customers.csv', `SELECT c.name, c.email, c.phone, c.language, c.created_at FROM crm_contacts c WHERE c.tenant_id = $1 ORDER BY c.name`],
  ['deals.csv', `SELECT d.title, c.name AS customer, c.email, c.phone, p.address, d.stage, d.value, d.source, d.lost_reason, COALESCE(u.name, u.email) AS handled_by, d.site_visit_at, d.created_at, d.updated_at
     FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id LEFT JOIN users u ON u.id = d.owner_user_id WHERE d.tenant_id = $1 ORDER BY d.created_at`],
  ['tasks.csv', `SELECT t.title, d.title AS deal, COALESCE(u.name, u.email) AS assigned_to, t.due_at, t.done_at, t.created_at FROM crm_tasks t LEFT JOIN crm_deals d ON d.id = t.deal_id LEFT JOIN users u ON u.id = t.assignee_user_id WHERE t.tenant_id = $1 ORDER BY t.created_at`],
  ['job-schedules.csv', `SELECT d.title AS job, i.title AS phase, i.start_date, i.end_date, i.status, v.name AS sub, i.confirm_status AS sub_confirmed FROM crm_job_items i JOIN crm_deals d ON d.id = i.deal_id LEFT JOIN crm_vendors v ON v.id = i.vendor_id WHERE i.tenant_id = $1 ORDER BY d.title, i.position`],
  ['estimates.csv', `SELECT e.number, d.title AS deal, e.title, e.kind, e.status, e.subtotal, e.tax, e.total, e.valid_until, e.sent_at, e.created_at FROM crm_estimates e JOIN crm_deals d ON d.id = e.deal_id WHERE e.tenant_id = $1 ORDER BY e.number`],
  ['estimate-lines.csv', `SELECT e.number AS estimate, l.section, l.description, l.quantity, l.unit, l.unit_cost, l.markup_pct FROM crm_estimate_lines l JOIN crm_estimates e ON e.id = l.estimate_id WHERE e.tenant_id = $1 ORDER BY e.number, l.position`],
  ['invoices.csv', `SELECT i.number, d.title AS deal, i.kind, i.title, i.amount, i.status, i.due_date, i.sent_at, i.paid_at, i.paid_amount, i.paid_via FROM crm_invoices i JOIN crm_deals d ON d.id = i.deal_id WHERE i.tenant_id = $1 ORDER BY i.number`],
  ['change-orders.csv', `SELECT o.number, d.title AS job, o.title, o.description, o.amount, o.cost, o.days_added, o.status, o.approved_at, o.approved_name FROM crm_change_orders o JOIN crm_deals d ON d.id = o.deal_id WHERE o.tenant_id = $1 ORDER BY o.number`],
  ['purchase-orders.csv', `SELECT o.number, d.title AS job, v.name AS vendor, o.title, o.total, o.status, o.needed_by, o.sent_at FROM crm_purchase_orders o JOIN crm_deals d ON d.id = o.deal_id LEFT JOIN crm_vendors v ON v.id = o.vendor_id WHERE o.tenant_id = $1 ORDER BY o.number`],
  ['costs.csv', `SELECT d.title AS job, c.cost_date, c.category, c.description, c.amount, c.vendor_name AS paid_to, c.hours, c.rate FROM crm_costs c JOIN crm_deals d ON d.id = c.deal_id WHERE c.tenant_id = $1 ORDER BY c.cost_date`],
  ['subs-and-vendors.csv', `SELECT name, trade, contact_name, email, phone, license_no, insurance_expires, archived FROM crm_vendors WHERE tenant_id = $1 ORDER BY name`],
  ['calendar.csv', `SELECT e.title, e.kind, e.starts_at, e.ends_at, e.all_day, e.location, d.title AS deal, COALESCE(u.name, u.email, 'Everyone') AS whose FROM crm_events e LEFT JOIN crm_deals d ON d.id = e.deal_id LEFT JOIN users u ON u.id = e.user_id WHERE e.tenant_id = $1 ORDER BY e.starts_at`],
  ['site-logs.csv', `SELECT d.title AS job, l.log_date, l.body, l.crew, l.shared AS homeowner_can_see FROM crm_daily_logs l JOIN crm_deals d ON d.id = l.deal_id WHERE l.tenant_id = $1 ORDER BY l.log_date`],
  ['notes-and-history.csv', `SELECT d.title AS deal, a.kind, a.actor, a.body, a.created_at FROM crm_activities a JOIN crm_deals d ON d.id = a.deal_id WHERE a.tenant_id = $1 ORDER BY a.created_at`]
];

async function exportAll(tenantId, now = new Date()) {
  const co = (await query('SELECT company_name FROM tenants WHERE id = $1', [tenantId])).rows[0] || {};
  const files = [];
  for (const [name, sql] of SHEETS) {
    const rows = (await query(sql, [tenantId]).catch(e => { console.error('[crmExport]', name, e.message); return { rows: [] }; })).rows;
    files.push({ name, data: csv(rows) });
  }
  files.unshift({ name: 'READ ME.txt', data: `Everything ${co.company_name || 'your company'} keeps in Eagle I CRM, as of ${now.toLocaleString('en-US', { timeZone: 'America/Chicago' })} (Central time).\r\n\r\nEach .csv file opens in Excel, Numbers or Google Sheets.\r\nFiles and photos stay on each job in Eagle I (and in Google Drive when it's connected).\r\n` });
  return zip(files, now);
}

module.exports = { exportAll, csv, SHEETS };
