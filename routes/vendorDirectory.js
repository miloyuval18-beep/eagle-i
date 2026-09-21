// One API for every verified-vendor category (see lib/vendorDirectories.js):
// list with filters + ranking, location facets, one-vendor contact lookup,
// and the guarded bulk-email flow. The panel in index.html is generated
// from GET /api/vendor-directory/catalog, so adding a category means
// adding it to the registry — no new route or UI copy.
const express = require('express');
const { requireAuth } = require('../auth');
const { checkAndIncrementPlacesUsage } = require('../lib/usage');
const { searchNearbyCompetitors } = require('../lib/googlePlaces');
const { findContactEmail } = require('../lib/vendorContactFinder');
const { stripLegalSuffix, isLikelySameBusiness } = require('../lib/placesMatch');
const dir = require('../lib/vendorDirectories');
const outreach = require('../lib/vendorOutreach');
const { verifyEmail } = require('../lib/emailVerification');
const tpl = require('../lib/outreachTemplate');
const followUps = require('../lib/followUps');
const letters = require('../lib/vendorLetters');
const queue = require('../lib/outreachQueue');
const crypto = require('crypto');
const { query } = require('../db');

const router = express.Router();

router.get('/api/vendor-directory/catalog', requireAuth, (req, res) => {
  res.json({ sections: dir.getCatalog(), sorts: dir.SORTS });
});

function parseFilters(q) {
  return {
    search: (q.search || '').toString().slice(0, 80),
    locations: (q.locations || '').toString().split('|').map(s => s.trim()).filter(Boolean).slice(0, 60),
    contact: ['has_email', 'verified', 'unchecked', 'no_email', 'mailable'].includes(q.contact) ? q.contact : '',
    minRating: [3.5, 4, 4.5].includes(Number(q.minRating)) ? Number(q.minRating) : null,
    hideEmailed: q.hideEmailed === '1' || q.hideEmailed === 'true',
    relationship: ['hide_mine', 'tracked'].includes(q.relationship) ? q.relationship : ''
  };
}

router.get('/api/vendor-directory/:source/:category/facets', requireAuth, async (req, res) => {
  try {
    res.json(await dir.getFacets({ source: req.params.source, category: req.params.category }));
  } catch (err) {
    const bad = /^Unknown/.test(err.message);
    res.status(bad ? 404 : 500).json({ error: { message: bad ? err.message : 'Failed to load filters: ' + err.message } });
  }
});

// limit goes up to 200 so "Top N" can select across the whole filtered set
// (the biggest Top-N option), not just the page the user has scrolled to.
router.get('/api/vendor-directory/:source/:category', requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const { total, rows, sort, distanceNote } = await dir.listDirectory({
      source: req.params.source, category: req.params.category,
      filters: parseFilters(req.query), sort: (req.query.sort || '').toString(),
      limit, offset, tenantId: req.tenantId
    });
    res.json({ total, sort, distanceNote, rows, hasMore: offset + rows.length < total });
  } catch (err) {
    const bad = /^Unknown/.test(err.message);
    res.status(bad ? 404 : 500).json({ error: { message: bad ? err.message : 'Failed to load vendors: ' + err.message } });
  }
});

// Google lookup for one vendor: find its listing, phone, website, rating,
// and a published email. Cached forever once done (refresh=true to redo), so
// each business is paid for at most once. Places returns its best guess even
// when that's a different business, so a result is only used when its name
// and location agree with the government record (lib/placesMatch.js).
router.post('/api/vendor-directory/:source/:id/find-contact', requireAuth, async (req, res) => {
  const sourceKey = req.params.source;
  const id = parseInt(req.params.id, 10);
  if (!dir.SOURCES[sourceKey]) return res.status(404).json({ error: { message: 'Unknown source.' } });
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'Invalid id.' } });

  try {
    const row = await dir.getRowForLookup(sourceKey, id);
    if (!row) return res.status(404).json({ error: { message: 'Not found.' } });

    if (row.contact_checked_at && req.query.refresh !== 'true') {
      return res.json({
        website: row.website, phone: dir.formatPhone(row.phone), email: row.contact_email,
        address: row.places_formatted_address, matchedName: row.places_matched_name,
        rating: row.google_rating !== null ? Number(row.google_rating) : null,
        reviewCount: row.google_review_count,
        ...(row.email_check_status === 'invalid' ? { email: null } : {}),
        emailStatus: row.email_check_status || null,
        emailNote: dir.emailNote(row),
        source: 'cache'
      });
    }
    if (!row.name) return res.json({ website: null, email: null, address: null, source: 'live', reason: 'No business name on file.' });
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({ error: { message: 'Lookup is not configured on this server yet (missing GOOGLE_PLACES_API_KEY).' } });
    }

    const usage = await checkAndIncrementPlacesUsage(req.tenantId);
    if (!usage.allowed) {
      return res.status(429).json({ error: { message: `Monthly lookup limit reached (${usage.used}/${usage.cap}). Upgrade your plan for more.`, code: 'lookup_cap' } });
    }

    const results = await searchNearbyCompetitors({ services: stripLegalSuffix(row.name), serviceArea: row.area, resultCount: 1 });
    const top = results[0];
    const agrees = (name) => top && isLikelySameBusiness({
      recordName: name, recordCity: row.city, recordZip: row.zip,
      matchedName: top.name, matchedAddress: top.address, allowedCities: dir.METRO_CITIES
    });
    const match = top && (agrees(row.name) || (row.alt_name && agrees(row.alt_name))) ? top : null;

    let email = null, verification = null, droppedReason = null;
    if (match && match.website) {
      const contact = await findContactEmail(match.website);
      email = contact.email || null;
    }
    // The Google match was validated above, so the site check isn't needed —
    // but an address whose domain can't receive mail is never kept as usable.
    if (email) {
      verification = await verifyEmail({ email, website: match.website, businessName: row.name, checkSite: false });
      if (verification.status === 'invalid') { droppedReason = `Found ${email} on their website, but ${verification.reason} — not used.`; email = null; verification = null; }
    }
    await dir.saveContact(sourceKey, id, {
      website: match?.website, phone: match?.phone, contactEmail: email, address: match?.address,
      matchedName: match?.name, rating: match?.rating, reviewCount: match?.reviewCount,
      emailStatus: verification && verification.status, emailReason: verification && verification.reason
    });

    res.json({
      website: match?.website || null, phone: match?.phone ? dir.formatPhone(match.phone) : dir.formatPhone(row.phone), email,
      address: match?.address || null, matchedName: match?.name || null,
      rating: match?.rating ?? null, reviewCount: match?.reviewCount ?? null, source: 'live',
      emailStatus: verification ? verification.status : null,
      emailNote: email ? dir.emailNote({ contact_email: email, email_check_status: verification.status, email_check_reason: verification.reason }) : null,
      reason: match
        ? (email ? null : (droppedReason || 'No published email found on their website.'))
        : (top
            ? `Closest Google result was "${top.name}" (${top.address || 'no address'}), which doesn't look like the same business — not used.`
            : 'No matching business found on Google.')
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Contact lookup failed: ' + err.message } });
  }
});

// ---- Outreach message template ----------------------------------------
// The message is built from a per-tenant template (lib/outreachTemplate.js)
// filled with this tenant's profile and the category being emailed. {name}
// is left open here and filled per recipient when it is sent.

async function loadTemplateContext(tenantId) {
  const t = await query('SELECT company_name FROM tenants WHERE id = $1', [tenantId]);
  if (!t.rows.length) return null;
  const p = await query('SELECT founder_name, phone, email, site, service_area, linkedin_url, outreach_settings FROM business_profile WHERE tenant_id = $1', [tenantId]);
  const profile = p.rows[0] || {};
  return { tenant: t.rows[0], profile, settings: profile.outreach_settings || {} };
}

// A category can override its source's relationship type and phrasing (e.g.
// landscapers do site work FOR a contractor, so they get the "capacity"
// message even though they sit with suppliers).
function resolveCategory(sourceKey, categoryKey) {
  const source = dir.SOURCES[sourceKey];
  const category = source && source.categories[categoryKey];
  if (!source || !category) return null;
  const merged = { ...source };
  for (const k of ['intent', 'ask', 'execute']) if (category[k]) merged[k] = category[k];
  return { source: merged, category };
}

const templateResponse = (ctx, source, category) => {
  const vars = tpl.buildVariables({ ...ctx, source, category });
  const message = tpl.renderTemplate(tpl.templateFor(ctx.settings, source.intent), vars);
  const savedSubject = ctx.settings.subjects && ctx.settings.subjects[source.intent];
  return {
    intent: source.intent,
    message,
    subject: savedSubject || `Quick note from ${ctx.tenant.company_name}`,
    hasCustomSubject: !!savedSubject,
    letterMessage: tpl.letterize(message, ctx.profile), // same wording, adapted for paper
    callScript: tpl.renderTemplate(tpl.DEFAULT_CALL_SCRIPTS[source.intent], vars),
    linkedinNote: tpl.fitLinkedinNote(tpl.renderTemplate(tpl.DEFAULT_LINKEDIN_NOTES[source.intent], vars)),
    followUp2: {
      message: tpl.renderTemplate(tpl.followUp2For(ctx.settings, source.intent), vars),
      days: followUps.DEFAULT_DAYS,
      hasCustom: !!(ctx.settings.followups2 && ctx.settings.followups2[source.intent])
    },
    followUp: {
      message: tpl.renderTemplate(tpl.followUpFor(ctx.settings, source.intent), vars),
      days: followUps.DEFAULT_DAYS,
      hasCustom: !!(ctx.settings.followups && ctx.settings.followups[source.intent])
    },
    settings: {
      linkedin: ctx.profile.linkedin_url || '', // from the company profile (Account Settings)
      blurb: ctx.settings.blurb || '',
      defaultBlurb: `${ctx.tenant.company_name} serves ${(ctx.profile.service_area || '').trim() || 'the Houston area'}.`,
      hasCustomTemplate: !!(ctx.settings.templates && ctx.settings.templates[source.intent])
    }
  };
};

router.get('/api/vendors/outreach-template', requireAuth, async (req, res) => {
  const found = resolveCategory(req.query.source, req.query.category);
  if (!found) return res.status(404).json({ error: { message: 'Unknown category.' } });
  try {
    const ctx = await loadTemplateContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    res.json(templateResponse(ctx, found.source, found.category));
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load the message: ' + err.message } });
  }
});

// Saves the company blurb and/or the message as this tenant's default
// wording for this relationship type. (The LinkedIn link is not saved here —
// it lives on the company profile.)
router.put('/api/vendors/outreach-template', requireAuth, async (req, res) => {
  const { source: sourceKey, category: categoryKey, message, subject, followupMessage, followup2Message, blurb, saveTemplate, resetTemplate } = req.body || {};
  const found = resolveCategory(sourceKey, categoryKey);
  if (!found) return res.status(404).json({ error: { message: 'Unknown category.' } });

  if (blurb !== undefined && String(blurb).length > 600) {
    return res.status(400).json({ error: { message: 'The company description is limited to 600 characters.' } });
  }
  if (saveTemplate && (!message || String(message).length > tpl.MAX_TEMPLATE_CHARS)) {
    return res.status(400).json({ error: { message: `Message must be 1–${tpl.MAX_TEMPLATE_CHARS} characters.` } });
  }

  try {
    const ctx = await loadTemplateContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const settings = { ...ctx.settings, subjects: { ...(ctx.settings.subjects || {}) }, templates: { ...(ctx.settings.templates || {}) }, followups: { ...(ctx.settings.followups || {}) }, followups2: { ...(ctx.settings.followups2 || {}) } };

    // Turn the edited message back into a template using the values as they
    // were when it was rendered, BEFORE applying any new LinkedIn/blurb.
    if (saveTemplate) {
      const vars = tpl.buildVariables({ ...ctx, source: found.source, category: found.category });
      settings.templates[found.source.intent] = tpl.templatize(String(message), vars);
      const cleanedSubject = outreach.cleanSubject(subject);
      if (cleanedSubject) settings.subjects[found.source.intent] = cleanedSubject;
      if (followupMessage && String(followupMessage).length <= tpl.MAX_TEMPLATE_CHARS) {
        settings.followups[found.source.intent] = tpl.templatize(String(followupMessage), vars);
      }
      if (followup2Message && String(followup2Message).length <= tpl.MAX_TEMPLATE_CHARS) {
        settings.followups2[found.source.intent] = tpl.templatize(String(followup2Message), vars);
      }
    }
    if (resetTemplate) { delete settings.templates[found.source.intent]; delete settings.followups[found.source.intent]; delete settings.followups2[found.source.intent]; delete settings.subjects[found.source.intent]; }
    if (blurb !== undefined) settings.blurb = String(blurb).trim();

    await query('UPDATE business_profile SET outreach_settings = $1 WHERE tenant_id = $2', [JSON.stringify(settings), req.tenantId]);
    res.json(templateResponse({ ...ctx, settings }, found.source, found.category));
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save: ' + err.message } });
  }
});

// Validates the follow-up settings a bulk send or schedule request carries.
// The wording is held to the same rules as the message itself, since it goes
// to real people later without another look.
function parseFollowUps(followUp) {
  if (!followUp || !followUp.enabled) return { fu1: null, fu2: null };
  const check = (raw, days, label) => {
    const message = String(raw || '').trim();
    if (!message || message.length > tpl.MAX_TEMPLATE_CHARS) return { error: { message: `The ${label} message is empty or too long.`, code: 'bad_followup' } };
    const left = message.replace(/\{name\}/g, '').match(/\{[a-z_]+\}/);
    if (left) return { error: { message: `The ${label} still contains ${left[0]}. Remove it or fill it in before sending.`, code: 'unresolved_token' } };
    return { value: { message, days: followUps.clampDays(days) } };
  };
  const one = check(followUp.message, followUp.days, 'follow-up');
  if (one.error) return { error: one.error };
  let fu2 = null;
  if (followUp.second && followUp.second.enabled) {
    const two = check(followUp.second.message, followUp.second.days, 'second follow-up');
    if (two.error) return { error: two.error };
    fu2 = two.value;
  }
  return { fu1: one.value, fu2 };
}

// Subject line and optional second version for a two-version test. The client
// assigns A/B alternately down the ranked list (so both halves get a similar mix
// of strong and weak prospects); if it doesn't, the server alternates itself.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortText = (v, n) => (v == null ? null : String(v).slice(0, n) || null);
function parseVariants({ message, subject, variantB, testId }) {
  const subjectA = outreach.cleanSubject(subject) || null;
  const meta = (r) => ({
    categoryKey: shortText(r && r.categoryKey, 80), city: shortText(r && r.city, 80),
    source: /^[a-z_]{1,20}$/.test((r && r.source) || '') ? r.source : null, sourceId: r && Number(r.sourceId) > 0 ? Number(r.sourceId) : null
  });
  if (!variantB || !variantB.message || !String(variantB.message).trim()) {
    return { testId: null, pick: (r) => ({ message: String(message), subject: subjectA, variant: null, meta: meta(r) }) };
  }
  const messageB = String(variantB.message);
  if (messageB.length > tpl.MAX_TEMPLATE_CHARS) return { error: { message: 'Version B is too long.', code: 'bad_variant' } };
  const left = messageB.replace(/\{name\}/g, '').match(/\{[a-z_]+\}/);
  if (left) return { error: { message: `Version B still contains ${left[0]}. Remove it or fill it in before sending.`, code: 'unresolved_token' } };
  const subjectB = outreach.cleanSubject(variantB.subject) || null;
  if (messageB.trim() === String(message).trim() && subjectB === subjectA) {
    return { error: { message: 'Version B is identical to version A, so there is nothing to compare. Change the subject or the message.', code: 'bad_variant' } };
  }
  const id = UUID_RE.test(String(testId || '')) ? String(testId).toLowerCase() : crypto.randomUUID();
  return {
    testId: id,
    pick: (r, i) => {
      const v = r && (r.variant === 'A' || r.variant === 'B') ? r.variant : (i % 2 ? 'B' : 'A');
      return v === 'B' ? { message: messageB, subject: subjectB, variant: 'B', meta: meta(r) } : { message: String(message), subject: subjectA, variant: 'A', meta: meta(r) };
    }
  };
}

// ---- Bulk outreach ---------------------------------------------------
// Bulk send is deliberately a two-step flow the UI gates behind a human
// review: PREVIEW says exactly who would and wouldn't be emailed (and why),
// SEND re-runs the same screening server-side — never trusting the preview —
// and enforces the daily cap. Nothing here sends on its own.

router.get('/api/vendors/outreach-bulk/status', requireAuth, async (req, res) => {
  try {
    const ctx = await outreach.getSenderContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const used = await outreach.sentInLast24h(req.tenantId);
    res.json({
      dailyCap: outreach.BULK_DAILY_CAP, sentLast24h: used, remaining: Math.max(0, outreach.BULK_DAILY_CAP - used),
      hasAddress: (ctx.profile.address || '').trim().length >= 8,
      configured: !!process.env.RESEND_API_KEY
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load send limits: ' + err.message } });
  }
});

router.post('/api/vendors/outreach-bulk/preview', requireAuth, async (req, res) => {
  const recipients = (req.body && req.body.recipients) || [];
  if (!Array.isArray(recipients) || recipients.length > 500) {
    return res.status(400).json({ error: { message: 'recipients must be a list of at most 500.' } });
  }
  try {
    const { sendable, skipped } = await outreach.screenRecipients(req.tenantId, recipients);
    const used = await outreach.sentInLast24h(req.tenantId);
    res.json({ sendable, skipped, dailyCap: outreach.BULK_DAILY_CAP, remaining: Math.max(0, outreach.BULK_DAILY_CAP - used) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Preview failed: ' + err.message } });
  }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// At most 25 per call — the client sends a large batch as several calls, so
// no single request runs long enough to hit a proxy timeout.
router.post('/api/vendors/outreach-bulk/send', requireAuth, async (req, res) => {
  const { recipients, message, followUp } = req.body || {};
  if (!Array.isArray(recipients) || !recipients.length || recipients.length > 25) {
    return res.status(400).json({ error: { message: 'Send between 1 and 25 recipients per request.' } });
  }
  if (!message || !String(message).trim()) return res.status(400).json({ error: { message: 'Message text is required.' } });
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: { message: 'Outreach emails are not configured on this server yet (missing RESEND_API_KEY).' } });
  }
  try {
    const ctx = await outreach.getSenderContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    // A physical postal address is required in commercial email (CAN-SPAM),
    // and this is where it comes from — refuse rather than send without it.
    if ((ctx.profile.address || '').trim().length < 8) {
      return res.status(400).json({ error: { message: 'Add your business address in your profile before sending bulk email — it is required in the footer of commercial email.', code: 'address_required' } });
    }
    // {name} is the only token allowed to be open; anything else still in the
    // text (e.g. a hand-typed {linkedin}) would be sent to real people as-is.
    const leftover = String(message).replace(/\{name\}/g, '').match(/\{[a-z_]+\}/);
    if (leftover) {
      return res.status(400).json({ error: { message: `The message still contains ${leftover[0]}. Remove it or fill it in before sending.`, code: 'unresolved_token' } });
    }
    const parsedFu = parseFollowUps(followUp);
    if (parsedFu.error) return res.status(400).json({ error: parsedFu.error });
    const fu = parsedFu.fu1, fu2 = parsedFu.fu2;
    const vs = parseVariants(req.body);
    if (vs.error) return res.status(400).json({ error: vs.error });
    const origByEmail = new Map();
    recipients.forEach((r, i) => { const k = outreach.normEmail(r && r.email); if (!origByEmail.has(k)) origByEmail.set(k, { r, i }); });
    // First occurrence of an address wins, matching how screening keeps the first.
    const greetingFor = new Map();
    for (const r of recipients) {
      const key = outreach.normEmail(r && r.email);
      if (!greetingFor.has(key)) greetingFor.set(key, (r && r.greeting) || tpl.friendlyGreeting(r && r.name, null));
    }
    const { sendable, skipped } = await outreach.screenRecipients(req.tenantId, recipients);
    const used = await outreach.sentInLast24h(req.tenantId);
    const remaining = Math.max(0, outreach.BULK_DAILY_CAP - used);
    const toSend = sendable.slice(0, remaining);
    const capped = sendable.slice(remaining).map(r => ({ ...r, reason: 'daily_cap' }));

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    let followUpsScheduled = 0;
    const results = [...skipped, ...capped].map(r => ({ email: r.email, name: r.name, status: 'skipped', reason: r.reason }));
    for (let i = 0; i < toSend.length; i++) {
      if (i > 0) await sleep(outreach.SEND_SPACING_MS);
      const r = toSend[i];
      const o = origByEmail.get(r.email) || { r: {}, i };
      const v = vs.pick(o.r, o.i);
      const out = await outreach.sendOutreach({
        tenantId: req.tenantId, ctx, baseUrl, toEmail: r.email, vendorName: r.name,
        message: tpl.fillName(v.message, greetingFor.get(r.email)), subject: v.subject || undefined,
        meta: { kind: 'initial', variant: v.variant, testId: vs.testId, ...v.meta }
      });
      if (out.ok && fu) {
        try {
          await followUps.scheduleFollowUp({
            tenantId: req.tenantId, outreachId: out.outreachId, toEmail: r.email, vendorName: r.name,
            message: tpl.fillName(fu.message, greetingFor.get(r.email)), days: fu.days, baseUrl,
            step: 1, nextDays: fu2 ? fu2.days : null, nextMessage: fu2 ? tpl.fillName(fu2.message, greetingFor.get(r.email)) : null
          });
          followUpsScheduled++;
        } catch (err) { console.error('[followUps] scheduling failed:', err.message); }
      }
      results.push(out.ok
        ? { email: r.email, name: r.name, status: 'sent' }
        : { email: r.email, name: r.name, status: out.reason === 'opted_out' ? 'skipped' : 'failed', reason: out.reason, error: out.error });
    }
    res.json({
      results,
      sent: results.filter(r => r.status === 'sent').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      remaining: Math.max(0, remaining - toSend.length),
      followUpsScheduled, followUpDays: fu ? fu.days : null, secondFollowUpDays: fu2 ? fu2.days : null,
      testId: vs.testId
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Bulk send failed: ' + err.message } });
  }
});

// ---- Mailed letters -----------------------------------------------------
// Builds the letters for the selected businesses (see lib/vendorLetters.js).
// Nothing is sent: the browser turns the result into a PDF the user prints and
// mails. Recording the batch is what lets the panel show "lettered" later.
router.post('/api/vendor-directory/:source/mailer-letters', requireAuth, async (req, res) => {
  const { category, ids, message, includeWithEmail, includeRecentlyLettered, record } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > letters.MAX_LETTERS) {
    return res.status(400).json({ error: { message: `Select between 1 and ${letters.MAX_LETTERS} businesses.` } });
  }
  if (!message || !String(message).trim() || String(message).length > tpl.MAX_TEMPLATE_CHARS) {
    return res.status(400).json({ error: { message: 'The letter text is empty or too long.' } });
  }
  const leftover = String(message).replace(/\{name\}/g, '').match(/\{[a-z_]+\}/);
  if (leftover) return res.status(400).json({ error: { message: `The letter still contains ${leftover[0]}. Remove it or fill it in first.`, code: 'unresolved_token' } });
  if (!resolveCategory(req.params.source, category)) return res.status(404).json({ error: { message: 'Unknown category.' } });

  try {
    const ctx = await outreach.getSenderContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    // A letter needs a return address, the same way the email footer does.
    if ((ctx.profile.address || '').trim().length < 8) {
      return res.status(400).json({ error: { message: 'Add your business address in your profile first — it goes at the top of each letter.', code: 'address_required' } });
    }
    const built = await letters.buildLetters({
      tenantId: req.tenantId, sourceKey: req.params.source, categoryKey: category, ids, message: String(message),
      includeWithEmail: !!includeWithEmail, includeRecentlyLettered: !!includeRecentlyLettered, record: record !== false
    });
    const t = await loadTemplateContext(req.tenantId);
    res.json({
      ...built,
      sender: {
        company: ctx.companyName, founder: ctx.profile.founder_name || '', phone: ctx.profile.phone || '',
        email: ctx.profile.email || '', address: ctx.profile.address || '', site: tpl.cleanSite(t && t.profile.site)
      }
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to prepare letters: ' + err.message } });
  }
});

// ---- Spread a batch over several business days -------------------------
// Same confirmation as an immediate bulk send; instead of sending now, each
// recipient is queued with a due time (lib/outreachQueue.js).
router.post('/api/vendors/outreach-bulk/schedule', requireAuth, async (req, res) => {
  const { recipients, message, followUp, spreadDays } = req.body || {};
  if (!Array.isArray(recipients) || !recipients.length || recipients.length > 200) {
    return res.status(400).json({ error: { message: 'Schedule between 1 and 200 recipients at a time.' } });
  }
  if (!message || !String(message).trim()) return res.status(400).json({ error: { message: 'Message text is required.' } });
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: { message: 'Outreach emails are not configured on this server yet (missing RESEND_API_KEY).' } });
  }
  try {
    const ctx = await outreach.getSenderContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    if ((ctx.profile.address || '').trim().length < 8) {
      return res.status(400).json({ error: { message: 'Add your business address in your profile before sending bulk email — it is required in the footer of commercial email.', code: 'address_required' } });
    }
    const leftover = String(message).replace(/\{name\}/g, '').match(/\{[a-z_]+\}/);
    if (leftover) return res.status(400).json({ error: { message: `The message still contains ${leftover[0]}. Remove it or fill it in before sending.`, code: 'unresolved_token' } });
    const parsedFu = parseFollowUps(followUp);
    if (parsedFu.error) return res.status(400).json({ error: parsedFu.error });
    const vs = parseVariants(req.body);
    if (vs.error) return res.status(400).json({ error: vs.error });
    const origByEmail = new Map();
    recipients.forEach((r, i) => { const k = outreach.normEmail(r && r.email); if (!origByEmail.has(k)) origByEmail.set(k, { r, i }); });

    const greetingFor = new Map();
    for (const r of recipients) {
      const key = outreach.normEmail(r && r.email);
      if (!greetingFor.has(key)) greetingFor.set(key, (r && r.greeting) || tpl.friendlyGreeting(r && r.name, null));
    }
    // Anyone already waiting in the queue counts as "already scheduled", not a fresh recipient.
    const { sendable, skipped } = await outreach.screenRecipients(req.tenantId, recipients);
    if ((await queue.pendingCount(req.tenantId)) + sendable.length > queue.MAX_PENDING_PER_TENANT) {
      return res.status(400).json({ error: { message: `You can have at most ${queue.MAX_PENDING_PER_TENANT} emails scheduled at once. Cancel some, or wait for them to send.`, code: 'queue_full' } });
    }
    // Never plan more per day than the daily send cap allows.
    const days = Math.min(queue.MAX_SPREAD_DAYS, Math.max(parseInt(spreadDays, 10) || 1, Math.ceil(sendable.length / outreach.BULK_DAILY_CAP)));
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const queued = await queue.enqueue({
      tenantId: req.tenantId, baseUrl, days, testId: vs.testId,
      follow1Days: parsedFu.fu1 ? parsedFu.fu1.days : null, follow2Days: parsedFu.fu2 ? parsedFu.fu2.days : null,
      recipients: sendable.map(r => {
        const g = greetingFor.get(r.email);
        const o = origByEmail.get(r.email) || { r: {}, i: 0 };
        const v = vs.pick(o.r, o.i);
        return {
          email: r.email, name: r.name, message: tpl.fillName(v.message, g), subject: v.subject, variant: v.variant, ...v.meta,
          follow1Message: parsedFu.fu1 ? tpl.fillName(parsedFu.fu1.message, g) : null,
          follow2Message: parsedFu.fu2 ? tpl.fillName(parsedFu.fu2.message, g) : null
        };
      })
    });
    const already = sendable.filter(r => !queued.some(q => q.email === r.email)).map(r => ({ ...r, reason: 'already_scheduled' }));
    const dues = queued.map(q => new Date(q.dueAt).getTime());
    res.json({
      scheduled: queued.length, skipped: [...skipped, ...already],
      firstDue: dues.length ? new Date(Math.min(...dues)) : null, lastDue: dues.length ? new Date(Math.max(...dues)) : null,
      spreadDays: days, perDay: Math.ceil(queued.length / days),
      followUpDays: parsedFu.fu1 ? parsedFu.fu1.days : null, secondFollowUpDays: parsedFu.fu2 ? parsedFu.fu2.days : null,
      testId: vs.testId
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Scheduling failed: ' + err.message } });
  }
});

router.get('/api/vendors/queue', requireAuth, async (req, res) => {
  try { res.json(await queue.listQueue(req.tenantId)); }
  catch (err) { res.status(500).json({ error: { message: 'Failed to load scheduled emails: ' + err.message } }); }
});
router.post('/api/vendors/queue/cancel-all', requireAuth, async (req, res) => {
  try { res.json({ cancelled: await queue.cancelQueueAll(req.tenantId) }); }
  catch (err) { res.status(500).json({ error: { message: 'Failed to cancel: ' + err.message } }); }
});
router.post('/api/vendors/queue/:id/cancel', requireAuth, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    const n = await queue.cancelQueueOne(req.tenantId, req.params.id);
    if (!n) return res.status(404).json({ error: { message: 'That email is no longer scheduled.' } });
    res.json({ cancelled: n });
  } catch (err) { res.status(500).json({ error: { message: 'Failed to cancel: ' + err.message } }); }
});

// ---- LinkedIn to-do queue -----------------------------------------------
// A hand-worked list: for each business, a LinkedIn search link and a short
// connection note to paste. Nothing here talks to LinkedIn or automates it.
router.post('/api/vendors/linkedin-queue', requireAuth, async (req, res) => {
  const { source: sourceKey, category: categoryKey, ids } = req.body || {};
  const found = resolveCategory(sourceKey, categoryKey);
  if (!found) return res.status(404).json({ error: { message: 'Unknown category.' } });
  if (!Array.isArray(ids) || !ids.length || ids.length > 100) return res.status(400).json({ error: { message: 'Add between 1 and 100 businesses at a time.' } });
  try {
    const ctx = await loadTemplateContext(req.tenantId);
    if (!ctx) return res.status(404).json({ error: { message: 'Tenant not found.' } });
    const vars = tpl.buildVariables({ ...ctx, source: found.source, category: found.category });
    const tmpl = tpl.fitLinkedinNote(tpl.renderTemplate(tpl.DEFAULT_LINKEDIN_NOTES[found.source.intent], vars), 400); // fitted per person below
    const rows = await dir.getNamesByIds(sourceKey, categoryKey, ids.map(n => parseInt(n, 10)).filter(Number.isFinite));
    let added = 0;
    for (const r of rows) {
      if (!r.name) continue;
      const note = tpl.fitLinkedinNote(tpl.fillName(tmpl, tpl.friendlyGreeting(r.name, r.greetFirst)));
      const url = 'https://www.linkedin.com/search/results/all/?keywords=' + encodeURIComponent(tpl.properName(r.name) + ' Houston');
      const ins = await query(
        `INSERT INTO linkedin_tasks (tenant_id, source, source_id, vendor_name, search_url, message)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, source, source_id) DO NOTHING RETURNING id`,
        [req.tenantId, sourceKey, r.id, tpl.properName(r.name), url, note]
      );
      if (ins.rows.length) added++;
    }
    res.json({ added, alreadyThere: rows.length - added });
  } catch (err) { res.status(500).json({ error: { message: 'Failed to add to the LinkedIn list: ' + err.message } }); }
});
router.get('/api/vendors/linkedin-queue', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, vendor_name, search_url, message, done_at FROM linkedin_tasks
       WHERE tenant_id = $1 ORDER BY (done_at IS NOT NULL), created_at DESC LIMIT 300`, [req.tenantId]);
    // bigserial ids arrive from pg as strings; the page passes them back as numbers.
    const tasks = r.rows.map(t => ({ ...t, id: Number(t.id) }));
    res.json({ tasks, open: tasks.filter(t => !t.done_at).length });
  } catch (err) { res.status(500).json({ error: { message: 'Failed to load the LinkedIn list: ' + err.message } }); }
});
router.post('/api/vendors/linkedin-queue/:id/done', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    const done = req.body && req.body.done === false ? null : new Date();
    const r = await query('UPDATE linkedin_tasks SET done_at = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id', [done, id, req.tenantId]);
    if (!r.rows.length) return res.status(404).json({ error: { message: 'Not found.' } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: { message: 'Failed to update: ' + err.message } }); }
});
router.delete('/api/vendors/linkedin-queue/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    await query('DELETE FROM linkedin_tasks WHERE id = $1 AND tenant_id = $2', [id, req.tenantId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: { message: 'Failed to remove: ' + err.message } }); }
});

// ---- Scheduled follow-ups ---------------------------------------------
router.get('/api/vendors/followups', requireAuth, async (req, res) => {
  try {
    res.json(await followUps.listFollowUps(req.tenantId));
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load follow-ups: ' + err.message } });
  }
});
router.post('/api/vendors/followups/cancel-all', requireAuth, async (req, res) => {
  try {
    res.json({ cancelled: await followUps.cancelAll(req.tenantId) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to cancel: ' + err.message } });
  }
});
router.post('/api/vendors/followups/:id/cancel', requireAuth, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: { message: 'Invalid id.' } });
  try {
    const n = await followUps.cancelOne(req.tenantId, req.params.id);
    if (!n) return res.status(404).json({ error: { message: 'That follow-up is no longer pending.' } });
    res.json({ cancelled: n });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to cancel: ' + err.message } });
  }
});

module.exports = router;
