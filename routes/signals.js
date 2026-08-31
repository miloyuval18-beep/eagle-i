// Real Signal Detection: live NWS storm alerts + real permit-spike
// detection (both from lib/weatherSignals.js and lib/houstonPermits.js).
// Gated the same way Permits already is — real-estate/home-services
// tenants, Houston-scoped — see lib/weatherSignals.js's header comment for
// why that geo assumption is made rather than solved generally.
//
// Deliberately does NOT auto-send anything. draft-outreach generates text
// for the owner to review and send themselves via the channels that
// already exist (Social HQ, Review Requests) — consistent with this app's
// existing "AI drafts, human approves" pattern everywhere else, not a new
// approval-queue system.
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { getActiveAlerts } = require('../lib/weatherSignals');
const { getRecentPermits, detectPermitSpikes } = require('../lib/houstonPermits');
const { getHighValueZipInfo } = require('../lib/houstonZipValues');
const { getRealHcadZipStatsForZips } = require('../lib/hcadZipValues');
const { generateJSON } = require('../lib/anthropic');
const { checkAndIncrementUsage } = require('../lib/usage');

const router = express.Router();
const REAL_ESTATE_INDUSTRIES = new Set(['home_services', 'real_estate']);

async function requireRealEstateTenant(req, res) {
  const tenantRes = await query('SELECT industry, company_name FROM tenants WHERE id = $1', [req.tenantId]);
  if (!tenantRes.rows.length) {
    res.status(404).json({ error: { message: 'Tenant not found.' } });
    return null;
  }
  if (!REAL_ESTATE_INDUSTRIES.has(tenantRes.rows[0].industry)) {
    res.status(403).json({ error: { message: 'This feature is only available for real estate / home services accounts.' } });
    return null;
  }
  return tenantRes.rows[0];
}

router.get('/api/signals', requireAuth, async (req, res) => {
  try {
    const tenant = await requireRealEstateTenant(req, res);
    if (!tenant) return;

    const forceRefresh = req.query.refresh === 'true';
    const [weather, permitsData] = await Promise.all([
      getActiveAlerts({ forceRefresh }).catch(err => ({ alerts: [], error: err.message })),
      getRecentPermits({ weeksBack: 4, forceRefresh })
    ]);

    const stormAlerts = (weather.alerts || []).filter(a => a.isStormTrigger);
    const rawSpikes = detectPermitSpikes(permitsData.records || []);
    const hcadByZip = await getRealHcadZipStatsForZips(rawSpikes.map(s => s.zip));
    const spikes = rawSpikes.map(s => {
      const zipInfo = getHighValueZipInfo(s.zip);
      return {
        ...s,
        neighborhood: zipInfo ? zipInfo.neighborhood : null,
        highValue: !!zipInfo,
        hcad: hcadByZip.get(s.zip) || null // real HCAD appraisal-district avg/median home value, when imported — see lib/hcadZipValues.js
      };
    });

    res.json({
      weatherAlerts: stormAlerts,
      weatherFetchedAt: weather.fetchedAt ? new Date(weather.fetchedAt).toISOString() : null,
      permitSpikes: spikes,
      permitsFetchedAt: permitsData.fetchedAt ? new Date(permitsData.fetchedAt).toISOString() : null
    });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to load signals: ' + err.message } });
  }
});

router.post('/api/signals/draft-outreach', requireAuth, async (req, res) => {
  try {
    const tenant = await requireRealEstateTenant(req, res);
    if (!tenant) return;

    const { type, context } = req.body || {};
    if (!['weather', 'permit_spike'].includes(type)) {
      return res.status(400).json({ error: { message: 'type must be "weather" or "permit_spike".' } });
    }

    const usage = await checkAndIncrementUsage(req.tenantId);
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly generation limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.` } });
    }

    const profileRes = await query('SELECT phone, email, service_area FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    const profile = profileRes.rows[0] || {};

    let prompt;
    if (type === 'weather') {
      const event = (context && context.event) || 'severe weather';
      const headline = (context && context.headline) || '';
      prompt = `A real, currently active NWS weather alert just triggered for ${tenant.company_name}'s service area: "${event}" — ${headline}
Write a short, real social post AND a short outreach email for this specific storm event, both mentioning ${tenant.company_name}, phone ${profile.phone || '[phone]'}. Tone: helpful and responsive, not alarmist or exploitative of the event. This is a REAL active alert, not a hypothetical.
Return ONLY valid JSON: {"post":"social post text","email_subject":"subject line","email_body":"email body"}`;
    } else {
      const zip = (context && context.zip) || '';
      const recentCount = (context && context.recentCount) || 0;
      const neighborhood = (context && context.neighborhood) || '';
      const hcadAvgValue = context && context.hcadAvgValue;
      const valueLine = hcadAvgValue
        ? ` This ZIP's real average home value, from Harris County's own appraisal records, is $${Number(hcadAvgValue).toLocaleString()} — you may cite that exact figure, it is real, not estimated.`
        : '';
      prompt = `Real permit data just showed a genuine spike in building-permit activity in ZIP ${zip}${neighborhood ? ' (' + neighborhood + ')' : ''} — ${recentCount} permits filed this week, well above the recent average.${valueLine} Write a short outreach email ${tenant.company_name} could send to a real estate agent or homeowner contact in that ZIP mentioning this real trend, and phone ${profile.phone || '[phone]'}. This is a REAL data trend, not hypothetical.
Return ONLY valid JSON: {"email_subject":"subject line","email_body":"email body"}`;
    }

    const draft = await generateJSON(prompt, 700);
    res.json({ ok: true, draft });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to draft outreach: ' + err.message } });
  }
});

module.exports = router;
