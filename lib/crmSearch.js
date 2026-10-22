// One search box for the whole CRM: deals and the people on them (name,
// email, phone, address), subs and vendors, invoices and estimates (by number
// or title), files, tasks, calendar entries and the person's own chats.
// Each result says what it is and where tapping it goes.
const { query } = require('../db');

const like = (q) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
const stageLabel = (k) => (require('./crm').STAGES.find(s => s.key === k) || {}).label || k;

async function search({ tenantId, userId, manager = false, seeMoney = true, q }) {
  const words = String(q || '').trim().slice(0, 100);
  if (words.length < 2) return { q: words, results: [] };
  const L = like(words), digits = words.replace(/\D/g, ''), num = /^#?\d{1,7}$/.test(words) ? parseInt(words.replace('#', ''), 10) : null;
  const P = [tenantId, L];
  const run = (sql, params = P) => query(sql, params).then(r => r.rows).catch(() => []);
  const [deals, vendors, invoices, estimates, files, tasks, events, chats] = await Promise.all([
    run(`SELECT d.id, d.title, d.stage, c.name, c.email, c.phone, p.address FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id LEFT JOIN crm_properties p ON p.id = d.property_id
         WHERE d.tenant_id = $1 AND (d.title ILIKE $2 OR c.name ILIKE $2 OR c.email ILIKE $2 OR p.address ILIKE $2
           OR (length($3) >= 4 AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE '%' || $3 || '%'))
         ORDER BY (d.stage = 'lost'), d.updated_at DESC LIMIT 12`, [tenantId, L, digits]),
    run(`SELECT id, name, trade, email, phone FROM crm_vendors WHERE tenant_id = $1 AND NOT archived AND (name ILIKE $2 OR trade ILIKE $2 OR email ILIKE $2 OR contact_name ILIKE $2) ORDER BY name LIMIT 8`),
    run(`SELECT i.id, i.number, i.title, i.amount, i.status, i.deal_id, d.title AS deal FROM crm_invoices i JOIN crm_deals d ON d.id = i.deal_id
         WHERE i.tenant_id = $1 AND (i.title ILIKE $2 OR ($3::int IS NOT NULL AND i.number = $3)) ORDER BY i.created_at DESC LIMIT 6`, [tenantId, L, num]),
    run(`SELECT e.id, e.number, e.title, e.status, e.deal_id, d.title AS deal FROM crm_estimates e JOIN crm_deals d ON d.id = e.deal_id
         WHERE e.tenant_id = $1 AND (e.title ILIKE $2 OR ($3::int IS NOT NULL AND e.number = $3)) ORDER BY e.created_at DESC LIMIT 6`, [tenantId, L, num]),
    run(`SELECT f.id, f.filename, f.deal_id, d.title AS deal FROM crm_files f JOIN crm_deals d ON d.id = f.deal_id WHERE f.tenant_id = $1 AND f.filename ILIKE $2 ORDER BY f.created_at DESC LIMIT 8`),
    run(`SELECT t.id, t.title, t.done_at, t.deal_id, d.title AS deal FROM crm_tasks t LEFT JOIN crm_deals d ON d.id = t.deal_id WHERE t.tenant_id = $1 AND t.title ILIKE $2 ORDER BY (t.done_at IS NOT NULL), t.created_at DESC LIMIT 6`),
    run(`SELECT id, title, starts_at FROM crm_events WHERE tenant_id = $1 AND title ILIKE $2 AND (user_id IS NULL OR user_id = $3 OR $4) ORDER BY starts_at DESC LIMIT 6`, [tenantId, L, userId, !!manager]),
    run(`SELECT id, title, updated_at FROM crm_ai_threads WHERE tenant_id = $1 AND user_id = $3 AND title ILIKE $2 ORDER BY updated_at DESC LIMIT 5`, [tenantId, L, userId])
  ]);
  const said = { draft: 'Draft (not sent)', sent: 'Sent', viewed: 'Opened', accepted: 'Signed', declined: 'Declined', paid: 'Paid', void: 'Cancelled' };
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const results = [
    ...deals.map(d => ({ type: 'deal', id: d.id, title: d.title, sub: [d.name, d.address, stageLabel(d.stage)].filter(Boolean).join(' · ') })),
    ...vendors.map(v => ({ type: 'vendor', id: v.id, title: v.name, sub: [v.trade, v.phone, v.email].filter(Boolean).join(' · ') })),
    ...(seeMoney ? invoices : []).map(i => ({ type: 'invoice', id: i.id, dealId: i.deal_id, title: `Invoice #${i.number}: ${i.title}`, sub: `${money(i.amount)} · ${said[i.status] || i.status} · ${i.deal}` })),
    ...estimates.map(e => ({ type: 'estimate', id: e.id, dealId: e.deal_id, title: `Estimate #${e.number}: ${e.title}`, sub: `${said[e.status] || e.status} · ${e.deal}` })),
    ...files.map(f => ({ type: 'file', id: f.id, dealId: f.deal_id, title: f.filename, sub: f.deal })),
    ...tasks.map(t => ({ type: 'task', id: t.id, dealId: t.deal_id, title: t.title, sub: [t.done_at ? 'Done' : 'To do', t.deal].filter(Boolean).join(' · ') })),
    ...events.map(e => ({ type: 'event', id: e.id, title: e.title, sub: new Date(e.starts_at).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })),
    ...chats.map(c => ({ type: 'chat', id: c.id, title: c.title || 'Chat', sub: 'Your chat with Eagle I' }))
  ];
  return { q: words, results };
}

module.exports = { search };
