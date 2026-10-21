// Estimates and the cost catalog in Eagle I CRM (lib/crmEstimates.js), plus
// the homeowner's public estimate page at /e/:token.
//
// The /api/crm/* routes here sit behind routes/crm.js's sign-in and
// "company has the CRM" check (mounted after it). The homeowner's routes
// live under /api/crm-public/*, which needs no login: the long random token
// in the link is the key.
const express = require('express');
const path = require('path');
const { requireAuth } = require('../auth');
const est = require('../lib/crmEstimates');
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

// ---------- cost catalog ----------

router.get('/api/crm/catalog', requireAuth, async (req, res) => {
  try { res.json({ items: await est.listCatalog(req.tenantId), categories: est.CATEGORIES, units: est.UNITS }); } catch (err) { fail(res, err, 'Failed to load the catalog'); }
});
router.post('/api/crm/catalog', requireAuth, managersOnly, async (req, res) => {
  try { res.json({ ok: true, item: await est.saveCatalogItem({ tenantId: req.tenantId, body: req.body }) }); } catch (err) { fail(res, err, 'Failed to save the item'); }
});
router.patch('/api/crm/catalog/:id', requireAuth, managersOnly, async (req, res) => {
  try { res.json({ ok: true, item: await est.saveCatalogItem({ tenantId: req.tenantId, id: req.params.id, body: req.body }) }); } catch (err) { fail(res, err, 'Failed to save the item'); }
});
router.delete('/api/crm/catalog/:id', requireAuth, managersOnly, async (req, res) => {
  try {
    const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'catalog', id: req.params.id, userId: req.userId }, async () => !!(await est.archiveCatalogItem({ tenantId: req.tenantId, id: req.params.id })));
    if (!r.ok) return res.status(404).json({ error: { message: 'Item not found.' } });
    res.json({ ok: true, undo: r.undo });
  } catch (err) { fail(res, err, 'Failed to remove the item'); }
});

// ---------- estimates ----------

router.get('/api/crm/estimates', requireAuth, async (req, res) => {
  try { res.json({ estimates: await est.listEstimates(req.tenantId, { dealId: req.query.dealId || null }), kinds: est.KINDS }); } catch (err) { fail(res, err, 'Failed to load estimates'); }
});
router.post('/api/crm/deals/:id/estimates', requireAuth, async (req, res) => {
  const b = req.body || {};
  try { res.json({ ok: true, estimate: await est.createEstimate({ tenantId: req.tenantId, dealId: req.params.id, kind: b.kind, userId: req.userId, copyFromId: b.copyFromId || null }) }); }
  catch (err) { fail(res, err, 'Failed to start the estimate'); }
});
router.get('/api/crm/estimates/:id', requireAuth, async (req, res) => {
  try {
    const e = await est.getEstimate(req.tenantId, req.params.id);
    if (!e) return res.status(404).json({ error: { message: 'Estimate not found.' } });
    res.json({ estimate: e, kinds: est.KINDS, units: est.UNITS, publicUrl: `${baseUrlOf(req)}/e/${e.public_token}` });
  } catch (err) { fail(res, err, 'Failed to load the estimate'); }
});
router.put('/api/crm/estimates/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, estimate: await est.saveEstimate({ tenantId: req.tenantId, id: req.params.id, body: req.body }) }); } catch (err) { fail(res, err, 'Failed to save the estimate'); }
});
router.post('/api/crm/estimates/:id/send', requireAuth, async (req, res) => {
  try {
    const r = await est.sendEstimate({ tenantId: req.tenantId, id: req.params.id, userId: req.userId, message: (req.body || {}).message, baseUrl: baseUrlOf(req) });
    res.json({ ok: true, ...r });
  } catch (err) {
    if (/RESEND_API_KEY/.test(err.message || '')) return res.status(503).json({ error: { message: 'Email sending is not set up on the server yet.' } });
    fail(res, err, 'Failed to send the estimate');
  }
});
router.delete('/api/crm/estimates/:id', requireAuth, async (req, res) => {
  try { const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'estimate', id: req.params.id, userId: req.userId }, () => est.deleteEstimate({ tenantId: req.tenantId, id: req.params.id })); res.json({ ok: true, undo: r.undo }); } catch (err) { fail(res, err, 'Failed to delete the estimate'); }
});

// ---------- the homeowner's page (no login) ----------

// Small per-address limit on accept/decline so the link can't be hammered.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 20;
}

router.get('/e/:token', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, '..', 'public', 'estimate.html'));
});

router.get('/api/crm-public/estimates/:token', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  try {
    const found = await est.getByToken(req.params.token, { viewerTenantId: req.session && req.session.tenantId });
    if (!found) return res.status(404).json({ error: { message: 'This estimate link is not valid. Please contact the company that sent it.' } });
    // The company's own team looking at it doesn't count as the homeowner opening it.
    const ownTeam = req.session && req.session.tenantId === found.est.tenant_id;
    if (!ownTeam && found.est.status !== 'draft') await est.recordView(found.est);
    res.json({ estimate: found.view, preview: ownTeam });
  } catch (err) { fail(res, err, 'Failed to load the estimate'); }
});

router.post('/api/crm-public/estimates/:token/accept', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  try { res.json({ ok: true, estimate: await est.acceptByToken({ token: req.params.token, name: (req.body || {}).name, ip: req.ip, baseUrl: baseUrlOf(req) }) }); }
  catch (err) { fail(res, err, 'Failed to accept'); }
});

router.post('/api/crm-public/estimates/:token/decline', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  try { res.json({ ok: true, estimate: await est.declineByToken({ token: req.params.token, reason: (req.body || {}).reason }) }); }
  catch (err) { fail(res, err, 'Failed to decline'); }
});

module.exports = router;
