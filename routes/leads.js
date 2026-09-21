const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { sendLeadAlert } = require('../lib/leadAlerts');
const { requireAuth } = require('../auth');
const { checkAndIncrementUsage } = require('../lib/usage');
const { generateJSON } = require('../lib/anthropic');
const { renderLandingPageHtml } = require('../lib/landingPageTemplate');
const landingStats = require('../lib/landingStats');
const leadSequence = require('../lib/leadSequence');

const router = express.Router();

const VALID_LEAD_STATUSES = new Set(['new', 'contacted', 'won', 'lost']);

// Per-IP sliding-window limit on the public lead form — same shape as
// routes/claude.js's isRateLimited, tuned for a public unauthenticated form.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const rateLimitHits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateLimitHits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

function slugify(name) {
  return String(name || 'business')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'business';
}

// ---------- Public routes (no auth — these are the tenant's public page) ----------

router.get('/lp/:slug', async (req, res) => {
  try {
    const result = await query(
      `SELECT lp.*, t.company_name, bp.phone, bp.email, bp.address
       FROM landing_pages lp
       JOIN tenants t ON t.id = lp.tenant_id
       LEFT JOIN business_profile bp ON bp.tenant_id = lp.tenant_id
       WHERE lp.slug = $1 AND lp.status = 'published'`,
      [req.params.slug]
    );
    if (!result.rows.length) {
      return res.status(404).send('Page not found.');
    }
    const page = result.rows[0];
    const visit = landingStats.assignVisit({ page, cookieHeader: req.headers.cookie, userAgent: req.headers['user-agent'] });
    // During a two-version test the visitor sees their assigned version.
    const shown = visit.variant === 'B'
      ? { ...page, headline: page.headline_b || page.headline, subheadline: page.subheadline_b || page.subheadline, cta_primary: page.cta_primary_b || page.cta_primary }
      : page;
    if (visit.setCookie) res.append('Set-Cookie', visit.setCookie);
    if (visit.countView) landingStats.recordView(page.id, visit.variant).catch(err => console.error('[landingStats] view failed:', err.message));
    const html = renderLandingPageHtml(shown, page, page.company_name);
    // Different visitors can see different versions, so this page must not be cached and shared.
    res.set({ 'Content-Type': 'text/html', 'Cache-Control': 'no-store', Vary: 'Cookie' }).send(html);
  } catch (err) {
    res.status(500).send('Failed to load page.');
  }
});

router.post('/lp/:slug/submit', async (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: { message: 'Too many submissions — please try again later.' } });
  }
  const { name, phone, email, message, company_website } = req.body || {};
  // Honeypot: a real visitor never fills this hidden field. Report success
  // without inserting anything, so bots don't learn the field is checked.
  if (company_website) {
    return res.json({ ok: true });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: { message: 'Name is required.' } });
  }
  if (!phone && !email) {
    return res.status(400).json({ error: { message: 'A phone number or email is required.' } });
  }
  try {
    const pageRes = await query(
      `SELECT id, tenant_id FROM landing_pages WHERE slug = $1 AND status = 'published'`,
      [req.params.slug]
    );
    if (!pageRes.rows.length) {
      return res.status(404).json({ error: { message: 'Page not found.' } });
    }
    // The visitor's cookie says which version they were shown; a submission with no
    // cookie (a script, not a browser that loaded the page) is not counted in the results.
    const shownVariant = landingStats.readCookie(req.headers.cookie, landingStats.cookieName(pageRes.rows[0].id));
    const variant = shownVariant === 'A' || shownVariant === 'B' ? shownVariant : null;
    const inserted = await query(
      `INSERT INTO leads (tenant_id, name, phone, email, message, source, landing_page_id, landing_variant)
       VALUES ($1, $2, $3, $4, $5, 'landing_page', $6, $7) RETURNING id`,
      [pageRes.rows[0].tenant_id, name.trim(), phone || null, email || null, message || null, pageRes.rows[0].id, variant]
    );
    res.json({ ok: true });
    if (variant) landingStats.recordSubmission(pageRes.rows[0].id, variant).catch(err => console.error('[landingStats] submission failed:', err.message));
    // The owner's optional automatic reply to the lead. Never able to fail the visitor's submission.
    const leadId = inserted.rows[0].id;
    leadSequence.scheduleForLead({ tenantId: pageRes.rows[0].tenant_id, leadId, email: email || '', baseUrl: `${req.protocol}://${req.get('host')}` })
      .then(r => (r.scheduled ? leadSequence.processDueLeadSequence({ onlyLeadId: leadId }) : null))
      .catch(err => console.error('[leadSequence] failed:', err.message));
    // After the visitor has their answer, and never able to fail it: tell the owner.
    sendLeadAlert({
      tenantId: pageRes.rows[0].tenant_id, lead: { name, phone, email, message },
      baseUrl: `${req.protocol}://${req.get('host')}`
    }).catch(err => console.error('[leadAlert] failed:', err.message));
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to submit — please try again.' } });
  }
});

// ---------- Authenticated dashboard routes ----------

router.get('/api/leads', requireAuth, async (req, res) => {
  const { status } = req.query;
  try {
    const result = status
      ? await query(`SELECT * FROM leads WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC`, [req.tenantId, status])
      : await query(`SELECT * FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC`, [req.tenantId]);
    res.json({ leads: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load leads: ' + err.message } });
  }
});

router.patch('/api/leads/:id', requireAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!VALID_LEAD_STATUSES.has(status)) {
    return res.status(400).json({ error: { message: 'status must be one of new/contacted/won/lost.' } });
  }
  try {
    const result = await query(
      `UPDATE leads SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [status, req.params.id, req.tenantId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: { message: 'Lead not found.' } });
    }
    // Once the owner has picked a lead up, automatic emails to that person stop.
    if (status !== 'new') leadSequence.cancelForLead(result.rows[0].id, 'lead_handled').catch(() => {});
    res.json({ ok: true, lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update lead: ' + err.message } });
  }
});

router.get('/api/landing-pages', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM landing_pages WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [req.tenantId]
    );
    res.json({ pages: result.rows, stats: await landingStats.getStats(req.tenantId), minVisitorsPerVersion: landingStats.MIN_VISITORS_PER_VERSION });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load landing pages: ' + err.message } });
  }
});

const ANGLE_HINTS = {
  primary: 'primary service offering',
  consult: 'free consultation / free estimate offer',
  offer: 'limited-time special offer',
  differentiator: 'key differentiator vs competitors',
  trust: 'trust, credentials, and social proof',
  about: 'about the business / brand story'
};

router.post('/api/landing-page/generate', requireAuth, async (req, res) => {
  const angleHint = ANGLE_HINTS[req.body && req.body.angle] || ANGLE_HINTS.primary;
  const targetLabel = (req.body && req.body.targetLabel || '').trim() || null;
  try {
    const tenantRes = await query('SELECT company_name FROM tenants WHERE id = $1', [req.tenantId]);
    const profileRes = await query('SELECT * FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const companyName = tenantRes.rows[0].company_name;
    const profile = profileRes.rows[0] || {};

    const usage = await checkAndIncrementUsage(req.tenantId);
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly generation limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.` } });
    }

    const prompt = `Landing page for ${companyName}${profile.site ? ' (' + profile.site + ')' : ''}.
Angle: ${angleHint}${targetLabel ? '. Specific target/focus for this page: ' + targetLabel : ''}. Phone: ${profile.phone || 'N/A'}. Email: ${profile.email || 'N/A'}. Address: ${profile.address || 'N/A'}.
Service area: ${profile.service_area || 'not specified'}. Services: ${profile.services || 'not specified'}.
Differentiators: ${profile.differentiators || 'not specified'}. Voice: ${profile.voice || 'professional and approachable'}.
Landing page best practices: clear headline with a real benefit, phone above fold, strong CTA, service section, trust/credentials section, service area mention.
Return ONLY valid JSON: {"headline":"H1 headline","subheadline":"Supporting line","offer":"A current offer or null","about_para":"3 sentences about this business and its area","service_para":"3 sentences about the service","trust_para":"2 sentences on credentials/differentiators","cta_primary":"CTA text","cta_secondary":"Secondary CTA text","meta_title":"SEO title under 60 chars","meta_desc":"SEO description under 155 chars"}`;

    const draft = await generateJSON(prompt, 1200);

    // Every generated page is now its own row — a tenant can hold several
    // pages (one per ZIP/service angle) instead of one page total.
    let slug;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `${slugify(targetLabel || companyName)}-${crypto.randomBytes(3).toString('hex')}`;
      const clash = await query('SELECT 1 FROM landing_pages WHERE slug = $1', [candidate]);
      if (!clash.rows.length) { slug = candidate; break; }
    }
    if (!slug) return res.status(500).json({ error: { message: 'Could not generate a unique page URL — try again.' } });

    const result = await query(
      `INSERT INTO landing_pages
         (tenant_id, slug, target_label, headline, subheadline, offer, about_para, service_para, trust_para, cta_primary, cta_secondary, meta_title, meta_desc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [req.tenantId, slug, targetLabel, draft.headline, draft.subheadline, draft.offer, draft.about_para,
       draft.service_para, draft.trust_para, draft.cta_primary, draft.cta_secondary, draft.meta_title, draft.meta_desc]
    );
    res.json({ ok: true, page: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to generate landing page: ' + err.message } });
  }
});

const EDITABLE_FIELDS = ['headline', 'subheadline', 'offer', 'about_para', 'service_para', 'trust_para', 'cta_primary', 'cta_secondary', 'meta_title', 'meta_desc', 'headline_b', 'subheadline_b', 'cta_primary_b'];

router.put('/api/landing-page/:id', requireAuth, async (req, res) => {
  const sets = [];
  const values = [];
  EDITABLE_FIELDS.forEach((field) => {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, field)) {
      values.push(req.body[field]);
      sets.push(`${field} = $${values.length}`);
    }
  });
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'targetLabel')) {
    values.push(req.body.targetLabel);
    sets.push(`target_label = $${values.length}`);
  }
  if (req.body && typeof req.body.abEnabled === 'boolean') {
    if (req.body.abEnabled) {
      // A test needs a real second version. Compare against what will be saved.
      const cur = (await query('SELECT * FROM landing_pages WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId])).rows[0];
      if (!cur) return res.status(404).json({ error: { message: 'Page not found.' } });
      const pick = (f) => (Object.prototype.hasOwnProperty.call(req.body, f) ? req.body[f] : cur[f]);
      const same = (a, b) => String(a || '').trim() === String(b || '').trim();
      const hasB = ['headline_b', 'subheadline_b', 'cta_primary_b'].some(f => String(pick(f) || '').trim());
      const differs = !same(pick('headline_b') || pick('headline'), pick('headline')) || !same(pick('subheadline_b') || pick('subheadline'), pick('subheadline')) || !same(pick('cta_primary_b') || pick('cta_primary'), pick('cta_primary'));
      if (!hasB || !differs) return res.status(400).json({ error: { message: 'Write a different headline, subheading or button for version B first; otherwise there is nothing to compare.' } });
      if (!cur.ab_enabled) { sets.push('ab_enabled = true'); sets.push('ab_started_at = now()'); }
    } else {
      sets.push('ab_enabled = false');
    }
  }
  if (!sets.length) {
    return res.status(400).json({ error: { message: 'No editable fields provided.' } });
  }
  values.push(req.params.id, req.tenantId);
  try {
    const result = await query(
      `UPDATE landing_pages SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length - 1} AND tenant_id = $${values.length} RETURNING *`,
      values
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: { message: 'Page not found.' } });
    }
    res.json({ ok: true, page: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save: ' + err.message } });
  }
});

// Ends a two-version test. Choosing B makes B the page's wording; either way the test stops.
router.post('/api/landing-page/:id/ab/finish', requireAuth, async (req, res) => {
  const winner = req.body && req.body.winner;
  if (winner !== 'A' && winner !== 'B') return res.status(400).json({ error: { message: 'Choose version A or B.' } });
  try {
    const result = winner === 'B'
      ? await query(
        `UPDATE landing_pages SET headline = COALESCE(NULLIF(headline_b, ''), headline), subheadline = COALESCE(NULLIF(subheadline_b, ''), subheadline),
                cta_primary = COALESCE(NULLIF(cta_primary_b, ''), cta_primary), ab_enabled = false, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`, [req.params.id, req.tenantId])
      : await query('UPDATE landing_pages SET ab_enabled = false, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *', [req.params.id, req.tenantId]);
    if (!result.rows.length) return res.status(404).json({ error: { message: 'Page not found.' } });
    res.json({ ok: true, page: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to finish the test: ' + err.message } });
  }
});

router.post('/api/landing-page/:id/publish', requireAuth, async (req, res) => {
  try {
    const pageRes = await query('SELECT * FROM landing_pages WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!pageRes.rows.length) {
      return res.status(404).json({ error: { message: 'Page not found.' } });
    }
    const page = pageRes.rows[0];
    const profileRes = await query('SELECT phone, email FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    const profile = profileRes.rows[0] || {};
    if (!page.headline || !page.headline.trim()) {
      return res.status(400).json({ error: { message: 'Add a headline before publishing.' } });
    }
    if (!profile.phone && !profile.email) {
      return res.status(400).json({ error: { message: 'Add a phone number or email to your business profile before publishing.' } });
    }
    await query(`UPDATE landing_pages SET status = 'published', updated_at = now() WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, url: '/lp/' + page.slug });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to publish: ' + err.message } });
  }
});

router.post('/api/landing-page/:id/unpublish', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE landing_pages SET status = 'draft', updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: { message: 'Page not found.' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to unpublish: ' + err.message } });
  }
});

router.delete('/api/landing-page/:id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM landing_pages WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: { message: 'Page not found.' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to delete: ' + err.message } });
  }
});

module.exports = router;
