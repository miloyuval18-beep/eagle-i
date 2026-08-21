const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { checkAndIncrementUsage } = require('../lib/usage');
const { generateJSON } = require('../lib/anthropic');
const { renderLandingPageHtml } = require('../lib/landingPageTemplate');

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
    const html = renderLandingPageHtml(page, page, page.company_name);
    res.set('Content-Type', 'text/html').send(html);
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
      `SELECT tenant_id FROM landing_pages WHERE slug = $1 AND status = 'published'`,
      [req.params.slug]
    );
    if (!pageRes.rows.length) {
      return res.status(404).json({ error: { message: 'Page not found.' } });
    }
    await query(
      `INSERT INTO leads (tenant_id, name, phone, email, message, source) VALUES ($1, $2, $3, $4, $5, 'landing_page')`,
      [pageRes.rows[0].tenant_id, name.trim(), phone || null, email || null, message || null]
    );
    res.json({ ok: true });
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
    res.json({ ok: true, lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update lead: ' + err.message } });
  }
});

router.get('/api/landing-page', requireAuth, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM landing_pages WHERE tenant_id = $1`, [req.tenantId]);
    res.json({ page: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load landing page: ' + err.message } });
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
Angle: ${angleHint}. Phone: ${profile.phone || 'N/A'}. Email: ${profile.email || 'N/A'}. Address: ${profile.address || 'N/A'}.
Service area: ${profile.service_area || 'not specified'}. Services: ${profile.services || 'not specified'}.
Differentiators: ${profile.differentiators || 'not specified'}. Voice: ${profile.voice || 'professional and approachable'}.
Landing page best practices: clear headline with a real benefit, phone above fold, strong CTA, service section, trust/credentials section, service area mention.
Return ONLY valid JSON: {"headline":"H1 headline","subheadline":"Supporting line","offer":"A current offer or null","about_para":"3 sentences about this business and its area","service_para":"3 sentences about the service","trust_para":"2 sentences on credentials/differentiators","cta_primary":"CTA text","cta_secondary":"Secondary CTA text","meta_title":"SEO title under 60 chars","meta_desc":"SEO description under 155 chars"}`;

    const draft = await generateJSON(prompt, 1200);

    let slug;
    const existing = await query('SELECT slug FROM landing_pages WHERE tenant_id = $1', [req.tenantId]);
    if (existing.rows.length) {
      slug = existing.rows[0].slug;
    } else {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `${slugify(companyName)}-${crypto.randomBytes(3).toString('hex')}`;
        const clash = await query('SELECT 1 FROM landing_pages WHERE slug = $1', [candidate]);
        if (!clash.rows.length) { slug = candidate; break; }
      }
      if (!slug) return res.status(500).json({ error: { message: 'Could not generate a unique page URL — try again.' } });
    }

    const result = await query(
      `INSERT INTO landing_pages
         (tenant_id, slug, headline, subheadline, offer, about_para, service_para, trust_para, cta_primary, cta_secondary, meta_title, meta_desc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id) DO UPDATE SET
         headline=EXCLUDED.headline, subheadline=EXCLUDED.subheadline, offer=EXCLUDED.offer,
         about_para=EXCLUDED.about_para, service_para=EXCLUDED.service_para, trust_para=EXCLUDED.trust_para,
         cta_primary=EXCLUDED.cta_primary, cta_secondary=EXCLUDED.cta_secondary,
         meta_title=EXCLUDED.meta_title, meta_desc=EXCLUDED.meta_desc, updated_at=now()
       RETURNING *`,
      [req.tenantId, slug, draft.headline, draft.subheadline, draft.offer, draft.about_para,
       draft.service_para, draft.trust_para, draft.cta_primary, draft.cta_secondary, draft.meta_title, draft.meta_desc]
    );
    res.json({ ok: true, page: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to generate landing page: ' + err.message } });
  }
});

const EDITABLE_FIELDS = ['headline', 'subheadline', 'offer', 'about_para', 'service_para', 'trust_para', 'cta_primary', 'cta_secondary', 'meta_title', 'meta_desc'];

router.put('/api/landing-page', requireAuth, async (req, res) => {
  const sets = [];
  const values = [];
  EDITABLE_FIELDS.forEach((field) => {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, field)) {
      values.push(req.body[field]);
      sets.push(`${field} = $${values.length}`);
    }
  });
  if (!sets.length) {
    return res.status(400).json({ error: { message: 'No editable fields provided.' } });
  }
  values.push(req.tenantId);
  try {
    const result = await query(
      `UPDATE landing_pages SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $${values.length} RETURNING *`,
      values
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: { message: 'No landing page yet — generate a draft first.' } });
    }
    res.json({ ok: true, page: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save: ' + err.message } });
  }
});

router.post('/api/landing-page/publish', requireAuth, async (req, res) => {
  try {
    const pageRes = await query('SELECT * FROM landing_pages WHERE tenant_id = $1', [req.tenantId]);
    if (!pageRes.rows.length) {
      return res.status(400).json({ error: { message: 'Generate a draft first.' } });
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
    await query(`UPDATE landing_pages SET status = 'published', updated_at = now() WHERE tenant_id = $1`, [req.tenantId]);
    res.json({ ok: true, url: '/lp/' + page.slug });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to publish: ' + err.message } });
  }
});

router.post('/api/landing-page/unpublish', requireAuth, async (req, res) => {
  try {
    await query(`UPDATE landing_pages SET status = 'draft', updated_at = now() WHERE tenant_id = $1`, [req.tenantId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to unpublish: ' + err.message } });
  }
});

module.exports = router;
