// Platform-admin, read-only visibility across all tenants. Deliberately NOT
// impersonation — an admin can view any tenant's data here, but every other
// route in the app still resolves req.tenantId from the admin's own session,
// so an admin account can never take actions (post, publish, delete, bill)
// as another tenant.
const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();

router.get('/api/admin/tenants', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT t.id, t.company_name, t.industry, t.plan_tier, t.created_at,
              u.email AS owner_email, u.email_verified,
              (bp.generated_content != '{}'::jsonb) AS onboarded,
              (SELECT count(*) FROM leads l WHERE l.tenant_id = t.id) AS lead_count,
              (SELECT count(*) FROM users u2 WHERE u2.tenant_id = t.id) AS user_count
       FROM tenants t
       LEFT JOIN business_profile bp ON bp.tenant_id = t.id
       LEFT JOIN LATERAL (
         SELECT email, email_verified FROM users WHERE tenant_id = t.id ORDER BY created_at ASC LIMIT 1
       ) u ON true
       ORDER BY t.created_at DESC`
    );
    res.json({ tenants: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load tenants: ' + err.message } });
  }
});

router.get('/api/admin/tenants/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const tenantRes = await query('SELECT * FROM tenants WHERE id = $1', [req.params.id]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });

    const [profile, users, leads, landingPage, scheduledPosts, socialConnections, reviewRequests] = await Promise.all([
      query('SELECT * FROM business_profile WHERE tenant_id = $1', [req.params.id]),
      query('SELECT id, email, email_verified, created_at FROM users WHERE tenant_id = $1', [req.params.id]),
      query('SELECT id, name, status, created_at FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50', [req.params.id]),
      query('SELECT slug, status, headline, updated_at FROM landing_pages WHERE tenant_id = $1', [req.params.id]),
      query('SELECT id, status, scheduled_at FROM scheduled_posts WHERE tenant_id = $1 ORDER BY scheduled_at DESC LIMIT 20', [req.params.id]),
      query('SELECT platform, page_name, ig_username, connected_at FROM social_connections WHERE tenant_id = $1', [req.params.id]),
      query('SELECT customer_name, status, created_at FROM review_requests WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20', [req.params.id])
    ]);

    res.json({
      tenant: tenantRes.rows[0],
      profile: profile.rows[0] || null,
      users: users.rows,
      leads: leads.rows,
      landingPage: landingPage.rows[0] || null,
      scheduledPosts: scheduledPosts.rows,
      socialConnections: socialConnections.rows,
      reviewRequests: reviewRequests.rows
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load tenant snapshot: ' + err.message } });
  }
});

// ---------- Eagle I CRM: every company, and a view-only look inside ----------
// Opening one puts its CRM in this admin's browser exactly as its owner sees it,
// but read only (auth.js blocks every change while looking). Each look is written
// in that company's activity log.
router.get('/api/admin/crm', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = (await query(
      `SELECT t.id, t.company_name, t.created_at, t.slug,
              (SELECT email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY u.created_at LIMIT 1) AS owner_email,
              (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.disabled_at IS NULL) AS people,
              (SELECT COUNT(*)::int FROM crm_deals d WHERE d.tenant_id = t.id AND d.stage NOT IN ('signed', 'production', 'complete', 'lost')) AS selling,
              (SELECT COUNT(*)::int FROM crm_deals d WHERE d.tenant_id = t.id AND d.stage IN ('signed', 'production')) AS jobs,
              (SELECT COUNT(*)::int FROM crm_deals d WHERE d.tenant_id = t.id) AS deals,
              (SELECT COUNT(*)::int FROM crm_subsidiaries s WHERE s.tenant_id = t.id AND s.archived_at IS NULL) AS companies,
              (SELECT MAX(a.created_at) FROM crm_activities a WHERE a.tenant_id = t.id) AS last_activity
       FROM tenants t WHERE 'crm' = ANY(t.products) ORDER BY (t.slug IS NOT NULL) DESC, t.created_at DESC`)).rows;
    res.json({ companies: rows, viewing: req.session.viewAs || null, mode: req.session.viewMode || null });
  } catch (err) { res.status(500).json({ error: { message: 'Failed to load the CRM companies: ' + err.message } }); }
});
router.post('/api/admin/view-as', requireAuth, requireAdmin, async (req, res) => {
  try {
    const t = (await query(`SELECT id, company_name FROM tenants WHERE id::text = $1 AND 'crm' = ANY(products)`, [String((req.body || {}).tenantId || '')])).rows[0];
    if (!t) return res.status(404).json({ error: { message: 'Company not found.' } });
    const edit = (req.body || {}).mode === 'edit';
    req.session.viewAs = t.id;
    req.session.viewMode = edit ? 'edit' : 'view';
    delete req.session.viewRole; delete req.session.viewUser;
    await new Promise((ok) => req.session.save(() => ok()));
    const me = (await query('SELECT email FROM users WHERE id = $1', [req.userId])).rows[0] || {};
    await require('../lib/crmAudit').log({ tenantId: t.id, actor: null, action: 'settings', detail: edit ? `The Eagle I admin (${me.email || 'Eagle I'}) opened the CRM with full access to make changes` : `The Eagle I admin (${me.email || 'Eagle I'}) looked at the CRM (view only)` }).catch(() => {});
    res.json({ ok: true, go: '/crm/app', company: t.company_name, mode: edit ? 'edit' : 'view' });
  } catch (err) { res.status(500).json({ error: { message: 'Failed to open it: ' + err.message } }); }
});
// "See as": which role the admin sees the company's CRM as (owner, admin, project manager…).
router.post('/api/admin/view-as/role', requireAuth, requireAdmin, async (req, res) => {
  const role = String((req.body || {}).role || '');
  if (!req.session.viewAs) return res.status(400).json({ error: { message: 'Open a company from the admin page first.' } });
  // One of the company's people ("user:<id>"): exactly what they see, view only (nothing done as them).
  const m = /^user:([0-9a-f-]{36})$/i.exec(role);
  if (m) {
    const p = (await query(`SELECT id, name, email FROM users WHERE id = $1 AND tenant_id = $2 AND disabled_at IS NULL AND app <> 'marketing'`, [m[1], req.session.viewAs])).rows[0];
    if (!p) return res.status(404).json({ error: { message: 'That person isn’t on this company’s team.' } });
    req.session.viewUser = p.id; req.session.viewMode = 'view';
    await new Promise((ok) => req.session.save(() => ok()));
    await require('../lib/crmAudit').log({ tenantId: req.session.viewAs, actor: null, action: 'settings', detail: `The Eagle I admin looked at the CRM as ${p.name || p.email} sees it (view only)` }).catch(() => {});
    return res.json({ ok: true, role, mode: 'view' });
  }
  if (!require('../lib/crmTeam').ROLES.includes(role)) return res.status(400).json({ error: { message: 'Pick a role.' } });
  req.session.viewRole = role; delete req.session.viewUser;
  await new Promise((ok) => req.session.save(() => ok()));
  res.json({ ok: true, role });
});
router.post('/api/admin/view-as/exit', requireAuth, async (req, res) => {
  delete req.session.viewAs; delete req.session.viewMode; delete req.session.viewRole; delete req.session.viewUser;
  await new Promise((ok) => req.session.save(() => ok()));
  res.json({ ok: true, go: '/admin' });
});

module.exports = router;
