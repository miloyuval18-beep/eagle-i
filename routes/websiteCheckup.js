// A real checkup of the tenant's OWN website (business_profile.site) —
// no external paid API involved (just one outbound fetch of their own
// site), so unlike the Places-backed competitor lookup this needs no
// usage cap. See lib/websiteCheckup.js for the actual analysis.
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { checkOwnWebsite } = require('../lib/websiteCheckup');

const router = express.Router();

router.get('/api/website-checkup', requireAuth, async (req, res) => {
  try {
    const profileRes = await query('SELECT site FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    const site = profileRes.rows[0]?.site;
    const result = await checkOwnWebsite(site);
    res.json({ ...result, checkedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to check your website: ' + err.message } });
  }
});

module.exports = router;
