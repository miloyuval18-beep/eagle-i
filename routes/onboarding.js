// Onboarding wizard + the "any industry" content engine: a short
// questionnaire about the tenant's business, followed by a one-time AI
// generation pass whose output is cached in Postgres (business_profile.
// generated_content) instead of being regenerated on every page load.
const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { checkAndIncrementUsage, checkAndIncrementPlacesUsage, currentMonth } = require('../lib/usage');
const { generateJSON } = require('../lib/anthropic');
const { searchNearbyCompetitors } = require('../lib/googlePlaces');
const { detectsHighValueFocus } = require('../lib/vendorTargeting');
const { qualifiesForPermits } = require('../lib/realEstateAccess');
const { findContactEmail } = require('../lib/vendorContactFinder');
const { sendEmail, buildReplyToAddress } = require('../lib/email');
const { escapeHtml } = require('../lib/landingPageTemplate');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PLACES_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const router = express.Router();

const REAL_ESTATE_INDUSTRIES = new Set(['home_services', 'real_estate']);
// Must match the list auth.js's signup handler validates against.
const VALID_INDUSTRIES = new Set(['home_services', 'real_estate', 'professional_services', 'retail', 'other']);

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
      // The Permits tab specifically also opens up for a construction
      // company that signed up under some other industry — see
      // lib/realEstateAccess.js. Deliberately separate from
      // showRealEstateFeatures above, which still gates the broader
      // real-estate-only feature bundle (Signals, Professional Partner
      // Network, etc.) by industry alone.
      showPermitsTab: qualifiesForPermits({ industry: tenant.industry, companyName: tenant.company_name }),
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

// Lightweight edit for the whole company/business profile — deliberately
// separate from POST /api/onboarding above, which re-runs AI generation and
// counts against the usage cap. This one doesn't, so a tenant can fix a
// phone number, address, company name, etc. anytime after signup without
// burning a generation or waiting on an AI call. Same convention as
// PATCH /api/onboarding/review-links just below.
router.patch('/api/onboarding/profile', requireAuth, async (req, res) => {
  const {
    companyName, industry,
    founderName, phone, email, address, site,
    serviceArea, services, differentiators, voice, logoDataUrl
  } = req.body || {};

  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: { message: 'Company name is required.' } });
  }
  if (!services || !services.trim()) {
    return res.status(400).json({ error: { message: 'Please describe the services this business offers.' } });
  }
  if (!VALID_INDUSTRIES.has(industry)) {
    return res.status(400).json({ error: { message: 'Invalid industry.' } });
  }
  const logoCheck = validateLogoDataUrl(logoDataUrl);
  if (!logoCheck.ok) {
    return res.status(400).json({ error: { message: logoCheck.error } });
  }

  try {
    await query(`UPDATE tenants SET company_name = $1, industry = $2 WHERE id = $3`, [companyName.trim(), industry, req.tenantId]);
    await query(
      `UPDATE business_profile SET
         founder_name = $1, phone = $2, email = $3, address = $4, site = $5,
         service_area = $6, services = $7, differentiators = $8, voice = $9,
         logo_url = COALESCE($10, logo_url), updated_at = now()
       WHERE tenant_id = $11`,
      [founderName, phone, email, address, site, serviceArea, services, differentiators, voice, logoCheck.value, req.tenantId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save profile: ' + err.message } });
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

// Real referral-partner businesses for one category, e.g. "Real Estate
// Agent" — the AI-suggested category type (from POST /api/claude's vendor
// prompt) is the search term; this finds who actually exists nearby.
// Cached per-category since a tenant looks up several categories over time.
router.get('/api/vendors/places', requireAuth, async (req, res) => {
  const category = (req.query.category || '').trim();
  const forceRefresh = req.query.refresh === 'true';
  if (!category) {
    return res.status(400).json({ error: { message: 'A category is required.' } });
  }

  try {
    const profileRes = await query(
      `SELECT service_area, services, differentiators, places_vendors FROM business_profile WHERE tenant_id = $1`,
      [req.tenantId]
    );
    if (!profileRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const profile = profileRes.rows[0];
    // A tenant whose own bio reads as luxury/high-end (see
    // lib/vendorTargeting.js) gets vendor results biased toward Houston's
    // known high-value neighborhoods instead of a plain service-area
    // search — cached separately from the plain search under the same
    // category, since it's genuinely a different query.
    const highValueFocus = detectsHighValueFocus(profile.services, profile.differentiators);
    const cacheKey = highValueFocus ? `${category}::hv` : category;
    const cached = (profile.places_vendors || {})[cacheKey];

    const fetchedAt = cached?.fetchedAt ? new Date(cached.fetchedAt) : null;
    const isFresh = fetchedAt && (Date.now() - fetchedAt.getTime()) < PLACES_CACHE_MAX_AGE_MS;

    if (isFresh && !forceRefresh) {
      return res.json({
        vendors: cached.results || [],
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        sparse: (cached.results || []).length === 0,
        highValueFocus
      });
    }

    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: { message: 'Real vendor lookup is not configured on this server yet (missing GOOGLE_PLACES_API_KEY).' } });
    }

    const usage = await checkAndIncrementPlacesUsage(req.tenantId);
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly lookup limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.` } });
    }

    const vendors = await searchNearbyCompetitors({
      services: category,
      serviceArea: profile.service_area,
      highValueFocus
    });

    const updatedVendors = { ...(profile.places_vendors || {}), [cacheKey]: { results: vendors, fetchedAt: new Date().toISOString() } };
    await query(
      `UPDATE business_profile SET places_vendors = $1 WHERE tenant_id = $2`,
      [JSON.stringify(updatedVendors), req.tenantId]
    );

    res.json({ vendors, source: 'live', fetchedAt: new Date().toISOString(), sparse: vendors.length === 0, highValueFocus });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load real vendor data: ' + err.message } });
  }
});

// Best-effort contact-email lookup on a real vendor's own public website —
// see lib/vendorContactFinder.js for what this does and does not do (no
// bulk crawling, no private data, returns null rather than guessing).
// Not usage-capped like the Places lookups above — it's a plain HTTP fetch
// with no per-call third-party cost, just SSRF-guarded and time/size-bounded.
router.get('/api/vendors/contact-email', requireAuth, async (req, res) => {
  const website = (req.query.website || '').toString();
  try {
    const result = await findContactEmail(website);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: { message: 'Contact lookup failed: ' + err.message } });
  }
});

// Sends one AI-drafted outreach message to one real vendor, only when the
// tenant clicks Send for that specific vendor — deliberately not a bulk/
// automatic blast (no consent from these businesses, and Resend's/CAN-SPAM's
// rules on unsolicited commercial email don't allow one).
//
// Persisted as a vendor_outreach row (id generated here, not by the DB
// default) so a reply can be matched back to it — see
// lib/email.js's buildReplyToAddress and routes/inboundEmail.js.
router.post('/api/vendors/outreach-email', requireAuth, async (req, res) => {
  const { toEmail, vendorName, message } = req.body || {};
  if (!toEmail || !EMAIL_RE.test(toEmail)) {
    return res.status(400).json({ error: { message: 'A valid contact email is required.' } });
  }
  if (!message || !message.trim()) {
    return res.status(400).json({ error: { message: 'Message text is required.' } });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: { message: 'Outreach emails are not configured on this server yet (missing RESEND_API_KEY).' } });
  }
  const outreachId = crypto.randomUUID();
  try {
    const tenantRes = await query('SELECT company_name FROM tenants WHERE id = $1', [req.tenantId]);
    const profileRes = await query('SELECT founder_name, phone, email FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const companyName = tenantRes.rows[0].company_name;
    const profile = profileRes.rows[0] || {};

    const signatureLine = [profile.founder_name || companyName, profile.phone, profile.email].filter(Boolean).map(escapeHtml).join(' · ');
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#12203a">
${escapeHtml(message).split('\n').map(line => `<p>${line}</p>`).join('')}
<p style="color:#5a7290;font-size:13px">${signatureLine}</p>
</div>`;

    // Reply-To is a reply+vendor-<id>@ address this app controls when
    // inbound email is configured (RESEND_INBOUND_DOMAIN) — that's what
    // lets a reply show up on the dashboard. Otherwise it falls back to
    // the tenant's own email directly: still reaches them via normal
    // email routing, just not captured/shown here. Only used when the
    // profile email actually looks like one.
    const validProfileEmail = profile.email && EMAIL_RE.test(profile.email) ? profile.email : undefined;
    const replyTo = buildReplyToAddress('vendor', outreachId) || validProfileEmail;

    let sent, sendError;
    try {
      sent = await sendEmail({ to: toEmail.trim(), subject: `Quick note from ${companyName}`, html, text: message, replyTo });
    } catch (err) {
      sendError = err;
    }

    await query(
      `INSERT INTO vendor_outreach (id, tenant_id, vendor_name, to_email, message, status, error, resend_email_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [outreachId, req.tenantId, vendorName || toEmail.trim(), toEmail.trim(), message,
       sendError ? 'failed' : 'sent', sendError ? sendError.message : null, sent && sent.id ? sent.id : null]
    );

    if (sendError) return res.status(502).json({ error: { message: 'Failed to send: ' + sendError.message } });
    res.json({ ok: true, id: sent.id || null, vendorName: vendorName || null });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to send: ' + err.message } });
  }
});

router.get('/api/vendors/outreach', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, vendor_name, to_email, message, status, error, reply_text, replied_at, created_at
       FROM vendor_outreach WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.tenantId]
    );
    res.json({ outreach: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load outreach history: ' + err.message } });
  }
});

module.exports = router;
