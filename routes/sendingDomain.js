// A company's own sending domain (see lib/sendingDomain.js).
const express = require('express');
const { requireAuth } = require('../auth');
const sd = require('../lib/sendingDomain');

const router = express.Router();
const sendError = (res, err, what) => (err && err.status
  ? res.status(err.status).json({ error: { message: err.message } })
  : res.status(500).json({ error: { message: `${what}: ${err.message}` } }));

router.get('/api/sending-domain', requireAuth, async (req, res) => {
  try { res.json({ domain: await sd.getStatus(req.tenantId), configured: !!process.env.RESEND_API_KEY }); }
  catch (err) { sendError(res, err, 'Failed to load'); }
});

router.post('/api/sending-domain', requireAuth, async (req, res) => {
  try { res.json({ domain: await sd.addDomain(req.tenantId, req.body && req.body.domain, req.body && req.body.fromLocal) }); }
  catch (err) { sendError(res, err, 'Failed to add the domain'); }
});

// "Check now": asks Resend to look at the DNS records again.
router.post('/api/sending-domain/verify', requireAuth, async (req, res) => {
  try { res.json({ domain: await sd.refresh(req.tenantId) }); }
  catch (err) { sendError(res, err, 'Failed to check the domain'); }
});

router.patch('/api/sending-domain', requireAuth, async (req, res) => {
  try { res.json({ domain: await sd.setFromLocal(req.tenantId, req.body && req.body.fromLocal) }); }
  catch (err) { sendError(res, err, 'Failed to save'); }
});

router.delete('/api/sending-domain', requireAuth, async (req, res) => {
  try { res.json(await sd.removeDomain(req.tenantId)); }
  catch (err) { sendError(res, err, 'Failed to remove'); }
});

module.exports = router;
