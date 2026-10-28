// The daily check-in (lib/crmCheckins.js): today's chat with Eagle I, your earlier
// check-ins, and for the owner, admins and company reports: everyone's day,
// progress by project, problems and any full chat.
//
// Mounted after routes/crm.js's sign-in and "company has the CRM" check.
const express = require('express');
const { requireAuth } = require('../auth');
const ci = require('../lib/crmCheckins');
const team = require('../lib/crmTeam');

const router = express.Router();
function fail(res, err, what) {
  const status = err.status || 500;
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
const wrap = (what, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, what); } };
const hide = (req, x) => team.can(req.crmUser, 'money') ? x : team.hideMoney(x);

// The Eagle I admin looking at a company (routes/admin.js) has no check-in of their own
// there: they see the company's Team, Projects and Problems, and nothing is made for them.
const ADMIN = 'The Eagle I admin doesn’t have a check-in of their own here.';
router.get('/api/crm/checkins/today', requireAuth, wrap('Failed to load your check-in', async (req, res) => {
  if (req.adminView) return res.json({ checkin: null, ai: !!process.env.ANTHROPIC_API_KEY, canSeeTeam: true });
  res.json({ ...(await ci.view(req.userId)), canSeeTeam: ci.canSeeTeam(req.crmUser) });
}));
router.post('/api/crm/checkins/today/message', requireAuth, wrap('Eagle I couldn’t answer', async (req, res) => {
  if (req.adminView) return res.status(403).json({ error: { message: ADMIN } });
  const b = req.body || {};
  res.json(await ci.message(req.userId, b.text, { voice: !!b.voice }));
}));
// "I'm done" (or the form, when the AI isn't on).
router.post('/api/crm/checkins/today/finish', requireAuth, wrap('Failed to save your check-in', async (req, res) => {
  if (req.adminView) return res.status(403).json({ error: { message: ADMIN } });
  const b = req.body || {};
  res.json({ checkin: await ci.finish(req.userId, { form: b.form || null }) });
}));
router.get('/api/crm/checkins/mine', requireAuth, wrap('Failed to load', async (req, res) => {
  if (req.adminView) return res.json({ items: [] });
  res.json({ items: await ci.mine(req.userId, { before: req.query.before }) });
}));
router.get('/api/crm/checkins/team', requireAuth, wrap('Failed to load', async (req, res) => res.json(hide(req, await ci.teamDay(req.crmUser, req.query.day)))));
router.get('/api/crm/checkins/projects', requireAuth, wrap('Failed to load', async (req, res) => res.json(hide(req, await ci.projects(req.crmUser, { days: req.query.days })))));
router.get('/api/crm/checkins/problems', requireAuth, wrap('Failed to load', async (req, res) => res.json({ items: hide(req, await ci.problems(req.crmUser, { all: req.query.all === '1' })) })));
router.post('/api/crm/checkins/problems/:id/handled', requireAuth, wrap('Failed to save', async (req, res) => res.json(await ci.handleProblem(req.crmUser, req.params.id))));
router.get('/api/crm/checkins/:id/chat', requireAuth, wrap('Failed to load', async (req, res) => res.json(hide(req, await ci.chat(req.crmUser, req.params.id)))));

module.exports = router;
