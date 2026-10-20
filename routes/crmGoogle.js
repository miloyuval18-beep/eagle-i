// Google Workspace email for Eagle I CRM (lib/crmGoogle.js). Mounted after
// routes/crm.js, so every route here already requires a signed-in person at a
// company that has the CRM. Connecting, choosing mailboxes and disconnecting
// are for the owner or an admin.
const express = require('express');
const { requireAuth } = require('../auth');
const google = require('../lib/crmGoogle');
const team = require('../lib/crmTeam');
const { query } = require('../db');

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
  try { res.json(await google.getStatus(req.tenantId, req.userId)); } catch (err) { fail(res, err, 'Failed to load Google Workspace'); }
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

// "Sign in with Google": anyone connects their own Gmail; only the owner or an admin adds Drive.
const redirectUri = (req) => process.env.GOOGLE_CRM_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/crm/google/oauth/callback`;
router.get('/api/crm/google/oauth/start', requireAuth, async (req, res) => {
  try {
    const wantDrive = req.query.drive === '1';
    if (wantDrive && !team.isManager(req.crmUser && req.crmUser.role)) return res.redirect('/crm?google_error=' + encodeURIComponent('Only the owner or an admin can connect Google Drive.') + '#company');
    res.redirect(await google.signInUrl({ tenantId: req.tenantId, userId: req.userId, wantDrive, redirectUri: redirectUri(req) }));
  } catch (err) { res.redirect('/crm?google_error=' + encodeURIComponent(err.message) + '#company'); }
});
router.get('/api/crm/google/oauth/callback', requireAuth, async (req, res) => {
  if (req.query.error) return res.redirect('/crm?google_error=' + encodeURIComponent(req.query.error === 'access_denied' ? 'Google sign-in was cancelled.' : String(req.query.error)) + '#company');
  try {
    const r = await google.finishSignIn({ tenantId: req.tenantId, userId: req.userId, code: req.query.code, state: req.query.state, redirectUri: redirectUri(req) });
    // Start reading right away; switch Drive on if that's what they came for.
    google.processGoogleSync({ onlyTenantId: req.tenantId }).catch(e => console.error('[crmGoogle] first sync failed:', e.message));
    let drive = '';
    if (r.drive && r.wantedDrive) {
      try { await require('../lib/crmDrive').enable(req.tenantId); drive = '&drive=on'; } catch (e) { drive = '&google_error=' + encodeURIComponent(e.message); }
    } else if (r.wantedDrive && !r.drive) drive = '&google_error=' + encodeURIComponent('Google Drive wasn’t allowed, so files stay in Eagle I. Sign in again and tick the Drive box to keep them in Drive.');
    res.redirect(`/crm?google=${encodeURIComponent(r.email)}${drive}#company`);
  } catch (err) { res.redirect('/crm?google_error=' + encodeURIComponent(err.message) + '#company'); }
});
router.delete('/api/crm/google/mailboxes/:id', requireAuth, async (req, res) => {
  try {
    const own = (await query('SELECT connected_by FROM crm_mailboxes WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]).catch(() => ({ rows: [] }))).rows[0];
    if (!own) return res.status(404).json({ error: { message: 'Mailbox not found.' } });
    if (own.connected_by !== req.userId && !team.isManager(req.crmUser && req.crmUser.role)) return res.status(403).json({ error: { message: 'Only the person who connected it, the owner or an admin can remove it.' } });
    await google.removeMailbox({ tenantId: req.tenantId, id: req.params.id });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to remove it'); }
});

// Project files in Google Drive (lib/crmDrive.js).
router.get('/api/crm/drive', requireAuth, async (req, res) => {
  try { res.json(await require('../lib/crmDrive').status(req.tenantId)); } catch (err) { fail(res, err, 'Failed to load Google Drive'); }
});
router.post('/api/crm/drive/enable', requireAuth, managersOnly, async (req, res) => {
  try {
    const st = await require('../lib/crmDrive').enable(req.tenantId);
    require('../lib/crmDrive').processDriveSync().catch(e => console.error('[crmDrive] first sync failed:', e.message));
    res.json(st);
  } catch (err) { fail(res, err, 'Failed to switch on Google Drive'); }
});
router.post('/api/crm/drive/disable', requireAuth, managersOnly, async (req, res) => {
  try { res.json(await require('../lib/crmDrive').disable(req.tenantId)); } catch (err) { fail(res, err, 'Failed'); }
});
router.post('/api/crm/drive/sync', requireAuth, managersOnly, async (req, res) => {
  try { const r = await require('../lib/crmDrive').processDriveSync(); res.json({ ok: true, ...r, status: await require('../lib/crmDrive').status(req.tenantId) }); } catch (err) { fail(res, err, 'Failed to sync'); }
});

router.delete('/api/crm/google', requireAuth, managersOnly, async (req, res) => {
  try { await google.disconnect(req.tenantId); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to disconnect'); }
});

module.exports = router;
