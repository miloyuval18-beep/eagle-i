// Running the job (lib/crmJobs.js): schedule, daily logs, subs and vendors,
// purchase orders, change orders and selections.
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it). The homeowner answers change orders and
// picks selections through their portal token, no login.
const express = require('express');
const { requireAuth } = require('../auth');
const jobs = require('../lib/crmJobs');
const team = require('../lib/crmTeam');
const { query } = require('../db');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;

function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  if (/RESEND_API_KEY/.test(err.message || '')) return res.status(503).json({ error: { message: 'Email sending is not set up on the server yet.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const manager = (req) => team.isManager(req.crmUser && req.crmUser.role);
async function ownDeal(req, res) {
  const r = await query('SELECT id FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]).catch(() => ({ rows: [] }));
  if (!r.rows.length) { res.status(404).json({ error: { message: 'Deal not found.' } }); return false; }
  return true;
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };

// Permits (lib/crmPermits.js): what the job needs and where each stands.
const permits = require('../lib/crmPermits');
// ---------- SOPs (lib/crmSops.js) ----------
const sops = () => require('../lib/crmSops');
router.get('/api/crm/sops', requireAuth, wrap('Failed to load the SOPs', async (req, res) => res.json(await sops().list(req.tenantId, { category: req.query.category ? String(req.query.category).slice(0, 20) : null }))));
router.get('/api/crm/sops/:id', requireAuth, wrap('Failed to load the SOP', async (req, res) => {
  const s = await sops().get(req.tenantId, req.params.id);
  if (!s) return res.status(404).json({ error: { message: 'SOP not found.' } });
  res.json({ sop: s });
}));
router.post('/api/crm/sops', requireAuth, wrap('Couldn’t write the SOP', async (req, res) => {
  const b = req.body || {};
  res.json({ sop: await sops().generate({ tenantId: req.tenantId, userId: req.userId, category: String(b.category || ''), kind: String(b.kind || 'project'), request: b.request, dealId: /^[0-9a-f-]{36}$/i.test(String(b.dealId || '')) ? b.dealId : null, vendorId: /^[0-9a-f-]{36}$/i.test(String(b.vendorId || '')) ? b.vendorId : null, audience: b.audience }) });
}));
router.post('/api/crm/sops/:id/revise', requireAuth, wrap('Couldn’t change the SOP', async (req, res) => res.json({ sop: await sops().revise({ tenantId: req.tenantId, id: req.params.id, instruction: (req.body || {}).instruction }) })));
router.delete('/api/crm/sops/:id', requireAuth, wrap('Couldn’t delete the SOP', async (req, res) => {
  const s = await sops().get(req.tenantId, req.params.id);
  if (!s) return res.status(404).json({ error: { message: 'SOP not found.' } });
  const own = (await require('../db').query('SELECT created_by FROM crm_sops WHERE id = $1', [s.id])).rows[0];
  if (!team.isManager(req.crmUser.role) && own.created_by !== req.userId) return res.status(403).json({ error: { message: 'Only the person who made it, or a manager, can delete it.' } });
  res.json(await sops().remove(req.tenantId, s.id));
}));
// Printed like the company's paper SOPs: a page to print or save as PDF.
router.get('/api/crm/sops/:id/print', requireAuth, wrap('Failed to open the SOP', async (req, res) => {
  const s = await sops().get(req.tenantId, req.params.id);
  if (!s) return res.status(404).send('SOP not found.');
  const co = (await require('../db').query(`SELECT t.company_name, bp.phone, bp.email, bp.address FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [req.tenantId])).rows[0] || {};
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' }).send(sops().html(s, co));
}));
// Who it can go to, the right people ticked (lib/crmSops.js recipients).
router.get('/api/crm/sops/:id/recipients', requireAuth, wrap('Failed to load', async (req, res) => {
  const s = await sops().get(req.tenantId, req.params.id);
  if (!s) return res.status(404).json({ error: { message: 'SOP not found.' } });
  res.json({ recipients: await sops().recipients(req.tenantId, s) });
}));
// Sent to the people picked (and anyone typed in): each their own email, the SOP in it.
router.post('/api/crm/sops/:id/email', requireAuth, wrap('Couldn’t send the SOP', async (req, res) => {
  const s = await sops().get(req.tenantId, req.params.id);
  if (!s) return res.status(404).json({ error: { message: 'SOP not found.' } });
  const b = req.body || {};
  const list = [...new Set((Array.isArray(b.to) ? b.to : String(b.to || '').split(/[,;\s]+/)).map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const bad = list.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (bad.length) return res.status(400).json({ error: { message: `That email address doesn’t look right: ${bad[0]}` } });
  if (!list.length) return res.status(400).json({ error: { message: 'Pick who to send it to.' } });
  if (list.length > 40) return res.status(400).json({ error: { message: 'Send it to 40 people or fewer at a time.' } });
  const db = require('../db');
  const co = (await db.query(`SELECT t.company_name, bp.phone, bp.email, bp.address FROM tenants t LEFT JOIN business_profile bp ON bp.tenant_id = t.id WHERE t.id = $1`, [req.tenantId])).rows[0] || {};
  const me = (await db.query('SELECT name, email FROM users WHERE id = $1', [req.userId])).rows[0] || {};
  const note = String(b.note || '').trim().slice(0, 2000);
  const page = sops().html(s, co).replace(/<div class="bar">[\s\S]*?<\/div>/, '').replace('src="/home/lion.png"', `src="${require('../lib/appUrl').appUrl()}/home/lion.png"`);
  const body = page.slice(page.indexOf('<body>') + 6, page.lastIndexOf('</body>'));
  const style = page.slice(page.indexOf('<style>'), page.indexOf('</style>') + 8);
  const text = `${s.title}\n\n${s.content.sections.map((sec, k) => `${'ABCDEFGHIJKL'[k]}. ${sec.heading}\n${sec.steps.map(st => `- ${st.title} ${st.text}${st.done ? ` Done when: ${st.done}` : ''}`).join('\n')}`).join('\n\n')}`;
  const esc = (x) => String(x).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  let sent = 0, held = 0;
  const failed = [];
  for (const to of list) {
    try {
      const r = await require('../lib/email').sendEmail({ to, subject: `${s.title} · ${co.company_name || ''}`.replace(/ · $/, ''), replyTo: me.email || co.email || undefined,
        fromName: me.name ? `${me.name} · ${co.company_name || ''}`.replace(/ · $/, '') : co.company_name,
        html: `${style}${note ? `<p style="font-family:Arial;font-size:15px;white-space:pre-wrap">${esc(note)}</p>` : ''}${body}`, text: `${note ? note + '\n\n' : ''}${text}` });
      if (r && r.paused) held++; else sent++;
    } catch (e) { failed.push(to); }
  }
  if (s.dealId) await require('../lib/crm').logActivity({ tenantId: req.tenantId, dealId: s.dealId, kind: 'email', userId: req.userId, body: `Sent the SOP “${s.title}” to ${list.length === 1 ? list[0] : list.length + ' people'}${held ? ' (held: email is paused)' : ''}` }).catch(() => {});
  res.json({ ok: !failed.length, sent, held, failed, paused: held > 0 && !sent });
}));

router.post('/api/crm/deals/:id/permits', requireAuth, wrap('Failed to add the permit', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  res.json({ permit: await permits.save({ tenantId: req.tenantId, dealId: req.params.id, body: req.body, userId: req.userId }) });
}));
router.post('/api/crm/deals/:id/permits/suggest', requireAuth, wrap('Failed to work out the permits', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  res.json(await permits.suggest({ tenantId: req.tenantId, dealId: req.params.id, userId: req.userId }));
}));
router.put('/api/crm/permits/:pid', requireAuth, wrap('Failed to save the permit', async (req, res) => res.json({ permit: await permits.save({ tenantId: req.tenantId, id: req.params.pid, body: req.body, userId: req.userId }) })));
router.delete('/api/crm/permits/:pid', requireAuth, wrap('Failed to delete the permit', async (req, res) => res.json(await permits.remove({ tenantId: req.tenantId, id: req.params.pid }))));

router.get('/api/crm/jobs', requireAuth, wrap('Failed to load jobs', async (req, res) => res.json({ jobs: await jobs.listJobs(req.tenantId) })));

router.get('/api/crm/deals/:id/job', requireAuth, wrap('Failed to load the job', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  let [schedule, logs, pos, cos, selections, vendors] = await Promise.all([
    jobs.listSchedule(req.tenantId, req.params.id), jobs.listLogs(req.tenantId, req.params.id), jobs.listPOs(req.tenantId, req.params.id),
    jobs.listCOs(req.tenantId, req.params.id), jobs.listSelections(req.tenantId, req.params.id), jobs.listVendors(req.tenantId)]);
  // Without "See money": purchase-order prices only for people who work with subs, change-order
  // prices only for people who make estimates, and the company's own costs for nobody.
  const can = (k) => team.can(req.crmUser, k);
  if (!can('money')) {
    if (!can('subs')) pos = team.hideMoney(pos);
    cos = can('estimates') ? cos.map(c => ({ ...c, cost: null })) : team.hideMoney(cos);
    selections = team.hideMoney(selections);
  }
  const permits = await require('../lib/crmPermits').list(req.tenantId, req.params.id);
  res.json({ schedule, logs, pos, cos, selections, vendors, permits, ai: !!process.env.ANTHROPIC_API_KEY, moneyHidden: !can('money') });
}));

// schedule
router.post('/api/crm/deals/:id/schedule/from-template', requireAuth, wrap('Failed to lay out the schedule', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  res.json({ ok: true, ...(await jobs.createScheduleFromTemplate({ tenantId: req.tenantId, dealId: req.params.id, startDate: (req.body || {}).startDate })) });
}));
router.post('/api/crm/deals/:id/schedule/save-template', requireAuth, wrap('Failed to save the template', async (req, res) => {
  if (!team.can(req.crmUser, 'settings')) return res.status(403).json({ error: { message: team.denyText('settings') } });
  res.json({ ok: true, ...(await jobs.saveTemplateFromJob({ tenantId: req.tenantId, dealId: req.params.id })) });
}));
router.post('/api/crm/deals/:id/schedule', requireAuth, wrap('Failed to add the phase', async (req, res) => {
  if (!(await ownDeal(req, res))) return;
  res.json({ ok: true, item: await jobs.saveItem({ tenantId: req.tenantId, dealId: req.params.id, body: req.body, userId: req.userId }) });
}));
router.patch('/api/crm/schedule/:itemId', requireAuth, wrap('Failed to save the phase', async (req, res) => {
  res.json({ ok: true, item: await jobs.saveItem({ tenantId: req.tenantId, id: req.params.itemId, body: req.body, userId: req.userId }) });
}));
router.delete('/api/crm/schedule/:itemId', requireAuth, wrap('Failed to delete the phase', async (req, res) => {
  const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'phase', id: req.params.itemId, userId: req.userId }, () => jobs.deleteItem({ tenantId: req.tenantId, id: req.params.itemId }));
  if (!r.ok) return res.status(404).json({ error: { message: 'Phase not found.' } });
  res.json({ ok: true, undo: r.undo });
}));

// daily logs
router.post('/api/crm/deals/:id/logs', requireAuth, wrap('Failed to save the log', async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, log: await jobs.addLog({ tenantId: req.tenantId, dealId: req.params.id, body: b.body, crew: b.crew, logDate: b.logDate, shared: !!b.shared, userId: req.userId }) });
}));

// subs & vendors
router.get('/api/crm/vendors', requireAuth, wrap('Failed to load vendors', async (req, res) => res.json({ vendors: await jobs.listVendors(req.tenantId) })));
// Many at once: a PDF or Excel list, or a photo of a business card (lib/crmVendorList.js). Read first, added on "Add".
router.post('/api/crm/vendors/file/read', requireAuth, wrap('Couldn’t read that file', async (req, res) => {
  const b = req.body || {};
  res.json(await require('../lib/crmVendorList').fromUpload({ tenantId: req.tenantId, filename: String(b.filename || '').slice(0, 200), dataBase64: b.dataBase64 }));
}));
router.post('/api/crm/vendors/file/add', requireAuth, wrap('Couldn’t add the vendors', async (req, res) => {
  const b = req.body || {};
  const add = (Array.isArray(b.add) ? b.add : []).slice(0, 500), fill = (Array.isArray(b.fill) ? b.fill : []).filter(f => f && /^[0-9a-f-]{36}$/i.test(String(f.id || ''))).slice(0, 500);
  res.json({ ok: true, ...(await require('../lib/crmVendorList').apply(req.tenantId, { add, fill })) });
}));
router.post('/api/crm/vendors', requireAuth, wrap('Failed to save the vendor', async (req, res) => res.json({ ok: true, vendor: await jobs.saveVendor({ tenantId: req.tenantId, body: req.body }) })));
router.patch('/api/crm/vendors/:vendorId', requireAuth, wrap('Failed to save the vendor', async (req, res) => res.json({ ok: true, vendor: await jobs.saveVendor({ tenantId: req.tenantId, id: req.params.vendorId, body: req.body }) })));
router.delete('/api/crm/vendors/:vendorId', requireAuth, wrap('Failed to remove the vendor', async (req, res) => {
  if (!team.can(req.crmUser, 'subs')) return res.status(403).json({ error: { message: team.denyText('subs') } });
  const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'vendor', id: req.params.vendorId, userId: req.userId }, () => jobs.archiveVendor({ tenantId: req.tenantId, id: req.params.vendorId }));
  if (!r.ok) return res.status(404).json({ error: { message: 'Vendor not found.' } });
  res.json({ ok: true, undo: r.undo });
}));

// purchase orders
router.post('/api/crm/deals/:id/pos', requireAuth, wrap('Failed to create the purchase order', async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, po: await jobs.createPO({ tenantId: req.tenantId, dealId: req.params.id, vendorId: b.vendorId || null, title: b.title, lines: b.lines, category: b.category, neededBy: b.neededBy, note: b.note, userId: req.userId }) });
}));
router.post('/api/crm/pos/:poId/send', requireAuth, wrap('Failed to send the purchase order', async (req, res) => res.json({ ok: true, ...(await jobs.sendPO({ baseUrl: `${req.protocol}://${req.get('host')}`, tenantId: req.tenantId, id: req.params.poId, userId: req.userId })) })));
router.patch('/api/crm/pos/:poId', requireAuth, wrap('Failed to save', async (req, res) => {
  const po = await jobs.setPOStatus({ tenantId: req.tenantId, id: req.params.poId, status: (req.body || {}).status, userId: req.userId });
  if (!po) return res.status(404).json({ error: { message: 'Purchase order not found.' } });
  res.json({ ok: true, po });
}));

// change orders
router.post('/api/crm/deals/:id/change-orders', requireAuth, wrap('Failed to create the change order', async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, co: await jobs.createCO({ tenantId: req.tenantId, dealId: req.params.id, title: b.title, description: b.description, amount: b.amount, cost: b.cost, daysAdded: b.daysAdded, userId: req.userId }) });
}));
router.post('/api/crm/change-orders/:coId/send', requireAuth, wrap('Failed to send the change order', async (req, res) => res.json({ ok: true, ...(await jobs.sendCO({ tenantId: req.tenantId, id: req.params.coId, userId: req.userId, baseUrl: baseUrlOf(req) })) })));

// selections
router.post('/api/crm/deals/:id/selections', requireAuth, wrap('Failed to save the selection', async (req, res) => res.json({ ok: true, selection: await jobs.saveSelection({ tenantId: req.tenantId, dealId: req.params.id, body: req.body }) })));
router.patch('/api/crm/selections/:selId', requireAuth, wrap('Failed to save the selection', async (req, res) => res.json({ ok: true, selection: await jobs.saveSelection({ tenantId: req.tenantId, id: req.params.selId, body: req.body }) })));
router.post('/api/crm/selections/:selId/clear', requireAuth, wrap('Failed to clear the choice', async (req, res) => {
  if (!(await jobs.clearChoice({ tenantId: req.tenantId, id: req.params.selId }))) return res.status(404).json({ error: { message: 'Selection not found.' } });
  res.json({ ok: true });
}));

// ---------- the homeowner, through the portal ----------
const hits = new Map();
function limited(ip) { const now = Date.now(); const l = (hits.get(ip) || []).filter(t => now - t < 3600000); l.push(now); hits.set(ip, l); return l.length > 30; }
router.post('/api/crm-public/portal/:token/change-orders/:coId', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  const b = req.body || {};
  try { await jobs.answerCO({ token: req.params.token, id: req.params.coId, approve: !!b.approve, name: b.name, ip: req.ip }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Failed to save your answer'); }
});
router.post('/api/crm-public/portal/:token/selections/:selId', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: { message: 'Too many attempts. Please try again later.' } });
  try { res.json({ ok: true, ...(await jobs.chooseOption({ token: req.params.token, id: req.params.selId, index: (req.body || {}).index })) }); } catch (err) { fail(res, err, 'Failed to save your choice'); }
});

module.exports = router;
