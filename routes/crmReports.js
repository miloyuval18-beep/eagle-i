// Weekly reports in Eagle I CRM (lib/crmReports.js). Mounted after
// routes/crm.js (signed in, company has the CRM). Reports talk about team
// members, so they're for the owner and admins.
const express = require('express');
const { requireAuth } = require('../auth');
const reports = require('../lib/crmReports');
const team = require('../lib/crmTeam');

const router = express.Router();

function fail(res, err, what) {
  const status = err.status || 500;
  res.status(status).json({ error: { message: status === 500 ? `${what}: ${err.message}` : err.message } });
}
function managersOnly(req, res, next) {
  if (team.isManager(req.crmUser && req.crmUser.role)) return next();
  res.status(403).json({ error: { message: 'Weekly reports are for the owner and admins.' } });
}

router.get('/api/crm/reports', requireAuth, managersOnly, async (req, res) => {
  try { res.json({ reports: await reports.listReports(req.tenantId) }); } catch (err) { fail(res, err, 'Failed to load reports'); }
});

// "So far this week": the last 7 days, written now and not saved. A few a day per company.
const recent = new Map();
router.post('/api/crm/reports/now', requireAuth, managersOnly, async (req, res) => {
  const now = Date.now();
  const list = (recent.get(req.tenantId) || []).filter(t => now - t < 86400000);
  if (list.length >= 5) return res.status(429).json({ error: { message: 'You can write up to 5 of these a day. The full report arrives on Monday.' } });
  list.push(now); recent.set(req.tenantId, list);
  try {
    const end = new Date(now);
    res.json({ report: await reports.buildReport(req.tenantId, { start: new Date(now - 7 * 86400000), end }, { save: false }) });
  } catch (err) { fail(res, err, 'Failed to write the report'); }
});

router.get('/api/crm/reports/:week', requireAuth, managersOnly, async (req, res) => {
  if (!require('../lib/day').test(req.params.week)) return res.status(404).json({ error: { message: 'Report not found.' } });
  try {
    const r = await reports.getReport(req.tenantId, req.params.week);
    if (!r) return res.status(404).json({ error: { message: 'Report not found.' } });
    res.json({ report: r });
  } catch (err) { fail(res, err, 'Failed to load the report'); }
});

module.exports = router;
