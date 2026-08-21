// Onboarding wizard + the "any industry" content engine: a short
// questionnaire about the tenant's business, followed by a one-time AI
// generation pass whose output is cached in Postgres (business_profile.
// generated_content) instead of being regenerated on every page load.
const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { checkAndIncrementUsage, checkAndIncrementPlacesUsage, currentMonth } = require('../lib/usage');
const { generateJSON } = require('../lib/anthropic');
const { searchNearbyCompetitors } = require('../lib/googlePlaces');

const PLACES_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const router = express.Router();

const REAL_ESTATE_INDUSTRIES = new Set(['home_services', 'real_estate']);

function buildGenerationPrompts(profile, companyName, industry) {
  const ctx = `Business: ${companyName} (industry: ${industry}).
Founder/contact: ${profile.founder_name || 'the owner'}. Phone: ${profile.phone || 'N/A'}. Email: ${profile.email || 'N/A'}.
Service area: ${profile.service_area || 'not specified'}. Services offered: ${profile.services || 'not specified'}.
Key differentiators: ${profile.differentiators || 'not specified'}. Brand voice: ${profile.voice || 'professional and approachable'}.`;

  return {
    strategy: `${ctx}
Generate 4 prioritized growth strategy recommendations for this business.
Return ONLY valid JSON: {"strategies":[{"priority":"high","title":"Title","problem":"Problem","fix":"Numbered steps","impact":"Numbers-based impact","timeline":"When"}]}`,

    keywords: `${ctx}
Generate the highest-demand marketing keywords/search terms this business should target, based on its actual services and service area.
Return ONLY valid JSON: {"keywords":[{"keyword":"...","vol":1200,"cpc":8.50,"comp":"medium","roi":72,"trend":"+12%","dir":"up","cat":"category","heat":"fire","action":"what to do about it"}],"insight":"one sharp insight","top_kw":"single top keyword"}
18 keywords: 3 "fire", 5 "hot", rest "warm".`,

    competitors: `${ctx}
Identify the likely competitive landscape for this business (general competitor archetypes appropriate to this industry and service area — do not fabricate specific real company names since they cannot be verified).
Return ONLY valid JSON: {"competitors":[{"archetype":"e.g. established local firm","typical_strength":"...","typical_weakness":"...","how_to_win":"how this business should differentiate against this type of competitor"}]}
4 competitor archetypes.`,

    opportunities: `${ctx}
Generate 4 realistic, general marketing opportunities/angles this business could act on this month (seasonal, market-condition, or community-based angles appropriate to the industry — do not invent specific news events or statistics that would need a citation).
Return ONLY valid JSON: {"opps":[{"title":"Title","desc":"Why this matters for this business","action":"Specific action to take","priority":"hot"}]}`
  };
}

router.get('/api/me', requireAuth, async (req, res) => {
  try {
    const tenantRes = await query(
      `SELECT id, company_name, industry, plan_tier, monthly_generation_cap FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    const profileRes = await query(`SELECT * FROM business_profile WHERE tenant_id = $1`, [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });

    const tenant = tenantRes.rows[0];
    const profile = profileRes.rows[0] || {};

    const usageRes = await query(
      'SELECT generation_count FROM usage_counters WHERE tenant_id = $1 AND month = $2',
      [req.tenantId, currentMonth()]
    );
    const generationsUsed = usageRes.rows[0] ? usageRes.rows[0].generation_count : 0;

    const userRes = await query('SELECT email, email_verified, is_admin FROM users WHERE id = $1', [req.userId]);
    const user = userRes.rows[0] || {};

    res.json({
      tenantId: tenant.id,
      companyName: tenant.company_name,
      industry: tenant.industry,
      planTier: tenant.plan_tier,
      monthlyGenerationCap: tenant.monthly_generation_cap,
      generationsUsed,
      accountEmail: user.email,
      emailVerified: user.email_verified,
      isAdmin: user.is_admin,
      showRealEstateFeatures: REAL_ESTATE_INDUSTRIES.has(tenant.industry),
      onboarded: Object.keys(profile.generated_content || {}).length > 0,
      profile: {
        founderName: profile.founder_name,
        phone: profile.phone,
        email: profile.email,
        address: profile.address,
        site: profile.site,
        serviceArea: profile.service_area,
        services: profile.services,
        differentiators: profile.differentiators,
        voice: profile.voice,
        logoUrl: profile.logo_url,
        googleReviewUrl: profile.google_review_url,
        yelpReviewUrl: profile.yelp_review_url
      },
      generatedContent: profile.generated_content || {}
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load profile: ' + err.message } });
  }
});

const LOGO_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|svg\+xml|webp);base64,/;
const MAX_LOGO_BYTES = 1024 * 1024; // 1MB, matches the client-side cap in onboarding.html

function validateLogoDataUrl(logoDataUrl) {
  if (!logoDataUrl) return { ok: true, value: null };
  if (typeof logoDataUrl !== 'string' || !LOGO_DATA_URL_RE.test(logoDataUrl)) {
    return { ok: false, error: 'Logo must be a PNG, JPEG, SVG, or WebP image.' };
  }
  const base64Part = logoDataUrl.slice(logoDataUrl.indexOf(',') + 1);
  const approxBytes = base64Part.length * 0.75;
  if (approxBytes > MAX_LOGO_BYTES) {
    return { ok: false, error: 'Logo file is too large (max 1MB).' };
  }
  return { ok: true, value: logoDataUrl };
}

router.post('/api/onboarding', requireAuth, async (req, res) => {
  const {
    founderName, phone, email, address, site,
    serviceArea, services, differentiators, voice, logoDataUrl,
    googleReviewUrl, yelpReviewUrl
  } = req.body || {};

  if (!services || !services.trim()) {
    return res.status(400).json({ error: { message: 'Please describe the services this business offers.' } });
  }

  const logoCheck = validateLogoDataUrl(logoDataUrl);
  if (!logoCheck.ok) {
    return res.status(400).json({ error: { message: logoCheck.error } });
  }

  try {
    await query(
      `UPDATE business_profile SET
         founder_name = $1, phone = $2, email = $3, address = $4, site = $5,
         service_area = $6, services = $7, differentiators = $8, voice = $9,
         logo_url = COALESCE($10, logo_url),
         google_review_url = $11, yelp_review_url = $12, updated_at = now()
       WHERE tenant_id = $13`,
      [founderName, phone, email, address, site, serviceArea, services, differentiators, voice, logoCheck.value,
       googleReviewUrl || null, yelpReviewUrl || null, req.tenantId]
    );

    const tenantRes = await query('SELECT company_name, industry FROM tenants WHERE id = $1', [req.tenantId]);
    const { company_name: companyName, industry } = tenantRes.rows[0];

    const prompts = buildGenerationPrompts(
      { founder_name: founderName, phone, email, service_area: serviceArea, services, differentiators, voice },
      companyName,
      industry
    );

    const generated = {};
    const errors = {};
    for (const [key, prompt] of Object.entries(prompts)) {
      const usage = await checkAndIncrementUsage(req.tenantId);
      if (!usage.allowed) {
        errors[key] = `Monthly generation limit reached (${usage.used}/${usage.cap}) partway through onboarding.`;
        break;
      }
      try {
        generated[key] = await generateJSON(prompt, 1500);
      } catch (err) {
        errors[key] = err.message;
      }
    }

    await query(
      `UPDATE business_profile SET generated_content = $1, updated_at = now() WHERE tenant_id = $2`,
      [JSON.stringify(generated), req.tenantId]
    );

    const hasErrors = Object.keys(errors).length > 0;
    const generatedAnything = Object.keys(generated).length > 0;

    if (!generatedAnything) {
      // Nothing succeeded — this must not look like success to the client
      // (previously returned 200/ok:true here, which sent the onboarding
      // page into a silent redirect loop back to itself).
      const firstError = Object.values(errors)[0] || 'Unknown error';
      return res.status(502).json({
        error: { message: `AI generation failed for every section: ${firstError}` },
        errors
      });
    }

    res.json({ ok: true, generated, partial: hasErrors, errors: hasErrors ? errors : undefined });
  } catch (err) {
    res.status(500).json({ error: { message: 'Onboarding failed: ' + err.message } });
  }
});

// Lightweight edit for the two review-link URLs — deliberately separate from
// POST /api/onboarding above, which re-runs AI generation and counts against
// the usage cap. This one doesn't, so business owners can fix a URL anytime.
router.patch('/api/onboarding/review-links', requireAuth, async (req, res) => {
  const { googleReviewUrl, yelpReviewUrl } = req.body || {};
  try {
    await query(
      `UPDATE business_profile SET google_review_url = $1, yelp_review_url = $2, updated_at = now() WHERE tenant_id = $3`,
      [googleReviewUrl || null, yelpReviewUrl || null, req.tenantId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save review links: ' + err.message } });
  }
});

// Regenerate one section on demand (subject to the same usage cap), e.g.
// the dashboard's "Refresh" buttons, instead of the old auto-fire-on-load behavior.
router.post('/api/onboarding/regenerate/:section', requireAuth, async (req, res) => {
  const section = req.params.section;
  try {
    const profileRes = await query(`SELECT * FROM business_profile WHERE tenant_id = $1`, [req.tenantId]);
    const tenantRes = await query('SELECT company_name, industry FROM tenants WHERE id = $1', [req.tenantId]);
    if (!profileRes.rows.length || !tenantRes.rows.length) {
      return res.status(404).json({ error: { message: 'Tenant not found.' } });
    }
    const profile = profileRes.rows[0];
    const { company_name: companyName, industry } = tenantRes.rows[0];
    const prompts = buildGenerationPrompts(profile, companyName, industry);

    if (!prompts[section]) {
      return res.status(400).json({ error: { message: `Unknown section "${section}".` } });
    }

    const usage = await checkAndIncrementUsage(req.tenantId);
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly generation limit reached (${usage.used}/${usage.cap}).` } });
    }

    const result = await generateJSON(prompts[section], 1500);
    const updatedContent = { ...(profile.generated_content || {}), [section]: result };
    await query(
      `UPDATE business_profile SET generated_content = $1, updated_at = now() WHERE tenant_id = $2`,
      [JSON.stringify(updatedContent), req.tenantId]
    );
    res.json({ ok: true, section, result });
  } catch (err) {
    res.status(500).json({ error: { message: 'Regeneration failed: ' + err.message } });
  }
});

// Real, cached, usage-capped nearby-competitor data — supplements (never
// replaces) the AI-estimated archetypes above, since Places coverage is
// sparse for some industries/areas.
router.get('/api/competitors/places', requireAuth, async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';
  try {
    const profileRes = await query(
      `SELECT services, service_area, places_competitors, places_competitors_fetched_at FROM business_profile WHERE tenant_id = $1`,
      [req.tenantId]
    );
    if (!profileRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const profile = profileRes.rows[0];

    const fetchedAt = profile.places_competitors_fetched_at ? new Date(profile.places_competitors_fetched_at) : null;
    const isFresh = fetchedAt && (Date.now() - fetchedAt.getTime()) < PLACES_CACHE_MAX_AGE_MS;

    if (isFresh && !forceRefresh) {
      return res.json({
        competitors: profile.places_competitors || [],
        source: 'cache',
        fetchedAt: profile.places_competitors_fetched_at,
        sparse: (profile.places_competitors || []).length === 0
      });
    }

    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: { message: 'Real competitor data is not configured on this server yet (missing GOOGLE_PLACES_API_KEY).' } });
    }

    const usage = await checkAndIncrementPlacesUsage(req.tenantId);
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly competitor-lookup limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.` } });
    }

    const tenantRes = await query('SELECT industry FROM tenants WHERE id = $1', [req.tenantId]);
    const industry = tenantRes.rows[0]?.industry;

    const competitors = await searchNearbyCompetitors({
      services: profile.services,
      serviceArea: profile.service_area,
      industry
    });

    await query(
      `UPDATE business_profile SET places_competitors = $1, places_competitors_fetched_at = now() WHERE tenant_id = $2`,
      [JSON.stringify(competitors), req.tenantId]
    );

    res.json({ competitors, source: 'live', fetchedAt: new Date().toISOString(), sparse: competitors.length === 0 });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load real competitor data: ' + err.message } });
  }
});

module.exports = router;
