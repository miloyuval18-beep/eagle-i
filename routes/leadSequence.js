// The owner's settings for the automatic email sequence sent to new leads
// (see lib/leadSequence.js), and a preview that goes only to the owner.
const express = require('express');
const { requireAuth } = require('../auth');
const seq = require('../lib/leadSequence');
const { query } = require('../db');

const router = express.Router();
const sendError = (res, err, what) => (err && err.status
  ? res.status(err.status).json({ error: { message: err.message } })
  : res.status(500).json({ error: { message: `${what}: ${err.message}` } }));

router.get('/api/lead-sequence', requireAuth, async (req, res) => {
  try {
    const [settings, stats] = await Promise.all([seq.loadSettings(req.tenantId), seq.stats(req.tenantId)]);
    const saved = (await query('SELECT lead_sequence IS NOT NULL AS saved FROM business_profile WHERE tenant_id = $1', [req.tenantId])).rows[0];
    res.json({ ...settings, saved: !!(saved && saved.saved), stats, defaults: seq.defaultSteps(), maxSteps: seq.MAX_STEPS, maxPerDay: seq.MAX_PER_DAY });
  } catch (err) { sendError(res, err, 'Failed to load'); }
});

router.put('/api/lead-sequence', requireAuth, async (req, res) => {
  try {
    const { enabled, steps } = req.body || {};
    const saved = await seq.saveSettings(req.tenantId, { enabled, steps });
    // Switching it off (or shortening it) also stops anything already waiting.
    if (!saved.enabled) await query("UPDATE lead_sequence_sends SET status = 'cancelled', cancel_reason = 'switched_off' WHERE tenant_id = $1 AND status = 'pending'", [req.tenantId]);
    res.json({ ok: true, ...saved });
  } catch (err) { sendError(res, err, 'Failed to save'); }
});

router.post('/api/lead-sequence/preview', requireAuth, async (req, res) => {
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: { message: 'Email is not configured on this server yet (missing RESEND_API_KEY).' } });
  try {
    const out = await seq.sendPreview({ tenantId: req.tenantId, step: parseInt(req.body && req.body.step, 10) || 1, baseUrl: `${req.protocol}://${req.get('host')}` });
    res.json({ ok: true, to: out.to });
  } catch (err) { sendError(res, err, 'Failed to send the preview'); }
});

module.exports = router;
