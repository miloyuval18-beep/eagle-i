// The Pipeline tab: deals, the "Needs you" exceptions inbox, and playbooks
// (approve-once automatic emails). The logic lives in lib/crm.js and
// lib/crmPlaybooks.js; this file only checks input and wires up requests.
const express = require('express');
const { requireAuth } = require('../auth');
const crm = require('../lib/crm');
const playbooks = require('../lib/crmPlaybooks');

const { query } = require('../db');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(res, err, what) {
  const status = err.status || 500;
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}

// Who is signed in and whether their company uses the CRM. Open to any
// logged-in user so the app can offer to switch the CRM on.
router.get('/api/crm/me', requireAuth, async (req, res) => {
  try {
    const r = (await query(
      `SELECT u.email, t.company_name, t.products FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [req.userId])).rows[0];
    if (!r) return res.status(401).json({ error: { message: 'Not logged in.' } });
    res.json({ email: r.email, companyName: r.company_name, products: r.products || [], hasCrm: (r.products || []).includes('crm'), hasMarketing: (r.products || []).includes('marketing') });
  } catch (err) { fail(res, err, 'Failed to load your account'); }
});

// A company already on Eagle I marketing can add the CRM to the same login.
router.post('/api/crm/activate', requireAuth, async (req, res) => {
  try {
    await query(`UPDATE tenants SET products = array_append(products, 'crm') WHERE id = $1 AND NOT ('crm' = ANY(products))`, [req.tenantId]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to switch on the CRM'); }
});

// Everything else under /api/crm is for companies that use the CRM.
router.use('/api/crm', requireAuth, async (req, res, next) => {
  try {
    if (await crm.hasCrm(req.tenantId)) return next();
    res.status(403).json({ error: { message: 'Eagle I CRM is not switched on for this company.', code: 'no_crm' } });
  } catch (err) { fail(res, err, 'Failed to check your account'); }
});

// The company details every automatic email uses (signature and footer).
router.get('/api/crm/company', async (req, res) => {
  try {
    const r = (await query(
      `SELECT t.company_name, bp.phone, bp.email, bp.address, bp.founder_name FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [req.tenantId])).rows[0];
    res.json({ company: r || {} });
  } catch (err) { fail(res, err, 'Failed to load company details'); }
});

router.patch('/api/crm/company', async (req, res) => {
  const b = req.body || {};
  const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  if (b.companyName !== undefined && !clean(b.companyName, 120)) return res.status(400).json({ error: { message: 'Add your company name.' } });
  if (b.email && !EMAIL_RE.test(clean(b.email, 200))) return res.status(400).json({ error: { message: 'That email address does not look right.' } });
  if (b.address !== undefined && clean(b.address, 200) && clean(b.address, 200).length < 8) return res.status(400).json({ error: { message: 'Add your full business address; it goes at the bottom of every email.' } });
  try {
    if (b.companyName !== undefined) await query('UPDATE tenants SET company_name = $1 WHERE id = $2', [clean(b.companyName, 120), req.tenantId]);
    const sets = []; const vals = [];
    for (const [k, col, max] of [['phone', 'phone', 40], ['email', 'email', 200], ['address', 'address', 200], ['founderName', 'founder_name', 120]]) {
      if (b[k] !== undefined) { vals.push(clean(b[k], max) || null); sets.push(`${col} = $${vals.length}`); }
    }
    if (sets.length) {
      vals.push(req.tenantId);
      await query(`UPDATE business_profile SET ${sets.join(', ')} WHERE tenant_id = $${vals.length}`, vals);
    }
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to save company details'); }
});


// A same-day email (for example "Welcome aboard" when a contract is signed)
// goes out right away instead of waiting for the next background tick.
function sendDueNow(dealId) {
  playbooks.processDueSends({ onlyDealId: dealId }).catch(err => console.error('[crm] immediate send failed:', err.message));
}

router.get('/api/crm/pipeline', requireAuth, async (req, res) => {
  try {
    // Leads that arrived before the pipeline existed are brought in the first time it is opened.
    await crm.ensureBackfilled(req.tenantId);
    const [pipeline, inbox, settings] = await Promise.all([crm.listPipeline(req.tenantId), crm.listInbox(req.tenantId), crm.getSettings(req.tenantId)]);
    res.json({ ...pipeline, needsYou: inbox.length, settings: { paused: settings.paused } });
  } catch (err) { fail(res, err, 'Failed to load the pipeline'); }
});

router.post('/api/crm/deals', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: { message: 'Add the person’s name.' } });
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim())) return res.status(400).json({ error: { message: 'That email address does not look right.' } });
  if (b.stage && !crm.isStage(b.stage)) return res.status(400).json({ error: { message: 'Unknown stage.' } });
  if (b.value !== undefined && b.value !== '' && crm.parseValue(b.value) == null) return res.status(400).json({ error: { message: 'Enter the value as a number, like 85000 or 85k.' } });
  try {
    const deal = await crm.createDeal({
      tenantId: req.tenantId, name: b.name, email: b.email, phone: b.phone, address: b.address, zip: b.zip,
      title: b.title, stage: b.stage || 'new', value: b.value, source: b.source || 'manual', note: b.note || null, baseUrl: baseUrlOf(req)
    });
    sendDueNow(deal.id);
    res.json({ ok: true, deal: await crm.getDeal(req.tenantId, deal.id) });
  } catch (err) { fail(res, err, 'Failed to add the deal'); }
});

router.get('/api/crm/deals/:id', requireAuth, async (req, res) => {
  try {
    const deal = await crm.getDeal(req.tenantId, req.params.id);
    if (!deal) return res.status(404).json({ error: { message: 'Deal not found.' } });
    res.json({ deal, ...(await crm.dealTimeline(req.tenantId, req.params.id)) });
  } catch (err) {
    if (/invalid input syntax for type uuid/.test(err.message)) return res.status(404).json({ error: { message: 'Deal not found.' } });
    fail(res, err, 'Failed to load the deal');
  }
});

router.patch('/api/crm/deals/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (b.stage && !crm.isStage(b.stage)) return res.status(400).json({ error: { message: 'Unknown stage.' } });
  try {
    const deal = await crm.updateDeal({ tenantId: req.tenantId, dealId: req.params.id, patch: b, baseUrl: baseUrlOf(req) });
    if (b.stage) sendDueNow(deal.id);
    res.json({ ok: true, deal });
  } catch (err) { fail(res, err, 'Failed to save the deal'); }
});

router.post('/api/crm/deals/:id/notes', requireAuth, async (req, res) => {
  try {
    await crm.addNote({ tenantId: req.tenantId, dealId: req.params.id, body: (req.body || {}).body });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to save the note'); }
});

router.delete('/api/crm/deals/:id', requireAuth, async (req, res) => {
  try {
    if (!(await crm.deleteDeal(req.tenantId, req.params.id))) return res.status(404).json({ error: { message: 'Deal not found.' } });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to delete the deal'); }
});

router.get('/api/crm/inbox', requireAuth, async (req, res) => {
  try { res.json({ items: await crm.listInbox(req.tenantId) }); } catch (err) { fail(res, err, 'Failed to load Needs you'); }
});

router.post('/api/crm/inbox/:id', requireAuth, async (req, res) => {
  const { action, days } = req.body || {};
  try {
    if (!(await crm.actOnInbox({ tenantId: req.tenantId, id: req.params.id, action, days }))) return res.status(404).json({ error: { message: 'Item not found.' } });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to update the item'); }
});

router.get('/api/crm/playbooks', requireAuth, async (req, res) => {
  try {
    res.json({ playbooks: await playbooks.listPlaybooks(req.tenantId), settings: await crm.getSettings(req.tenantId), maxSteps: playbooks.MAX_STEPS, maxPerDay: playbooks.MAX_PER_DAY });
  } catch (err) { fail(res, err, 'Failed to load playbooks'); }
});

router.put('/api/crm/playbooks/:id', requireAuth, async (req, res) => {
  const { name, steps } = req.body || {};
  try { res.json({ ok: true, ...(await playbooks.savePlaybook({ tenantId: req.tenantId, id: req.params.id, name, steps })) }); } catch (err) { fail(res, err, 'Failed to save the playbook'); }
});

router.post('/api/crm/playbooks/:id/approve', requireAuth, async (req, res) => {
  try { await playbooks.approvePlaybook({ tenantId: req.tenantId, id: req.params.id }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to approve the playbook'); }
});

router.post('/api/crm/playbooks/:id/enabled', requireAuth, async (req, res) => {
  try { await playbooks.setEnabled({ tenantId: req.tenantId, id: req.params.id, enabled: !!(req.body || {}).enabled }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to switch the playbook'); }
});

router.post('/api/crm/playbooks/:id/reset', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await playbooks.resetPlaybook({ tenantId: req.tenantId, id: req.params.id })) }); } catch (err) { fail(res, err, 'Failed to reset the playbook'); }
});

router.post('/api/crm/playbooks/:id/preview', requireAuth, async (req, res) => {
  try {
    const r = await playbooks.sendPreview({ tenantId: req.tenantId, id: req.params.id, step: parseInt((req.body || {}).step, 10) || 1, baseUrl: baseUrlOf(req) });
    res.json({ ok: true, ...r });
  } catch (err) {
    if (/RESEND_API_KEY/.test(err.message)) return res.status(503).json({ error: { message: 'Email sending is not configured yet.' } });
    fail(res, err, 'Failed to send the preview');
  }
});

router.patch('/api/crm/settings', requireAuth, async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.paused === 'boolean') patch.paused = b.paused;
  if (typeof b.weeklySummary === 'boolean') patch.weeklySummary = b.weeklySummary;
  if (b.waitingMinutes !== undefined) patch.waitingMinutes = b.waitingMinutes;
  try { res.json({ ok: true, settings: await crm.saveSettings(req.tenantId, patch) }); } catch (err) { fail(res, err, 'Failed to save settings'); }
});

// The "what Eagle I did for you" numbers for the last 7 days (same counts as the Monday email).
router.get('/api/crm/summary', requireAuth, async (req, res) => {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86400000);
    res.json({ summary: await crm.buildWeeklySummary(req.tenantId, { start, end }) });
  } catch (err) { fail(res, err, 'Failed to load the summary'); }
});

module.exports = router;
