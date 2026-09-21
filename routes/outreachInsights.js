// Results and organisation around vendor outreach: the results report, sorting
// a reply by hand, and the relationship tracker (stage / notes / next follow-up).
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { getReport } = require('../lib/outreachReport');
const relationships = require('../lib/relationships');
const { CATEGORIES } = require('../lib/replyClassifier');
const { cancelFollowUps } = require('../lib/followUps');
const { cancelQueued } = require('../lib/outreachQueue');
const monthly = require('../lib/monthlyReport');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sendError = (res, err, what) => {
  if (err && err.status) return res.status(err.status).json({ error: { message: err.message } });
  return res.status(500).json({ error: { message: `${what}: ${err.message}` } });
};

router.get('/api/vendors/outreach-report', requireAuth, async (req, res) => {
  try { res.json(await getReport(req.tenantId, { days: req.query.days })); }
  catch (err) { sendError(res, err, 'Failed to build the report'); }
});

// Re-sort a reply by hand when the automatic sorting got it wrong.
router.patch('/api/vendors/outreach/:id/reply-category', requireAuth, async (req, res) => {
  const category = req.body && req.body.category;
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: { message: 'Unknown category.' } });
  try {
    const r = await query(
      `UPDATE vendor_outreach SET reply_category = $3, reply_category_by = 'user'
       WHERE id = $1 AND tenant_id = $2 AND (reply_text IS NOT NULL OR replied_at IS NOT NULL) RETURNING to_email`,
      [req.params.id, req.tenantId, category]);
    if (!r.rows.length) return res.status(404).json({ error: { message: 'No reply found for that email.' } });
    if (category === 'unsubscribe') {
      await query(
        `INSERT INTO outreach_suppressions (tenant_id, email, reason) VALUES ($1, $2, 'unsubscribed')
         ON CONFLICT (tenant_id, lower(email)) DO NOTHING`, [req.tenantId, r.rows[0].to_email]);
      await cancelFollowUps(req.tenantId, r.rows[0].to_email, 'opted_out');
      await cancelQueued(req.tenantId, r.rows[0].to_email, 'opted_out');
    }
    res.json({ ok: true, category });
  } catch (err) { sendError(res, err, 'Failed to update the reply'); }
});

// ---- Relationship tracker ----------------------------------------------

router.get('/api/relationships', requireAuth, async (req, res) => {
  try {
    const [rows, summary] = await Promise.all([
      relationships.list(req.tenantId, { stage: String(req.query.stage || ''), due: req.query.due === '1' }),
      relationships.summary(req.tenantId)
    ]);
    res.json({ relationships: rows, summary, stages: relationships.STAGES.map(s => ({ key: s, label: relationships.STAGE_LABELS[s] })) });
  } catch (err) { sendError(res, err, 'Failed to load your vendors'); }
});

router.post('/api/relationships', requireAuth, async (req, res) => {
  try { res.json({ relationship: await relationships.upsert(req.tenantId, req.body || {}) }); }
  catch (err) { sendError(res, err, 'Failed to save'); }
});

router.patch('/api/relationships/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try { res.json({ relationship: await relationships.updateById(req.tenantId, id, req.body || {}) }); }
  catch (err) { sendError(res, err, 'Failed to save'); }
});

router.delete('/api/relationships/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    const n = await relationships.remove(req.tenantId, id);
    if (!n) return res.status(404).json({ error: { message: 'Not found.' } });
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Failed to remove'); }
});

// ---- Monthly results report ----------------------------------------------

router.get('/api/reports/monthly', requireAuth, async (req, res) => {
  const month = req.query.month ? String(req.query.month) : monthly.previousMonthKey();
  try {
    const report = await monthly.buildReport(req.tenantId, month);
    const t = await query('SELECT company_name FROM tenants WHERE id = $1', [req.tenantId]);
    res.json({ report, sections: monthly.renderReport({ companyName: t.rows[0] && t.rows[0].company_name, report, categoryLabels: await monthly.categoryLabels() }), companyName: t.rows[0] && t.rows[0].company_name });
  } catch (err) { sendError(res, err, 'Failed to build the report'); }
});

router.post('/api/reports/monthly/email', requireAuth, async (req, res) => {
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: { message: 'Email is not configured on this server yet (missing RESEND_API_KEY).' } });
  const month = (req.body && req.body.month) ? String(req.body.month) : monthly.previousMonthKey();
  try {
    const out = await monthly.emailReport(req.tenantId, month, { appUrl: `${req.protocol}://${req.get('host')}` });
    if (!out.sent) return res.status(400).json({ error: { message: 'Add an email address to your Company Profile first.' } });
    res.json({ ok: true, to: out.to });
  } catch (err) { sendError(res, err, 'Failed to email the report'); }
});

module.exports = router;
