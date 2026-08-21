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

module.exports = router;
