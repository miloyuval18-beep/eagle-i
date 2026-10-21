// The Pipeline tab: deals, the "Needs you" exceptions inbox, and playbooks
// (approve-once automatic emails). The logic lives in lib/crm.js and
// lib/crmPlaybooks.js; this file only checks input and wires up requests.
const express = require('express');
const { requireAuth } = require('../auth');
const crm = require('../lib/crm');
const playbooks = require('../lib/crmPlaybooks');
const team = require('../lib/crmTeam');
const tasks = require('../lib/crmTasks');

const { query } = require('../db');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(res, err, what) {
  // A malformed id is just "not found", never a server error.
  if (/invalid input syntax for type (uuid|bigint|integer)/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  const status = err.status || 500;
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}

// Who is signed in and whether their company uses the CRM. Open to any
// logged-in user so the app can offer to switch the CRM on.
router.get('/api/crm/me', requireAuth, async (req, res) => {
  try {
    const r = (await query(
      `SELECT u.id, u.email, u.name, u.role, t.company_name, t.products FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [req.userId])).rows[0];
    if (!r) return res.status(401).json({ error: { message: 'Not logged in.' } });
    res.json({
      userId: r.id, email: r.email, name: r.name, role: r.role, canManage: team.isManager(r.role), companyName: r.company_name,
      products: r.products || [], hasCrm: (r.products || []).includes('crm'),
      // Team members invited to the CRM only see the CRM; the marketing dashboard is the owner's.
      hasMarketing: (r.products || []).includes('marketing') && r.role === 'owner'
    });
  } catch (err) { fail(res, err, 'Failed to load your account'); }
});

// A company already on Eagle I marketing can add the CRM to the same login.
router.post('/api/crm/activate', requireAuth, async (req, res) => {
  try {
    const me = await team.getUser(req.userId);
    if (!me || me.role !== 'owner') return res.status(403).json({ error: { message: 'Only the account owner can switch the CRM on.' } });
    await query(`UPDATE tenants SET products = array_append(products, 'crm') WHERE id = $1 AND NOT ('crm' = ANY(products))`, [req.tenantId]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to switch on the CRM'); }
});

// Invitation links (no login: the person doesn't have one yet).
router.get('/api/crm/join', async (req, res) => {
  try {
    const info = await team.inviteInfo(String(req.query.token || ''));
    if (!info) return res.status(404).json({ error: { message: 'This invitation link is invalid, already used, or has expired. Ask for a new one.' } });
    res.json({ email: info.email, name: info.name, companyName: info.company_name });
  } catch (err) { fail(res, err, 'Failed to load the invitation'); }
});

router.post('/api/crm/join', async (req, res) => {
  const { token, name, password } = req.body || {};
  try {
    const user = await team.acceptInvite({ token: String(token || ''), name, password });
    req.session.userId = user.id;
    req.session.tenantId = user.tenant_id;
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to join'); }
});

// Everything else under /api/crm is for signed-in people at companies that use the CRM.
router.use('/api/crm', requireAuth, async (req, res, next) => {
  try {
    const me = await team.getUser(req.userId);
    // A removed team member's old session stops working at once.
    if (!me || me.tenant_id !== req.tenantId) return res.status(401).json({ error: { message: 'Not logged in.' } });
    req.crmUser = me;
    if (await crm.hasCrm(req.tenantId)) {
      // After the trial (with billing switched on) the CRM is read-only until a plan is chosen.
      if (!['GET', 'HEAD'].includes(req.method) && !/^\/api\/crm\/(billing|me)(\/|$)/.test(req.originalUrl.split('?')[0])) {
        const a = await require('../lib/crmBilling').accessFor(req.tenantId);
        if (a.locked) return res.status(402).json({ error: { message: a.reason, code: 'billing' } });
      }
      return next();
    }
    res.status(403).json({ error: { message: 'Eagle I CRM is not switched on for this company.', code: 'no_crm' } });
  } catch (err) { fail(res, err, 'Failed to check your account'); }
});

// For changes that speak for the whole company: the team, company details,
// and the wording and switches of automatic emails.
function managersOnly(req, res, next) {
  if (team.isManager(req.crmUser && req.crmUser.role)) return next();
  res.status(403).json({ error: { message: 'Only the owner or an admin can change this.' } });
}

// The company details every automatic email uses (signature and footer).
router.get('/api/crm/company', async (req, res) => {
  try {
    const r = (await query(
      `SELECT t.company_name, bp.phone, bp.email, bp.address, bp.founder_name FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [req.tenantId])).rows[0];
    res.json({ company: r || {} });
  } catch (err) { fail(res, err, 'Failed to load company details'); }
});

router.patch('/api/crm/company', managersOnly, async (req, res) => {
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

router.post('/api/crm/deals/duplicates', requireAuth, async (req, res) => {
  try { res.json({ matches: await crm.findDuplicates({ tenantId: req.tenantId, ...(req.body || {}) }) }); } catch (err) { fail(res, err, 'Failed to check'); }
});
router.get('/api/crm/deals/:id/stage-check', requireAuth, async (req, res) => {
  try { res.json({ warnings: await crm.stageWarnings({ tenantId: req.tenantId, dealId: req.params.id, stage: String(req.query.stage || '') }) }); } catch (err) { fail(res, err, 'Failed to check'); }
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
      title: b.title, stage: b.stage || 'new', value: b.value, source: b.source || 'manual', note: b.note || null, baseUrl: baseUrlOf(req),
      userId: req.userId, ownerUserId: b.ownerUserId || null
    });
    sendDueNow(deal.id);
    res.json({ ok: true, deal: await crm.getDeal(req.tenantId, deal.id) });
  } catch (err) { fail(res, err, 'Failed to add the deal'); }
});

router.get('/api/crm/deals/:id', requireAuth, async (req, res) => {
  try {
    const deal = await crm.getDeal(req.tenantId, req.params.id);
    if (!deal) return res.status(404).json({ error: { message: 'Deal not found.' } });
    res.json({ deal, ...(await crm.dealTimeline(req.tenantId, req.params.id)), tasks: await tasks.listForDeal(req.tenantId, req.params.id) });
  } catch (err) {
    if (/invalid input syntax for type uuid/.test(err.message)) return res.status(404).json({ error: { message: 'Deal not found.' } });
    fail(res, err, 'Failed to load the deal');
  }
});

router.patch('/api/crm/deals/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (b.stage && !crm.isStage(b.stage)) return res.status(400).json({ error: { message: 'Unknown stage.' } });
  try {
    const deal = await crm.updateDeal({ tenantId: req.tenantId, dealId: req.params.id, patch: b, baseUrl: baseUrlOf(req), userId: req.userId });
    if (b.stage) sendDueNow(deal.id);
    res.json({ ok: true, deal });
  } catch (err) { fail(res, err, 'Failed to save the deal'); }
});

router.post('/api/crm/deals/:id/notes', requireAuth, async (req, res) => {
  try {
    const r = await crm.addNote({ tenantId: req.tenantId, dealId: req.params.id, body: (req.body || {}).body, userId: req.userId, pickOut: !!(req.body || {}).pickOut, baseUrl: baseUrlOf(req) });
    res.json({ ok: true, picked: r.picked });
  } catch (err) { fail(res, err, 'Failed to save the note'); }
});

router.delete('/api/crm/deals/:id', requireAuth, managersOnly, async (req, res) => {
  try {
    const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'deal', id: req.params.id, userId: req.userId }, () => crm.deleteDeal(req.tenantId, req.params.id));
    if (!r.ok) return res.status(404).json({ error: { message: 'Deal not found.' } });
    res.json({ ok: true, undo: r.undo });
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

router.put('/api/crm/playbooks/:id', requireAuth, managersOnly, async (req, res) => {
  const { name, steps, stepsEs } = req.body || {};
  try { res.json({ ok: true, ...(await playbooks.savePlaybook({ tenantId: req.tenantId, id: req.params.id, name, steps, stepsEs })) }); } catch (err) { fail(res, err, 'Failed to save the playbook'); }
});

// A Spanish draft to read over (nothing is saved or sent).
router.post('/api/crm/playbooks/:id/spanish', requireAuth, managersOnly, async (req, res) => {
  try { res.json({ ok: true, ...(await playbooks.spanishDraft({ tenantId: req.tenantId, id: req.params.id, steps: (req.body || {}).steps || null })) }); } catch (err) { fail(res, err, 'Failed to draft the Spanish'); }
});

router.post('/api/crm/playbooks/:id/approve', requireAuth, managersOnly, async (req, res) => {
  try { await playbooks.approvePlaybook({ tenantId: req.tenantId, id: req.params.id }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to approve the playbook'); }
});

router.post('/api/crm/playbooks/:id/enabled', requireAuth, managersOnly, async (req, res) => {
  try { await playbooks.setEnabled({ tenantId: req.tenantId, id: req.params.id, enabled: !!(req.body || {}).enabled }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to switch the playbook'); }
});

router.post('/api/crm/playbooks/:id/reset', requireAuth, managersOnly, async (req, res) => {
  try { res.json({ ok: true, ...(await playbooks.resetPlaybook({ tenantId: req.tenantId, id: req.params.id })) }); } catch (err) { fail(res, err, 'Failed to reset the playbook'); }
});

router.post('/api/crm/playbooks/:id/preview', requireAuth, async (req, res) => {
  try {
    const r = await playbooks.sendPreview({ tenantId: req.tenantId, id: req.params.id, step: parseInt((req.body || {}).step, 10) || 1, lang: (req.body || {}).lang === 'es' ? 'es' : 'en', baseUrl: baseUrlOf(req) });
    res.json({ ok: true, ...r });
  } catch (err) {
    if (/RESEND_API_KEY/.test(err.message)) return res.status(503).json({ error: { message: 'Email sending is not configured yet.' } });
    fail(res, err, 'Failed to send the preview');
  }
});

router.patch('/api/crm/settings', requireAuth, managersOnly, async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.paused === 'boolean') patch.paused = b.paused;
  if (typeof b.weeklySummary === 'boolean') patch.weeklySummary = b.weeklySummary;
  if (b.waitingMinutes !== undefined) patch.waitingMinutes = b.waitingMinutes;
  if (b.stageLabels !== undefined) patch.stageLabels = b.stageLabels;
  if (b.hiddenStages !== undefined) patch.hiddenStages = b.hiddenStages;
  try {
    if (b.leadOwnerUserId !== undefined) {
      if (b.leadOwnerUserId && !(await query('SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2', [b.leadOwnerUserId, req.tenantId])).rows.length) {
        return res.status(400).json({ error: { message: 'That person is not on your team.' } });
      }
      patch.leadOwnerUserId = b.leadOwnerUserId || null;
    } res.json({ ok: true, settings: await crm.saveSettings(req.tenantId, patch) }); } catch (err) { fail(res, err, 'Failed to save settings'); }
});

// The "what Eagle I did for you" numbers for the last 7 days (same counts as the Monday email).
router.get('/api/crm/summary', requireAuth, async (req, res) => {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86400000);
    res.json({ summary: await crm.buildWeeklySummary(req.tenantId, { start, end }) });
  } catch (err) { fail(res, err, 'Failed to load the summary'); }
});

// ---------- tasks and "Today" ----------

// Everything that needs this person today: exceptions, their open tasks (and
// unassigned ones), and site visits coming up this week.
router.get('/api/crm/today', requireAuth, async (req, res) => {
  try {
    const everyone = req.query.all === '1' && team.isManager(req.crmUser.role);
    const [inbox, open, visits] = await Promise.all([
      crm.listInbox(req.tenantId),
      tasks.listOpen(req.tenantId, { userId: everyone ? null : req.userId }),
      query(
        `SELECT d.id, d.title, d.site_visit_at, c.name AS contact_name, p.address FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id
         LEFT JOIN crm_properties p ON p.id = d.property_id
         WHERE d.tenant_id = $1 AND d.site_visit_at BETWEEN now() - interval '2 hours' AND now() + interval '7 days' AND d.stage NOT IN ('lost', 'complete')
           AND ($2::uuid IS NULL OR d.owner_user_id = $2::uuid OR d.owner_user_id IS NULL)
         ORDER BY d.site_visit_at LIMIT 50`, [req.tenantId, everyone ? null : req.userId]).then(r => r.rows)
    ]);
    res.json({ inbox, tasks: open, visits });
  } catch (err) { fail(res, err, 'Failed to load Today'); }
});

router.post('/api/crm/tasks', requireAuth, async (req, res) => {
  const b = req.body || {};
  try {
    const t = await tasks.createTask({ tenantId: req.tenantId, dealId: b.dealId || null, title: b.title, dueAt: b.dueAt || null, assigneeUserId: b.assigneeUserId || null, createdBy: req.userId });
    res.json({ ok: true, task: t });
  } catch (err) { fail(res, err, 'Failed to add the task'); }
});

router.patch('/api/crm/tasks/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, task: await tasks.updateTask({ tenantId: req.tenantId, id: req.params.id, patch: req.body || {}, userId: req.userId }) }); }
  catch (err) {
    if (/invalid input syntax for type uuid/.test(err.message)) return res.status(404).json({ error: { message: 'Task not found.' } });
    fail(res, err, 'Failed to save the task');
  }
});

router.delete('/api/crm/tasks/:id', requireAuth, async (req, res) => {
  try {
    const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'task', id: req.params.id, userId: req.userId }, () => tasks.deleteTask({ tenantId: req.tenantId, id: req.params.id }));
    if (!r.ok) return res.status(404).json({ error: { message: 'Task not found.' } });
    res.json({ ok: true, undo: r.undo });
  } catch (err) { fail(res, err, 'Failed to delete the task'); }
});

// ---------- team ----------

// Your own name, shown to your team on deals and in history.
router.patch('/api/crm/me', requireAuth, async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: { message: 'Add your name.' } });
  try { await query('UPDATE users SET name = $1 WHERE id = $2', [name, req.userId]); res.json({ ok: true }); }
  catch (err) { fail(res, err, 'Failed to save your name'); }
});

router.get('/api/crm/team', requireAuth, async (req, res) => {
  try { res.json({ ...(await team.listTeam(req.tenantId)), me: { id: req.crmUser.id, role: req.crmUser.role } }); } catch (err) { fail(res, err, 'Failed to load your team'); }
});

router.post('/api/crm/team/invites', requireAuth, managersOnly, async (req, res) => {
  const { email, name, role } = req.body || {};
  try { await require('../lib/crmBilling').checkSeat(req.tenantId); res.json({ ok: true, ...(await team.createInvite({ tenantId: req.tenantId, invitedBy: req.userId, email, name, role: role || 'member', baseUrl: baseUrlOf(req) })) }); }
  catch (err) { fail(res, err, 'Failed to send the invitation'); }
});

router.delete('/api/crm/team/invites/:id', requireAuth, managersOnly, async (req, res) => {
  try {
    if (!(await team.revokeInvite({ tenantId: req.tenantId, id: req.params.id }))) return res.status(404).json({ error: { message: 'Invitation not found.' } });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to cancel the invitation'); }
});

router.patch('/api/crm/team/:userId', requireAuth, managersOnly, async (req, res) => {
  try { await team.setRole({ tenantId: req.tenantId, actor: req.crmUser, userId: req.params.userId, role: (req.body || {}).role }); res.json({ ok: true }); }
  catch (err) { fail(res, err, 'Failed to change the role'); }
});

router.delete('/api/crm/team/:userId', requireAuth, managersOnly, async (req, res) => {
  try { await team.removeMember({ tenantId: req.tenantId, actor: req.crmUser, userId: req.params.userId }); res.json({ ok: true }); }
  catch (err) { fail(res, err, 'Failed to remove the team member'); }
});

module.exports = router;
