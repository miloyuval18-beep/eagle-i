const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { sendEmail, buildReplyToAddress } = require('../lib/email');
const { REMINDER_DAYS } = require('../lib/reviewReminders');
const { findOwnPlaceCandidates, getPlaceReviews } = require('../lib/googlePlaces');
const { checkAndIncrementPlacesUsage, checkAndIncrementUsage } = require('../lib/usage');
const { generateJSON } = require('../lib/anthropic');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildReviewRequestEmail(companyName, customerName, links) {
  const buttons = links.map(l =>
    `<p style="margin:10px 0"><a href="${l.url}" style="display:inline-block;background:#1a7ee8;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600">Leave a ${l.label} review</a></p>`
  ).join('');
  const textLinks = links.map(l => `${l.label}: ${l.url}`).join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#12203a">
<p>Hi ${customerName},</p>
<p>Thanks for choosing ${companyName}! If you have a minute, a quick review would mean a lot to us.</p>
${buttons}
<p style="color:#5a7290;font-size:13px">Thank you,<br>${companyName}</p>
</div>`;
  const text = `Hi ${customerName},\n\nThanks for choosing ${companyName}! If you have a minute, a quick review would mean a lot to us.\n\n${textLinks}\n\nThank you,\n${companyName}`;

  return { subject: `Quick favor? Leave ${companyName} a review`, html, text };
}

router.post('/api/review-requests', requireAuth, async (req, res) => {
  const { customerName, customerEmail, remind } = req.body || {};
  if (!customerName || !customerName.trim()) {
    return res.status(400).json({ error: { message: 'Customer name is required.' } });
  }
  if (!customerEmail || !customerEmail.trim()) {
    return res.status(400).json({ error: { message: 'Customer email is required.' } });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: { message: 'Review request emails are not configured on this server yet (missing RESEND_API_KEY).' } });
  }

  try {
    const tenantRes = await query('SELECT company_name FROM tenants WHERE id = $1', [req.tenantId]);
    const profileRes = await query('SELECT google_review_url, yelp_review_url, email FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const companyName = tenantRes.rows[0].company_name;
    const profile = profileRes.rows[0] || {};

    const links = [];
    if (profile.google_review_url) links.push({ label: 'Google', url: profile.google_review_url });
    if (profile.yelp_review_url) links.push({ label: 'Yelp', url: profile.yelp_review_url });
    if (!links.length) {
      return res.status(400).json({ error: { message: 'Add a Google or Yelp review link in your business profile first.' } });
    }

    const { subject, html, text } = buildReviewRequestEmail(companyName, customerName.trim(), links);
    const includedPlatforms = links.map(l => l.label.toLowerCase());
    const reviewRequestId = crypto.randomUUID();

    // Reply-To is a reply+review-<id>@ address this app controls when
    // inbound email is configured (RESEND_INBOUND_DOMAIN) — that's what
    // lets a customer's reply show up on the dashboard. Otherwise it falls
    // back to the tenant's own email directly: still reaches them via
    // normal email routing, just not captured/shown here.
    const validProfileEmail = profile.email && EMAIL_RE.test(profile.email) ? profile.email : undefined;
    const replyTo = buildReplyToAddress('review', reviewRequestId) || validProfileEmail;

    try {
      const sent = await sendEmail({ to: customerEmail.trim(), subject, html, text, replyTo, fromName: companyName });
      const row = await query(
        `INSERT INTO review_requests (id, tenant_id, sent_by, customer_name, customer_email, included_platforms, status, resend_email_id)
         VALUES ($1,$2,$3,$4,$5,$6,'sent',$7) RETURNING *`,
        [reviewRequestId, req.tenantId, req.userId, customerName.trim(), customerEmail.trim(), JSON.stringify(includedPlatforms), sent.id || null]
      );
      let reviewRequest = row.rows[0];
      // One optional reminder if they don't reply (lib/reviewReminders.js).
      if (remind) {
        const upd = await query(
          `UPDATE review_requests SET reminder_status = 'pending', reminder_due_at = now() + ($2 || ' days')::interval, reminder_base_url = $3
           WHERE id = $1 RETURNING *`,
          [reviewRequestId, String(REMINDER_DAYS), `${req.protocol}://${req.get('host')}`]
        );
        reviewRequest = upd.rows[0];
      }
      res.json({ ok: true, reviewRequest, reminderDays: remind ? REMINDER_DAYS : null });
    } catch (sendErr) {
      const row = await query(
        `INSERT INTO review_requests (id, tenant_id, sent_by, customer_name, customer_email, included_platforms, status, error)
         VALUES ($1,$2,$3,$4,$5,$6,'failed',$7) RETURNING *`,
        [reviewRequestId, req.tenantId, req.userId, customerName.trim(), customerEmail.trim(), JSON.stringify(includedPlatforms), sendErr.message]
      );
      res.status(502).json({ error: { message: 'Failed to send: ' + sendErr.message }, reviewRequest: row.rows[0] });
    }
  } catch (err) {
    res.status(500).json({ error: { message: 'Review request failed: ' + err.message } });
  }
});

router.get('/api/review-requests', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM review_requests WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [req.tenantId]
    );
    res.json({ reviewRequests: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load review requests: ' + err.message } });
  }
});

// ---- Own reviews + AI-drafted replies --------------------------------
// This app can only READ Google reviews via the Places API key already in
// use — replying is a separate, harder-to-get Business Profile OAuth scope
// per tenant, not something built here. So this generates a draft the
// tenant copies into their own Google Business Profile reply box by hand
// (same "we draft it, you do the real-world step" pattern as the LinkedIn
// connection notes and mailed letters elsewhere in the app).

router.get('/api/reviews/my-place', requireAuth, async (req, res) => {
  try {
    const r = await query('SELECT own_place_id, own_place_name, own_place_address, own_place_confirmed_at FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    const row = r.rows[0] || {};
    res.json({ placeId: row.own_place_id || null, name: row.own_place_name || null, address: row.own_place_address || null, confirmedAt: row.own_place_confirmed_at || null });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load: ' + err.message } });
  }
});

// Search candidates — never auto-picks, since a wrong match would show the
// tenant a stranger's real reviews as if they were their own.
router.post('/api/reviews/my-place/search', requireAuth, async (req, res) => {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return res.status(503).json({ error: { message: 'Lookup is not configured on this server yet (missing GOOGLE_PLACES_API_KEY).' } });
  }
  try {
    const tenantRes = await query('SELECT company_name FROM tenants WHERE id = $1', [req.tenantId]);
    const profileRes = await query('SELECT address FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    if (!tenantRes.rows.length) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const name = (req.body && req.body.query) || tenantRes.rows[0].company_name;
    const address = profileRes.rows[0] ? profileRes.rows[0].address : null;

    const usage = await checkAndIncrementPlacesUsage(req.tenantId);
    if (!usage.allowed) return res.status(429).json({ error: { message: `Monthly lookup limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.`, code: 'lookup_cap' } });

    const candidates = await findOwnPlaceCandidates({ name, address });
    res.json({ candidates });
  } catch (err) {
    res.status(500).json({ error: { message: 'Search failed: ' + err.message } });
  }
});

router.post('/api/reviews/my-place/confirm', requireAuth, async (req, res) => {
  const { placeId, name, address } = req.body || {};
  if (!placeId) return res.status(400).json({ error: { message: 'placeId is required.' } });
  try {
    await query(
      `UPDATE business_profile SET own_place_id = $2, own_place_name = $3, own_place_address = $4, own_place_confirmed_at = now() WHERE tenant_id = $1`,
      [req.tenantId, placeId, name || null, address || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save: ' + err.message } });
  }
});

router.get('/api/reviews/mine', requireAuth, async (req, res) => {
  try {
    const profileRes = await query('SELECT own_place_id, own_place_name FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    const ownPlaceId = profileRes.rows[0] && profileRes.rows[0].own_place_id;
    const rows = (await query('SELECT id, author_name, rating, text, published_at, reply_draft, reply_draft_generated_at, fetched_at FROM own_reviews WHERE tenant_id = $1 ORDER BY id DESC', [req.tenantId])).rows;
    res.json({ ownPlaceId: ownPlaceId || null, ownPlaceName: (profileRes.rows[0] && profileRes.rows[0].own_place_name) || null, reviews: rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load reviews: ' + err.message } });
  }
});

// Pulls current real reviews from Google and upserts by Places' own stable
// review resource name — never overwrites a review's reply_draft that's
// already been generated, so a re-fetch can't silently wipe out a draft
// someone already edited.
router.post('/api/reviews/refresh', requireAuth, async (req, res) => {
  try {
    const profileRes = await query('SELECT own_place_id FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    const placeId = profileRes.rows[0] && profileRes.rows[0].own_place_id;
    if (!placeId) return res.status(400).json({ error: { message: 'Confirm which business is yours first.', code: 'no_place' } });
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: { message: 'Lookup is not configured on this server yet (missing GOOGLE_PLACES_API_KEY).' } });
    }
    const usage = await checkAndIncrementPlacesUsage(req.tenantId);
    if (!usage.allowed) return res.status(429).json({ error: { message: `Monthly lookup limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.`, code: 'lookup_cap' } });

    const { reviews, rating, reviewCount } = await getPlaceReviews(placeId);
    for (const rv of reviews) {
      await query(
        `INSERT INTO own_reviews (tenant_id, review_ref, author_name, rating, text, published_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, review_ref) DO UPDATE SET author_name = EXCLUDED.author_name, rating = EXCLUDED.rating, text = EXCLUDED.text, published_at = EXCLUDED.published_at, fetched_at = now()`,
        [req.tenantId, rv.ref, rv.authorName, rv.rating, rv.text, rv.publishedAt]
      );
    }
    res.json({ ok: true, fetched: reviews.length, rating, reviewCount, note: 'Google returns at most 5 reviews per business through this API, its own pick of "most relevant" — not necessarily the most recent.' });
  } catch (err) {
    res.status(500).json({ error: { message: 'Refresh failed: ' + err.message } });
  }
});

function buildReplyPrompt({ companyName, founderName, industry, review }) {
  return `You are drafting a short, genuine-sounding reply from a small ${industry || 'construction'} business owner to a real Google review. Ground the reply ONLY in what the review actually says — never invent specifics (names, dates, job details) that aren't in the review text.

Business: ${companyName}${founderName ? `, owner ${founderName}` : ''}
Review rating: ${review.rating ?? 'unknown'} out of 5
Review text: "${String(review.text || '').slice(0, 1000)}"

Write a reply that:
- Is 2-4 sentences, warm and specific to what they actually wrote, not generic
- If the rating is 4-5: thanks them genuinely, no groveling
- If the rating is 1-3: acknowledges their specific concern without being defensive, apologizes for the experience, invites them to reach out directly to make it right — do NOT make excuses or dispute their account
- Never promises a discount, refund, or specific compensation
- Signs off with the owner's first name if given, else the company name

Return ONLY this JSON: {"reply": "..."}`;
}

router.post('/api/reviews/:id/draft-reply', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: { message: 'AI drafting is not configured on this server yet (missing ANTHROPIC_API_KEY).' } });
  }
  try {
    const reviewRes = await query('SELECT id, rating, text FROM own_reviews WHERE id = $1 AND tenant_id = $2', [id, req.tenantId]);
    if (!reviewRes.rows.length) return res.status(404).json({ error: { message: 'Review not found.' } });
    const review = reviewRes.rows[0];

    const usage = await checkAndIncrementUsage(req.tenantId);
    if (!usage.allowed) return res.status(429).json({ error: { message: `Monthly generation limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.`, code: 'generation_cap' } });

    const tenantRes = await query('SELECT company_name, industry FROM tenants WHERE id = $1', [req.tenantId]);
    const profileRes = await query('SELECT founder_name FROM business_profile WHERE tenant_id = $1', [req.tenantId]);
    const companyName = tenantRes.rows[0] ? tenantRes.rows[0].company_name : 'the business';
    const industry = tenantRes.rows[0] ? tenantRes.rows[0].industry : null;
    const founderName = profileRes.rows[0] ? profileRes.rows[0].founder_name : null;

    const result = await generateJSON(buildReplyPrompt({ companyName, founderName, industry, review }), 600);
    const reply = String(result.reply || '').trim();
    if (!reply) throw new Error('Empty draft.');

    await query('UPDATE own_reviews SET reply_draft = $1, reply_draft_generated_at = now() WHERE id = $2', [reply, id]);
    res.json({ ok: true, reply });
  } catch (err) {
    res.status(500).json({ error: { message: 'Draft failed: ' + err.message } });
  }
});

module.exports = router;
