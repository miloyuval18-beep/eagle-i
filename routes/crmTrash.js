// The recycle bin (lib/crmTrash.js).
//
// /api/crm/* routes sit behind routes/crm.js's sign-in and "company has the
// CRM" check (mounted after it).
const express = require('express');
const { requireAuth } = require('../auth');
const trash = require('../lib/crmTrash');
const team = require('../lib/crmTeam');

const router = express.Router();
function fail(res, err, what) {
  const status = err.status || 500;
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };
const manager = (req) => team.isManager(req.crmUser && req.crmUser.role);
// Members restore what they deleted; the owner and admins anything.
async function allowed(req) {
  const e = await trash.entry(req.tenantId, req.params.id);
  if (!e) { const x = new Error('That’s no longer in the recycle bin.'); x.status = 404; throw x; }
  if (!manager(req) && e.deleted_by !== req.userId) { const x = new Error('Only the person who deleted it, the owner or an admin can restore it.'); x.status = 403; throw x; }
  return e;
}

router.get('/api/crm/trash', requireAuth, wrap('Failed to load the recycle bin', async (req, res) => {
  res.json({ items: await trash.list(req.tenantId, { userId: manager(req) ? null : req.userId }), days: trash.DAYS, everyone: manager(req) });
}));
router.post('/api/crm/trash/:id/restore', requireAuth, wrap('Failed to restore it', async (req, res) => {
  await allowed(req);
  res.json({ ok: true, restored: await trash.restore({ tenantId: req.tenantId, id: req.params.id }) });
}));
router.delete('/api/crm/trash/:id', requireAuth, wrap('Failed to delete it', async (req, res) => {
  if (!manager(req)) return res.status(403).json({ error: { message: 'Only the owner or an admin can delete things for good.' } });
  await allowed(req);
  res.json({ ok: (await trash.purge({ tenantId: req.tenantId, id: req.params.id })) > 0 });
}));

module.exports = router;
