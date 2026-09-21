// Past customers: import a list, browse it, and email it after review.
// See lib/customers.js for the safeguards.
const express = require('express');
const { requireAuth } = require('../auth');
const customers = require('../lib/customers');

const router = express.Router();
const sendError = (res, err, what) => (err && err.status
  ? res.status(err.status).json({ error: { message: err.message, code: err.code } })
  : res.status(500).json({ error: { message: `${what}: ${err.message}` } }));
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

router.get('/api/customers', requireAuth, async (req, res) => {
  try {
    res.json({
      ...(await customers.listCustomers(req.tenantId, { search: String(req.query.search || ''), limit: parseInt(req.query.limit, 10) || 50, offset: parseInt(req.query.offset, 10) || 0 })),
      dailyCap: customers.DAILY_CAP, sentLast24h: await customers.sentInLast24h(req.tenantId), attestation: customers.ATTESTATION, maxPerImport: customers.MAX_PER_IMPORT
    });
  } catch (err) { sendError(res, err, 'Failed to load customers'); }
});

router.post('/api/customers/import', requireAuth, async (req, res) => {
  try { res.json(await customers.importRows(req.tenantId, req.body && req.body.rows, { attested: req.body && req.body.attested })); }
  catch (err) { sendError(res, err, 'Import failed'); }
});

router.post('/api/customers/from-leads', requireAuth, async (req, res) => {
  try { res.json(await customers.importWonLeads(req.tenantId)); }
  catch (err) { sendError(res, err, 'Import failed'); }
});

router.post('/api/customers/delete', requireAuth, async (req, res) => {
  try { res.json({ deleted: await customers.deleteCustomers(req.tenantId, req.body || {}) }); }
  catch (err) { sendError(res, err, 'Delete failed'); }
});

router.get('/api/customers/templates', requireAuth, async (req, res) => {
  try { res.json({ templates: await customers.starterTemplates(req.tenantId) }); }
  catch (err) { sendError(res, err, 'Failed to load templates'); }
});

// Who would (and would not) be emailed. ids omitted means every customer.
router.post('/api/customers/campaign/preview', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : undefined;
    const { sendable, skipped } = await customers.screen(req.tenantId, ids);
    const used = await customers.sentInLast24h(req.tenantId);
    res.json({ sendable, skipped, dailyCap: customers.DAILY_CAP, remaining: Math.max(0, customers.DAILY_CAP - used) });
  } catch (err) { sendError(res, err, 'Preview failed'); }
});

router.post('/api/customers/campaign/test', requireAuth, async (req, res) => {
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: { message: 'Email is not configured on this server yet (missing RESEND_API_KEY).' } });
  try { res.json({ ok: true, ...(await customers.sendTest({ tenantId: req.tenantId, subject: req.body && req.body.subject, message: req.body && req.body.message, baseUrl: baseUrl(req) })) }); }
  catch (err) { sendError(res, err, 'Failed to send the preview'); }
});

// At most 25 per call; the browser sends a large list as several calls.
router.post('/api/customers/campaign/send', requireAuth, async (req, res) => {
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: { message: 'Email is not configured on this server yet (missing RESEND_API_KEY).' } });
  const b = req.body || {};
  try {
    res.json(await customers.sendBatch({
      tenantId: req.tenantId, ids: b.ids, subject: b.subject, message: b.message,
      campaignId: /^[0-9a-f-]{36}$/i.test(String(b.campaignId || '')) ? b.campaignId : undefined, baseUrl: baseUrl(req)
    }));
  } catch (err) { sendError(res, err, 'Send failed'); }
});

module.exports = router;
