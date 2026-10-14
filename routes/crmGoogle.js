// Google Workspace email for Eagle I CRM (lib/crmGoogle.js). Mounted after
// routes/crm.js, so every route here already requires a signed-in person at a
// company that has the CRM. Connecting, choosing mailboxes and disconnecting
// are for the owner or an admin.
const express = require('express');
const { requireAuth } = require('../auth');
const google = require('../lib/crmGoogle');
const team = require('../lib/crmTeam');

const router = express.Router();

function fail(res, err, what) {
  const status = err.status || 500;
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
function managersOnly(req, res, next) {
  if (team.isManager(req.crmUser && req.crmUser.role)) return next();
  res.status(403).json({ error: { message: 'Only the owner or an admin can change this.' } });
}

router.get('/api/crm/google', requireAuth, async (req, res) => {
  try { res.json(await google.getStatus(req.tenantId)); } catch (err) { fail(res, err, 'Failed to load Google Workspace'); }
});

router.post('/api/crm/google/connect', requireAuth, managersOnly, async (req, res) => {
  const { domain, adminEmail } = req.body || {};
  try {
    const r = await google.connect({ tenantId: req.tenantId, domain, adminEmail, userId: req.userId });
    // Start reading right away instead of waiting for the next background run.
    google.processGoogleSync({ onlyTenantId: req.tenantId }).catch(e => console.error('[crmGoogle] first sync failed:', e.message));
    res.json({ ok: true, ...r });
  } catch (err) { fail(res, err, 'Failed to connect Google Workspace'); }
});

router.patch('/api/crm/google/mailboxes/:id', requireAuth, managersOnly, async (req, res) => {
  try {
    if (!(await google.setIncluded({ tenantId: req.tenantId, id: req.params.id, included: (req.body || {}).included }))) return res.status(404).json({ error: { message: 'Mailbox not found.' } });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to save'); }
});

router.post('/api/crm/google/sync', requireAuth, managersOnly, async (req, res) => {
  try { res.json({ ok: true, ...(await google.processGoogleSync({ onlyTenantId: req.tenantId })) }); } catch (err) { fail(res, err, 'Failed to read email'); }
});

router.delete('/api/crm/google', requireAuth, managersOnly, async (req, res) => {
  try { await google.disconnect(req.tenantId); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to disconnect'); }
});

module.exports = router;
