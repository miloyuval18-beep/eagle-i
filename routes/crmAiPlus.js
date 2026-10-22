// Routes for the rest of the AI features: proposals, estimate checks and
// takeoffs (lib/crmEstimateAi.js), the change-order catcher, job outlook
// (lib/crmForecast.js), bills matched to POs, the product catalog and
// selection suggestions, photo checks and punch lists, coaching and win/loss,
// the design visualizer, and the homeowner portal's "ask about your project".
//
// /api/crm/* sits behind routes/crm.js's sign-in and "company has the CRM"
// check (mounted after it). /api/crm-public/* needs no login: the portal's
// long random token is the key.
const express = require('express');
const { requireAuth } = require('../auth');
const { query } = require('../db');
const team = require('../lib/crmTeam');
const estAi = require('../lib/crmEstimateAi');
const catcher = require('../lib/crmChangeCatcher');
const forecast = require('../lib/crmForecast');
const products = require('../lib/crmProducts');
const photoAi = require('../lib/crmPhotoAi');
const coaching = require('../lib/crmCoaching');
const visual = require('../lib/crmVisualizer');
const portalAi = require('../lib/crmPortalAi');

const router = express.Router();
const wrap = (what, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    const st = err.status || 500;
    if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
    if (/ANTHROPIC_API_KEY is not set/.test(err.message || '')) return res.status(503).json({ error: { message: 'The AI isn’t switched on yet (ANTHROPIC_API_KEY on the server).' } });
    res.status(st).json({ error: { message: st === 500 ? `${what}: ${err.message}` : err.message } });
  }
};
async function ownDeal(req, res) {
  const d = (await query('SELECT id, title FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]).catch(() => ({ rows: [] }))).rows[0];
  if (!d) res.status(404).json({ error: { message: 'Deal not found.' } });
  return d;
}
async function ownEstimate(req, res) {
  const e = (await query('SELECT id, deal_id FROM crm_estimates WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]).catch(() => ({ rows: [] }))).rows[0];
  if (!e) res.status(404).json({ error: { message: 'Estimate not found.' } });
  return e;
}
const viewer = (req) => ({ userId: req.userId, manager: team.can(req.crmUser, 'reports') });

// ---------- proposals and estimate checks ----------
router.get('/api/crm/estimates/:id/ai', requireAuth, wrap('Failed to load', async (req, res) => {
  if (!(await ownEstimate(req, res))) return;
  const r = (await query('SELECT proposal, proposal_at, review, review_at FROM crm_estimates WHERE id = $1', [req.params.id])).rows[0];
  res.json({ ...r, ai: !!process.env.ANTHROPIC_API_KEY });
}));
router.post('/api/crm/estimates/:id/proposal/write', requireAuth, wrap('Failed to write the proposal', async (req, res) => {
  if (!(await ownEstimate(req, res))) return;
  res.json({ proposal: await estAi.writeProposal(req.tenantId, req.params.id) });
}));
router.put('/api/crm/estimates/:id/proposal', requireAuth, wrap('Failed to save the proposal', async (req, res) => {
  if (!(await ownEstimate(req, res))) return;
  res.json({ proposal: await estAi.saveProposal(req.tenantId, req.params.id, req.body || {}) });
}));
router.post('/api/crm/estimates/:id/check', requireAuth, wrap('Failed to check the estimate', async (req, res) => {
  if (!(await ownEstimate(req, res))) return;
  res.json({ review: await estAi.checkEstimate(req.tenantId, req.params.id) });
}));

// ---------- takeoffs ----------
router.get('/api/crm/deals/:id/takeoffs', requireAuth, wrap('Failed to load', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  const plans = (await query(`SELECT id, filename, content_type, created_at FROM crm_files WHERE deal_id = $1 AND (content_type = 'application/pdf' OR content_type LIKE 'image/%') AND COALESCE(caption, '') NOT IN ('Receipt', 'Walkthrough') ORDER BY created_at DESC LIMIT 100`, [d.id])).rows;
  res.json({ takeoffs: await estAi.listTakeoffs(req.tenantId, d.id), files: plans, ai: !!process.env.ANTHROPIC_API_KEY });
}));
router.post('/api/crm/deals/:id/takeoffs', requireAuth, wrap('Failed to read the plans', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  const b = req.body || {};
  res.json({ takeoff: await estAi.readTakeoff({ tenantId: req.tenantId, dealId: d.id, fileId: b.fileId, focus: b.focus, userId: req.userId }) });
}));
router.put('/api/crm/takeoffs/:tid', requireAuth, wrap('Failed to save', async (req, res) => res.json({ takeoff: await estAi.saveTakeoff({ tenantId: req.tenantId, id: req.params.tid, items: (req.body || {}).items }) })));
router.post('/api/crm/takeoffs/:tid/to-estimate', requireAuth, wrap('Failed to add to the estimate', async (req, res) => res.json(await estAi.takeoffToEstimate({ tenantId: req.tenantId, id: req.params.tid, estimateId: (req.body || {}).estimateId || null, userId: req.userId }))));

// ---------- the job: outlook, change catches, punch list, photos ----------
router.get('/api/crm/deals/:id/outlook', requireAuth, wrap('Failed to load', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  const [o, catches, punch, photos, bills] = await Promise.all([
    forecast.jobOutlook(req.tenantId, d.id), catcher.listSuggestions(req.tenantId, d.id), photoAi.listPunch(req.tenantId, d.id), photoAi.photoProgress(req.tenantId, d.id),
    query(`SELECT c.id, c.amount, c.vendor_name, c.description, c.match_note, p.number AS po_number FROM crm_costs c JOIN crm_purchase_orders p ON p.id = c.matched_po_id WHERE c.deal_id = $1 ORDER BY c.created_at DESC LIMIT 30`, [d.id])
  ]);
  res.json({ ...o, catches, punch, photos, bills: bills.rows, ai: !!process.env.ANTHROPIC_API_KEY });
}));
router.post('/api/crm/change-catches/:sid/draft', requireAuth, wrap('Failed to draft the change order', async (req, res) => res.json(await catcher.draftFromSuggestion({ tenantId: req.tenantId, id: req.params.sid, userId: req.userId }))));
router.post('/api/crm/change-catches/:sid/dismiss', requireAuth, wrap('Failed', async (req, res) => res.json(await catcher.dismissSuggestion({ tenantId: req.tenantId, id: req.params.sid }))));

router.post('/api/crm/deals/:id/punch', requireAuth, wrap('Failed to add', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  const b = req.body || {};
  res.json({ item: await photoAi.addPunch({ tenantId: req.tenantId, dealId: d.id, location: b.location, issue: b.issue, trade: b.trade, userId: req.userId }) });
}));
router.post('/api/crm/deals/:id/walkthrough', requireAuth, wrap('Failed to write the punch list', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  const b = req.body || {};
  res.json(await photoAi.punchFromWalkthrough({ tenantId: req.tenantId, dealId: d.id, frames: b.frames, notes: b.notes, userId: req.userId }));
}));
router.patch('/api/crm/punch/:pid', requireAuth, wrap('Failed to save', async (req, res) => res.json({ item: await photoAi.updatePunch({ tenantId: req.tenantId, id: req.params.pid, body: req.body }) })));

// ---------- products and selection suggestions ----------
router.get('/api/crm/products', requireAuth, wrap('Failed to load', async (req, res) => res.json({ products: await products.listProducts(req.tenantId) })));
router.post('/api/crm/products', requireAuth, wrap('Failed to save the product', async (req, res) => res.json({ product: await products.saveProduct({ tenantId: req.tenantId, body: req.body }) })));
router.put('/api/crm/products/:pid', requireAuth, wrap('Failed to save the product', async (req, res) => res.json({ product: await products.saveProduct({ tenantId: req.tenantId, id: req.params.pid, body: req.body }) })));
router.delete('/api/crm/products/:pid', requireAuth, wrap('Failed', async (req, res) => {
  const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'product', id: req.params.pid, userId: req.userId }, () => products.archiveProduct({ tenantId: req.tenantId, id: req.params.pid }));
  if (!r.ok) return res.status(404).json({ error: { message: 'Product not found.' } });
  res.json({ ok: true, undo: r.undo });
}));
const photoOut = (res, p) => { res.set({ 'Content-Type': p.photo_type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }); res.send(Buffer.from(p.photo)); };
router.get('/api/crm/products/:pid/photo', requireAuth, wrap('Failed', async (req, res) => {
  const p = await products.productPhoto(req.tenantId, req.params.pid);
  if (!p) return res.status(404).send('Not found');
  photoOut(res, p);
}));
router.post('/api/crm/deals/:id/selection-ideas', requireAuth, wrap('Failed to suggest options', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  const b = req.body || {};
  res.json(await products.suggestOptions({ tenantId: req.tenantId, dealId: d.id, category: b.category, allowance: b.allowance, style: b.style }));
}));
router.get('/api/crm-public/portal/:token/products/:pid/photo', wrap('Failed', async (req, res) => {
  const p = await products.portalProductPhoto(req.params.token, req.params.pid);
  if (!p) return res.status(404).send('Not found');
  photoOut(res, p);
}));

// ---------- coaching and win/loss ----------
router.get('/api/crm/coaching', requireAuth, wrap('Failed to load', async (req, res) => {
  const v = viewer(req);
  const people = v.manager ? (await query('SELECT id, COALESCE(name, email) AS name FROM users WHERE tenant_id = $1 ORDER BY name', [req.tenantId])).rows : [];
  res.json({ coaching: await coachingForSafe(req, req.query.user || req.userId), people, manager: v.manager });
}));
async function coachingForSafe(req, userId) {
  return coaching.coachingFor({ tenantId: req.tenantId, userId, viewer: viewer(req), refresh: req.query.refresh === '1' });
}
router.get('/api/crm/win-loss', requireAuth, wrap('Failed to load', async (req, res) => {
  if (!viewer(req).manager) return res.status(403).json({ error: { message: team.denyText('reports') } });
  res.json(await coaching.winLoss(req.tenantId));
}));

// ---------- design visualizer ----------
router.get('/api/crm/visualizer', requireAuth, wrap('Failed to load', async (req, res) => res.json(await visual.status(req.tenantId))));
router.post('/api/crm/deals/:id/visualize', requireAuth, wrap('Failed to make the picture', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  const b = req.body || {};
  res.json(await visual.visualize({ tenantId: req.tenantId, dealId: d.id, fileId: b.fileId, design: b.design, userId: req.userId }));
}));

// ---------- the homeowner's "ask about your project" ----------
const hits = new Map();
function limited(key, max) { const now = Date.now(); const l = (hits.get(key) || []).filter(t => now - t < 3600000); l.push(now); hits.set(key, l); return l.length > max; }
router.post('/api/crm-public/portal/:token/ask', wrap('Failed to answer', async (req, res) => {
  if (limited('ask:' + req.ip, 30)) return res.status(429).json({ error: { message: 'Too many questions. Please try again later.' } });
  res.json(await portalAi.ask({ token: req.params.token, question: (req.body || {}).question, history: (req.body || {}).history, lang: req.get('X-Lang') === 'es' ? 'es' : null }));
}));
router.get('/api/crm/deals/:id/portal-questions', requireAuth, wrap('Failed to load', async (req, res) => {
  const d = await ownDeal(req, res); if (!d) return;
  res.json({ questions: await portalAi.listQuestions(req.tenantId, d.id) });
}));

module.exports = router;
