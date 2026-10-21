// Referrals, trade partners, reviews and the home file (lib/crmLifetime.js).
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it). /r/<code> is anyone's referral link.
const express = require('express');
const { requireAuth } = require('../auth');
const life = require('../lib/crmLifetime');
const team = require('../lib/crmTeam');
const { query } = require('../db');

const router = express.Router();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
function fail(res, err, what) {
  const status = err.status || 500;
  if (/invalid input syntax for type uuid/.test(err.message || '')) return res.status(404).json({ error: { message: 'Not found.' } });
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };
const manager = (req) => team.isManager(req.crmUser && req.crmUser.role);
const managersOnly = (res) => res.status(403).json({ error: { message: 'Only the owner or an admin can change this.' } });
async function ownDeal(req, res) {
  const r = await query('SELECT * FROM crm_deals WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]).catch(() => ({ rows: [] }));
  if (!r.rows.length) { res.status(404).json({ error: { message: 'Deal not found.' } }); return null; }
  return r.rows[0];
}

router.get('/api/crm/lifetime/settings', requireAuth, wrap('Failed to load settings', async (req, res) => res.json(await life.lifetimeSettings(req.tenantId))));
router.patch('/api/crm/lifetime/settings', requireAuth, wrap('Failed to save settings', async (req, res) => {
  if (!manager(req)) return managersOnly(res);
  const b = req.body || {};
  res.json(await life.saveLifetimeSettings(req.tenantId, { referralReward: b.referralReward, reviewUrl: b.reviewUrl, warrantyMonths: b.warrantyMonths }));
}));

// The scoreboard: partners, referring clients, rewards.
router.get('/api/crm/referrals', requireAuth, wrap('Failed to load referrals', async (req, res) => {
  const board = await life.scoreboard(req.tenantId);
  const base = baseUrlOf(req);
  board.partners = board.partners.map(p => ({ ...p, link: `${base}/r/${p.code}` }));
  res.json({ ...board, kinds: life.PARTNER_KINDS, settings: await life.lifetimeSettings(req.tenantId) });
}));
router.post('/api/crm/partners', requireAuth, wrap('Failed to save the partner', async (req, res) => res.json({ ok: true, partner: await life.savePartner({ tenantId: req.tenantId, body: req.body }) })));
router.patch('/api/crm/partners/:pid', requireAuth, wrap('Failed to save the partner', async (req, res) => res.json({ ok: true, partner: await life.savePartner({ tenantId: req.tenantId, id: req.params.pid, body: req.body }) })));
router.delete('/api/crm/partners/:pid', requireAuth, wrap('Failed to remove the partner', async (req, res) => {
  if (!manager(req)) return managersOnly(res);
  const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'partner', id: req.params.pid, userId: req.userId }, async () => !!(await life.archivePartner({ tenantId: req.tenantId, id: req.params.pid })));
  if (!r.ok) return res.status(404).json({ error: { message: 'Partner not found.' } });
  res.json({ ok: true, undo: r.undo });
}));
router.post('/api/crm/rewards/:rid', requireAuth, wrap('Failed to save', async (req, res) => {
  if (!manager(req)) return managersOnly(res);
  const r = await life.setRewardPaid({ tenantId: req.tenantId, id: req.params.rid, paid: !!(req.body || {}).paid });
  if (!r) return res.status(404).json({ error: { message: 'Reward not found.' } });
  res.json({ ok: true, reward: r });
}));

// One deal: who referred it, the homeowner's own referral link, the home file.
router.get('/api/crm/deals/:id/lifetime', requireAuth, wrap('Failed to load', async (req, res) => {
  const deal = await ownDeal(req, res);
  if (!deal) return;
  const ref = (await query(
    `SELECT p.id AS partner_id, p.name AS partner_name, c.id AS contact_id, c.name AS contact_name FROM crm_deals d
     LEFT JOIN crm_partners p ON p.id = d.partner_id LEFT JOIN crm_contacts c ON c.id = d.referred_by_contact_id WHERE d.id = $1`, [deal.id])).rows[0];
  const partners = (await query('SELECT id, name, company FROM crm_partners WHERE tenant_id = $1 AND archived = false ORDER BY name', [req.tenantId])).rows;
  res.json({
    referrer: ref.partner_id ? { kind: 'partner', id: ref.partner_id, name: ref.partner_name } : ref.contact_id ? { kind: 'client', id: ref.contact_id, name: ref.contact_name } : null,
    partners, referralLink: `${baseUrlOf(req)}/r/${await life.contactCode(req.tenantId, deal.contact_id)}`,
    home: await life.listHomeItems(req.tenantId, deal.id), categories: life.HOME_CATEGORIES
  });
}));
router.patch('/api/crm/deals/:id/referrer', requireAuth, wrap('Failed to save', async (req, res) => {
  const b = req.body || {};
  await life.setReferrer({ tenantId: req.tenantId, dealId: req.params.id, partnerId: b.partnerId || null, contactId: b.contactId || null });
  res.json({ ok: true });
}));
router.post('/api/crm/deals/:id/home', requireAuth, wrap('Failed to save the item', async (req, res) => res.json({ ok: true, item: await life.saveHomeItem({ tenantId: req.tenantId, dealId: req.params.id, body: req.body }) })));
router.patch('/api/crm/home/:itemId', requireAuth, wrap('Failed to save the item', async (req, res) => res.json({ ok: true, item: await life.saveHomeItem({ tenantId: req.tenantId, id: req.params.itemId, body: req.body }) })));
router.delete('/api/crm/home/:itemId', requireAuth, wrap('Failed to delete the item', async (req, res) => {
  const r = await require('../lib/crmTrash').around({ tenantId: req.tenantId, kind: 'home', id: req.params.itemId, userId: req.userId }, async () => !!(await life.deleteHomeItem({ tenantId: req.tenantId, id: req.params.itemId })));
  if (!r.ok) return res.status(404).json({ error: { message: 'Item not found.' } });
  res.json({ ok: true, undo: r.undo });
}));

// Anyone's referral link: on to the company's inquiry form.
router.get('/r/:code', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  try {
    const to = await life.referralTarget(req.params.code);
    if (!to) return res.status(404).type('text/plain').send('This link is no longer active.');
    res.redirect(302, to);
  } catch (err) { res.status(500).type('text/plain').send('Something went wrong. Please try again.'); }
});

module.exports = router;
