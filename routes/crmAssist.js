// Import, the setup interview and the AI helpers (lib/crmAssist.js).
//
// Sits behind routes/crm.js's sign-in and "company has the CRM" check
// (mounted after it). Import and setup are for owners and admins.
const express = require('express');
const { requireAuth } = require('../auth');
const assist = require('../lib/crmAssist');
const team = require('../lib/crmTeam');
const { query } = require('../db');

const router = express.Router();
function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };
const managersOnly = (req, res) => {
  if (team.can(req.crmUser, 'data')) return false;
  res.status(403).json({ error: { message: team.denyText('data') } });
  return true;
};

// Bringing data in from another system (lib/crmImport.js): look, check, then do it.
const imp = require('../lib/crmImport');
router.get('/api/crm/imports', requireAuth, wrap('Failed to load', async (req, res) => res.json({ imports: await imp.list(req.tenantId), kinds: Object.fromEntries(Object.entries(imp.KINDS).map(([k, v]) => [k, v.label])) })));
router.post('/api/crm/imports/preview', requireAuth, wrap('Failed to read the file', async (req, res) => {
  if (managersOnly(req, res)) return;
  const b = req.body || {};
  res.json(await imp.preview({ filename: b.filename, dataBase64: b.dataBase64, kind: b.kind || null }));
}));
router.post('/api/crm/imports/check', requireAuth, wrap('Failed to check the file', async (req, res) => {
  if (managersOnly(req, res)) return;
  const b = req.body || {};
  res.json(await imp.check({ tenantId: req.tenantId, userId: req.userId, filename: b.filename, dataBase64: b.dataBase64, kind: b.kind, mapping: b.mapping, headerRow: b.headerRow }));
}));
router.post('/api/crm/imports', requireAuth, wrap('Failed to bring it in', async (req, res) => {
  if (managersOnly(req, res)) return;
  const b = req.body || {};
  res.json({ ok: true, ...(await imp.run({ tenantId: req.tenantId, userId: req.userId, filename: b.filename, dataBase64: b.dataBase64, kind: b.kind, mapping: b.mapping, headerRow: b.headerRow, platform: b.platform || null })) });
}));
router.post('/api/crm/imports/:importId/undo', requireAuth, wrap('Failed to undo it', async (req, res) => {
  if (managersOnly(req, res)) return;
  res.json({ ok: true, ...(await imp.undo({ tenantId: req.tenantId, id: req.params.importId })) });
}));
router.get('/api/crm/import', requireAuth, wrap('Failed to load', async (req, res) => res.json({ imports: await assist.listImports(req.tenantId), fields: assist.FIELDS })));
router.post('/api/crm/import/preview', requireAuth, wrap('Failed to read the file', async (req, res) => {
  if (managersOnly(req, res)) return;
  const b = req.body || {};
  res.json(assist.previewImport({ filename: b.filename, dataBase64: b.dataBase64 }));
}));
router.post('/api/crm/import', requireAuth, wrap('Failed to import', async (req, res) => {
  if (managersOnly(req, res)) return;
  const b = req.body || {};
  res.json({ ok: true, ...(await assist.runImport({ tenantId: req.tenantId, userId: req.userId, filename: b.filename, dataBase64: b.dataBase64, mapping: b.mapping })) });
}));
router.post('/api/crm/import/:importId/undo', requireAuth, wrap('Failed to undo the import', async (req, res) => {
  if (managersOnly(req, res)) return;
  res.json({ ok: true, ...(await assist.undoImport({ tenantId: req.tenantId, id: req.params.importId })) });
}));

router.get('/api/crm/setup', requireAuth, wrap('Failed to load', async (req, res) => {
  const r = (await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [req.tenantId])).rows[0];
  res.json({ done: !!(r && r.crm_settings && r.crm_settings.setupDoneAt), builds: assist.BUILDS, ai: !!process.env.ANTHROPIC_API_KEY });
}));
router.post('/api/crm/setup', requireAuth, wrap('Failed to set things up', async (req, res) => {
  if (managersOnly(req, res)) return;
  res.json({ ok: true, ...(await assist.applySetup({ tenantId: req.tenantId, answers: req.body || {} })) });
}));

router.post('/api/crm/estimates/:estId/draft', requireAuth, wrap('Failed to draft the estimate', async (req, res) => {
  res.json({ ok: true, ...(await assist.draftEstimate({ tenantId: req.tenantId, estimateId: req.params.estId, scope: (req.body || {}).scope })) });
}));
router.post('/api/crm/deals/:id/update-draft', requireAuth, wrap('Failed to draft the update', async (req, res) => {
  const text = await assist.draftJobUpdate({ tenantId: req.tenantId, dealId: req.params.id });
  res.json({ ok: true, draft: text });
}));

module.exports = router;
