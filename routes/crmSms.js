// Texting and calls for Eagle I CRM (lib/crmSms.js).
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it). Twilio's webhooks (/api/twilio/*) carry no
// login; each request must carry Twilio's signature for the exact URL, or it
// is refused.
const express = require('express');
const { requireAuth } = require('../auth');
const sms = require('../lib/crmSms');
const team = require('../lib/crmTeam');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;

function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
function managersOnly(req, res, next) {
  if (team.isManager(req.crmUser && req.crmUser.role)) return next();
  res.status(403).json({ error: { message: 'Only the owner or an admin can change this.' } });
}

router.get('/api/crm/sms', requireAuth, async (req, res) => {
  try { res.json(await sms.status(req.tenantId)); } catch (err) { fail(res, err, 'Failed to load texting'); }
});

router.post('/api/crm/sms/number', requireAuth, managersOnly, async (req, res) => {
  try { res.json(await sms.provisionNumber({ tenantId: req.tenantId, areaCode: (req.body || {}).areaCode, baseUrl: baseUrlOf(req) })); } catch (err) { fail(res, err, 'Failed to get a number'); }
});

router.patch('/api/crm/sms/settings', requireAuth, managersOnly, async (req, res) => {
  const b = req.body || {};
  try { res.json(await sms.saveSettings({ tenantId: req.tenantId, forwardTo: b.forwardTo, missedCallText: b.missedCallText, approve: b.approve })); } catch (err) { fail(res, err, 'Failed to save'); }
});

router.get('/api/crm/deals/:id/messages', requireAuth, async (req, res) => {
  try { res.json(await sms.listMessages(req.tenantId, req.params.id)); } catch (err) { fail(res, err, 'Failed to load texts'); }
});

router.post('/api/crm/deals/:id/messages', requireAuth, async (req, res) => {
  try {
    const { query } = require('../db');
    const d = (await query('SELECT contact_id FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId])).rows[0];
    if (!d) return res.status(404).json({ error: { message: 'Deal not found.' } });
    res.json({ ok: true, ...(await sms.sendSms({ tenantId: req.tenantId, contactId: d.contact_id, dealId: req.params.id, body: (req.body || {}).body, userId: req.userId })) });
  } catch (err) { fail(res, err, 'Failed to send the text'); }
});

router.post('/api/crm/deals/:id/sms-consent', requireAuth, async (req, res) => {
  try { await sms.setConsent({ tenantId: req.tenantId, dealId: req.params.id, consent: !!(req.body || {}).consent }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to save'); }
});

// ---------- Twilio → Eagle I ----------

const form = express.urlencoded({ extended: false, limit: '64kb' });
function signed(handler) {
  return async (req, res) => {
    if (!sms.validSignature(`${baseUrlOf(req)}${req.originalUrl}`, req.body || {}, req.get('X-Twilio-Signature'))) return res.status(403).send('Bad signature.');
    try {
      res.type('text/xml').send(await handler(req.body || {}, { baseUrl: baseUrlOf(req) }));
    } catch (err) {
      console.error('[crmSms] webhook failed:', err.message);
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  };
}
router.post('/api/twilio/sms', form, signed(sms.handleIncomingSms));
router.post('/api/twilio/voice', form, signed(sms.handleIncomingCall));
router.post('/api/twilio/call-done', form, signed(sms.callFinished));

module.exports = router;
