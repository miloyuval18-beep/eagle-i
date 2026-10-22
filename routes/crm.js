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
      `SELECT u.id, u.email, u.name, u.phone, u.role, u.app, u.permissions, u.setup_done_at, t.company_name, t.products, t.setup_done_at AS company_setup_done FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [req.userId])).rows[0];
    if (!r || r.app === 'marketing') return res.status(401).json({ error: { message: 'Not logged in.' } });
    res.json({
      userId: r.id, email: r.email, name: r.name, phone: r.phone, role: r.role, roleLabel: team.roleLabel(r.role), canManage: team.isManager(r.role), perms: team.permsOf(r), companyName: r.company_name,
      // Guided setup (crm.html #setup): the company's for its owner, a shorter one for everyone else.
      needsSetup: r.role === 'owner' ? !r.company_setup_done : !r.setup_done_at,
      products: r.products || [], hasCrm: (r.products || []).includes('crm'),
      // Team members invited to the CRM only see the CRM; the marketing dashboard is the owner's.
      hasMarketing: (r.products || []).includes('marketing') && r.role === 'owner'
    });
  } catch (err) { fail(res, err, 'Failed to load your account'); }
});

// Eagle I CRM accounts are separate from marketing logins (lib/crmAccounts.js):
// a marketing company starts the CRM by creating a CRM account at /crm/login.
router.post('/api/crm/activate', requireAuth, (req, res) => res.status(410).json({ error: { message: 'Eagle I CRM has its own accounts now. Create one at /crm/login.' } }));

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
    req.session.device = require('../auth').deviceOf(req);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to join'); }
});

// Routes that need a permission from the person's checklist (lib/crmTeam.js PERMS)
// beyond working deals. Company-wide settings are checked on each route instead.
const WRITE = /^(POST|PATCH|PUT|DELETE)$/;
const PERM_ROUTES = [
  ['money', /^GET$/, /^\/api\/crm\/(invoices|payments|cashflow|costing)$|^\/api\/crm\/deals\/[^/]+\/(costs|draws)$/],
  ['money', WRITE, /^\/api\/crm\/deals\/[^/]+\/(costs|receipts)$|^\/api\/crm\/costs\//],
  ['invoices', WRITE, /^\/api\/crm\/deals\/[^/]+\/(invoices|draws)(\/.*)?$|^\/api\/crm\/invoices\/[^/]+\/(send|paid)$|^\/api\/crm\/draws\/(?!settings$)[^/]+(\/invoice)?$/],
  ['estimates', WRITE, /^\/api\/crm\/deals\/[^/]+\/(estimates|change-orders)$|^\/api\/crm\/estimates\/[^/]+(\/.*)?$|^\/api\/crm\/change-orders\/|^\/api\/crm\/change-catches\/|^\/api\/crm\/takeoffs\/[^/]+\/to-estimate$/],
  ['subs', WRITE, /^\/api\/crm\/vendors(\/.*)?$|^\/api\/crm\/deals\/[^/]+\/pos$|^\/api\/crm\/pos\/|^\/api\/crm\/bids\//]
];

// Everything else under /api/crm is for signed-in people at companies that use the CRM.
router.use('/api/crm', requireAuth, async (req, res, next) => {
  try {
    const me = await team.getUser(req.userId);
    // A removed team member's old session stops working at once, and a marketing login never opens the CRM.
    if (!me || me.tenant_id !== req.tenantId || me.app === 'marketing') return res.status(401).json({ error: { message: 'Not logged in.' } });
    req.crmUser = me;
    // Money, estimates, invoices and subs follow each person's permissions checklist.
    const p = (req.baseUrl + req.path).replace(/\/+$/, '');
    const rule = PERM_ROUTES.find(([, m, re]) => m.test(req.method) && re.test(p));
    if (rule && !team.can(me, rule[0])) return res.status(403).json({ error: { message: team.denyText(rule[0]), code: 'permission' } });
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

// Changes that speak for the whole company need a permission from the person's
// checklist (lib/crmTeam.js PERMS): team.need('settings'), team.need('emails')…

// The company details every automatic email uses (signature and footer).
router.get('/api/crm/company', async (req, res) => {
  try {
    const r = (await query(
      `SELECT t.company_name, bp.phone, bp.email, bp.address, bp.founder_name FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [req.tenantId])).rows[0];
    res.json({ company: r || {} });
  } catch (err) { fail(res, err, 'Failed to load company details'); }
});

router.patch('/api/crm/company', team.need('settings'), async (req, res) => {
  const b = req.body || {};
  const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  if (b.companyName !== undefined && !clean(b.companyName, 120)) return res.status(400).json({ error: { message: 'Add your company name.' } });
  if (b.email && !EMAIL_RE.test(clean(b.email, 200))) return res.status(400).json({ error: { message: 'That email address does not look right.' } });
  if (b.address !== undefined && clean(b.address, 200) && clean(b.address, 200).length < 8) return res.status(400).json({ error: { message: 'Add your full business address; it goes at the bottom of every email.' } });
  try {
    const before = (await query('SELECT email, address FROM business_profile WHERE tenant_id = $1', [req.tenantId])).rows[0] || {};
    if (b.companyName !== undefined) await query('UPDATE tenants SET company_name = $1 WHERE id = $2', [clean(b.companyName, 120), req.tenantId]);
    const sets = []; const vals = [];
    for (const [k, col, max] of [['phone', 'phone', 40], ['email', 'email', 200], ['address', 'address', 200], ['founderName', 'founder_name', 120]]) {
      if (b[k] !== undefined) { vals.push(clean(b[k], max) || null); sets.push(`${col} = $${vals.length}`); }
    }
    if (sets.length) {
      vals.push(req.tenantId);
      await query(`UPDATE business_profile SET ${sets.join(', ')} WHERE tenant_id = $${vals.length}`, vals);
    }
    // The address customers reply to, or the one on every email, changed: the owner should know.
    for (const [k, label] of [['email', 'The company email (where customer replies go)'], ['address', 'The business address on every email']]) {
      if (b[k] !== undefined && (clean(b[k], 200) || null) !== (before[k] || null) && before[k]) {
        await require('../lib/crmAlerts').ownerAlert({ tenantId: req.tenantId, actorId: req.userId, title: `${label} was changed`, detail: `From “${before[k]}” to “${clean(b[k], 200) || '(empty)'}”.`, key: `company-${k}:${Date.now()}` }).catch(() => {});
      }
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

// Download all my data (owners and admins): every record as spreadsheets in one .zip.
router.get('/api/crm/export/all', requireAuth, team.need('data'), async (req, res) => {
  try {
    const buf = await require('../lib/crmExport').exportAll(req.tenantId);
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="eagle-i-data-${new Date().toISOString().slice(0, 10)}.zip"`, 'Cache-Control': 'no-store' });
    res.send(buf);
  } catch (err) { fail(res, err, 'Failed to build the download'); }
});
// "Report a problem": what happened, in their words, plus where they were.
router.post('/api/crm/report-problem', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const what = String(b.what || '').trim().slice(0, 4000);
    if (what.length < 3) return res.status(400).json({ error: { message: 'Say what happened (a sentence is enough).' } });
    const co = (await query('SELECT company_name FROM tenants WHERE id = $1', [req.tenantId])).rows[0] || {};
    const who = req.crmUser || {};
    const ctx = [`Company: ${co.company_name || req.tenantId}`, `Person: ${who.name || ''} <${who.email || ''}> (${who.role || ''})`, `Screen: ${String(b.screen || '').slice(0, 200)}`, `Device: ${String(req.get('user-agent') || '').slice(0, 300)}`, `Recent errors: ${String(b.errors || 'none').slice(0, 3000)}`].join('\n');
    await require('../lib/alerting').sendProblemReport({ from: `${who.name || who.email || 'someone'} at ${co.company_name || 'a company'}`, what, context: ctx });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to send the report'); }
});

// Devices signed in to this account, and signing out everywhere else.
router.get('/api/crm/me/devices', requireAuth, async (req, res) => {
  try {
    const rows = (await query(`SELECT sid, sess->'device' AS device, expire FROM session WHERE sess->>'userId' = $1 ORDER BY expire DESC LIMIT 50`, [String(req.userId)])).rows;
    res.json({ devices: rows.map(r => ({ id: r.sid === req.sessionID ? 'this' : require('crypto').createHash('sha256').update(r.sid).digest('hex').slice(0, 16), name: (r.device && r.device.name) || 'A device (signed in before this list was added)', since: r.device && r.device.at, current: r.sid === req.sessionID })) });
  } catch (err) { fail(res, err, 'Failed to load'); }
});
router.post('/api/crm/me/devices/sign-out-others', requireAuth, async (req, res) => {
  try {
    const r = await query(`DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2`, [String(req.userId), req.sessionID]);
    res.json({ ok: true, signedOut: r.rowCount });
  } catch (err) { fail(res, err, 'Failed to sign out'); }
});

// The getting-started checklist: each step ticks itself off when it's done.
router.get('/api/crm/checklist', requireAuth, async (req, res) => {
  try {
    const t = req.tenantId, u = req.userId, can = (k) => team.can(req.crmUser, k);
    const one = async (sql, p) => (await query(sql, p)).rows[0] || {};
    const [bp, mail, people, pb, deals, subs, cal] = await Promise.all([
      one('SELECT address, phone, email FROM business_profile WHERE tenant_id = $1', [t]),
      one(`SELECT (EXISTS (SELECT 1 FROM crm_mailboxes WHERE tenant_id = $1 AND connected_by = $2) OR EXISTS (SELECT 1 FROM crm_google_connections WHERE tenant_id = $1 AND kind = 'workspace' AND status = 'connected')) AS y`, [t, u]),
      one(`SELECT (SELECT COUNT(*) FROM users WHERE tenant_id = $1)::int + (SELECT COUNT(*) FROM crm_invites WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL)::int AS n`, [t]).catch(() => ({ n: 1 })),
      one('SELECT EXISTS (SELECT 1 FROM crm_playbooks WHERE tenant_id = $1 AND enabled) AS y', [t]),
      one(`SELECT COUNT(*)::int AS n FROM crm_deals d LEFT JOIN crm_imports i ON i.id = d.import_id WHERE d.tenant_id = $1 AND COALESCE(i.filename, '') <> '__practice__'`, [t]),
      one('SELECT COUNT(*)::int AS n FROM crm_vendors WHERE tenant_id = $1 AND NOT archived', [t]),
      one('SELECT crm_calendar_token IS NOT NULL AS y FROM users WHERE id = $1', [u])
    ]);
    const steps = [
      can('settings') && { key: 'company', text: 'Add your company details (address, phone, email)', done: !!(bp.address && bp.address.trim().length >= 8 && bp.phone && bp.email), go: 'company' },
      { key: 'gmail', text: 'Connect your Gmail so customer emails land on their deals', done: !!mail.y, go: 'company' },
      can('team') && { key: 'team', text: 'Invite your team', done: (people.n || 1) > 1, go: 'team' },
      can('emails') && { key: 'emails', text: 'Read and turn on the automatic emails', done: !!pb.y, go: 'auto' },
      { key: 'deal', text: 'Add your first customer', done: (deals.n || 0) > 0, go: 'newdeal' },
      { key: 'subs', text: 'Add your subs and suppliers', done: (subs.n || 0) > 0, go: 'jobs' },
      { key: 'calendar', text: 'Put the Eagle I calendar on your phone', done: !!cal.y, go: 'phone' }
    ].filter(Boolean);
    res.json({ steps, done: steps.filter(x => x.done).length, total: steps.length, practice: await require('../lib/crmAssist').practiceInfo(t) });
  } catch (err) { fail(res, err, 'Failed to load'); }
});
// Practice customers (lib/crmAssist.js): try things out, then remove them all.
router.get('/api/crm/practice', requireAuth, async (req, res) => { try { res.json(await require('../lib/crmAssist').practiceInfo(req.tenantId)); } catch (err) { fail(res, err, 'Failed to load'); } });
router.post('/api/crm/practice', requireAuth, team.need('data'), async (req, res) => { try { res.json(await require('../lib/crmAssist').practiceStart({ tenantId: req.tenantId, userId: req.userId })); } catch (err) { fail(res, err, 'Failed to add them'); } });
router.delete('/api/crm/practice', requireAuth, team.need('data'), async (req, res) => { try { res.json(await require('../lib/crmAssist').practiceRemove(req.tenantId)); } catch (err) { fail(res, err, 'Failed to remove them'); } });
router.get('/api/crm/search', requireAuth, async (req, res) => {
  try { res.json(await require('../lib/crmSearch').search({ tenantId: req.tenantId, userId: req.userId, manager: team.can(req.crmUser, 'see_all'), q: req.query.q })); } catch (err) { fail(res, err, 'Search failed'); }
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
    res.json({ deal, ...(await crm.dealTimeline(req.tenantId, req.params.id)), tasks: await tasks.listForDeal(req.tenantId, req.params.id), nextStep: await crm.nextStep(req.tenantId, req.params.id).catch(() => null) });
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

router.delete('/api/crm/deals/:id', requireAuth, team.need('delete'), async (req, res) => {
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

router.put('/api/crm/playbooks/:id', requireAuth, team.need('emails'), async (req, res) => {
  const { name, steps, stepsEs } = req.body || {};
  try { res.json({ ok: true, ...(await playbooks.savePlaybook({ tenantId: req.tenantId, id: req.params.id, name, steps, stepsEs })) }); } catch (err) { fail(res, err, 'Failed to save the playbook'); }
});

// A Spanish draft to read over (nothing is saved or sent).
router.post('/api/crm/playbooks/:id/spanish', requireAuth, team.need('emails'), async (req, res) => {
  try { res.json({ ok: true, ...(await playbooks.spanishDraft({ tenantId: req.tenantId, id: req.params.id, steps: (req.body || {}).steps || null })) }); } catch (err) { fail(res, err, 'Failed to draft the Spanish'); }
});

router.post('/api/crm/playbooks/:id/approve', requireAuth, team.need('emails'), async (req, res) => {
  try { await playbooks.approvePlaybook({ tenantId: req.tenantId, id: req.params.id }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to approve the playbook'); }
});

router.post('/api/crm/playbooks/:id/enabled', requireAuth, team.need('emails'), async (req, res) => {
  try { await playbooks.setEnabled({ tenantId: req.tenantId, id: req.params.id, enabled: !!(req.body || {}).enabled }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to switch the playbook'); }
});

router.post('/api/crm/playbooks/:id/reset', requireAuth, team.need('emails'), async (req, res) => {
  try { res.json({ ok: true, ...(await playbooks.resetPlaybook({ tenantId: req.tenantId, id: req.params.id })) }); } catch (err) { fail(res, err, 'Failed to reset the playbook'); }
});

router.get('/api/crm/automations/upcoming', requireAuth, async (req, res) => {
  try { res.json({ sends: await playbooks.upcomingSends(req.tenantId) }); } catch (err) { fail(res, err, 'Failed to load'); }
});
router.post('/api/crm/automations/sends/:id/skip', requireAuth, team.need('emails'), async (req, res) => {
  try { if (!(await playbooks.skipSend({ tenantId: req.tenantId, id: req.params.id }))) return res.status(404).json({ error: { message: 'That email already went out or was cancelled.' } }); res.json({ ok: true }); }
  catch (err) { fail(res, err, 'Failed to skip it'); }
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

router.patch('/api/crm/settings', requireAuth, team.need('emails'), async (req, res) => {
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
    // "My team": the owner and admins see everyone's; a project manager or
    // superintendent sees their own and the people under them.
    let ids = [req.userId];
    if (req.query.all === '1') {
      const r = await team.reach(req.tenantId, req.crmUser);
      ids = team.can(req.crmUser, 'see_all') ? null : [req.userId, ...r.below];
    }
    const [inbox, open, visits] = await Promise.all([
      crm.listInbox(req.tenantId),
      tasks.listOpen(req.tenantId, { userIds: ids }),
      query(
        `SELECT d.id, d.title, d.site_visit_at, c.name AS contact_name, p.address FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id
         LEFT JOIN crm_properties p ON p.id = d.property_id
         WHERE d.tenant_id = $1 AND d.site_visit_at BETWEEN now() - interval '2 hours' AND now() + interval '7 days' AND d.stage NOT IN ('lost', 'complete')
           AND ($2::uuid[] IS NULL OR COALESCE(d.site_visit_user_id, d.owner_user_id) = ANY($2::uuid[]) OR COALESCE(d.site_visit_user_id, d.owner_user_id) IS NULL)
         ORDER BY d.site_visit_at LIMIT 50`, [req.tenantId, ids]).then(r => r.rows)
    ]);
    res.json({ inbox, tasks: open, visits, team: ids === null || ids.length > 1 });
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
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  if (b.name !== undefined && !name) return res.status(400).json({ error: { message: 'Add your name.' } });
  const phone = b.phone === undefined ? undefined : String(b.phone || '').trim().slice(0, 40);
  if (phone && !/^(1)?\d{10}$/.test(phone.replace(/\D/g, ''))) return res.status(400).json({ error: { message: 'That phone number doesn’t look right. Use 10 digits, like 713-555-0100.' } });
  try {
    if (name) await query('UPDATE users SET name = $1 WHERE id = $2', [name, req.userId]);
    if (phone !== undefined) await query('UPDATE users SET phone = $1 WHERE id = $2', [phone || null, req.userId]);
    res.json({ ok: true });
  }
  catch (err) { fail(res, err, 'Failed to save your name'); }
});

// Guided setup finished (or skipped): the company's for the owner, their own for anyone else.
router.post('/api/crm/setup/done', requireAuth, async (req, res) => {
  try {
    if (req.crmUser.role === 'owner') await query('UPDATE tenants SET setup_done_at = COALESCE(setup_done_at, now()) WHERE id = $1', [req.tenantId]);
    await query('UPDATE users SET setup_done_at = COALESCE(setup_done_at, now()) WHERE id = $1', [req.userId]);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to save'); }
});

router.get('/api/crm/team', requireAuth, async (req, res) => {
  try {
    const r = await team.reach(req.tenantId, req.crmUser);
    const roles = Object.entries(team.ROLE_INFO).map(([key, v]) => ({ key, ...v }));
    res.json({ ...(await team.listTeam(req.tenantId)), roles, perms: team.PERMS, defaults: team.ROLE_DEFAULTS,
      me: { id: req.crmUser.id, role: req.crmUser.role, sees: [...r.ids], canAssign: [...r.assign], below: [...r.below], above: [...r.above] } });
  } catch (err) { fail(res, err, 'Failed to load your team'); }
});

// Whether schedules are seen up and down each person's line, or by everyone.
router.patch('/api/crm/team-settings', requireAuth, team.need('team'), async (req, res) => {
  try { await team.setVisibility({ tenantId: req.tenantId, visibility: (req.body || {}).visibility }); res.json({ ok: true }); }
  catch (err) { fail(res, err, 'Failed to save'); }
});

router.post('/api/crm/team/invites', requireAuth, team.need('team'), async (req, res) => {
  const { email, name, role, reportsTo } = req.body || {};
  if (role === 'admin' && !team.isManager(req.crmUser.role)) return res.status(403).json({ error: { message: 'Only the owner or an admin can invite an admin.' } });
  try { await require('../lib/crmBilling').checkSeat(req.tenantId); res.json({ ok: true, ...(await team.createInvite({ tenantId: req.tenantId, invitedBy: req.userId, email, name, role: role || 'member', reportsTo: reportsTo || null, baseUrl: baseUrlOf(req) })) }); }
  catch (err) { fail(res, err, 'Failed to send the invitation'); }
});

router.delete('/api/crm/team/invites/:id', requireAuth, team.need('team'), async (req, res) => {
  try {
    if (!(await team.revokeInvite({ tenantId: req.tenantId, id: req.params.id }))) return res.status(404).json({ error: { message: 'Invitation not found.' } });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to cancel the invitation'); }
});

// { role } and/or { reportsTo } (a user id, or null for no one).
router.patch('/api/crm/team/:userId', requireAuth, team.need('team'), async (req, res) => {
  const b = req.body || {};
  try {
    if (b.role !== undefined) await team.setRole({ tenantId: req.tenantId, actor: req.crmUser, userId: req.params.userId, role: b.role });
    if (b.reportsTo !== undefined) await team.setReportsTo({ tenantId: req.tenantId, actor: req.crmUser, userId: req.params.userId, reportsTo: b.reportsTo || null });
    // { permissions: { key: true|false } } adjusts their checklist; null puts them back on their role's defaults.
    if (b.permissions !== undefined) return res.json({ ok: true, permissions: await team.setPermissions({ tenantId: req.tenantId, actor: req.crmUser, userId: req.params.userId, permissions: b.permissions }) });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to change the role'); }
});

router.delete('/api/crm/team/:userId', requireAuth, team.need('team'), async (req, res) => {
  try { await team.removeMember({ tenantId: req.tenantId, actor: req.crmUser, userId: req.params.userId }); res.json({ ok: true }); }
  catch (err) { fail(res, err, 'Failed to remove the team member'); }
});

module.exports = router;
