// Integration tests against a real running instance of the server and the
// real Postgres DB (see helpers.js for why there's no separate test DB).
// Every tenant a test creates is registered with trackTenant() and deleted
// in the top-level `after` hook, whether tests pass or fail.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { Webhook } = require('svix');

const {
  BASE_URL, startServer, stopServer, makeClient, trackTenant, cleanupTenants, uniqueEmail, getTestPool, TEST_WEBHOOK_SECRET
} = require('./helpers');
const { checkAndIncrementCounter } = require('../lib/usage');

// Signs a real payload with the real svix library against the test
// server's actual RESEND_WEBHOOK_SECRET (see helpers.js) — the same
// mechanism used to hand-verify this end-to-end earlier, now permanent.
function signWebhookPayload(payload) {
  const wh = new Webhook(TEST_WEBHOOK_SECRET);
  const msgId = 'msg_' + Math.random().toString(36).slice(2);
  const timestamp = new Date();
  const signature = wh.sign(msgId, timestamp, payload);
  return {
    'svix-id': msgId,
    'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'svix-signature': signature
  };
}

async function postInboundWebhook(client, dataOverrides) {
  const payload = JSON.stringify({
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: { email_id: 'test-email-id', from: 'someone@example.com', to: [], subject: 'Test', ...dataOverrides }
  });
  return client.raw('/api/webhooks/resend-inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signWebhookPayload(payload) },
    body: payload
  });
}

before(async () => {
  await startServer();
}, { timeout: 20000 });

after(async () => {
  await cleanupTenants();
  stopServer();
});

describe('auth: signup, login, session', () => {
  test('signup creates a tenant and logs the user in', async () => {
    const client = makeClient();
    const email = uniqueEmail('signup');
    const r = await client.post('/api/auth/signup', {
      email, password: 'TestPass1234!', companyName: 'Test Co', industry: 'home_services', acceptedTerms: true
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    trackTenant(body.tenantId);

    const me = await client.get('/api/me');
    assert.equal(me.status, 200);
    const meBody = await me.json();
    assert.equal(meBody.accountEmail, email.toLowerCase());
    assert.equal(meBody.companyName, 'Test Co');
  });

  test('rejects an invalid email', async () => {
    const client = makeClient();
    const r = await client.post('/api/auth/signup', {
      email: 'not-an-email', password: 'TestPass1234!', companyName: 'X', industry: 'home_services', acceptedTerms: true
    });
    assert.equal(r.status, 400);
  });

  test('rejects a too-short password', async () => {
    const client = makeClient();
    const r = await client.post('/api/auth/signup', {
      email: uniqueEmail('shortpw'), password: 'short', companyName: 'X', industry: 'home_services', acceptedTerms: true
    });
    assert.equal(r.status, 400);
  });

  test('wrong password on login is rejected', async () => {
    const client = makeClient();
    const email = uniqueEmail('badlogin');
    const signupRes = await client.post('/api/auth/signup', {
      email, password: 'TestPass1234!', companyName: 'X', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signupRes.json()).tenantId);

    const freshClient = makeClient(); // new client = no session cookie carried over
    const r = await freshClient.post('/api/auth/login', { email, password: 'WrongPassword!' });
    assert.equal(r.status, 401);
  });

  test('unauthenticated request to a protected route is rejected', async () => {
    const client = makeClient();
    const r = await client.get('/api/leads');
    assert.equal(r.status, 401);
  });
});

describe('tenant isolation', () => {
  test("tenant A cannot see tenant B's leads", async () => {
    const clientA = makeClient();
    const signupA = await clientA.post('/api/auth/signup', {
      email: uniqueEmail('tenantA'), password: 'TestPass1234!', companyName: 'Tenant A', industry: 'home_services', acceptedTerms: true
    });
    const tenantA = (await signupA.json()).tenantId;
    trackTenant(tenantA);

    const clientB = makeClient();
    const signupB = await clientB.post('/api/auth/signup', {
      email: uniqueEmail('tenantB'), password: 'TestPass1234!', companyName: 'Tenant B', industry: 'home_services', acceptedTerms: true
    });
    const tenantB = (await signupB.json()).tenantId;
    trackTenant(tenantB);

    // Both tenants start with zero leads — the real assertion is that each
    // only ever sees rows scoped to req.tenantId, checked directly below.
    const pool = getTestPool();
    try {
      await pool.query(`INSERT INTO leads (tenant_id, name, phone, source) VALUES ($1, 'Only for A', '555-0100', 'landing_page')`, [tenantA]);
    } finally {
      await pool.end();
    }

    const leadsA = await (await clientA.get('/api/leads')).json();
    assert.equal(leadsA.leads.length, 1);
    assert.equal(leadsA.leads[0].name, 'Only for A');

    const leadsB = await (await clientB.get('/api/leads')).json();
    assert.equal(leadsB.leads.length, 0);
  });
});

describe('company profile editing (PATCH /api/onboarding/profile)', () => {
  test('updates the tenant + business_profile without touching generated_content or the usage cap', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('profedit'), password: 'TestPass1234!', companyName: 'Original Name', industry: 'home_services', acceptedTerms: true
    });
    const tenantId = (await signup.json()).tenantId;
    trackTenant(tenantId);

    const before = await (await client.get('/api/me')).json();
    assert.equal(before.generationsUsed, 0);

    const r = await client.patch('/api/onboarding/profile', {
      companyName: 'Updated Name', industry: 'professional_services',
      founderName: 'Jane Owner', phone: '555-0123', email: 'jane@example.com', address: '1 Main St',
      site: 'example.com', serviceArea: 'Metro area', services: 'Updated services', differentiators: 'Fast',
      voice: 'warm'
    });
    assert.equal(r.status, 200);

    const after = await (await client.get('/api/me')).json();
    assert.equal(after.companyName, 'Updated Name');
    assert.equal(after.industry, 'professional_services');
    assert.equal(after.profile.founderName, 'Jane Owner');
    assert.equal(after.profile.services, 'Updated services');
    // Unrelated to onboarding's AI generation — must not have run or counted.
    assert.equal(after.generationsUsed, 0);
    assert.deepEqual(after.generatedContent, {});
  });

  test('rejects a missing company name, missing services, or invalid industry', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('profedit2'), password: 'TestPass1234!', companyName: 'X Co', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const base = { companyName: 'X Co', industry: 'home_services', services: 'Something' };
    assert.equal((await client.patch('/api/onboarding/profile', { ...base, companyName: '' })).status, 400);
    assert.equal((await client.patch('/api/onboarding/profile', { ...base, services: '' })).status, 400);
    assert.equal((await client.patch('/api/onboarding/profile', { ...base, industry: 'not_a_real_industry' })).status, 400);
  });

  test("tenant A editing their profile doesn't affect tenant B", async () => {
    const clientA = makeClient();
    const signupA = await clientA.post('/api/auth/signup', {
      email: uniqueEmail('profA'), password: 'TestPass1234!', companyName: 'Profile Tenant A', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signupA.json()).tenantId);

    const clientB = makeClient();
    const signupB = await clientB.post('/api/auth/signup', {
      email: uniqueEmail('profB'), password: 'TestPass1234!', companyName: 'Profile Tenant B', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signupB.json()).tenantId);

    await clientA.patch('/api/onboarding/profile', {
      companyName: 'A Renamed', industry: 'home_services', services: 'A services'
    });

    const bAfter = await (await clientB.get('/api/me')).json();
    assert.equal(bAfter.companyName, 'Profile Tenant B');
  });
});

describe('usage caps (lib/usage.js checkAndIncrementCounter)', () => {
  test('blocks once the monthly cap is reached, and does not increment past it', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('capcheck'), password: 'TestPass1234!', companyName: 'Cap Check', industry: 'home_services', acceptedTerms: true
    });
    const tenantId = (await signup.json()).tenantId;
    trackTenant(tenantId);

    const pool = getTestPool();
    try {
      await pool.query('UPDATE tenants SET monthly_generation_cap = 2 WHERE id = $1', [tenantId]);
    } finally {
      await pool.end();
    }

    const opts = { capColumn: 'monthly_generation_cap', counterColumn: 'generation_count' };
    const first = await checkAndIncrementCounter(tenantId, opts);
    assert.equal(first.allowed, true);
    assert.equal(first.used, 1);

    const second = await checkAndIncrementCounter(tenantId, opts);
    assert.equal(second.allowed, true);
    assert.equal(second.used, 2);

    const third = await checkAndIncrementCounter(tenantId, opts);
    assert.equal(third.allowed, false);
    assert.equal(third.used, 2); // did not increment past the cap
  });
});

describe('permits: industry gating + real data', () => {
  test('403s for an industry outside real estate / home services', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('wrongindustry'), password: 'TestPass1234!', companyName: 'Not Real Estate', industry: 'restaurant', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/permits/high-value-areas');
    assert.equal(r.status, 403);
  });

  test('200s with real permit data for a home_services tenant', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('permitsok'), password: 'TestPass1234!', companyName: 'Permits OK', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/permits/high-value-areas');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.areas));
    assert.ok(body.totalPermits > 0, 'expected real permit records, got 0 — the live data source may be down');
    // hcad is a real lookup against hcad_zip_stats (see lib/hcadZipValues.js)
    // — it's `null` for any zip the import script hasn't covered in this
    // environment, but the key must always be present, never missing.
    if (body.areas.length) assert.ok('hcad' in body.areas[0]);
  }, { timeout: 30000 });

  test('200s for a construction-named company even under a non-real-estate industry', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('constructionname'), password: 'TestPass1234!', companyName: 'Bayou City Construction LLC', industry: 'other', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/permits/high-value-areas');
    assert.equal(r.status, 200);
  }, { timeout: 30000 });

  test('/api/me reports showPermitsTab true for that same construction-named company', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('constructionme'), password: 'TestPass1234!', companyName: 'Lone Star Roofing Co', industry: 'retail', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const me = await (await client.get('/api/me')).json();
    assert.equal(me.showPermitsTab, true);
    // showRealEstateFeatures stays industry-only — a construction name alone
    // shouldn't also unlock the broader real-estate-only feature bundle.
    assert.equal(me.showRealEstateFeatures, false);
  });
});

describe('permits: mailer letters (POST /api/permits/mailer-letters)', () => {
  test('403s for an industry outside real estate / home services', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('mailerwrongind'), password: 'TestPass1234!', companyName: 'Not Real Estate', industry: 'restaurant', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.post('/api/permits/mailer-letters', { permits: [{ address: '1 Main St', zip: '77019', permitType: 'Roof', permitDate: '2026-08-01' }] });
    assert.equal(r.status, 403);
  });

  test('400s when no permits are selected', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('mailerempty'), password: 'TestPass1234!', companyName: 'Empty Mailer Co', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.post('/api/permits/mailer-letters', { permits: [] });
    assert.equal(r.status, 400);
  });

  test('400s when more than 200 permits are selected', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('mailertoomany'), password: 'TestPass1234!', companyName: 'Too Many Co', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const permits = Array.from({ length: 201 }, (_, i) => ({ address: `${i} Main St`, zip: '77019', permitType: 'Roof', permitDate: '2026-08-01' }));
    const r = await client.post('/api/permits/mailer-letters', { permits });
    assert.equal(r.status, 400);
  });

  test('returns one personalized letter per selected permit, addressed to the real permit address', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('mailerok'), password: 'TestPass1234!', companyName: 'Acme Roofing', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const permits = [
      { address: '123 Main St', zip: '77019', permitType: 'Roof Replacement', permitDate: '2026-08-01', projectNo: 'P-1' },
      { address: '456 Oak Dr', zip: '77024', permitType: 'Pool/Spa', permitDate: '2026-08-05', projectNo: 'P-2' }
    ];
    const r = await client.post('/api/permits/mailer-letters', { permits });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.letters.length, 2);
    assert.equal(body.letters[0].recipientAddress, '123 Main St');
    assert.equal(body.letters[0].region, 'River Oaks');
    assert.equal(body.letters[1].recipientAddress, '456 Oak Dr');
    // No confident owner match exists for these made-up test addresses —
    // must fall back to "Property Owner", never a guess.
    assert.equal(body.letters[0].recipientName, 'Property Owner');
    assert.equal(body.letters[0].greeting, 'Dear Property Owner,');
    // Personalized: mentions the real signed-up company name, not a
    // generic/copy-pasted placeholder.
    const fullText = body.letters[0].bodyParagraphs.join(' ');
    assert.match(fullText, /Acme Roofing/);
    assert.notEqual(body.letters[0].bodyParagraphs.join(' '), body.letters[1].bodyParagraphs.join(' '));
  });

  test('addresses a real confident owner name pulled from hcad_owner_parcels', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('mailerowner'), password: 'TestPass1234!', companyName: 'Acme Roofing', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const pool = getTestPool();
    try {
      await pool.query(
        `INSERT INTO hcad_owner_parcels (zip, normalized_address, owner_first_name, owner_last_name, raw_site_address, tax_year)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['77019', '789 CONFIDENT LN', 'Taylor', 'Nguyen', '789 CONFIDENT LN', '2026']
      );

      const r = await client.post('/api/permits/mailer-letters', {
        permits: [{ address: '789 Confident Ln', zip: '77019', permitType: 'Roof Replacement', permitDate: '2026-08-01', projectNo: 'P-OWNER' }]
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.letters[0].recipientName, 'Taylor Nguyen');
      assert.equal(body.letters[0].greeting, 'Dear Taylor,');
    } finally {
      // This table holds real, shared HCAD data (not tenant-scoped) — clean
      // up this test's synthetic row rather than leaving it mixed in.
      await pool.query(`DELETE FROM hcad_owner_parcels WHERE normalized_address = '789 CONFIDENT LN'`);
      await pool.end();
    }
  });

  test('falls back to "Property Owner" when two different owners share the same (zip, address) — ambiguous, not confident', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('mailerambiguous'), password: 'TestPass1234!', companyName: 'Acme Roofing', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const pool = getTestPool();
    try {
      await pool.query(
        `INSERT INTO hcad_owner_parcels (zip, normalized_address, owner_first_name, owner_last_name, raw_site_address, tax_year)
         VALUES ($1, $2, $3, $4, $5, $6), ($1, $2, $7, $8, $5, $6)`,
        ['77019', '0 AMBIGUOUS ST', 'Taylor', 'Nguyen', '0 AMBIGUOUS ST', '2026', 'Jordan', 'Lee']
      );

      const r = await client.post('/api/permits/mailer-letters', {
        permits: [{ address: '0 Ambiguous St', zip: '77019', permitType: 'Roof Replacement', permitDate: '2026-08-01', projectNo: 'P-AMBIG' }]
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.letters[0].recipientName, 'Property Owner');
      assert.equal(body.letters[0].greeting, 'Dear Property Owner,');
    } finally {
      await pool.query(`DELETE FROM hcad_owner_parcels WHERE normalized_address = '0 AMBIGUOUS ST'`);
      await pool.end();
    }
  });
});

describe('"not configured" fallbacks (external keys unset in this test run)', () => {
  test('Stripe checkout returns a clean 503 with a clear message, not a crash', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('stripecheck'), password: 'TestPass1234!', companyName: 'Stripe Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.post('/api/stripe/create-checkout-session', {});
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.match(body.error.message, /not configured/i);
  });

  test('Google Places vendor lookup returns a clean 503, not a crash', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('placescheck'), password: 'TestPass1234!', companyName: 'Places Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/vendors/places?category=roofing');
    assert.equal(r.status, 503);
  });

  test('Meta Ads campaign creation returns a clean 503, not a crash', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('metaadscheck'), password: 'TestPass1234!', companyName: 'Meta Ads Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.post('/api/ads/meta/campaign', { name: 'Test', dailyBudgetCents: 2000, message: 'hi', link: 'https://example.com' });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.match(body.error.message, /not configured/i);
  });

  test('Meta Ads OAuth connect returns a clean 503, not a crash', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('metaadsoauth'), password: 'TestPass1234!', companyName: 'Meta Ads OAuth Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/ads/meta/connect');
    assert.equal(r.status, 503);
  });

  test('Google Ads campaign creation returns a clean 503, not a crash', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('googleadscheck'), password: 'TestPass1234!', companyName: 'Google Ads Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.post('/api/ads/google/campaign', {
      name: 'Test', dailyBudgetCents: 2000, finalUrl: 'https://example.com',
      headlines: ['a', 'b', 'c'], descriptions: ['d', 'e']
    });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.match(body.error.message, /not configured/i);
  });

  test('Google Ads OAuth connect returns a clean 503, not a crash', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('googleadsoauth'), password: 'TestPass1234!', companyName: 'Google Ads OAuth Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/ads/google/connect');
    assert.equal(r.status, 503);
  });

  test('Google Business Profile post returns a clean 503, not a crash', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('gbpcheck'), password: 'TestPass1234!', companyName: 'GBP Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.post('/api/gbp/post', { summary: 'hello' });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.match(body.error.message, /not configured/i);
  });

  test('Google Business Profile OAuth connect returns a clean 503, not a crash', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('gbpoauth'), password: 'TestPass1234!', companyName: 'GBP OAuth Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/gbp/connect');
    assert.equal(r.status, 503);
  });

  test('Google Business Profile status reports unconfigured, not a crash', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('gbpstatus'), password: 'TestPass1234!', companyName: 'GBP Status Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/gbp/status');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.configured, false);
    assert.equal(body.connected, false);
  });

  test('Social analytics reports not connected, not a crash (no fabricated numbers)', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('socialanalytics'), password: 'TestPass1234!', companyName: 'Social Analytics Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/social/analytics');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.connected, false);
    assert.equal('facebook' in body, false);
    assert.equal('instagram' in body, false);
  });

  test('Google Business Profile analytics reports not connected, not a crash (no fabricated numbers)', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('gbpanalytics'), password: 'TestPass1234!', companyName: 'GBP Analytics Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/gbp/analytics');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.connected, false);
    assert.equal('totalReviewCount' in body, false);
  });

  test('Vendor outreach-email send returns a clean 503, not a crash', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('vendoroutreach'), password: 'TestPass1234!', companyName: 'Vendor Outreach Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.post('/api/vendors/outreach-email', { toEmail: 'vendor@example.com', vendorName: 'Acme', message: 'Hi there' });
    assert.equal(r.status, 503);
  });

});

describe('review requests (routes/reviews.js)', () => {
  test('validates customer name and email are required', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('rrvalidate'), password: 'TestPass1234!', companyName: 'RR Validate Co', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    assert.equal((await client.post('/api/review-requests', { customerEmail: 'a@example.com' })).status, 400);
    assert.equal((await client.post('/api/review-requests', { customerName: 'Jane' })).status, 400);
  });

  test('returns a clean 503, not a crash, when RESEND_API_KEY is unset', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('rr503'), password: 'TestPass1234!', companyName: 'RR 503 Co', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.post('/api/review-requests', { customerName: 'Jane', customerEmail: 'jane@example.com' });
    assert.equal(r.status, 503);
  });

  test('a fresh tenant has zero review requests, sees only their own, and replies show up', async () => {
    const clientA = makeClient();
    const signupA = await clientA.post('/api/auth/signup', {
      email: uniqueEmail('rrA'), password: 'TestPass1234!', companyName: 'RR Tenant A', industry: 'home_services', acceptedTerms: true
    });
    const tenantA = (await signupA.json()).tenantId;
    trackTenant(tenantA);

    const clientB = makeClient();
    const signupB = await clientB.post('/api/auth/signup', {
      email: uniqueEmail('rrB'), password: 'TestPass1234!', companyName: 'RR Tenant B', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signupB.json()).tenantId);

    const empty = await (await clientA.get('/api/review-requests')).json();
    assert.deepEqual(empty.reviewRequests, []);

    const pool = getTestPool();
    try {
      await pool.query(
        `INSERT INTO review_requests (id, tenant_id, customer_name, customer_email, included_platforms, status, reply_text, replied_at)
         VALUES (gen_random_uuid(), $1, 'Jane Customer', 'jane@example.com', '["google"]', 'sent', 'Left you a review!', now())`,
        [tenantA]
      );
    } finally {
      await pool.end();
    }

    const aList = await (await clientA.get('/api/review-requests')).json();
    assert.equal(aList.reviewRequests.length, 1);
    assert.equal(aList.reviewRequests[0].reply_text, 'Left you a review!');
    assert.ok(aList.reviewRequests[0].replied_at);

    const bList = await (await clientB.get('/api/review-requests')).json();
    assert.deepEqual(bList.reviewRequests, []);
  });
});

describe('inbound email webhook (routes/inboundEmail.js) — real svix signature verification', () => {
  test('rejects a request with no signature headers at all', async () => {
    const client = makeClient();
    const r = await client.raw('/api/webhooks/resend-inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email.received', data: {} })
    });
    assert.equal(r.status, 400);
  });

  test('rejects a real signature computed with the wrong secret', async () => {
    const client = makeClient();
    const payload = JSON.stringify({ type: 'email.received', data: { email_id: 'x', to: [] } });
    const wrongWh = new Webhook('whsec_dGhpc2lzYWRpZmZlcmVudHNlY3JldA==');
    const msgId = 'msg_wrong';
    const timestamp = new Date();
    const signature = wrongWh.sign(msgId, timestamp, payload);
    const r = await client.raw('/api/webhooks/resend-inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': msgId,
        'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
        'svix-signature': signature
      },
      body: payload
    });
    assert.equal(r.status, 400);
  });

  test('accepts a validly-signed payload addressed to nothing of ours, and leaves an unrelated row untouched', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('webhooknomatch'), password: 'TestPass1234!', companyName: 'Webhook No Match Co', industry: 'home_services', acceptedTerms: true
    });
    const tenantId = (await signup.json()).tenantId;
    trackTenant(tenantId);

    const pool = getTestPool();
    let outreachId;
    try {
      const ins = await pool.query(
        `INSERT INTO vendor_outreach (id, tenant_id, vendor_name, to_email, message, status)
         VALUES (gen_random_uuid(), $1, 'Untouched Vendor', 'vendor@example.com', 'Hi', 'sent') RETURNING id`,
        [tenantId]
      );
      outreachId = ins.rows[0].id;
    } finally {
      await pool.end();
    }

    const r = await postInboundWebhook(client, { to: ['someone-unrelated@mail.example.com'] });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { received: true });

    const pool2 = getTestPool();
    try {
      const check = await pool2.query('SELECT reply_text, replied_at FROM vendor_outreach WHERE id = $1', [outreachId]);
      assert.equal(check.rows[0].reply_text, null);
      assert.equal(check.rows[0].replied_at, null);
    } finally {
      await pool2.end();
    }
  });

  test('accepts a validly-signed payload matching a real vendor_outreach row (processing then safely no-ops without RESEND_API_KEY)', async () => {
    // Full success (saving the real reply body + forwarding it) needs a
    // real RESEND_API_KEY to fetch the full email from Resend's API — not
    // available in this test run, same boundary as every other external-
    // key-gated route in this suite. What IS verified here for real:
    // signature verification passes, the reply+vendor-<id>@ address is
    // correctly matched back to its row, and the request completes
    // cleanly (200, no crash, no unhandled rejection) even though the
    // downstream Resend call fails — matching what actually happened in
    // production before RESEND_API_KEY there was corrected to a
    // full-access key.
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('webhookmatch'), password: 'TestPass1234!', companyName: 'Webhook Match Co', industry: 'home_services', acceptedTerms: true
    });
    const tenantId = (await signup.json()).tenantId;
    trackTenant(tenantId);

    const pool = getTestPool();
    let outreachId;
    try {
      const ins = await pool.query(
        `INSERT INTO vendor_outreach (id, tenant_id, vendor_name, to_email, message, status)
         VALUES (gen_random_uuid(), $1, 'Reply Test Vendor', 'vendor@example.com', 'Hi', 'sent') RETURNING id`,
        [tenantId]
      );
      outreachId = ins.rows[0].id;
    } finally {
      await pool.end();
    }

    const r = await postInboundWebhook(client, { to: [`reply+vendor-${outreachId}@mail.example.com`] });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { received: true });

    // Give the fire-and-continue processing (which happens after the
    // response is already sent) a moment to run and fail safely.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const pool2 = getTestPool();
    try {
      const check = await pool2.query('SELECT reply_text, replied_at FROM vendor_outreach WHERE id = $1', [outreachId]);
      // Not populated — RESEND_API_KEY is unset, so getReceivedEmail()
      // threw before ever reaching the DB write. This asserts the failure
      // was contained (still null, not some corrupted partial state),
      // not that the happy path ran.
      assert.equal(check.rows[0].reply_text, null);
      assert.equal(check.rows[0].replied_at, null);
    } finally {
      await pool2.end();
    }
  });
});

describe('image hosting (routes/images.js)', () => {
  // A real 1x1 transparent PNG — small enough to keep the test fast, real
  // enough to exercise the actual base64-decode/store/serve round trip.
  const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  test('uploads a real image and serves it back publicly with the right content type', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('imgupload'), password: 'TestPass1234!', companyName: 'Image Upload Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const upload = await client.post('/api/images/upload', { dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}` });
    assert.equal(upload.status, 200);
    const uploadBody = await upload.json();
    assert.ok(uploadBody.url.includes('/img/'));

    // The serving route is public — fetch it with a fresh, unauthenticated
    // client to confirm no session is required (Instagram's own servers
    // can't send one).
    const publicResp = await fetch(uploadBody.url);
    assert.equal(publicResp.status, 200);
    assert.equal(publicResp.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await publicResp.arrayBuffer());
    assert.equal(bytes.toString('base64'), TINY_PNG_BASE64);
  });

  test('rejects a non-image upload with a clean 400', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('imgbad'), password: 'TestPass1234!', companyName: 'Image Bad Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.post('/api/images/upload', { dataUrl: 'not-a-data-url' });
    assert.equal(r.status, 400);
  });

  test('unknown image id returns 404, not a crash', async () => {
    const client = makeClient();
    const r = await client.get('/img/00000000-0000-0000-0000-000000000000');
    assert.equal(r.status, 404);
  });
});

describe('signals: industry gating + real live data', () => {
  test('403s for an industry outside real estate / home services', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('signalswrongind'), password: 'TestPass1234!', companyName: 'Not Real Estate', industry: 'restaurant', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/signals');
    assert.equal(r.status, 403);
  });

  test('200s with real weather-alert and permit-spike data for a home_services tenant', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('signalsok'), password: 'TestPass1234!', companyName: 'Signals OK', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.get('/api/signals');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.weatherAlerts), 'expected a real (possibly empty) weatherAlerts array from NWS — no key needed');
    assert.ok(Array.isArray(body.permitSpikes), 'expected a real (possibly empty) permitSpikes array from live permit data');
    if (body.permitSpikes.length) assert.ok('hcad' in body.permitSpikes[0]);
  }, { timeout: 30000 });

  test('draft-outreach requires a valid type', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('signalsdraft'), password: 'TestPass1234!', companyName: 'Signals Draft', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.post('/api/signals/draft-outreach', { type: 'not-a-real-type' });
    assert.equal(r.status, 400);
  });
});

describe('landing pages: multi-page support', () => {
  test('a fresh tenant has zero pages, and unknown-id operations 404 rather than crashing', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('lppages'), password: 'TestPass1234!', companyName: 'LP Pages Co', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const list = await client.get('/api/landing-pages');
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.deepEqual(listBody.pages, []);

    const fakeId = '00000000-0000-0000-0000-000000000000';
    assert.equal((await client.put('/api/landing-page/' + fakeId, { headline: 'x' })).status, 404);
    assert.equal((await client.post('/api/landing-page/' + fakeId + '/publish')).status, 404);
    assert.equal((await client.delete('/api/landing-page/' + fakeId)).status, 404);
  });

  test("tenant A's landing pages are invisible to tenant B", async () => {
    const clientA = makeClient();
    const signupA = await clientA.post('/api/auth/signup', {
      email: uniqueEmail('lpA'), password: 'TestPass1234!', companyName: 'LP Tenant A', industry: 'home_services', acceptedTerms: true
    });
    const tenantA = (await signupA.json()).tenantId;
    trackTenant(tenantA);

    const clientB = makeClient();
    const signupB = await clientB.post('/api/auth/signup', {
      email: uniqueEmail('lpB'), password: 'TestPass1234!', companyName: 'LP Tenant B', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signupB.json()).tenantId);

    const pool = getTestPool();
    let pageId;
    try {
      const inserted = await pool.query(
        `INSERT INTO landing_pages (tenant_id, slug, target_label, headline, status) VALUES ($1, $2, 'Test Page', 'Headline', 'draft') RETURNING id`,
        [tenantA, 'lp-test-' + Date.now()]
      );
      pageId = inserted.rows[0].id;
    } finally {
      await pool.end();
    }

    const bListsIt = await (await clientB.get('/api/landing-pages')).json();
    assert.deepEqual(bListsIt.pages, []);

    // Tenant B can't edit or delete tenant A's page even by guessing its id.
    assert.equal((await clientB.put('/api/landing-page/' + pageId, { headline: 'hijacked' })).status, 404);
    assert.equal((await clientB.delete('/api/landing-page/' + pageId)).status, 404);

    const aListsIt = await (await clientA.get('/api/landing-pages')).json();
    assert.equal(aListsIt.pages.length, 1);
    assert.equal(aListsIt.pages[0].target_label, 'Test Page');
  });
});

describe('real vendor lookup: high-value-focus targeting (routes/onboarding.js + lib/vendorTargeting.js)', () => {
  // The live Places API call itself needs GOOGLE_PLACES_API_KEY (unset in
  // this test run, same boundary as every other external-key-gated route
  // here), but the cache-hit path doesn't — so this exercises the real
  // detectsHighValueFocus() read from the real profile and the real
  // cache-key branching (category vs category::hv), seeding both cache
  // entries directly and confirming each tenant gets the one that matches
  // their own bio.
  test('a luxury-market bio gets the ::hv cache entry; an ordinary bio gets the plain one', async () => {
    const luxuryClient = makeClient();
    const luxurySignup = await luxuryClient.post('/api/auth/signup', {
      email: uniqueEmail('hvfocus'), password: 'TestPass1234!', companyName: 'Luxury Homes Co', industry: 'home_services', acceptedTerms: true
    });
    const luxuryTenantId = (await luxurySignup.json()).tenantId;
    trackTenant(luxuryTenantId);
    const luxuryPatch = await luxuryClient.patch('/api/onboarding/profile', {
      companyName: 'Luxury Homes Co', industry: 'home_services',
      services: 'We build luxury custom homes for discerning clients.'
    });
    assert.equal(luxuryPatch.status, 200);

    const plainClient = makeClient();
    const plainSignup = await plainClient.post('/api/auth/signup', {
      email: uniqueEmail('plainfocus'), password: 'TestPass1234!', companyName: 'Ordinary Roofing Co', industry: 'home_services', acceptedTerms: true
    });
    const plainTenantId = (await plainSignup.json()).tenantId;
    trackTenant(plainTenantId);
    const plainPatch = await plainClient.patch('/api/onboarding/profile', {
      companyName: 'Ordinary Roofing Co', industry: 'home_services',
      services: 'We repair roofs and gutters for local homeowners.'
    });
    assert.equal(plainPatch.status, 200);

    const pool = getTestPool();
    try {
      await pool.query(
        `UPDATE business_profile SET places_vendors = $1 WHERE tenant_id = $2`,
        [JSON.stringify({ 'roofer::hv': { results: [{ name: 'High-Value Roofer' }], fetchedAt: new Date().toISOString() } }), luxuryTenantId]
      );
      await pool.query(
        `UPDATE business_profile SET places_vendors = $1 WHERE tenant_id = $2`,
        [JSON.stringify({ roofer: { results: [{ name: 'Plain Roofer' }], fetchedAt: new Date().toISOString() } }), plainTenantId]
      );
    } finally {
      await pool.end();
    }

    const luxuryResult = await (await luxuryClient.get('/api/vendors/places?category=roofer')).json();
    assert.equal(luxuryResult.highValueFocus, true);
    assert.equal(luxuryResult.vendors[0].name, 'High-Value Roofer');

    const plainResult = await (await plainClient.get('/api/vendors/places?category=roofer')).json();
    assert.equal(plainResult.highValueFocus, false);
    assert.equal(plainResult.vendors[0].name, 'Plain Roofer');
  });
});

describe('vendor outreach history + reply tracking', () => {
  test('a fresh tenant has zero outreach, and only sees their own', async () => {
    const clientA = makeClient();
    const signupA = await clientA.post('/api/auth/signup', {
      email: uniqueEmail('outreachA'), password: 'TestPass1234!', companyName: 'Outreach Tenant A', industry: 'home_services', acceptedTerms: true
    });
    const tenantA = (await signupA.json()).tenantId;
    trackTenant(tenantA);

    const clientB = makeClient();
    const signupB = await clientB.post('/api/auth/signup', {
      email: uniqueEmail('outreachB'), password: 'TestPass1234!', companyName: 'Outreach Tenant B', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signupB.json()).tenantId);

    const emptyList = await (await clientA.get('/api/vendors/outreach')).json();
    assert.deepEqual(emptyList.outreach, []);

    // Simulate what routes/inboundEmail.js does on a real reply: directly
    // insert a row (as the send route would) with a reply already attached,
    // and confirm the list reflects it — and stays invisible to tenant B.
    const pool = getTestPool();
    try {
      await pool.query(
        `INSERT INTO vendor_outreach (id, tenant_id, vendor_name, to_email, message, status, reply_text, replied_at)
         VALUES (gen_random_uuid(), $1, 'Acme Roofing', 'acme@example.com', 'Hi there', 'sent', 'Sure, let''s talk', now())`,
        [tenantA]
      );
    } finally {
      await pool.end();
    }

    const aList = await (await clientA.get('/api/vendors/outreach')).json();
    assert.equal(aList.outreach.length, 1);
    assert.equal(aList.outreach[0].vendor_name, 'Acme Roofing');
    assert.equal(aList.outreach[0].reply_text, "Sure, let's talk");
    assert.ok(aList.outreach[0].replied_at);

    const bList = await (await clientB.get('/api/vendors/outreach')).json();
    assert.deepEqual(bList.outreach, []);
  });
});

describe('scheduled posts', () => {
  test('validates targets, future time, and requires a connected platform', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('sched'), password: 'TestPass1234!', companyName: 'Sched Co', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    assert.equal((await client.post('/api/scheduled-posts', { message: '', targets: ['facebook'], scheduledAt: future })).status, 400);
    assert.equal((await client.post('/api/scheduled-posts', { message: 'hi', targets: [], scheduledAt: future })).status, 400);
    assert.equal((await client.post('/api/scheduled-posts', { message: 'hi', targets: ['linkedin'], scheduledAt: future })).status, 400);
    assert.equal((await client.post('/api/scheduled-posts', { message: 'hi', targets: ['facebook'], scheduledAt: new Date(Date.now() - 1000).toISOString() })).status, 400);

    // No Meta connection on this fresh tenant — a well-formed request is
    // still rejected, with a clear reason rather than silently queuing a
    // post that can never actually send.
    const noConn = await client.post('/api/scheduled-posts', { message: 'hi', targets: ['facebook'], scheduledAt: future });
    assert.equal(noConn.status, 400);
    const noConnBody = await noConn.json();
    assert.match(noConnBody.error.message, /no facebook\/instagram account connected/i);
  });

  test('list only returns the caller\'s own tenant, and cancel only touches still-pending rows', async () => {
    const clientA = makeClient();
    const signupA = await clientA.post('/api/auth/signup', {
      email: uniqueEmail('schedA'), password: 'TestPass1234!', companyName: 'Sched Tenant A', industry: 'home_services', acceptedTerms: true
    });
    const tenantA = (await signupA.json()).tenantId;
    trackTenant(tenantA);

    const clientB = makeClient();
    const signupB = await clientB.post('/api/auth/signup', {
      email: uniqueEmail('schedB'), password: 'TestPass1234!', companyName: 'Sched Tenant B', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signupB.json()).tenantId);

    const pool = getTestPool();
    let pendingId, sentId;
    try {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const pending = await pool.query(
        `INSERT INTO scheduled_posts (tenant_id, message, targets, scheduled_at, status) VALUES ($1, 'pending post', '["facebook"]', $2, 'pending') RETURNING id`,
        [tenantA, future]
      );
      pendingId = pending.rows[0].id;
      const sent = await pool.query(
        `INSERT INTO scheduled_posts (tenant_id, message, targets, scheduled_at, status) VALUES ($1, 'already sent', '["facebook"]', $2, 'sent') RETURNING id`,
        [tenantA, future]
      );
      sentId = sent.rows[0].id;
    } finally {
      await pool.end();
    }

    // Tenant B can't see or cancel tenant A's scheduled posts.
    const bList = await (await clientB.get('/api/scheduled-posts')).json();
    assert.deepEqual(bList.posts, []);
    assert.equal((await clientB.delete('/api/scheduled-posts/' + pendingId)).status, 404);

    const aList = await (await clientA.get('/api/scheduled-posts?status=pending')).json();
    assert.equal(aList.posts.length, 1);
    assert.equal(aList.posts[0].id, pendingId);

    // Only the still-pending row can be canceled — a sent one 404s rather
    // than silently flipping status on something already fired.
    assert.equal((await clientA.delete('/api/scheduled-posts/' + sentId)).status, 404);
    assert.equal((await clientA.delete('/api/scheduled-posts/' + pendingId)).status, 200);
    assert.equal((await clientA.delete('/api/scheduled-posts/' + pendingId)).status, 404); // already canceled, not pending anymore
  });
});

describe('malformed request bodies return clean JSON, not an HTML error page', () => {
  test('malformed JSON body on signup returns 400 JSON', async () => {
    const client = makeClient();
    const r = await client.raw('/api/auth/signup', { method: 'POST', body: '{not valid json' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error.message, /malformed json/i);
  });
});

describe('pipeline (CRM)', () => {
  async function signup(label, product = 'crm') {
    const client = makeClient();
    const r = await client.post('/api/auth/signup', {
      email: uniqueEmail(label), password: 'TestPass1234!', companyName: 'CRM Co', industry: 'home_services', acceptedTerms: true, product
    });
    const body = await r.json();
    trackTenant(body.tenantId);
    client.tenantId = body.tenantId;
    return client;
  }

  test('the CRM is its own product: a CRM signup lands in /crm, not the marketing dashboard', async () => {
    const client = await signup('crm-only');
    const me = await (await client.get('/api/crm/me')).json();
    assert.deepEqual(me.products, ['crm']);
    const home = await client.get('/marketing');
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/crm/app');
    assert.equal((await client.get('/crm/app')).status, 200);
    assert.equal((await makeClient().get('/crm/app')).headers.get('location'), '/crm/login');
  });

  test('marketing logins and CRM logins are separate', async () => {
    const mkt = await signup('mkt-only', 'marketing');
    assert.equal((await mkt.get('/api/crm/pipeline')).status, 401, 'a marketing login never opens the CRM');
    assert.equal((await mkt.get('/crm/app')).headers.get('location'), '/crm/login?marketing=1');
    assert.equal((await mkt.post('/api/crm/activate', {})).status, 410);
    // The same email can have its own CRM account, with its own password.
    const pool = getTestPool();
    let email;
    try { email = (await pool.query('SELECT email FROM users WHERE tenant_id = $1', [mkt.tenantId])).rows[0].email; } finally { await pool.end(); }
    const crm = makeClient();
    const r = await crm.post('/api/crm-auth/signup', { type: 'company', companyName: 'Same Person Builders', name: 'Sam Same', email, password: 'CrmPass12345!', acceptedTerms: true });
    assert.equal(r.status, 200);
    trackTenant(await getTenantOf(email, 'crm'));
    assert.equal((await crm.get('/api/crm/pipeline')).status, 200);
    assert.equal((await crm.get('/api/leads')).status, 403, 'and the CRM login doesn’t open marketing');
    assert.equal((await makeClient().post('/api/crm-auth/login', { email, password: 'TestPass1234!' })).status, 401, 'the marketing password doesn’t open the CRM');
    assert.equal((await makeClient().post('/api/auth/login', { email, password: 'CrmPass12345!' })).status, 401, 'nor the other way');
    assert.equal((await makeClient().post('/api/auth/login', { email, password: 'TestPass1234!' })).status, 200);
  });

  test('company details for email footers can be saved', async () => {
    const client = await signup('crm-co');
    assert.equal((await client.patch('/api/crm/company', { address: 'short' })).status, 400);
    assert.equal((await client.patch('/api/crm/company', { companyName: 'Levi Test', phone: '713-555-0100', address: '1001 S Dairy Ashford, Houston TX 77077' })).status, 200);
    const { company } = await (await client.get('/api/crm/company')).json();
    assert.equal(company.company_name, 'Levi Test');
    assert.match(company.address, /Dairy Ashford/);
  });

  test('pipeline routes require a login', async () => {
    const r = await makeClient().get('/api/crm/pipeline');
    assert.equal(r.status, 401);
  });

  test('a deal can be added, moved and noted, and the timeline records each step', async () => {
    const client = await signup('crm');
    const add = await client.post('/api/crm/deals', { name: 'Pat Doe', email: 'pat@example.test', title: 'Primary bath', value: '65k', source: 'referral' });
    assert.equal(add.status, 200);
    const { deal } = await add.json();
    assert.equal(deal.stage, 'new');
    assert.equal(Number(deal.value), 65000);

    const moved = await client.patch(`/api/crm/deals/${deal.id}`, { stage: 'proposal' });
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).deal.stage, 'proposal');
    assert.equal((await client.post(`/api/crm/deals/${deal.id}/notes`, { body: 'Walked the house.' })).status, 200);

    const detail = await (await client.get(`/api/crm/deals/${deal.id}`)).json();
    const kinds = detail.activities.map(a => a.kind);
    assert.ok(kinds.includes('stage') && kinds.includes('note'));
    // No playbook is approved yet, so nothing is scheduled.
    assert.equal(detail.automations.length, 0);

    const pipe = await (await client.get('/api/crm/pipeline')).json();
    assert.equal(pipe.counts.proposal, 1);
  });

  test('input is checked', async () => {
    const client = await signup('crm-bad');
    assert.equal((await client.post('/api/crm/deals', { name: '' })).status, 400);
    assert.equal((await client.post('/api/crm/deals', { name: 'X', email: 'nope' })).status, 400);
    assert.equal((await client.post('/api/crm/deals', { name: 'X', value: 'lots' })).status, 400);
    assert.equal((await client.post('/api/crm/deals', { name: 'X', stage: 'made_up' })).status, 400);
  });

  test('playbooks start off, need approval, and lose it when the wording changes', async () => {
    const client = await signup('crm-pb');
    const list = (await (await client.get('/api/crm/playbooks')).json()).playbooks;
    assert.equal(list.length, 13);
    assert.ok(list.every(p => !p.enabled && !p.approved));
    const p = list.find(x => x.key === 'proposal_follow_up');
    assert.equal((await client.post(`/api/crm/playbooks/${p.id}/enabled`, { enabled: true })).status, 400);
    assert.equal((await client.post(`/api/crm/playbooks/${p.id}/approve`, {})).status, 200);
    let now = (await (await client.get('/api/crm/playbooks')).json()).playbooks.find(x => x.id === p.id);
    assert.equal(now.enabled && now.approved, true);
    const steps = now.steps.map(s => ({ ...s }));
    steps[0].message += ' Thanks!';
    assert.equal((await client.put(`/api/crm/playbooks/${p.id}`, { steps })).status, 200);
    now = (await (await client.get('/api/crm/playbooks')).json()).playbooks.find(x => x.id === p.id);
    assert.equal(now.enabled, false);
    assert.equal(now.approved, false);
  });

  test("tenant A cannot read or change tenant B's deal", async () => {
    const a = await signup('crm-a');
    const b = await signup('crm-b');
    const { deal } = await (await b.post('/api/crm/deals', { name: 'B only' })).json();
    assert.equal((await a.get(`/api/crm/deals/${deal.id}`)).status, 404);
    assert.equal((await a.patch(`/api/crm/deals/${deal.id}`, { stage: 'lost' })).status, 404);
    assert.equal((await a.delete(`/api/crm/deals/${deal.id}`)).status, 404);
    const pipeA = await (await a.get('/api/crm/pipeline')).json();
    assert.equal(pipeA.deals.length, 0);
  });
});

async function getTenantOf(email, app) {
  const pool = getTestPool();
  try { return ((await pool.query('SELECT tenant_id FROM users WHERE lower(email) = lower($1) AND app = $2', [email, app])).rows[0] || {}).tenant_id; } finally { await pool.end(); }
}

describe('CRM accounts: create a company, join one, homeowners and subs', () => {
  const pw = 'AcctPass1234!';
  const made = [];
  after(async () => {
    const pool = getTestPool();
    try { await pool.query('DELETE FROM crm_accounts WHERE lower(email) = ANY($1::text[])', [made.map(e => e.toLowerCase())]); } finally { await pool.end(); }
  });
  // Taps the "confirm your email" link of a join request (the token is set here, as the email would carry it).
  async function confirmJoin(client, email) {
    const token = require('crypto').randomBytes(32).toString('hex');
    const pool = getTestPool();
    try { await pool.query(`UPDATE crm_join_requests SET confirm_token_hash = $2 WHERE lower(email) = lower($1) AND status = 'pending'`, [email, require('crypto').createHash('sha256').update(token).digest('hex')]); } finally { await pool.end(); }
    return client.get('/crm/join-confirm?token=' + token);
  }
  async function company() {
    const c = makeClient();
    const email = uniqueEmail('acct-owner');
    const r = await c.post('/api/crm-auth/signup', { type: 'company', companyName: 'Acct Builders', name: 'Olga Owner', phone: '713-555-0100', email, password: pw, acceptedTerms: true });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).go, '/crm/app');
    c.tenantId = await getTenantOf(email, 'crm'); trackTenant(c.tenantId);
    c.email = email;
    return c;
  }

  test('creating a company makes you its owner and starts the guided setup', async () => {
    const c = await company();
    const me = await (await c.get('/api/crm/me')).json();
    assert.equal(me.role, 'owner'); assert.equal(me.companyName, 'Acct Builders'); assert.equal(me.name, 'Olga Owner');
    assert.equal(me.needsSetup, true);
    assert.equal((await c.post('/api/crm-auth/signup', { type: 'company', companyName: 'Again', name: 'O', email: c.email, password: pw, acceptedTerms: true })).status, 409);
    assert.equal((await makeClient().post('/api/crm-auth/signup', { type: 'company', companyName: 'X', name: 'X', email: uniqueEmail('x'), password: pw })).status, 400, 'terms must be ticked');
    assert.equal((await c.post('/api/crm/setup/done', {})).status, 200);
    assert.equal((await (await c.get('/api/crm/me')).json()).needsSetup, false);
    assert.equal((await c.patch('/api/crm/me', { phone: '12' })).status, 400);
  });

  test('joining with the company code waits for the owner, who picks the role', async () => {
    const c = await company();
    const { code, requests } = await (await c.get('/api/crm/join-code')).json();
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/); assert.equal(requests.length, 0);
    assert.equal((await (await makeClient().get('/api/crm-auth/company-code?code=' + code.toLowerCase().replace('-', ''))).json()).companyName, 'Acct Builders');
    assert.equal((await makeClient().get('/api/crm-auth/company-code?code=ZZZZ-ZZZZ')).status, 404);
    const email = uniqueEmail('acct-joiner');
    const j = makeClient();
    const r = await (await j.post('/api/crm-auth/signup', { type: 'join', code, name: 'Jo Joiner', email, password: pw, note: 'New super', acceptedTerms: true })).json();
    assert.equal(r.pending, true); assert.equal(r.confirm, true); assert.equal(r.companyName, 'Acct Builders');
    assert.equal((await j.get('/api/crm/me')).status, 401, 'not in yet');
    // Not shown to the owner until the email is confirmed.
    assert.equal((await (await c.get('/api/crm/join-code')).json()).requests.length, 0);
    const early = await makeClient().post('/api/crm-auth/login', { email, password: pw });
    assert.equal(early.status, 403); assert.match((await early.json()).error.message, /Confirm your email first/);
    assert.equal((await makeClient().get('/crm/join-confirm?token=' + 'a'.repeat(64))).headers.get('location').startsWith('/crm/login?google_error='), true);
    const conf = await confirmJoin(makeClient(), email);
    assert.match(conf.headers.get('location'), /^\/crm\/login\?pending=Acct%20Builders&confirmed=1$/);
    const login = await makeClient().post('/api/crm-auth/login', { email, password: pw });
    assert.equal(login.status, 403); assert.match((await login.json()).error.message, /waiting for the owner/);
    const today = await (await c.get('/api/crm/today')).json();
    assert.ok(today.inbox.some(i => /Jo Joiner asked to join/.test(i.title)), 'the owner sees it in Today');
    const reqs = (await (await c.get('/api/crm/join-code')).json()).requests;
    assert.equal(reqs.length, 1); assert.equal(reqs[0].note, 'New super');
    const ownerId = (await (await c.get('/api/crm/me')).json()).userId;
    assert.equal((await c.post('/api/crm/join-requests/' + reqs[0].id, { approve: true, role: 'superintendent', reportsTo: ownerId })).status, 200);
    const s = makeClient();
    const ok = await (await s.post('/api/crm-auth/login', { email, password: pw })).json();
    assert.equal(ok.go, '/crm/app');
    const me = await (await s.get('/api/crm/me')).json();
    assert.equal(me.role, 'superintendent'); assert.equal(me.needsSetup, true, 'their own short setup');
    assert.equal((await s.get('/api/crm/join-code')).status, 403, 'only the owner or an admin sees the code');
    // A fresh code stops the old one working.
    const fresh = (await (await c.post('/api/crm/join-code/new', {})).json()).code;
    assert.notEqual(fresh, code);
    assert.equal((await makeClient().get('/api/crm-auth/company-code?code=' + code)).status, 404);
  });

  test('an invited person who uses the company code goes in with their invitation’s role once their email is confirmed, and nobody else can claim it', async () => {
    const c = await company();
    const email = uniqueEmail('acct-invited');
    await c.post('/api/crm/team/invites', { email, name: 'Ivy', role: 'office' });
    const { code } = await (await c.get('/api/crm/join-code')).json();
    // Someone who knows the code and Ivy's email picks a password: nothing happens without Ivy's inbox.
    const thief = makeClient();
    const t1 = await (await thief.post('/api/crm-auth/signup', { type: 'join', code, name: 'Not Ivy', email, password: 'ThiefPass123!', acceptedTerms: true })).json();
    assert.equal(t1.pending, true); assert.equal(t1.confirm, true);
    assert.equal((await thief.get('/api/crm/me')).status, 401);
    assert.equal((await makeClient().post('/api/crm-auth/login', { email, password: 'ThiefPass123!' })).status, 403);
    // Ivy asks with her own password (which replaces the thief's), and taps the link in her email.
    await makeClient().post('/api/crm-auth/signup', { type: 'join', code, name: 'Ivy Invited', email, password: pw, acceptedTerms: true });
    const j = makeClient();
    const conf = await confirmJoin(j, email);
    assert.equal(conf.headers.get('location'), '/crm/app');
    assert.equal((await (await j.get('/api/crm/me')).json()).role, 'office');
    assert.equal((await makeClient().post('/api/crm-auth/login', { email, password: 'ThiefPass123!' })).status, 401, 'the thief’s password never worked');
    assert.equal((await makeClient().post('/api/crm-auth/login', { email, password: pw })).status, 200);
  });

  test('the quick setup routes: Google sign-up, the whole team at once, one-tap emails, and who may use them', async () => {
    const c = await company();
    // Without Google set up on this server, the Google button says so plainly.
    const g = await makeClient().post('/api/crm-auth/google/start', { type: 'homeowner', acceptedTerms: true });
    assert.ok([200, 503].includes(g.status));
    assert.equal((await makeClient().post('/api/crm-auth/google/start', { type: 'homeowner' })).status, 400, 'terms first');
    // A Google return that isn't a sign-up still needs a session.
    assert.equal((await makeClient().get('/api/crm/google/oauth/callback?state=' + 'a'.repeat(48) + '&code=x')).status, 401);
    // The whole team at once.
    const bulk = await (await c.post('/api/crm/team/invites/bulk', { text: `Pat P, ${uniqueEmail('bulk1')}\n${uniqueEmail('bulk2')}`, role: 'sales' })).json();
    assert.equal(bulk.sent, 2);
    const t = await (await c.get('/api/crm/team')).json();
    assert.equal(t.invites.length, 2); assert.ok(t.invites.every(i => i.role === 'sales'));
    // One-tap emails.
    const { emails } = await (await c.get('/api/crm/setup/emails')).json();
    assert.ok(emails.length >= 6);
    const on = await (await c.post('/api/crm/setup/emails', { ids: emails.map(e => e.id) })).json();
    assert.equal(on.on, emails.length); assert.equal(on.waitingForAddress, true);
    // Without Gmail connected, nothing is scanned.
    assert.equal((await (await c.get('/api/crm/setup/from-email')).json()).connected, false);
    // The phone-calendar link a QR code points to.
    const daily = await (await c.get('/api/crm/me/daily')).json();
    assert.match(daily.phoneUrl, /\/cal\/[0-9a-f]{48}\/add$/);
    const iphone = await makeClient().raw(new URL(daily.phoneUrl).pathname, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
    assert.match(iphone.headers.get('location'), /^webcal:\/\/.+\.ics$/);
    const android = await makeClient().raw(new URL(daily.phoneUrl).pathname, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14)' } });
    assert.match(android.headers.get('location'), /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal/);
    // A sales person can't invite the team or switch emails on.
    const email = uniqueEmail('quick-sales');
    const inv = await (await c.post('/api/crm/team/invites', { email, name: 'S', role: 'sales' })).json();
    const s = makeClient();
    await s.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'S', password: pw });
    assert.equal((await s.post('/api/crm/team/invites/bulk', { text: uniqueEmail('x') })).status, 403);
    assert.equal((await s.get('/api/crm/setup/emails')).status, 403);
    assert.equal((await s.post('/api/crm/setup/from-email', { subs: [{ email: 'a@b.test', name: 'A' }] })).status, 403, 'adding subs needs that permission');
  });

  test('saying no to a join request', async () => {
    const c = await company();
    const { code } = await (await c.get('/api/crm/join-code')).json();
    const email = uniqueEmail('acct-stranger');
    await makeClient().post('/api/crm-auth/signup', { type: 'join', code, name: 'Stranger', email, password: pw, acceptedTerms: true });
    await confirmJoin(makeClient(), email);
    const id = (await (await c.get('/api/crm/join-code')).json()).requests[0].id;
    assert.equal((await c.post('/api/crm/join-requests/' + id, { approve: false })).status, 200);
    assert.equal((await makeClient().post('/api/crm-auth/login', { email, password: pw })).status, 401);
    assert.equal((await c.post('/api/crm/join-requests/' + id, { approve: true })).status, 404, 'decided once');
  });

  test('a homeowner sees their projects from every builder once their email is confirmed', async () => {
    const c = await company();
    const email = uniqueEmail('acct-home'); made.push(email);
    const { deal } = await (await c.post('/api/crm/deals', { name: 'Hana Home', email, title: 'Hana kitchen' })).json();
    const h = makeClient();
    const r = await (await h.post('/api/crm-auth/signup', { type: 'homeowner', name: 'Hana Home', email, password: pw, acceptedTerms: true })).json();
    assert.equal(r.go, '/crm/home');
    assert.equal((await h.get('/api/crm/me')).status, 401, 'a homeowner never gets into a company’s CRM');
    assert.equal((await h.get('/crm/app')).headers.get('location'), '/crm/home');
    let home = await (await h.get('/api/crm-account')).json();
    assert.equal(home.account.kind, 'homeowner'); assert.equal(home.projects.length, 0, 'nothing until the email is confirmed');
    // Confirm the email (the token from the database stands in for the emailed link).
    const pool = getTestPool();
    const token = require('crypto').randomBytes(32).toString('hex');
    try { await pool.query('UPDATE crm_accounts SET verify_token_hash = $2 WHERE lower(email) = lower($1)', [email, require('crypto').createHash('sha256').update(token).digest('hex')]); } finally { await pool.end(); }
    assert.equal((await h.get('/crm/verify?token=' + token)).headers.get('location'), '/crm/home?confirmed=1');
    home = await (await h.get('/api/crm-account')).json();
    assert.equal(home.projects.length, 1); assert.equal(home.projects[0].title, 'Hana kitchen'); assert.equal(home.projects[0].builder, 'Acct Builders');
    assert.match(home.projects[0].url, /\/p\/[0-9a-f]{48}$/);
    assert.equal((await makeClient().get(home.projects[0].url.replace(/^https?:\/\/[^/]+/, ''))).status, 200);
    assert.equal((await h.patch('/api/crm-account', { phone: '713-555-0199', address: '9 Elm St, Houston TX', done: true })).status, 200);
    assert.ok((await (await h.get('/api/crm-account')).json()).account.setup_done_at);
    assert.equal((await h.patch('/api/crm-account', { phone: '5' })).status, 400);
    // Forgot password: the reset link works for a homeowner's account too.
    const resetToken = require('crypto').randomBytes(32).toString('hex');
    const pool2 = getTestPool();
    try { await pool2.query(`INSERT INTO password_reset_tokens (account_id, token_hash, expires_at) SELECT id, $2, now() + interval '1 hour' FROM crm_accounts WHERE lower(email) = lower($1)`, [email, require('crypto').createHash('sha256').update(resetToken).digest('hex')]); } finally { await pool2.end(); }
    assert.equal((await makeClient().post('/api/auth/reset-password', { token: resetToken, newPassword: 'NewHomePass123!' })).status, 200);
    assert.equal((await makeClient().post('/api/crm-auth/login', { email, password: 'NewHomePass123!' })).status, 200);
    assert.equal((await makeClient().post('/api/auth/request-password-reset', { email, app: 'crm' })).status, 200);
    assert.equal((await makeClient().post('/api/auth/reset-password', { token: resetToken, newPassword: pw })).status, 400, 'a reset link works once');
    // Signing in again goes to the homeowner page; a wrong password doesn’t.
    assert.equal((await (await makeClient().post('/api/crm-auth/login', { email, password: 'NewHomePass123!' })).json()).go, '/crm/home');
    assert.equal((await makeClient().post('/api/crm-auth/login', { email, password: 'wrongwrong' })).status, 401);
    assert.ok(deal.id);
  });

  test('a sub sees their builders, links one by its page link, and fills in what builders are missing', async () => {
    const c = await company();
    const email = uniqueEmail('acct-sub'); made.push(email);
    const v = await (await c.post('/api/crm/vendors', { name: 'Sid Framing', email, trade: '' })).json();
    const vendorId = (v.vendor || v).id;
    const sb = makeClient();
    assert.equal((await sb.post('/api/crm-auth/signup', { type: 'sub', name: 'Sid', email, password: pw, acceptedTerms: true })).status, 400, 'a sub needs a business name');
    assert.equal((await sb.post('/api/crm-auth/signup', { type: 'sub', name: 'Sid', businessName: 'Sid Framing LLC', trade: 'Framing', email, password: pw, acceptedTerms: true })).status, 200);
    let home = await (await sb.get('/api/crm-account')).json();
    assert.equal(home.builders.length, 0, 'not confirmed yet');
    // A link the builder sent links that builder even before confirming.
    const page = await (await c.get(`/api/crm/vendors/${vendorId}/portal`)).json();
    const url = page.url || page.link;
    assert.equal((await sb.post('/api/crm-account/link', { url: 'https://x.test/p/' + 'a'.repeat(48) })).status, 400, 'a homeowner link isn’t a sub link');
    const lk = await (await sb.post('/api/crm-account/link', { url })).json();
    assert.equal(lk.linked, 'Acct Builders');
    home = await (await sb.get('/api/crm-account')).json();
    assert.equal(home.builders.length, 1); assert.equal(home.builders[0].builder, 'Acct Builders');
    const pool = getTestPool();
    try { await pool.query('UPDATE crm_accounts SET email_verified = true WHERE lower(email) = lower($1)', [email]); } finally { await pool.end(); }
    assert.equal((await sb.patch('/api/crm-account', { phone: '713-555-0142', trade: 'Framing', insuranceExpires: '2031-05-01', done: true })).status, 200);
    const vendors = (await (await c.get('/api/crm/vendors')).json()).vendors;
    const mine = vendors.find(x => x.id === vendorId);
    assert.equal(mine.trade, 'Framing', 'blank trade filled in'); assert.equal(mine.phone, '713-555-0142');
    assert.equal(String(mine.insurance_expires).slice(0, 10), '2031-05-01');
    // One email, two kinds of account: signing in asks which.
    const h = makeClient();
    await h.post('/api/crm-auth/signup', { type: 'homeowner', name: 'Sid', email, password: pw, acceptedTerms: true });
    const both = await (await makeClient().post('/api/crm-auth/login', { email, password: pw })).json();
    assert.deepEqual(both.choose.map(x => x.as).sort(), ['homeowner', 'sub']);
    assert.equal((await (await makeClient().post('/api/crm-auth/login', { email, password: pw, as: 'sub' })).json()).go, '/crm/home');
  });
});

describe('CRM team safety, money, homeowner and sub extras, help and errors', () => {
  const pw = 'SafePass1234!';
  const crypto = require('crypto');
  const sql = async (q, p) => { const pool = getTestPool(); try { return (await pool.query(q, p)).rows; } finally { await pool.end(); } };
  async function company(label) {
    const c = makeClient(); const email = uniqueEmail(label);
    await c.post('/api/crm-auth/signup', { type: 'company', companyName: 'Safe ' + label, name: 'Owner ' + label, email, password: pw, acceptedTerms: true });
    c.me = await (await c.get('/api/crm/me')).json(); c.email = email;
    c.tenantId = (await sql('SELECT tenant_id FROM users WHERE id = $1', [c.me.userId]))[0].tenant_id; trackTenant(c.tenantId);
    return c;
  }
  async function member(o, role, label = role) {
    const email = uniqueEmail('safe-' + label);
    const inv = await (await o.post('/api/crm/team/invites', { email, name: label + ' Person', role })).json();
    const m = makeClient();
    await m.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: label + ' Person', password: pw });
    m.me = await (await m.get('/api/crm/me')).json(); m.email = email;
    return m;
  }

  test('owners and admins need an emailed code on a new device, unless they trusted it', async () => {
    const o = await company('2fa');
    const c = makeClient();
    const first = await (await c.post('/api/crm-auth/login', { email: o.email, password: pw })).json();
    assert.equal(first.code, true); assert.match(first.to, /•/);
    assert.equal((await c.get('/api/crm/me')).status, 401, 'not in yet');
    assert.equal((await c.post('/api/crm-auth/login/code', { code: '000000' })).status, 400);
    const code = '482913';
    await sql(`UPDATE crm_login_codes SET code_hash = $2 WHERE user_id = $1 AND used_at IS NULL`, [o.me.userId, crypto.createHash('sha256').update(code).digest('hex')]);
    const ok = await c.raw('/api/crm-auth/login/code', { method: 'POST', body: JSON.stringify({ code, remember: true }) });
    assert.equal(ok.status, 200);
    const trust = (ok.headers.get('set-cookie') || '').match(/eagle_trust=([0-9a-f]{64})/);
    assert.ok(trust, 'a trusted-device cookie');
    assert.equal((await c.get('/api/crm/me')).status, 200);
    assert.equal((await c.post('/api/crm-auth/login/code', { code })).status, 400, 'a code works once');
    // The trusted device skips the code next time.
    const again = makeClient();
    const r2 = await again.raw('/api/crm-auth/login', { method: 'POST', body: JSON.stringify({ email: o.email, password: pw }), headers: { Cookie: 'eagle_trust=' + trust[1] } });
    assert.equal((await r2.json()).go, '/crm/app');
    // Team members don't get a code.
    const m = await member(o, 'member');
    assert.equal((await (await makeClient().post('/api/crm-auth/login', { email: m.email, password: pw })).json()).go, '/crm/app');
    // Five wrong codes and that code is done.
    const d = makeClient(); await d.post('/api/crm-auth/login', { email: o.email, password: pw });
    for (let i = 0; i < 5; i++) await d.post('/api/crm-auth/login/code', { code: '111111' });
    assert.match((await (await d.post('/api/crm-auth/login/code', { code: '111111' })).json()).error.message, /Too many wrong codes/);
    // Signing out everywhere else makes trusted devices ask again.
    await c.post('/api/crm/me/devices/sign-out-others', {});
    assert.equal((await sql('SELECT COUNT(*)::int AS n FROM crm_trusted_devices WHERE user_id = $1', [o.me.userId]))[0].n, 0);
    const log = (await (await c.get('/api/crm/activity-log')).json()).items;
    assert.ok(log.some(a => a.action === 'signed_in_new'));
  });

  test('turning someone off, handing over their work, and the activity log', async () => {
    const o = await company('off');
    const pm = await member(o, 'project_manager', 'pm');
    const sup = await member(o, 'superintendent', 'sup');
    await o.patch(`/api/crm/team/${sup.me.userId}`, { reportsTo: pm.me.userId });
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Handover Lead', email: 'ho@x.test' })).json();
    await o.patch(`/api/crm/deals/${deal.id}`, { ownerUserId: pm.me.userId });
    await sql('UPDATE crm_deals SET owner_user_id = $2 WHERE id = $1', [deal.id, pm.me.userId]);
    await o.post('/api/crm/tasks', { title: 'Order windows', assigneeUserId: pm.me.userId });
    // Turn off: signed out at once, can't sign in, keeps their login.
    assert.equal((await o.post(`/api/crm/team/${pm.me.userId}/active`, { on: false })).status, 200);
    const gone = await pm.get('/api/crm/pipeline');
    assert.equal(gone.status, 401);
    const back = await makeClient().post('/api/crm-auth/login', { email: pm.email, password: pw });
    assert.equal(back.status, 403); assert.match((await back.json()).error.message, /turned off/);
    assert.equal((await o.post(`/api/crm/team/${o.me.userId}/active`, { on: false })).status, 400, 'not the owner');
    // Hand over: deals, tasks and the people who reported to them.
    const ho = await (await o.post(`/api/crm/team/${pm.me.userId}/handover`, { to: o.me.userId })).json();
    assert.equal(ho.moved.deals, 1); assert.equal(ho.moved.tasks, 1); assert.equal(ho.moved.reports, 1);
    assert.equal((await sql('SELECT owner_user_id FROM crm_deals WHERE id = $1', [deal.id]))[0].owner_user_id, o.me.userId);
    assert.equal((await sql('SELECT reports_to FROM users WHERE id = $1', [sup.me.userId]))[0].reports_to, o.me.userId);
    assert.equal((await o.post(`/api/crm/team/${sup.me.userId}/handover`, { to: pm.me.userId })).status, 400, 'not to someone turned off');
    // Back on.
    assert.equal((await o.post(`/api/crm/team/${pm.me.userId}/active`, { on: true })).status, 200);
    assert.equal((await makeClient().post('/api/crm-auth/login', { email: pm.email, password: pw })).status, 200);
    // Everything above is in the log, newest first; only people who manage the team see it.
    await o.patch(`/api/crm/team/${sup.me.userId}`, { permissions: { money: true } });
    const log = (await (await o.get('/api/crm/activity-log')).json()).items;
    for (const a of ['turned_off', 'turned_on', 'handover', 'reports_to', 'permissions']) assert.ok(log.some(x => x.action === a), a);
    assert.match(log.find(x => x.action === 'permissions').detail, /can now: see money/);
    const mine = (await (await o.get('/api/crm/activity-log?person=' + pm.me.userId)).json()).items;
    assert.ok(mine.length && mine.every(x => x.target_id === pm.me.userId || x.actor_id === pm.me.userId));
    assert.equal((await sup.get('/api/crm/activity-log')).status, 403);
  });

  test('without See money: no deal values, no payments on the calendar, no prices on a job', async () => {
    const o = await company('money');
    const sup = await member(o, 'superintendent', 'nomoney');
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Money Lead', email: 'ml@x.test', value: '85k' })).json();
    const pipe = await (await sup.get('/api/crm/pipeline')).json();
    assert.equal(pipe.moneyHidden, true); assert.equal(pipe.openValue, null);
    assert.equal(pipe.deals.find(d => d.id === deal.id).value, null);
    assert.equal(Number((await (await o.get('/api/crm/pipeline')).json()).deals.find(d => d.id === deal.id).value), 85000, 'the owner still sees it');
    assert.equal((await (await sup.get(`/api/crm/deals/${deal.id}`)).json()).deal.value, null);
    const sum = (await (await sup.get('/api/crm/summary')).json()).summary;
    assert.ok(!JSON.stringify(sum).match(/"(signedValue|openValue)":\d/), 'no money in the weekly numbers');
    const job = await (await sup.get(`/api/crm/deals/${deal.id}/job`)).json();
    assert.equal(job.moneyHidden, true);
    await o.post(`/api/crm/deals/${deal.id}/invoices`, { title: 'Deposit', amount: 5000, dueDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) });
    const day = new Date().toISOString().slice(0, 10);
    const ownerCal = await (await o.get(`/api/crm/calendar?who=all&from=${day}&to=${day}`)).json();
    const supCal = await (await sup.get(`/api/crm/calendar?who=all&from=${day}&to=${day}`)).json();
    assert.ok(!supCal.items.some(i => i.type === 'money'), 'no payments on their calendar');
    assert.ok(ownerCal.items.every(i => i.type !== 'money' || /Payment due/.test(i.title)));
    // Dollar figures written in the deal's history and in the jobs list come out too.
    const hist = await (await sup.get(`/api/crm/deals/${deal.id}`)).json();
    assert.ok(!/\$\d/.test(JSON.stringify(hist)), 'no dollar amounts in the deal or its history');
    assert.ok(/\$\d/.test(JSON.stringify(await (await o.get(`/api/crm/deals/${deal.id}`)).json())), 'the owner still sees them');
    assert.ok(!/\$\d/.test(JSON.stringify(await (await sup.get('/api/crm/marketing')).json())));
    const big = await o.raw('/api/crm-account/insurance', { method: 'POST', body: JSON.stringify({ dataBase64: 'x'.repeat(13 * 1024 * 1024) }) });
    assert.equal(big.status, 413, 'too big is a plain answer, not a server error');
    const found = await (await sup.get('/api/crm/search?q=Deposit')).json();
    assert.ok(!found.results.some(r => r.type === 'invoice'), 'no invoices in their search');
  });

  test('homeowner and sub extras: waiting list always; invites, notices and insurance only once switched on', async () => {
    const o = await company('extras');
    const hEmail = uniqueEmail('extras-home');
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Hal Home', email: hEmail, title: 'Hal kitchen' })).json();
    await o.patch('/api/crm/company', { address: '1001 S Dairy Ashford, Houston TX 77077' });
    await o.post(`/api/crm/deals/${deal.id}/invoices`, { title: 'Deposit', amount: 2500, send: true });
    const inv = (await sql('SELECT id FROM crm_invoices WHERE deal_id = $1', [deal.id]))[0];
    await sql(`UPDATE crm_invoices SET status = 'sent', sent_at = now() WHERE id = $1`, [inv.id]);
    // Invitations are off until switched on.
    const st = await (await o.get(`/api/crm/deals/${deal.id}/account-invite`)).json();
    assert.equal(st.on, false); assert.equal(st.hasAccount, false);
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/account-invite`, {})).status, 400);
    const f = await (await o.get('/api/crm/account-features')).json();
    assert.deepEqual(f.features, { invites: false, notices: false, insurance: false });
    const sales = await member(o, 'sales', 'feat');
    assert.equal((await sales.patch('/api/crm/account-features', { invites: true })).status, 403);
    assert.equal((await o.patch('/api/crm/account-features', { invites: true, notices: true, insurance: true, junk: true })).status, 200);
    // (No email on the test server: it says so plainly instead of failing.)
    const sentInv = await o.post(`/api/crm/deals/${deal.id}/account-invite`, {});
    assert.ok([200, 503].includes(sentInv.status), String(sentInv.status));
    if (sentInv.status === 503) assert.match((await sentInv.json()).error.message, /couldn’t be sent/);
    // The homeowner makes an account and confirms: the invoice waits for them.
    const h = makeClient();
    await h.post('/api/crm-auth/signup', { type: 'homeowner', name: 'Hal Home', email: hEmail, password: pw, acceptedTerms: true });
    await sql('UPDATE crm_accounts SET email_verified = true WHERE lower(email) = lower($1)', [hEmail]);
    const home = await (await h.get('/api/crm-account')).json();
    assert.equal(home.waiting.length, 1); assert.equal(home.waiting[0].kind, 'invoice'); assert.match(home.waiting[0].url, /^\/i\//); assert.match(home.waiting[0].detail, /\$2,500/);
    assert.equal((await (await o.get(`/api/crm/deals/${deal.id}/account-invite`)).json()).hasAccount, true);
    // An update posted (not emailed) tells them once.
    await o.post(`/api/crm/deals/${deal.id}/updates`, { body: 'Cabinets arrive Thursday.' });
    await o.post(`/api/crm/deals/${deal.id}/updates`, { body: 'Tile next week.' });
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await sql(`SELECT COUNT(*)::int AS n FROM crm_account_notices n JOIN crm_accounts a ON a.id = n.account_id WHERE lower(a.email) = lower($1)`, [hEmail]))[0].n, 1, 'one notice, not two');
    // A sub uploads insurance; the builder sees it.
    const sEmail = uniqueEmail('extras-sub');
    const v = (await (await o.post('/api/crm/vendors', { name: 'Ins Tile', email: sEmail })).json()).vendor;
    const sb = makeClient();
    await sb.post('/api/crm-auth/signup', { type: 'sub', name: 'Ivan', businessName: 'Ins Tile', email: sEmail, password: pw, acceptedTerms: true });
    await sql('UPDATE crm_accounts SET email_verified = true WHERE lower(email) = lower($1)', [sEmail]);
    assert.deepEqual((await (await sb.get('/api/crm-account')).json()).insurance.builders, ['Safe extras']);
    const pdf = Buffer.from('%PDF-1.4 fake certificate').toString('base64');
    assert.equal((await sb.post('/api/crm-account/insurance', { filename: 'coi.pdf', dataBase64: Buffer.from('not a pdf').toString('base64'), expires: '2031-01-01' })).status, 400);
    assert.equal((await sb.post('/api/crm-account/insurance', { filename: 'coi.pdf', dataBase64: pdf, expires: '2020-01-01' })).status, 400, 'not an old one');
    assert.equal((await sb.post('/api/crm-account/insurance', { filename: 'coi.pdf', dataBase64: pdf, expires: '2031-01-01' })).status, 200);
    const cert = (await (await o.get(`/api/crm/vendors/${v.id}/insurance`)).json()).certificate;
    assert.equal(String(cert.expires).slice(0, 10), '2031-01-01');
    const file = await o.get(`/api/crm/vendors/${v.id}/insurance/file`);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.equal(String((await sql('SELECT insurance_expires FROM crm_vendors WHERE id = $1', [v.id]))[0].insurance_expires.toISOString()).slice(0, 10), '2031-01-01');
    // Switched off again: the builder no longer sees certificates.
    await o.patch('/api/crm/account-features', { insurance: false });
    assert.equal((await (await o.get(`/api/crm/vendors/${v.id}/insurance`)).json()).certificate, null);
  });

  test('the pop-up tips remember what each person has seen, on any device, and can be turned off or back on', async () => {
    const o = await company('tips');
    assert.deepEqual((await (await o.get('/api/crm/me')).json()).tips, { seen: [], off: false });
    await o.post('/api/crm/me/tips', { seen: 'pipeline' });
    await o.post('/api/crm/me/tips', { seen: 'pipeline' });
    await o.post('/api/crm/me/tips', { seen: 'deal' });
    assert.equal((await o.post('/api/crm/me/tips', { seen: '<script>' })).status, 200);
    assert.deepEqual((await (await o.get('/api/crm/me')).json()).tips, { seen: ['pipeline', 'deal'], off: false }, 'once each, junk ignored');
    await o.post('/api/crm/me/tips', { off: true });
    assert.equal((await (await o.get('/api/crm/me')).json()).tips.off, true);
    await o.post('/api/crm/me/tips', { reset: true });
    assert.deepEqual((await (await o.get('/api/crm/me')).json()).tips, { seen: [], off: false });
    const h = makeClient();
    await h.post('/api/crm-auth/signup', { type: 'homeowner', name: 'Tia', email: uniqueEmail('tips-home'), password: pw, acceptedTerms: true });
    assert.equal((await h.post('/api/crm-account/tips', { seen: 'home' })).status, 200);
    assert.deepEqual((await (await h.get('/api/crm-account')).json()).account.tips, { seen: ['home'], off: false });
    assert.equal((await makeClient().post('/api/crm/me/tips', { seen: 'x' })).status, 401);
  });

  test('help requests, and errors from people’s screens are kept', async () => {
    const o = await company('help');
    assert.equal((await o.post('/api/crm/help-request', {})).status, 400);
    assert.equal((await o.post('/api/crm/help-request', { phone: '713-555-0100', bestTime: 'Mornings', need: 'Importing from Buildertrend' })).status, 200);
    assert.equal((await sql('SELECT need FROM crm_help_requests WHERE tenant_id = $1', [o.tenantId]))[0].need, 'Importing from Buildertrend');
    const msg = 'TypeError: x is undefined ' + Date.now();
    await o.post('/api/crm/client-error', { message: msg, stack: 'at foo', screen: 'pipeline' });
    await new Promise(r => setTimeout(r, 300));
    const row = (await sql('SELECT source, path, user_id FROM crm_errors WHERE message = $1', [msg]))[0];
    assert.equal(row.source, 'browser'); assert.equal(row.path, 'pipeline'); assert.equal(row.user_id, o.me.userId);
    assert.equal((await makeClient().post('/api/crm/client-error', { message: 'x' })).status, 401);
  });
});

describe('CRM team', () => {
  async function owner() {
    const client = makeClient();
    const r = await client.post('/api/auth/signup', {
      email: uniqueEmail('team-owner'), password: 'TestPass1234!', companyName: 'Team Co', industry: 'home_services', acceptedTerms: true, product: 'crm'
    });
    trackTenant((await r.json()).tenantId);
    return client;
  }
  // RESEND_API_KEY is unset in tests, so the invite email fails and the link comes back to the inviter.
  async function inviteAndJoin(ownerClient, role) {
    const email = uniqueEmail('team-' + role);
    const inv = await ownerClient.post('/api/crm/team/invites', { email, name: 'Pat ' + role, role });
    assert.equal(inv.status, 200);
    const { inviteUrl, emailed } = await inv.json();
    assert.equal(emailed, false);
    const token = new URL(inviteUrl).searchParams.get('token');
    const info = await (await makeClient().get('/api/crm/join?token=' + token)).json();
    assert.equal(info.email, email.toLowerCase());
    const member = makeClient();
    const join = await member.post('/api/crm/join', { token, name: 'Pat ' + role, password: 'MemberPass123!' });
    assert.equal(join.status, 200);
    assert.equal((await makeClient().post('/api/crm/join', { token, name: 'X', password: 'MemberPass123!' })).status, 400, 'a link works once');
    return member;
  }

  test('an owner can invite a member, who joins and works deals but cannot manage the company', async () => {
    const o = await owner();
    const m = await inviteAndJoin(o, 'member');
    const me = await (await m.get('/api/crm/me')).json();
    assert.equal(me.role, 'member');
    assert.equal(me.canManage, false);
    assert.equal(me.hasMarketing, false);
    const add = await m.post('/api/crm/deals', { name: 'Member Lead' });
    assert.equal(add.status, 200);
    const { deal } = await add.json();
    assert.equal(deal.owner_user_id, me.userId, 'a deal you add is yours');
    assert.equal((await m.patch(`/api/crm/deals/${deal.id}`, { stage: 'qualified' })).status, 200);
    // Company-wide changes are for the owner and admins.
    assert.equal((await m.patch('/api/crm/company', { companyName: 'Hijack' })).status, 403);
    assert.equal((await m.post('/api/crm/team/invites', { email: uniqueEmail('x') })).status, 403);
    const pb = (await (await m.get('/api/crm/playbooks')).json()).playbooks[0];
    assert.equal((await m.post(`/api/crm/playbooks/${pb.id}/approve`, {})).status, 403);
    assert.equal((await m.patch('/api/crm/settings', { paused: true })).status, 403);
    assert.equal((await m.delete(`/api/crm/deals/${deal.id}`)).status, 403);
    // The marketing product is the owner's only.
    assert.equal((await m.get('/api/leads')).status, 403);
    const home = await m.get('/marketing');
    assert.equal(home.headers.get('location'), '/crm/app');
  });

  test('an admin can manage the team; nobody can remove the owner; a removed member is signed out', async () => {
    const o = await owner();
    const a = await inviteAndJoin(o, 'admin');
    const m = await inviteAndJoin(o, 'member');
    const t = await (await a.get('/api/crm/team')).json();
    assert.equal(t.members.length, 3);
    const ownerRow = t.members.find(x => x.role === 'owner');
    const memberRow = t.members.find(x => x.role === 'member');
    assert.equal((await a.delete(`/api/crm/team/${ownerRow.id}`)).status, 400);
    assert.equal((await a.patch(`/api/crm/team/${memberRow.id}`, { role: 'admin' })).status, 200);
    assert.equal((await a.patch(`/api/crm/team/${memberRow.id}`, { role: 'member' })).status, 200);
    assert.equal((await a.delete(`/api/crm/team/${memberRow.id}`)).status, 200);
    assert.equal((await m.get('/api/crm/pipeline')).status, 401);
  });

  test('new leads can be handed to a team member automatically', async () => {
    const o = await owner();
    const m = await inviteAndJoin(o, 'member');
    const memberId = (await (await m.get('/api/crm/me')).json()).userId;
    assert.equal((await o.patch('/api/crm/settings', { leadOwnerUserId: memberId })).status, 200);
    const pool = getTestPool();
    let slug;
    try {
      const tid = (await pool.query('SELECT tenant_id FROM users WHERE id = $1', [memberId])).rows[0].tenant_id;
      slug = `team-${tid.slice(0, 8)}`;
      await pool.query(`INSERT INTO landing_pages (tenant_id, slug, headline, status) VALUES ($1, $2, 'H', 'published')`, [tid, slug]);
    } finally { await pool.end(); }
    await makeClient().post(`/lp/${slug}/submit`, { name: 'Auto Assigned', email: 'auto@example.test' });
    let deal;
    for (let i = 0; i < 20 && !deal; i++) {
      const pipe = await (await o.get('/api/crm/pipeline')).json();
      deal = pipe.deals.find(d => d.contact_name === 'Auto Assigned');
      if (!deal) await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(deal, 'the form lead reached the pipeline');
    assert.equal(deal.owner_user_id, memberId);
  });

  test('roles and who reports to whom decide whose schedule people see, both ways', async () => {
    const o = await owner();
    const pm = await inviteAndJoin(o, 'project_manager');
    const pmId = (await (await pm.get('/api/crm/me')).json()).userId;
    // Invited straight under the project manager.
    const email = uniqueEmail('team-super');
    const inv = await (await o.post('/api/crm/team/invites', { email, name: 'Sam Super', role: 'superintendent', reportsTo: pmId })).json();
    const sup = makeClient();
    assert.equal((await sup.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'Sam Super', password: 'MemberPass123!' })).status, 200);
    const sales = await inviteAndJoin(o, 'sales');
    const me = async (c) => (await c.get('/api/crm/me')).json();
    const [ownerMe, supMe, salesMe] = [await me(o), await me(sup), await me(sales)];
    assert.equal(supMe.role, 'superintendent'); assert.equal(supMe.roleLabel, 'Superintendent'); assert.equal(supMe.canManage, false);

    const t = await (await pm.get('/api/crm/team')).json();
    assert.equal(t.members.find(m => m.id === supMe.userId).reports_to, pmId, 'joined reporting to the project manager');
    assert.deepEqual(t.me.below, [supMe.userId], 'the project manager has the superintendent under them');
    assert.ok(t.me.sees.includes(ownerMe.userId), 'and sees up to the owner');
    assert.ok(!t.me.sees.includes(salesMe.userId), 'but not someone outside their line');
    assert.ok(t.roles.some(r => r.key === 'office'));

    // Calendars: down the line, up the line, never sideways.
    const evOn = async (c, userId, title) => c.post('/api/crm/calendar/events', { title, date: '2031-03-04', time: '09:00', userId });
    assert.equal((await evOn(pm, supMe.userId, 'Walk the framing')).status, 200, 'a project manager plans for the people under them');
    assert.equal((await evOn(sup, pmId, 'Plan the boss’s day')).status, 403, 'but not the other way');
    assert.equal((await evOn(sales, supMe.userId, 'Sideways')).status, 403);
    await evOn(o, pmId, 'PM meeting with owner');
    const cal = async (c, who) => c.get(`/api/crm/calendar?from=2031-03-03&to=2031-03-05&who=${who}`);
    const titles = async (c, who) => (await (await cal(c, who)).json()).items.map(i => i.title);
    assert.ok((await titles(pm, supMe.userId)).includes('Walk the framing'), 'the project manager sees the superintendent’s calendar');
    assert.ok((await titles(sup, pmId)).includes('PM meeting with owner'), 'the superintendent sees the project manager’s, both ways');
    assert.equal((await cal(sales, supMe.userId)).status, 403, 'someone outside the line doesn’t');
    assert.equal((await cal(sales, pmId)).status, 403);
    const team = await titles(sup, 'all');
    assert.ok(team.includes('Walk the framing') && team.includes('PM meeting with owner'));
    assert.ok((await titles(o, supMe.userId)).includes('Walk the framing'), 'the owner sees everyone');

    // Today: the project manager's team tasks include the superintendent's.
    await o.post('/api/crm/tasks', { title: 'Order trusses', assigneeUserId: supMe.userId });
    const today = await (await pm.get('/api/crm/today?all=1')).json();
    assert.ok(today.tasks.some(x => x.title === 'Order trusses'));
    assert.ok(!(await (await sales.get('/api/crm/today?all=1')).json()).tasks.some(x => x.title === 'Order trusses'));

    // Reporting lines go up only; changing a role tidies lines that no longer make sense.
    assert.equal((await o.patch(`/api/crm/team/${pmId}`, { reportsTo: supMe.userId })).status, 400, 'can’t report to someone below you');
    assert.equal((await o.patch(`/api/crm/team/${salesMe.userId}`, { reportsTo: pmId })).status, 200);
    assert.ok((await (await sales.get('/api/crm/team')).json()).me.sees.includes(pmId));
    assert.equal((await o.patch(`/api/crm/team/${pmId}`, { role: 'sales' })).status, 200);
    const after = await (await o.get('/api/crm/team')).json();
    assert.equal(after.members.find(m => m.id === supMe.userId).reports_to, null, 'a superintendent can’t report to sales');
    assert.equal(after.members.find(m => m.id === salesMe.userId).reports_to, null);
    assert.equal((await pm.patch(`/api/crm/team/${salesMe.userId}`, { reportsTo: null })).status, 403, 'only the owner or an admin changes the team');
    assert.equal((await o.patch(`/api/crm/team/${salesMe.userId}`, { role: 'boss' })).status, 400);

    // The owner can let everyone see everyone's.
    assert.equal((await cal(sales, supMe.userId)).status, 403);
    assert.equal((await o.patch('/api/crm/team-settings', { visibility: 'everyone' })).status, 200);
    assert.equal((await cal(sales, supMe.userId)).status, 200);
    assert.equal((await sales.patch('/api/crm/team-settings', { visibility: 'chain' })).status, 403);
  });

  test('each role starts with default permissions, the owner adjusts them per person, and a new role starts over', async () => {
    const o = await owner();
    const sales = await inviteAndJoin(o, 'sales');
    const sMe = await (await sales.get('/api/crm/me')).json();
    assert.equal(sMe.perms.estimates, true); assert.equal(sMe.perms.money, false); assert.equal(sMe.perms.team, false);
    const { deal } = await (await sales.post('/api/crm/deals', { name: 'Perm Lead' })).json();
    // Sales defaults: estimates yes; money, invoices and subs no.
    assert.equal((await sales.post(`/api/crm/deals/${deal.id}/estimates`, {})).status, 200);
    const noMoney = await sales.get('/api/crm/invoices');
    assert.equal(noMoney.status, 403); assert.match((await noMoney.json()).error.message, /see money/);
    assert.equal((await sales.post('/api/crm/vendors', { name: 'Nope Framing' })).status, 403);
    // Capital letters and trailing slashes reach the same routes, so they're checked the same.
    assert.equal((await sales.post('/api/crm/VENDORS', { name: 'Nope Framing' })).status, 403);
    assert.equal((await sales.post(`/API/crm/deals/${deal.id}/INVOICES/`, { title: 'Deposit', amount: 100 })).status, 403);
    assert.equal((await sales.get('/api/crm/CashFlow')).status, 403);
    assert.equal((await sales.post(`/api/crm/deals/${deal.id}/invoices`, { title: 'Deposit', amount: 100 })).status, 403);

    // The owner adjusts the checklist: no estimates, but money.
    const t = await (await o.get('/api/crm/team')).json();
    assert.ok(t.perms.length >= 10 && t.defaults.sales.estimates === true);
    const row = t.members.find(m => m.id === sMe.userId);
    assert.equal(row.custom, false); assert.equal(row.permissions.estimates, true);
    assert.equal((await o.patch(`/api/crm/team/${sMe.userId}`, { permissions: { estimates: false, money: true } })).status, 200);
    assert.equal((await sales.post(`/api/crm/deals/${deal.id}/estimates`, {})).status, 403, 'takes effect at once');
    assert.equal((await sales.get('/api/crm/invoices')).status, 200);
    assert.equal((await (await o.get('/api/crm/team')).json()).members.find(m => m.id === sMe.userId).custom, true);
    // Changing the role starts over from the new role's defaults.
    assert.equal((await o.patch(`/api/crm/team/${sMe.userId}`, { role: 'office' })).status, 200);
    const after = (await (await o.get('/api/crm/team')).json()).members.find(m => m.id === sMe.userId);
    assert.equal(after.custom, false); assert.equal(after.permissions.estimates, false); assert.equal(after.permissions.invoices, true); assert.equal(after.permissions.data, true);
    // Back to the defaults.
    await o.patch(`/api/crm/team/${sMe.userId}`, { permissions: { billing: true } });
    assert.equal((await o.patch(`/api/crm/team/${sMe.userId}`, { permissions: null })).status, 200);
    assert.equal((await (await o.get('/api/crm/team')).json()).members.find(m => m.id === sMe.userId).custom, false);

    // Someone given "manage the team" can't give what they don't have, can't make admins, can't change their own.
    const ownerId = (await (await o.get('/api/crm/me')).json()).userId;
    await o.patch(`/api/crm/team/${sMe.userId}`, { permissions: { team: true } });
    const member = await inviteAndJoin(o, 'member');
    const mId = (await (await member.get('/api/crm/me')).json()).userId;
    assert.equal((await sales.patch(`/api/crm/team/${mId}`, { permissions: { billing: true } })).status, 403);
    assert.equal((await sales.patch(`/api/crm/team/${mId}`, { permissions: { money: false } })).status, 200, 'but can take away');
    assert.equal((await sales.patch(`/api/crm/team/${mId}`, { role: 'admin' })).status, 403);
    assert.equal((await sales.post('/api/crm/team/invites', { email: uniqueEmail('x'), role: 'admin' })).status, 403);
    assert.equal((await sales.patch(`/api/crm/team/${sMe.userId}`, { permissions: { billing: true } })).status, 400, 'not their own');
    assert.equal((await o.patch(`/api/crm/team/${ownerId}`, { permissions: { money: false } })).status, 400, 'the owner always has everything');
    // A team member keeps what members could always do.
    const mm = await (await member.get('/api/crm/me')).json();
    assert.equal(mm.perms.estimates && mm.perms.invoices && mm.perms.subs, true);
    assert.equal(mm.perms.money, false, 'taken away above');
    assert.equal(mm.perms.delete, false); assert.equal(mm.perms.emails, false);
  });

  test('an invite to someone who already has an account is refused', async () => {
    const o = await owner();
    const me = await (await o.get('/api/crm/me')).json();
    assert.equal((await o.post('/api/crm/team/invites', { email: me.email })).status, 409);
  });
});

describe('CRM estimates', () => {
  async function crmOwner(label) {
    const client = makeClient();
    const r = await client.post('/api/auth/signup', {
      email: uniqueEmail(label), password: 'TestPass1234!', companyName: 'Estimate Co', industry: 'home_services', acceptedTerms: true, product: 'crm'
    });
    trackTenant((await r.json()).tenantId);
    await client.patch('/api/crm/company', { address: '1001 S Dairy Ashford, Houston TX 77077' });
    return client;
  }

  test('an estimate is priced on the server, accepted online, and moves the deal to signed', async () => {
    const o = await crmOwner('est');
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Home Owner', email: 'ho@example.test', stage: 'site_visit' })).json();
    const { item } = await (await o.post('/api/crm/catalog', { name: 'Tile install', unit: 'sf', unit_cost: 8.5, markup_pct: 30, category: 'labor' })).json();
    const { estimate } = await (await o.post(`/api/crm/deals/${deal.id}/estimates`, { kind: 'construction' })).json();
    assert.equal(estimate.status, 'draft');
    assert.ok(estimate.number > 1000);
    const saved = await o.put(`/api/crm/estimates/${estimate.id}`, {
      title: 'Primary bath', kind: 'construction', default_markup_pct: 25, tax_pct: 0, deposit_pct: 10,
      // A total sent from the browser is ignored; the server works it out.
      total: 1, lines: [{ description: 'Demo', quantity: 1, unit: 'ls', unit_cost: 1000 }, { description: 'Tile', quantity: 100, unit: 'sf', unit_cost: 8.5, markup_pct: 30, catalog_item_id: item.id }]
    });
    assert.equal(saved.status, 200);
    assert.equal(Number((await saved.json()).estimate.total), 2355);

    const token = (await (await o.get(`/api/crm/estimates/${estimate.id}`)).json()).estimate.public_token;
    // Never sent: the public link shows nothing to anyone outside the company.
    assert.equal((await makeClient().get(`/api/crm-public/estimates/${token}`)).status, 404);
    // Sending needs email, which isn't configured in tests; mark it sent directly.
    const pool = getTestPool();
    try { await pool.query(`UPDATE crm_estimates SET status = 'sent', sent_at = now(), valid_until = CURRENT_DATE + 30 WHERE id = $1`, [estimate.id]); } finally { await pool.end(); }

    const homeowner = makeClient();
    const view = await (await homeowner.get(`/api/crm-public/estimates/${token}`)).json();
    assert.equal(view.estimate.total, 2355);
    assert.ok(!/unit_cost|markup|cost_total/.test(JSON.stringify(view)), 'no costs or markups leak');
    assert.equal((await homeowner.post(`/api/crm-public/estimates/${token}/accept`, { name: 'H' })).status, 400, 'a full name is required');
    const acc = await homeowner.post(`/api/crm-public/estimates/${token}/accept`, { name: 'Home Owner' });
    assert.equal(acc.status, 200);
    assert.equal((await acc.json()).estimate.status, 'accepted');

    const after = await (await o.get(`/api/crm/deals/${deal.id}`)).json();
    assert.equal(after.deal.stage, 'signed');
    assert.equal(Number(after.deal.value), 2355);
    assert.ok(after.activities.some(a => /Opened construction estimate/.test(a.body)));
    assert.ok(after.activities.some(a => /Accepted construction estimate/.test(a.body)));
    const inbox = await (await o.get('/api/crm/inbox')).json();
    assert.ok(inbox.items.some(i => i.kind === 'estimate_accepted'));
    // Accepted estimates are locked.
    assert.equal((await o.put(`/api/crm/estimates/${estimate.id}`, { title: 'Changed', lines: [] })).status, 400);
  });

  test('a declined estimate lands in Needs you; another company cannot read it', async () => {
    const o = await crmOwner('est-dec');
    const other = await crmOwner('est-other');
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Decliner', email: 'd@example.test' })).json();
    const { estimate } = await (await o.post(`/api/crm/deals/${deal.id}/estimates`, { kind: 'design_agreement' })).json();
    await o.put(`/api/crm/estimates/${estimate.id}`, { title: 'Design', lines: [{ description: 'Design fee', quantity: 1, unit_cost: 2500, markup_pct: 0 }] });
    assert.equal((await other.get(`/api/crm/estimates/${estimate.id}`)).status, 404);
    const token = (await (await o.get(`/api/crm/estimates/${estimate.id}`)).json()).estimate.public_token;
    const pool = getTestPool();
    try { await pool.query(`UPDATE crm_estimates SET status = 'sent', sent_at = now() WHERE id = $1`, [estimate.id]); } finally { await pool.end(); }
    const dec = await makeClient().post(`/api/crm-public/estimates/${token}/decline`, { reason: 'Went another way' });
    assert.equal(dec.status, 200);
    const inbox = await (await o.get('/api/crm/inbox')).json();
    assert.ok(inbox.items.some(i => i.kind === 'negative_reply' && /declined/.test(i.title)));
  });

  test('members can build estimates but not change the catalog', async () => {
    const o = await crmOwner('est-team');
    const inv = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('est-mem'), name: 'Mem', role: 'member' })).json();
    const m = makeClient();
    await m.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'Mem', password: 'MemberPass123!' });
    assert.equal((await m.post('/api/crm/catalog', { name: 'X', unit_cost: 1 })).status, 403);
    const { deal } = await (await m.post('/api/crm/deals', { name: 'Member deal' })).json();
    assert.equal((await m.post(`/api/crm/deals/${deal.id}/estimates`, { kind: 'construction' })).status, 200);
  });
});

describe('CRM lead intake and site visits', () => {
  async function crmOwner(label) {
    const client = makeClient();
    const r = await client.post('/api/auth/signup', {
      email: uniqueEmail(label), password: 'TestPass1234!', companyName: 'Intake Co', industry: 'home_services', acceptedTerms: true, product: 'crm'
    });
    trackTenant((await r.json()).tenantId);
    return client;
  }

  test('the website form turns a visitor into a deal; bots and bad input are turned away', async () => {
    const o = await crmOwner('intake');
    const info = await (await o.get('/api/crm/intake')).json();
    const key = new URL(info.formUrl).pathname.split('/').pop();
    assert.match(info.embedCode, /<iframe/);
    const page = await makeClient().get(`/crm/f/${key}`);
    assert.equal(page.status, 200);
    const visitor = makeClient();
    assert.equal((await (await visitor.get(`/api/crm-public/forms/${key}`)).json()).companyName, 'Intake Co');
    assert.equal((await visitor.post(`/api/crm-public/forms/${key}`, { name: 'No Contact' })).status, 400);
    assert.equal((await visitor.post(`/api/crm-public/forms/${key}`, { name: 'Bot', email: 'bot@example.test', company_website: 'spam' })).status, 200);
    const ok = await visitor.post(`/api/crm-public/forms/${key}`, { name: 'Form Lead', email: 'form@example.test', phone: '713-555-0199', address: '9 Elm St, Houston TX 77024', message: 'Patio and outdoor kitchen' });
    assert.equal(ok.status, 200);
    const pipe = await (await o.get('/api/crm/pipeline')).json();
    assert.equal(pipe.deals.length, 1, 'the honeypot submission was dropped');
    assert.equal(pipe.deals[0].contact_name, 'Form Lead');
    assert.equal(pipe.deals[0].source, 'website');
    assert.equal(pipe.deals[0].stage, 'new');
    assert.equal(pipe.deals[0].first_response_at, null, 'nobody has picked it up yet');
    // A new link retires the old one.
    const fresh = await (await o.post('/api/crm/intake/rotate', {})).json();
    assert.notEqual(fresh.formUrl, info.formUrl);
    assert.equal((await makeClient().get(`/api/crm-public/forms/${key}`)).status, 404);
  });

  test('booking a site visit moves the deal to "Site visit set"', async () => {
    const o = await crmOwner('visit');
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Visit Person', email: 'v@example.test' })).json();
    const at = new Date(Date.now() + 3 * 86400000).toISOString();
    const r = await o.patch(`/api/crm/deals/${deal.id}`, { siteVisitAt: at });
    assert.equal(r.status, 200);
    const d = (await r.json()).deal;
    assert.equal(d.stage, 'site_visit');
    assert.equal(new Date(d.site_visit_at).toISOString(), at);
    assert.equal((await o.patch(`/api/crm/deals/${deal.id}`, { siteVisitAt: 'not a date' })).status, 400);
  });
});

describe('CRM Google Workspace', () => {
  test('without the server key it says so plainly; members cannot connect', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('gw'), password: 'TestPass1234!', companyName: 'GW Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const st = await (await o.get('/api/crm/google')).json();
    assert.equal(st.configured, false);
    assert.equal(st.connection, null);
    assert.equal((await o.post('/api/crm/google/connect', { domain: 'example.test', adminEmail: 'a@example.test' })).status, 503);
    const inv = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('gw-mem'), name: 'M', role: 'member' })).json();
    const m = makeClient();
    const joined = await m.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'M', password: 'MemberPass123!' });
    assert.equal(joined.status, 200, await joined.clone().text());
    assert.equal((await m.get('/api/crm/google')).status, 200);
    assert.equal((await m.post('/api/crm/google/connect', { domain: 'example.test', adminEmail: 'a@example.test' })).status, 403);
    assert.equal((await m.delete('/api/crm/google')).status, 403);
  });
});

describe('CRM weekly reports', () => {
  test('owners can write one now; members cannot see reports', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('rep'), password: 'TestPass1234!', companyName: 'Report Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    await o.post('/api/crm/deals', { name: 'Pat Doe', title: 'Signed One', value: '50k', stage: 'new' }).then(x => x.json()).then(({ deal }) => o.patch(`/api/crm/deals/${deal.id}`, { stage: 'signed' }));
    const now = await o.post('/api/crm/reports/now', {});
    assert.equal(now.status, 200);
    const { report } = await now.json();
    assert.equal(report.facts.company.signedValue, 50000);
    assert.equal(report.writtenBy, 'rules', 'no AI key in tests');
    assert.ok(report.narrative.successes.some(s => /Signed One/.test(s)));
    assert.deepEqual((await (await o.get('/api/crm/reports')).json()).reports, [], 'a "so far" report is not saved');
    const inv = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('rep-mem'), name: 'M', role: 'member' })).json();
    const m = makeClient();
    const joined = await m.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'M', password: 'MemberPass123!' });
    assert.equal(joined.status, 200, await joined.clone().text());
    assert.equal((await m.get('/api/crm/reports')).status, 403);
    assert.equal((await m.post('/api/crm/reports/now', {})).status, 403);
  });
});

describe('CRM tasks and Today', () => {
  test('signing a contract adds kickoff and deposit tasks once; tasks can be added, done and shown in Today', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('tasks'), password: 'TestPass1234!', companyName: 'Task Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Tess', title: 'Bath' })).json();
    await o.patch(`/api/crm/deals/${deal.id}`, { stage: 'signed' });
    await o.patch(`/api/crm/deals/${deal.id}`, { stage: 'proposal' });
    await o.patch(`/api/crm/deals/${deal.id}`, { stage: 'signed' });
    let d = await (await o.get(`/api/crm/deals/${deal.id}`)).json();
    assert.deepEqual(d.tasks.map(t => t.title).sort(), ['Collect the deposit', 'Schedule the kickoff meeting'], 'created once, not twice');
    assert.ok(d.tasks.every(t => t.source === 'auto'));
    const add = await o.post('/api/crm/tasks', { dealId: deal.id, title: 'Order tile samples', dueAt: new Date(Date.now() - 86400000).toISOString() });
    assert.equal(add.status, 200);
    const { task } = await add.json();
    assert.equal((await o.post('/api/crm/tasks', { title: '' })).status, 400);
    let today = await (await o.get('/api/crm/today')).json();
    assert.ok(today.tasks.some(t => t.title === 'Order tile samples' && t.deal_title === 'Bath'));
    assert.equal((await o.patch(`/api/crm/tasks/${task.id}`, { done: true })).status, 200);
    today = await (await o.get('/api/crm/today')).json();
    assert.ok(!today.tasks.some(t => t.id === task.id));
    d = await (await o.get(`/api/crm/deals/${deal.id}`)).json();
    assert.ok(d.activities.some(a => a.body === 'Done: Order tile samples'));
  });

  test('stages can be renamed and hidden, but the core ones stay', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('stages'), password: 'TestPass1234!', companyName: 'Stage Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    await o.patch('/api/crm/settings', { stageLabels: { proposal: 'Bid sent', new: 'Inquiry', bogus: 'x' }, hiddenStages: ['design_agreement', 'in_design', 'signed'] });
    const pipe = await (await o.get('/api/crm/pipeline')).json();
    const by = Object.fromEntries(pipe.stages.map(s => [s.key, s]));
    assert.equal(by.proposal.label, 'Bid sent');
    assert.equal(by.new.label, 'Inquiry');
    assert.equal(by.design_agreement.hidden, true);
    assert.equal(by.signed.hidden, false, 'core stages cannot be hidden');
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Ren' })).json();
    await o.patch(`/api/crm/deals/${deal.id}`, { stage: 'proposal' });
    const d = await (await o.get(`/api/crm/deals/${deal.id}`)).json();
    assert.ok(d.activities.some(a => a.body === 'Inquiry → Bid sent'), 'the timeline uses the company’s names');
  });
});

describe('CRM files and homeowner portal', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  async function owner(label) {
    const c = makeClient();
    const r = await c.post('/api/auth/signup', { email: uniqueEmail(label), password: 'TestPass1234!', companyName: 'Portal Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    return c;
  }
  test('photos upload, only shared ones reach the portal, and the homeowner can write and add photos', async () => {
    const o = await owner('portal');
    const other = await owner('portal-other');
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Home Owner', title: 'Kitchen', email: 'ho@example.test' })).json();
    const up1 = await (await o.post(`/api/crm/deals/${deal.id}/files`, { filename: 'shared.png', dataBase64: PNG, shared: true })).json();
    const up2 = await (await o.post(`/api/crm/deals/${deal.id}/files`, { filename: 'team-only.png', dataBase64: PNG, shared: false })).json();
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/files`, { filename: 'evil.html', dataBase64: Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 400);
    const dl = await o.get(`/api/crm/files/${up1.file.id}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'image/png');
    assert.equal((await other.get(`/api/crm/files/${up1.file.id}`)).status, 404, 'another company cannot fetch it');

    const { url } = await (await o.get(`/api/crm/deals/${deal.id}/portal`)).json();
    const token = url.split('/p/')[1];
    const homeowner = makeClient();
    assert.equal((await homeowner.get(`/p/${token}`)).status, 200);
    const v = (await (await homeowner.get(`/api/crm-public/portal/${token}`)).json()).portal;
    assert.deepEqual(v.files.map(f => f.id), [up1.file.id], 'only shared files');
    assert.equal(v.project.status, 'Getting started');
    assert.ok(!/value|lost_reason|notes/.test(JSON.stringify(v.project)));
    assert.equal((await homeowner.get(`/api/crm-public/portal/${token}/files/${up2.file.id}`)).status, 404, 'team-only file is not reachable');
    assert.equal((await homeowner.get(`/api/crm-public/portal/${token}/files/${up1.file.id}`)).status, 200);

    assert.equal((await homeowner.post(`/api/crm-public/portal/${token}/messages`, { message: 'Can we move the island?' })).status, 200);
    assert.equal((await homeowner.post(`/api/crm-public/portal/${token}/files`, { filename: 'inspo.png', dataBase64: PNG })).status, 200);
    const inbox = await (await o.get('/api/crm/inbox')).json();
    assert.ok(inbox.items.some(i => /sent a message from their portal/.test(i.title)));
    const files = (await (await o.get(`/api/crm/deals/${deal.id}/files`)).json()).files;
    assert.ok(files.some(f => f.from_homeowner && f.shared), 'homeowner photos are shared and marked');

    // Posting an update shows in the portal (email isn't configured in tests).
    const post = await o.post(`/api/crm/deals/${deal.id}/updates`, { body: 'Cabinets arrive Thursday.', email: false });
    assert.equal(post.status, 200);
    const v2 = (await (await homeowner.get(`/api/crm-public/portal/${token}`)).json()).portal;
    assert.equal(v2.updates[0].body, 'Cabinets arrive Thursday.');
    // A new link retires the old one.
    const reset = await (await o.post(`/api/crm/deals/${deal.id}/portal/reset`, {})).json();
    assert.notEqual(reset.url, url);
    assert.equal((await homeowner.get(`/api/crm-public/portal/${token}`)).status, 404);
  });
});

describe('CRM invoices without online payments', () => {
  test('invoices work with checks; the pay page says how to pay; members cannot cancel', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('inv'), password: 'TestPass1234!', companyName: 'Invoice Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Ivy', title: 'Deck' })).json();
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/invoices`, { amount: 'abc' })).status, 400);
    const { invoice } = await (await o.post(`/api/crm/deals/${deal.id}/invoices`, { kind: 'progress', title: 'Framing', amount: '7,500.50' })).json();
    assert.equal(Number(invoice.amount), 7500.5);
    assert.equal(invoice.status, 'draft');
    assert.equal((await makeClient().get(`/api/crm-public/invoices/${invoice.public_token}`)).status, 404, 'drafts are not public');
    const pool = getTestPool();
    try { await pool.query(`UPDATE crm_invoices SET status = 'sent' WHERE id = $1`, [invoice.id]); } finally { await pool.end(); }
    const pub = (await (await makeClient().get(`/api/crm-public/invoices/${invoice.public_token}`)).json()).invoice;
    assert.equal(pub.payOnline, false);
    assert.equal((await makeClient().post(`/api/crm-public/invoices/${invoice.public_token}/checkout`, {})).status, 400);
    assert.equal((await o.get('/api/crm/payments')).status, 200);
    const inv2 = await (await o.post(`/api/crm/deals/${deal.id}/invoices`, { title: 'Extra', amount: 100 })).json();
    const t = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('inv-m'), name: 'M', role: 'member' })).json();
    const m = makeClient();
    const joined = await m.post('/api/crm/join', { token: new URL(t.inviteUrl).searchParams.get('token'), name: 'M', password: 'MemberPass123!' });
    assert.equal(joined.status, 200, await joined.clone().text());
    assert.equal((await m.post(`/api/crm/invoices/${inv2.invoice.id}/void`, {})).status, 403);
    assert.equal((await m.post(`/api/crm/invoices/${invoice.id}/paid`, { via: 'check' })).status, 200, 'anyone can record a check');
    const list = (await (await o.get(`/api/crm/invoices?dealId=${deal.id}`)).json()).invoices;
    assert.equal(list.find(i => i.id === invoice.id).status, 'paid');
    assert.equal((await makeClient().get(`/i/${invoice.public_token}`)).status, 200);
  });
});

describe('CRM has no texting', () => {
  test('the old texting endpoints are gone', async () => {
    const r = await makeClient().raw('/api/twilio/sms', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'From=%2B17135550101&Body=hi' });
    assert.notEqual(r.status, 200);
  });
});

describe('CRM running the job', () => {
  test('signing lays out the schedule; change orders and selections flow through the portal', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('job'), password: 'TestPass1234!', companyName: 'Job Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Jo Builder', title: 'Kitchen', value: 80000 })).json();
    await o.patch(`/api/crm/deals/${deal.id}`, { stage: 'signed' });
    let job = await (await o.get(`/api/crm/deals/${deal.id}/job`)).json();
    assert.ok(job.schedule.length >= 10, 'schedule laid out on signing');
    assert.equal(job.schedule[0].title, 'Kickoff meeting');
    const jobs = (await (await o.get('/api/crm/jobs')).json()).jobs;
    assert.equal(jobs[0].current_phase, 'Kickoff meeting');

    // Finish every phase: Eagle I suggests closing the job.
    for (const item of job.schedule) await o.patch(`/api/crm/schedule/${item.id}`, { title: item.title, startDate: String(item.start_date).slice(0, 10), endDate: String(item.end_date).slice(0, 10), status: 'done' });
    assert.ok((await (await o.get('/api/crm/inbox')).json()).items.some(i => i.kind === 'job_done'));

    // A shared daily log shows up in the portal.
    await o.post(`/api/crm/deals/${deal.id}/logs`, { body: 'Cabinets set, level and shimmed.', shared: true });
    await o.post(`/api/crm/deals/${deal.id}/logs`, { body: 'Internal: plumber late.', shared: false });
    const { url } = await (await o.get(`/api/crm/deals/${deal.id}/portal`)).json();
    const token = url.split('/p/')[1];
    const homeowner = makeClient();
    let portal = (await (await homeowner.get(`/api/crm-public/portal/${token}`)).json()).portal;
    assert.ok(portal.updates.some(u => /Cabinets set/.test(u.body)));
    assert.ok(!portal.updates.some(u => /plumber late/.test(u.body)), 'private logs stay private');
    assert.ok(portal.job.schedule.length >= 10);

    // Change order: sent, approved in the portal by typed name, job value goes up.
    const { co } = await (await o.post(`/api/crm/deals/${deal.id}/change-orders`, { title: 'Add pot filler', amount: '1,200', cost: 650, daysAdded: 1 })).json();
    assert.equal((await homeowner.post(`/api/crm-public/portal/${token}/change-orders/${co.id}`, { approve: true, name: 'Jo Builder' })).status, 400, 'drafts cannot be approved');
    assert.equal((await o.post(`/api/crm/change-orders/${co.id}/send`, {})).status, 200);
    portal = (await (await homeowner.get(`/api/crm-public/portal/${token}`)).json()).portal;
    assert.equal(portal.job.changeOrders[0].status, 'sent');
    assert.equal((await homeowner.post(`/api/crm-public/portal/${token}/change-orders/${co.id}`, { approve: true, name: 'J' })).status, 400, 'full name needed');
    assert.equal((await homeowner.post(`/api/crm-public/portal/${token}/change-orders/${co.id}`, { approve: true, name: 'Jo Builder' })).status, 200);
    const after = (await (await o.get(`/api/crm/deals/${deal.id}`)).json()).deal;
    assert.equal(Number(after.value), 81200);

    // Selection over allowance: a change order is drafted for the difference.
    const { selection } = await (await o.post(`/api/crm/deals/${deal.id}/selections`, { category: 'Backsplash tile', allowance: 2000, options: [{ name: 'Subway white', price: 1500 }, { name: 'Zellige', price: 2600 }] })).json();
    const pick = await homeowner.post(`/api/crm-public/portal/${token}/selections/${selection.id}`, { index: 1 });
    assert.equal((await pick.json()).over, 600);
    assert.equal((await homeowner.post(`/api/crm-public/portal/${token}/selections/${selection.id}`, { index: 0 })).status, 400, 'one choice');
    job = await (await o.get(`/api/crm/deals/${deal.id}/job`)).json();
    const drafted = job.cos.find(c => /Zellige/.test(c.title));
    assert.equal(Number(drafted.amount), 600);
    assert.equal(drafted.status, 'draft', 'the team checks it before it goes out');

    // Vendors and purchase orders.
    const { vendor } = await (await o.post('/api/crm/vendors', { name: 'Gulf Lumber', trade: 'Lumber', email: 'orders@gulf.test', insuranceExpires: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) })).json();
    const { po } = await (await o.post(`/api/crm/deals/${deal.id}/pos`, { vendorId: vendor.id, title: 'Framing lumber', lines: [{ description: '2x6x8', quantity: 120, unit_cost: 6.85 }, { description: 'Nails', quantity: 2, unit_cost: 45 }] })).json();
    assert.equal(Number(po.total), 912);
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/pos`, { title: 'Empty', lines: [] })).status, 400);
  });
});

describe('CRM job costing and export', () => {
  test('costs add up; only owners/admins export; the export is a CSV download', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('cost'), password: 'TestPass1234!', companyName: 'Cost Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Cy', title: 'Bath', value: 30000, stage: 'signed' })).json();
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/costs`, { category: 'materials', amount: '' })).status, 400);
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/costs`, { category: 'materials', amount: '1,250.50', vendorName: 'Ferguson' })).status, 200);
    const d = await (await o.get(`/api/crm/deals/${deal.id}/costs`)).json();
    assert.equal(d.summary.actual, 1250.5);
    assert.equal(d.summary.contract, 30000);
    const today = new Date().toISOString().slice(0, 10);
    const ex = await o.get(`/api/crm/export?kind=costs&from=2020-01-01&to=${today}`);
    assert.equal(ex.status, 200);
    assert.match(ex.headers.get('content-type'), /text\/csv/);
    assert.match(await ex.text(), /Ferguson/);
    assert.equal((await o.get('/api/crm/export?kind=bogus&from=2020-01-01&to=2020-02-01')).status, 400);
    const inv = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('cost-m'), name: 'M', role: 'member' })).json();
    const m = makeClient();
    const joined = await m.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'M', password: 'MemberPass123!' });
    assert.equal(joined.status, 200, await joined.clone().text());
    assert.equal((await m.get(`/api/crm/export?kind=costs&from=2020-01-01&to=${today}`)).status, 403);
    assert.equal((await m.post(`/api/crm/deals/${deal.id}/costs`, { category: 'labor', hours: 8, rate: 40 })).status, 200, 'members can log costs');
  });
});

describe('CRM qualifying and booking', () => {
  test('the questionnaire and booking pages work by link; settings are for managers; tokens are checked', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('fit'), password: 'TestPass1234!', companyName: 'Fit Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const st = await (await o.patch('/api/crm/qualify/settings', { minJobValue: '40000', booking: { days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '18:00', notice: 1 } })).json();
    assert.equal(st.minJobValue, 40000);
    assert.equal((await o.patch('/api/crm/qualify/settings', { minJobValue: 'x' })).status, 400);
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Kim Vo', email: 'kim@fit.test', title: 'Kitchen' })).json();
    const fit = await (await o.get(`/api/crm/deals/${deal.id}/fit`)).json();
    assert.ok(fit.grade);
    const qToken = fit.links.questionnaire.split('/q/')[1];
    assert.match(qToken, /^[0-9a-f]{48}$/);
    const home = makeClient();
    assert.equal((await home.get(`/q/${qToken}`)).status, 200);
    assert.equal((await home.get('/api/crm-public/q/' + 'a'.repeat(48))).status, 404);
    assert.equal((await home.post(`/api/crm-public/q/${qToken}`, { types: ['kitchen'], budget: 'lots', timeline: 'asap' })).status, 400);
    const ans = await (await home.post(`/api/crm-public/q/${qToken}`, { types: ['kitchen'], budget: '100_250k', timeline: '1_3m', decision: 'all' })).json();
    assert.equal(ans.canBook, true);
    const bi = await (await home.get(`/api/crm-public/b/${qToken}`)).json();
    assert.ok(bi.slots.length);
    assert.equal((await home.post(`/api/crm-public/b/${qToken}`, { slot: bi.slots[0] })).status, 200);
    const after = (await (await o.get(`/api/crm/deals/${deal.id}`)).json()).deal;
    assert.equal(after.stage, 'site_visit');
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/brief`, {})).status, 200);
    // The public booking page by intake key; the honeypot quietly drops bots.
    const { formUrl, bookingUrl } = await (await o.get('/api/crm/intake')).json();
    const key = bookingUrl.split('/book/')[1];
    assert.equal(key, formUrl.split('/crm/f/')[1]);
    assert.equal((await home.get(`/book/${key}`)).status, 200);
    const pub = await (await home.get(`/api/crm-public/book/${key}`)).json();
    assert.ok(!pub.slots.includes(bi.slots[0]), 'booked times are gone');
    assert.equal((await home.post(`/api/crm-public/book/${key}`, { name: 'Bot', email: 'b@x.test', slot: pub.slots[0], company_website: 'spam' })).status, 200);
    assert.equal((await home.post(`/api/crm-public/book/${key}`, { name: 'Lee Ann', email: 'lee@fit.test', slot: pub.slots[0] })).status, 200);
    const pipe = await (await o.get('/api/crm/pipeline')).json();
    assert.ok(pipe.deals.some(x => x.contact_name === 'Lee Ann' && x.stage === 'site_visit' && x.grade));
    assert.ok(!pipe.deals.some(x => x.contact_name === 'Bot'));
    // Members can't change booking rules.
    const inv = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('fit-m'), name: 'M', role: 'member' })).json();
    const m = makeClient();
    assert.equal((await m.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'M', password: 'MemberPass123!' })).status, 200);
    assert.equal((await m.patch('/api/crm/qualify/settings', { minJobValue: 1 })).status, 403);
    assert.equal((await m.get('/api/crm/qualify/settings')).status, 200);
  });
});

describe('CRM referrals, partners and the home file', () => {
  test('referral links credit the lead; partners and rewards are for the team; the home file shows in the portal', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('life'), password: 'TestPass1234!', companyName: 'Life Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    assert.equal((await o.patch('/api/crm/lifetime/settings', { reviewUrl: 'http://not-secure.test' })).status, 400);
    assert.equal((await o.patch('/api/crm/lifetime/settings', { reviewUrl: 'https://g.page/r/x', referralReward: '250', warrantyMonths: 24 })).status, 200);
    const { partner } = await (await o.post('/api/crm/partners', { name: 'Dana Designs', kind: 'designer' })).json();
    const board = await (await o.get('/api/crm/referrals')).json();
    const link = board.partners.find(p => p.id === partner.id).link;
    // The link goes to the inquiry form; submitting it credits the partner.
    const anon = makeClient();
    const go = await anon.get(new URL(link).pathname);
    assert.equal(go.status, 302);
    const form = new URL(go.headers.get('location'), link);
    assert.equal(form.searchParams.get('ref'), partner.code);
    assert.equal((await anon.get('/r/0000000000')).status, 404);
    const key = form.pathname.split('/crm/f/')[1];
    assert.equal((await anon.post(`/api/crm-public/forms/${key}`, { name: 'Lee Park', email: 'lee@life.test', message: 'Kitchen', ref: partner.code })).status, 200);
    const pipe = await (await o.get('/api/crm/pipeline')).json();
    const lee = pipe.deals.find(x => x.contact_name === 'Lee Park');
    assert.equal(lee.source, 'partner');
    const lt = await (await o.get(`/api/crm/deals/${lee.id}/lifetime`)).json();
    assert.equal(lt.referrer.name, 'Dana Designs');
    assert.match(lt.referralLink, /\/r\/[0-9a-f]{10}$/);
    // Signing owes the reward; finishing adds the warranty to the home file.
    await o.patch(`/api/crm/deals/${lee.id}`, { stage: 'signed' });
    const after = await (await o.get('/api/crm/referrals')).json();
    assert.equal(after.rewards.length, 1); assert.equal(Number(after.rewards[0].amount), 250);
    assert.equal((await o.post(`/api/crm/deals/${lee.id}/home`, { name: '' })).status, 400);
    assert.equal((await o.post(`/api/crm/deals/${lee.id}/home`, { name: 'Range hood', category: 'appliance', careEveryMonths: 3, careNote: 'Wash the filters' })).status, 200);
    await o.patch(`/api/crm/deals/${lee.id}`, { stage: 'complete' });
    const home = (await (await o.get(`/api/crm/deals/${lee.id}/lifetime`)).json()).home;
    assert.ok(home.some(i => i.category === 'warranty'));
    const fit = await (await o.get(`/api/crm/deals/${lee.id}/fit`)).json();
    const token = fit.links.questionnaire.split('/q/')[1];
    const view = (await (await anon.get(`/api/crm-public/portal/${token}`)).json()).portal;
    assert.ok(view.home.items.some(i => i.name === 'Range hood' && i.careNote === 'Wash the filters'));
    assert.match(view.home.referralCode, /^[0-9a-f]{10}$/);
    // Members can add partners but not change rewards or remove partners.
    const inv = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('life-m'), name: 'M', role: 'member' })).json();
    const m = makeClient();
    assert.equal((await m.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'M', password: 'MemberPass123!' })).status, 200);
    assert.equal((await m.post('/api/crm/partners', { name: 'Ray Realty', kind: 'realtor' })).status, 200);
    assert.equal((await m.delete(`/api/crm/partners/${partner.id}`)).status, 403);
    assert.equal((await m.post(`/api/crm/rewards/${after.rewards[0].id}`, { paid: true })).status, 403);
    assert.equal((await m.patch('/api/crm/lifetime/settings', { referralReward: 1 })).status, 403);
  });
});

describe('CRM marketing and backlog', () => {
  test('ad leads are labelled; spend and targets are for owners/admins; everyone can see the numbers', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('mk'), password: 'TestPass1234!', companyName: 'Mk Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const info = await (await o.get('/api/crm/intake')).json();
    assert.match(info.embedCode, /<script>/);
    const key = info.formUrl.split('/crm/f/')[1];
    assert.equal((await makeClient().post(`/api/crm-public/forms/${key}`, { name: 'Ann Ads', email: 'ann@mk.test', utm: { gclid: 'abc', utm_campaign: 'spring' } })).status, 200);
    const deal = (await (await o.get('/api/crm/pipeline')).json()).deals.find(d => d.contact_name === 'Ann Ads');
    assert.equal(deal.source, 'google_ads');
    const month = new Date().toISOString().slice(0, 7);
    assert.equal((await o.post('/api/crm/marketing/spend', { source: 'google_ads', month, amount: '2,500' })).status, 200);
    assert.equal((await o.post('/api/crm/marketing/spend', { source: 'google_ads', month, amount: 'lots' })).status, 400);
    assert.equal((await o.patch('/api/crm/marketing/settings', { monthlyCapacity: '100000', lowWeeks: 6, highWeeks: 16 })).status, 200);
    const d = await (await o.get('/api/crm/marketing?months=3')).json();
    const g = d.report.channels.find(c => c.source === 'google_ads');
    assert.equal(g.leads, 1); assert.equal(g.spend, 2500); assert.equal(g.costPerLead, 2500);
    assert.equal(d.backlog.settings.lowWeeks, 6); assert.equal(d.backlog.weeksBooked, 0); assert.equal(d.backlog.advice.level, 'ramp');
    const inv = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('mk-m'), name: 'M', role: 'member' })).json();
    const m = makeClient();
    assert.equal((await m.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'M', password: 'MemberPass123!' })).status, 200);
    assert.equal((await m.get('/api/crm/marketing')).status, 200);
    assert.equal((await m.post('/api/crm/marketing/spend', { source: 'facebook', month, amount: 1 })).status, 403);
    assert.equal((await m.delete(`/api/crm/marketing/spend/${d.spend[0].id}`)).status, 403);
    assert.equal((await m.patch('/api/crm/marketing/settings', { monthlyCapacity: 1 })).status, 403);
  });
});

describe('CRM import and setup', () => {
  test('owners import a spreadsheet and undo it; members cannot; setup applies; AI helpers say when they are off', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('imp'), password: 'TestPass1234!', companyName: 'Imp Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const file = { filename: 'jobs.csv', dataBase64: Buffer.from('Name,Email,Status,Amount\nAna Ruiz,ana@imp.test,Sold,50000\nBo Lee,bo@imp.test,Lead,\n').toString('base64') };
    const prev = await (await o.post('/api/crm/import/preview', file)).json();
    assert.equal(prev.rows, 2); assert.equal(prev.mapping['0'], 'name');
    const imp = await (await o.post('/api/crm/import', { ...file, mapping: prev.mapping })).json();
    assert.equal(imp.created, 2);
    const pipe = await (await o.get('/api/crm/pipeline')).json();
    assert.equal(pipe.deals.find(d => d.contact_name === 'Ana Ruiz').stage, 'signed');
    assert.equal((await o.post('/api/crm/import/preview', { filename: 'x.xls', dataBase64: 'AAAA' })).status, 400);
    const setup = await (await o.post('/api/crm/setup', { minJob: '30000', paidDesign: 'yes', replySpeed: 'day' })).json();
    assert.ok(setup.notes.length);
    assert.equal((await (await o.get('/api/crm/setup')).json()).done, true);
    const { estimate } = await (await o.post(`/api/crm/deals/${pipe.deals[0].id}/estimates`, { kind: 'construction' })).json();
    assert.equal((await o.post(`/api/crm/estimates/${estimate.id}/draft`, { scope: 'New quartz counters for the kitchen.' })).status, 503);
    const inv = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('imp-m'), name: 'M', role: 'member' })).json();
    const m = makeClient();
    assert.equal((await m.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'M', password: 'MemberPass123!' })).status, 200);
    assert.equal((await m.post('/api/crm/import', file)).status, 403);
    assert.equal((await m.post(`/api/crm/import/${imp.id}/undo`, {})).status, 403);
    assert.equal((await m.post('/api/crm/setup', {})).status, 403);
    assert.equal((await o.post(`/api/crm/import/${imp.id}/undo`, {})).status, 200);
    assert.equal((await (await o.get('/api/crm/pipeline')).json()).deals.length, 0);
  });
});

describe('CRM payment schedule and check-ins', () => {
  test('signing lays out draws; milestones invoice; the check-in page answers by link; managers own the switches', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('draw'), password: 'TestPass1234!', companyName: 'Draw Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Cy Park', email: 'cy@draw.test', title: 'Bath', value: 50000, stage: 'proposal' })).json();
    await o.patch(`/api/crm/deals/${deal.id}`, { stage: 'signed' });
    const d = await (await o.get(`/api/crm/deals/${deal.id}/draws`)).json();
    assert.equal(d.draws.length, 3); assert.equal(d.contract, 50000); assert.ok(d.phases.length > 5);
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/draws`, { title: 'Bad', pct: 0 })).status, 400);
    const first = d.draws.find(w => w.pct != null);
    const inv = await (await o.post(`/api/crm/draws/${first.id}/invoice`, {})).json();
    assert.equal(Number(inv.invoice.amount), 15000); assert.equal(inv.sent, false);
    assert.equal((await o.post(`/api/crm/draws/${first.id}/invoice`, {})).status, 400, 'once');
    assert.equal((await o.get('/pulse/' + 'a'.repeat(48))).status, 200);
    assert.equal((await o.get('/api/crm-public/pulse/' + 'a'.repeat(48))).status, 404);
    const inv2 = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('draw-m'), name: 'M', role: 'member' })).json();
    const m = makeClient();
    assert.equal((await m.post('/api/crm/join', { token: new URL(inv2.inviteUrl).searchParams.get('token'), name: 'M', password: 'MemberPass123!' })).status, 200);
    assert.equal((await m.patch('/api/crm/draws/settings', { autoSend: true })).status, 403);
    assert.equal((await m.patch('/api/crm/pulse/settings', { on: true })).status, 403);
    assert.equal((await o.patch('/api/crm/pulse/settings', { on: true })).status, 200);
    assert.equal((await (await m.get('/api/crm/pulse/settings')).json()).on, true);
  });
});

describe('Server source is never served', () => {
  test('code, config and docs in the project folder are not downloadable', async () => {
    const c = makeClient();
    for (const p of ['/server.js', '/lib/crm.js', '/routes/crm.js', '/render.yaml', '/package.json', '/db.js', '/auth.js', '/migrations/1760400000000_crm_core.js', '/README.md', '/.env', '/crm.html']) {
      const r = await c.get(p);
      assert.notEqual(r.status, 200, `${p} must not be served (got ${r.status})`);
    }
    assert.equal((await c.get('/favicon.svg')).status, 200, 'public files still are');
  });
});

describe('CRM calendar link, morning email, duplicates and the home-screen app', () => {
  test('each person gets a private calendar; the morning email can be switched off; only managers merge', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('day'), password: 'TestPass1234!', companyName: 'Day Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const d = await (await o.get('/api/crm/me/daily')).json();
    assert.match(d.calendarUrl, /\/cal\/[0-9a-f]{48}\.ics$/); assert.match(d.webcalUrl, /^webcal:/); assert.equal(d.digestOn, true);
    const cal = await makeClient().get(new URL(d.calendarUrl).pathname);
    assert.equal(cal.status, 200); assert.match(cal.headers.get('content-type'), /text\/calendar/);
    assert.match(await cal.text(), /BEGIN:VCALENDAR/);
    assert.equal((await makeClient().get('/cal/' + 'b'.repeat(48) + '.ics')).status, 404);
    const fresh = await (await o.post('/api/crm/me/calendar/reset', {})).json();
    assert.notEqual(fresh.calendarUrl, d.calendarUrl);
    assert.equal((await makeClient().get(new URL(d.calendarUrl).pathname)).status, 404, 'the old link stops');
    assert.equal((await (await o.patch('/api/crm/me/digest', { on: false })).json()).on, false);
    assert.equal((await (await o.get('/api/crm/me/daily')).json()).digestOn, false);
    assert.deepEqual((await (await o.get('/api/crm/duplicates')).json()).groups, []);
    const inv = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('day-m'), name: 'M', role: 'member' })).json();
    const m = makeClient();
    assert.equal((await m.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'M', password: 'MemberPass123!' })).status, 200);
    const merge = await m.post('/api/crm/duplicates/merge', { keepId: 'x', mergeIds: ['y'] });
    assert.equal(merge.status, 403, await merge.text());
    const man = await makeClient().get('/crm-manifest.webmanifest');
    assert.equal(man.status, 200); assert.equal(JSON.parse(await man.text()).start_url, '/crm/app');
    assert.equal((await makeClient().get('/crm-sw.js')).status, 200);
  });
});

describe('CRM sub confirmations and cash flow', () => {
  test('cash flow loads; the sub page needs a real link; managers own the switch', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('sub'), password: 'TestPass1234!', companyName: 'Sub Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const cf = await (await o.get('/api/crm/cashflow')).json();
    assert.equal(cf.weeks.length, 8); assert.equal(cf.overdue, 0);
    assert.equal((await o.get('/sub/' + 'c'.repeat(48))).status, 200);
    assert.equal((await makeClient().get('/api/crm-public/sub/' + 'c'.repeat(48))).status, 404);
    assert.equal((await makeClient().post('/api/crm-public/sub/' + 'c'.repeat(48), { yes: true })).status, 404);
    assert.equal((await (await o.patch('/api/crm/subs/settings', { on: true })).json()).on, true);
    const inv = await (await o.post('/api/crm/team/invites', { email: uniqueEmail('sub-m'), name: 'M', role: 'member' })).json();
    const m = makeClient();
    assert.equal((await m.post('/api/crm/join', { token: new URL(inv.inviteUrl).searchParams.get('token'), name: 'M', password: 'MemberPass123!' })).status, 200);
    assert.equal((await m.patch('/api/crm/subs/settings', { on: false })).status, 403);
  });
});

describe('CRM assistant and bids', () => {
  test('conversations are private; files are checked; without an AI key it says so; the bid page needs a real link', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('ask'), password: 'TestPass1234!', companyName: 'Ask Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const home = await (await o.get('/api/crm/assistant/home')).json();
    assert.ok(home.chips.length >= 3); assert.equal(typeof home.ai, 'boolean');
    const { thread } = await (await o.post('/api/crm/assistant/threads', {})).json();
    assert.ok(thread.id);
    const f = await (await o.post('/api/crm/assistant/files', { filename: 'plans.pdf', dataBase64: Buffer.from('%PDF-1.4 test').toString('base64') })).json();
    assert.equal(f.file.content_type, 'application/pdf');
    assert.equal((await o.post('/api/crm/assistant/files', { filename: 'x.exe', dataBase64: Buffer.from('MZ').toString('base64') })).status, 400);
    if (!process.env.ANTHROPIC_API_KEY) {
      const m = await o.post(`/api/crm/assistant/threads/${thread.id}/messages`, { text: 'hi' });
      assert.equal(m.status, 503); assert.match((await m.json()).error.message, /AI key/);
    }
    const other = makeClient();
    const r2 = await other.post('/api/auth/signup', { email: uniqueEmail('ask2'), password: 'TestPass1234!', companyName: 'Other Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r2.json()).tenantId);
    assert.equal((await other.get(`/api/crm/assistant/threads/${thread.id}`)).status, 404, 'another company can’t open it');
    assert.equal((await other.post(`/api/crm/assistant/actions/00000000-0000-0000-0000-000000000000`, { approve: true })).status, 404);
    assert.equal((await o.delete(`/api/crm/assistant/threads/${thread.id}`)).status, 200);
    assert.equal((await (await o.patch('/api/crm/me/checkin', { on: false })).json()).on, false);
    assert.equal((await (await o.get('/api/crm/me/checkin')).json()).on, false);
    assert.equal((await o.get('/bid/' + 'd'.repeat(48))).status, 200);
    assert.equal((await makeClient().get('/api/crm-public/bid/' + 'd'.repeat(48))).status, 404);
    assert.equal((await makeClient().get('/api/crm-public/bid/' + 'd'.repeat(48) + '/files/00000000-0000-0000-0000-000000000000')).status, 404);
  });
});

describe('CRM plans and billing', () => {
  test('a new company is on a trial; without Stripe nothing locks and checkout says billing is not set up', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('bill'), password: 'TestPass1234!', companyName: 'Bill Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const b = await (await o.get('/api/crm/billing')).json();
    assert.equal(b.status, 'trialing'); assert.ok(b.trialDaysLeft >= 13); assert.equal(b.locked, false); assert.equal(b.plans.length, 3);
    if (!process.env.STRIPE_SECRET_KEY) assert.equal((await o.post('/api/crm/billing/checkout', { plan: 'team' })).status, 503);
    assert.equal((await o.post('/api/crm/deals', { name: 'Still works', title: 'x' })).status, 200);
  });
});

describe('Spanish for homeowners, all the way', () => {
  test('errors on homeowner pages come back in Spanish when the page asks; the unsubscribe page speaks Spanish too', async () => {
    const c = makeClient();
    const en = await c.get('/api/crm-public/q/' + 'e'.repeat(48));
    assert.equal((await en.json()).error.message, 'This link is not valid.');
    const es = await c.raw('/api/crm-public/q/' + 'e'.repeat(48), { method: 'GET', headers: { 'X-Lang': 'es' } });
    assert.equal((await es.json()).error.message, 'Este enlace no es válido.');
    const page = await (await c.get('/unsubscribe?t=x&e=y&s=z&lang=es')).text();
    assert.match(page, /Este enlace no es válido/);
  });
});

describe('CRM coach', () => {
  test('the coach panel loads; drafting a reply needs something to reply to; email and voice log are checked', async () => {
    const o = makeClient();
    const r = await o.post('/api/auth/signup', { email: uniqueEmail('coach'), password: 'TestPass1234!', companyName: 'Coach Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await r.json()).tenantId);
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Kim Vo', title: 'Bath' })).json();
    const c = await (await o.get(`/api/crm/deals/${deal.id}/coach`)).json();
    assert.equal(c.latestEmail, null); assert.equal(typeof c.ai, 'boolean');
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/draft-reply`, {})).status, 400);
    const nm = await (await o.post(`/api/crm/deals/${deal.id}/next-move`, {})).json();
    assert.ok(nm.advice);
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/email`, { subject: 'Hi', message: 'Hello' })).status, 400, 'no email address on file');
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/voice-log`, { text: '' })).status, 400);
    assert.equal((await o.post(`/api/crm/deals/${deal.id}/voice-log`, { text: 'Measured the bathroom.' })).status, 200);
    assert.equal((await o.get('/api/crm/nudges/00000000-0000-0000-0000-000000000000')).status, 404);
  });
});

describe('the real address: Render’s own name and www go to myeaglei.com', () => {
  const http = require('http');
  const get = (path, host, method = 'GET') => new Promise((resolve, reject) => {
    const u = new URL(BASE_URL + path);
    const r = http.request({ hostname: u.hostname, port: u.port, path, method, headers: { Host: host } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location })); });
    r.on('error', reject); r.end();
  });
  test('pages redirect, keeping the path; health checks and API calls do not', async () => {
    let r = await get('/crm', 'eagle-i-abc1.onrender.com');
    assert.equal(r.status, 301); assert.equal(r.location, 'https://myeaglei.com/crm');
    r = await get('/crm/login?next=%2Fcrm', 'www.myeaglei.com');
    assert.equal(r.status, 301); assert.equal(r.location, 'https://myeaglei.com/crm/login?next=%2Fcrm');
    assert.equal((await get('/healthz', 'eagle-i-abc1.onrender.com')).status, 200);
    assert.notEqual((await get('/api/crm/me', 'eagle-i-abc1.onrender.com')).status, 301);
    assert.notEqual((await get('/crm', 'eagle-i-abc1.onrender.com', 'POST')).status, 301);
    assert.notEqual((await get('/crm', 'localhost')).status, 301);
  });
});

describe('the homepage: choose the CRM or Eagle I Marketing', () => {
  test('everyone gets the choice; the marketing dashboard lives at /marketing', async () => {
    const page = await makeClient().get('/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /href="\/crm"/); assert.match(html, /href="\/marketing"/);
    assert.equal((await makeClient().get('/marketing')).headers.get('location'), '/login.html');
    // Coming back from connecting an account still lands on the dashboard.
    assert.equal((await makeClient().get('/?ads_connected=meta')).headers.get('location'), '/marketing?ads_connected=meta');
  });
});

describe('Levi Construction Group: one team, its companies each with their own projects and files', () => {
  async function owner(label) {
    const c = makeClient();
    const r = await (await c.post('/api/auth/signup', { email: uniqueEmail(label), password: 'TestPass1234!', companyName: 'Group Co', industry: 'home_services', acceptedTerms: true, product: 'crm' })).json();
    trackTenant(r.tenantId);
    return { c, tenantId: r.tenantId };
  }
  test('/crm is the portfolio; old links still open the CRM', async () => {
    const page = await makeClient().get('/crm');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Levi Construction Group/); assert.match(html, /\/lcg-mark\.svg/);
    assert.match(html, /location\.replace\('\/crm\/app' \+ location\.hash\)/, 'old /crm#… links forward to the app');
    assert.equal((await makeClient().get('/crm?google=x')).headers.get('location'), '/crm/app?google=x');
  });
  test('companies in the group: profiles, a way in from the portfolio, and projects under each', async () => {
    const pool = getTestPool();
    const { c: o, tenantId } = await owner('group');
    const { c: other } = await owner('group-other');
    const hadSlug = (await pool.query(`UPDATE tenants SET slug = NULL WHERE slug = 'levi-construction-group' RETURNING id`)).rows.map(r => r.id);
    await pool.query(`UPDATE tenants SET slug = 'levi-construction-group' WHERE id = $1`, [tenantId]);
    // Adding a company (company settings).
    const add = await (await o.post('/api/crm/subsidiaries', { name: 'Levi Homes', what: 'Luxury home remodeling', services: 'Kitchens, Bathrooms', website: 'levihomes.com', phone: '713-555-0100' })).json();
    const lh = add.company;
    assert.equal(lh.slug, 'levi-homes'); assert.equal(lh.website, 'https://levihomes.com'); assert.deepEqual(lh.services, ['Kitchens', 'Bathrooms']);
    const second = (await (await o.post('/api/crm/subsidiaries', { name: 'Levi Homes' })).json()).company;
    assert.equal(second.slug, 'levi-homes-2', 'each gets its own address');
    assert.equal((await o.post('/api/crm/subsidiaries', { name: '' })).status, 400);
    // Upcoming: not open yet, listed under Upcoming on the portfolio; saving other details keeps it.
    const soon = (await (await o.post('/api/crm/subsidiaries', { name: 'Levish Properties', upcoming: true })).json()).company;
    assert.equal(soon.upcoming, true); assert.equal(lh.upcoming, false); assert.equal(lh.logo, null);
    assert.equal((await (await o.patch('/api/crm/subsidiaries/' + soon.id, { what: 'Rentals' })).json()).company.upcoming, true);
    assert.equal((await (await o.patch('/api/crm/subsidiaries/' + soon.id, { upcoming: false })).json()).company.upcoming, false);
    await o.delete('/api/crm/subsidiaries/' + soon.id);
    // The public portfolio lists them (no ids); each has a way in.
    const pf = await (await makeClient().get('/api/crm-portfolio')).json();
    assert.equal(pf.group.name, 'Group Co'); assert.ok(pf.companies.some(x => x.slug === 'levi-homes' && x.phone === '713-555-0100' && !x.id));
    assert.deepEqual(await (await makeClient().get('/api/crm-portfolio/levi-homes')).json(), { name: 'Levi Homes' });
    assert.equal((await makeClient().get('/crm/c/levi-homes')).headers.get('location'), '/crm/login?co=levi-homes');
    assert.equal((await o.get('/crm/c/levi-homes')).headers.get('location'), '/crm/app#co/levi-homes');
    assert.match((await other.get('/crm/c/levi-homes')).headers.get('location'), /^\/crm\/login\?co=levi-homes&other=Group%20Co/);
    assert.equal((await makeClient().get('/crm/c/nope-nothing')).headers.get('location'), '/crm');
    // A project under a company, its files on the company's profile.
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Rita Ruiz', title: 'Ruiz kitchen', subsidiaryId: lh.id })).json();
    assert.equal(deal.subsidiary_id, lh.id); assert.equal(deal.subsidiary_name, 'Levi Homes');
    const pl = await (await o.get('/api/crm/pipeline')).json();
    assert.equal(pl.deals.find(x => x.id === deal.id).subsidiary_id, lh.id);
    await o.post(`/api/crm/deals/${deal.id}/files`, { filename: 'plans.png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' });
    let prof = await (await o.get('/api/crm/subsidiaries/levi-homes')).json();
    assert.equal(prof.company.name, 'Levi Homes'); assert.equal(prof.selling[0].id, deal.id); assert.equal(prof.files[0].filename, 'plans.png');
    assert.equal((await o.get('/api/crm/subsidiaries/' + lh.id)).status, 200, 'by id too');
    const list = await (await o.get('/api/crm/subsidiaries')).json();
    assert.equal(list.companies.find(x => x.id === lh.id).selling, 1);
    // Another company can't see it or put its deals under it.
    assert.equal((await other.get('/api/crm/subsidiaries/levi-homes')).status, 404);
    const { deal: theirs } = await (await other.post('/api/crm/deals', { name: 'Someone', title: 'Theirs', subsidiaryId: lh.id })).json();
    assert.equal(theirs.subsidiary_id, null);
    assert.equal((await other.patch(`/api/crm/deals/${theirs.id}`, { subsidiaryId: lh.id })).status, 400);
    // Moving a project to another company, and taking a company off the list.
    await o.patch(`/api/crm/deals/${deal.id}`, { subsidiaryId: second.id });
    assert.equal((await (await o.get(`/api/crm/deals/${deal.id}`)).json()).deal.subsidiary_name, 'Levi Homes', 'the second one is also called Levi Homes');
    assert.ok((await (await o.get(`/api/crm/deals/${deal.id}`)).json()).activities.some(a => /company to Levi Homes/.test(a.body || '')));
    assert.equal((await o.delete('/api/crm/subsidiaries/' + second.id)).status, 200);
    assert.equal((await (await o.get(`/api/crm/deals/${deal.id}`)).json()).deal.subsidiary_id, null, 'its projects stay, no longer under it');
    assert.ok(!(await (await makeClient().get('/api/crm-portfolio')).json()).companies.some(x => x.slug === 'levi-homes-2'));
    await pool.query(`UPDATE tenants SET slug = NULL WHERE id = $1`, [tenantId]);
    // Back to whoever had it (the local preview's Levi Construction Group).
    if (hadSlug.length) await pool.query(`UPDATE tenants SET slug = 'levi-construction-group' WHERE id = $1`, [hadSlug[0]]);
  });
});

describe('the Eagle I admin: every CRM company, view only', () => {
  test('lists CRM companies, opens one read-only, logs it, and stops', async () => {
    const pool = getTestPool();
    // A company with a deal.
    const o = makeClient();
    const co = await (await o.post('/api/auth/signup', { email: uniqueEmail('adm-co'), password: 'TestPass1234!', companyName: 'Looked At Co', industry: 'home_services', acceptedTerms: true, product: 'crm' })).json();
    trackTenant(co.tenantId);
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Pat Doe', title: 'Doe kitchen' })).json();
    // The admin (an Eagle I Marketing login with is_admin) and someone who isn't.
    const a = makeClient(); const aEmail = uniqueEmail('adm');
    const ad = await (await a.post('/api/auth/signup', { email: aEmail, password: 'TestPass1234!', companyName: 'Admin', industry: 'home_services', acceptedTerms: true })).json();
    trackTenant(ad.tenantId);
    await pool.query('UPDATE users SET is_admin = true WHERE LOWER(email) = $1', [aEmail.toLowerCase()]);
    assert.equal((await o.get('/api/admin/crm')).status, 403);
    assert.equal((await o.post('/api/admin/view-as', { tenantId: co.tenantId })).status, 403, 'only the admin');
    assert.equal((await a.get('/admin')).status, 200);
    assert.notEqual((await o.get('/admin')).status, 200);
    const list = await (await a.get('/api/admin/crm')).json();
    assert.ok(list.companies.some(c => c.id === co.tenantId && c.deals === 1));
    // Looking: their CRM, as its owner sees it.
    const v = await (await a.post('/api/admin/view-as', { tenantId: co.tenantId })).json();
    assert.equal(v.go, '/crm/app');
    assert.equal((await a.get('/crm/app')).status, 200);
    const me = await (await a.get('/api/crm/me')).json();
    assert.equal(me.viewOnly, true); assert.equal(me.companyName, 'Looked At Co');
    const pl = await (await a.get('/api/crm/pipeline')).json();
    assert.ok(pl.deals.some(d => d.id === deal.id));
    assert.equal((await (await a.get(`/api/crm/deals/${deal.id}`)).json()).deal.title, 'Doe kitchen');
    // Nothing can be changed, sent or connected.
    for (const [m, path, body] of [['post', '/api/crm/deals', { name: 'X' }], ['patch', `/api/crm/deals/${deal.id}`, { title: 'Hacked' }], ['delete', `/api/crm/deals/${deal.id}`]]) {
      const r = await a[m](path, body || {});
      assert.equal(r.status, 403, `${m} ${path}`); assert.equal((await r.json()).error.code, 'view_only');
    }
    assert.equal((await a.get('/api/crm/google/oauth/start')).status, 403);
    assert.equal((await (await o.get(`/api/crm/deals/${deal.id}`)).json()).deal.title, 'Doe kitchen', 'unchanged');
    const log = (await pool.query(`SELECT detail FROM crm_audit WHERE tenant_id = $1`, [co.tenantId])).rows;
    assert.ok(log.some(l => /Eagle I admin .* looked at the CRM \(view only\)/.test(l.detail)));
    // The admin's own Eagle I Marketing still works as itself.
    assert.notEqual((await a.get('/api/leads')).status, 403);
    // Full access: changes are real; Google still can't be connected; the visit is logged.
    const fe = await (await a.post('/api/admin/view-as', { tenantId: co.tenantId, mode: 'edit' })).json();
    assert.equal(fe.mode, 'edit');
    const me2 = await (await a.get('/api/crm/me')).json();
    assert.equal(me2.adminEdit, true); assert.equal(me2.viewOnly, false);
    const added = await a.post('/api/crm/deals', { name: 'Added By Admin', title: 'Admin-added deal' });
    assert.equal(added.status, 200);
    assert.equal((await a.patch(`/api/crm/deals/${deal.id}`, { title: 'Doe kitchen and bath' })).status, 200);
    assert.equal((await (await o.get(`/api/crm/deals/${deal.id}`)).json()).deal.title, 'Doe kitchen and bath', 'the owner sees the change');
    assert.equal((await a.get('/api/crm/google/oauth/start')).status, 403);
    assert.ok((await pool.query(`SELECT detail FROM crm_audit WHERE tenant_id = $1`, [co.tenantId])).rows.some(l => /opened the CRM with full access/.test(l.detail)));
    // Daily check-in: the company's Team and Problems, but no check-in of the admin's own.
    const ck = await (await a.get('/api/crm/checkins/today')).json();
    assert.equal(ck.checkin, null); assert.equal(ck.canSeeTeam, true);
    assert.equal((await a.post('/api/crm/checkins/today/message', { text: 'hi' })).status, 403);
    assert.equal((await a.post('/api/crm/checkins/today/finish', { form: { did: 'x' } })).status, 403);
    assert.equal((await a.get('/api/crm/checkins/team')).status, 200);
    assert.equal((await pool.query(`SELECT 1 FROM crm_checkins c JOIN users u ON u.id = c.user_id WHERE LOWER(u.email) = $1`, [aEmail.toLowerCase()])).rows.length, 0, 'nothing made for the admin');
    // Someone else can't turn it on.
    assert.equal((await o.post('/api/admin/view-as', { tenantId: co.tenantId, mode: 'edit' })).status, 403);
    // Stopping.
    await a.post('/api/admin/view-as/exit', {});
    assert.equal((await a.get('/api/crm/me')).status, 401, 'back to their own (marketing) login');
  });
});

describe('the Eagle I admin signs in on either side', () => {
  test('a marketing-and-CRM admin login: the CRM side goes to the admin page; portfolio buttons open view only', async () => {
    const pool = getTestPool();
    const email = uniqueEmail('both-adm');
    const s = await (await makeClient().post('/api/auth/signup', { email, password: 'TestPass1234!', companyName: 'Admin', industry: 'home_services', acceptedTerms: true })).json();
    trackTenant(s.tenantId);
    await pool.query(`UPDATE users SET is_admin = true, app = 'both', role = 'member' WHERE LOWER(email) = $1`, [email.toLowerCase()]);
    // Marketing side still signs in.
    assert.equal((await makeClient().post('/api/auth/login', { email, password: 'TestPass1234!' })).status, 200);
    // CRM side signs in too, and lands on the admin page.
    const c = makeClient();
    const r = await (await c.post('/api/crm-auth/login', { email, password: 'TestPass1234!' })).json();
    assert.equal(r.go, '/admin');
    assert.equal((await c.get('/crm/app')).headers.get('location'), '/admin');
    assert.equal((await c.get('/admin')).status, 200);
    // Someone else's marketing login still can't use the CRM side.
    const other = uniqueEmail('mkt-only');
    trackTenant((await (await makeClient().post('/api/auth/signup', { email: other, password: 'TestPass1234!', companyName: 'M', industry: 'home_services', acceptedTerms: true })).json()).tenantId);
    assert.equal((await makeClient().post('/api/crm-auth/login', { email: other, password: 'TestPass1234!' })).status >= 400, true);
  });
});

describe('the assistant: talk or type, each person’s choice', () => {
  test('not chosen yet, then saved; only talk or text', async () => {
    const c = makeClient();
    const s = await (await c.post('/api/auth/signup', { email: uniqueEmail('aimode'), password: 'TestPass1234!', companyName: 'Talk Co', industry: 'home_services', acceptedTerms: true, product: 'crm' })).json();
    trackTenant(s.tenantId);
    assert.equal((await (await c.get('/api/crm/me')).json()).aiMode, null, 'asked the first time');
    assert.equal((await c.patch('/api/crm/me/ai-mode', { mode: 'shout' })).status, 400);
    assert.equal((await (await c.patch('/api/crm/me/ai-mode', { mode: 'talk' })).json()).mode, 'talk');
    assert.equal((await (await c.get('/api/crm/me')).json()).aiMode, 'talk');
    assert.equal((await (await c.get('/api/crm/me/daily')).json()).aiMode, 'talk');
    await c.patch('/api/crm/me/ai-mode', { mode: 'text' });
    assert.equal((await (await c.get('/api/crm/me')).json()).aiMode, 'text');
  });
});

describe('talk or type everywhere: asked once, saved where each person can be found again', () => {
  test('marketing logins, homeowners (on their record) and subs (on theirs)', async () => {
    const pool = getTestPool();
    const c = makeClient();
    const s = await (await c.post('/api/auth/signup', { email: uniqueEmail('tt-mkt'), password: 'TestPass1234!', companyName: 'Talk Mkt', industry: 'home_services', acceptedTerms: true })).json();
    trackTenant(s.tenantId);
    assert.equal((await (await c.get('/api/me')).json()).aiMode, null);
    assert.equal((await c.patch('/api/me/ai-mode', { mode: 'yell' })).status, 400);
    assert.equal((await (await c.patch('/api/me/ai-mode', { mode: 'talk' })).json()).mode, 'talk');
    assert.equal((await (await c.get('/api/me')).json()).aiMode, 'talk');
    // A homeowner's project page and a sub's page.
    const o = makeClient();
    const co = await (await o.post('/api/auth/signup', { email: uniqueEmail('tt-crm'), password: 'TestPass1234!', companyName: 'Talk CRM', industry: 'home_services', acceptedTerms: true, product: 'crm' })).json();
    trackTenant(co.tenantId);
    const { deal } = await (await o.post('/api/crm/deals', { name: 'Hope Owner', title: 'Owner kitchen', email: 'hope@home.test' })).json();
    const ptok = require('crypto').randomBytes(24).toString('hex');
    await pool.query('UPDATE crm_deals SET portal_token = $2 WHERE id = $1', [deal.id, ptok]);
    assert.equal((await (await makeClient().get('/api/crm-public/portal/' + ptok)).json()).portal.aiMode, null, 'asked the first time');
    assert.equal((await makeClient().post(`/api/crm-public/portal/${ptok}/ai-mode`, { mode: 'nope' })).status, 400);
    assert.equal((await makeClient().post(`/api/crm-public/portal/nope/ai-mode`, { mode: 'talk' })).status, 404);
    await makeClient().post(`/api/crm-public/portal/${ptok}/ai-mode`, { mode: 'talk' });
    assert.equal((await (await makeClient().get('/api/crm-public/portal/' + ptok)).json()).portal.aiMode, 'talk', 'same on any device');
    const stok = require('crypto').randomBytes(24).toString('hex');
    await pool.query(`INSERT INTO crm_vendors (tenant_id, name, email, portal_token) VALUES ($1, 'Sam Framing', 'sam@frame.test', $2)`, [co.tenantId, stok]);
    assert.equal((await (await makeClient().get('/api/crm-public/sub-portal/' + stok)).json()).aiMode, null);
    await makeClient().post(`/api/crm-public/sub-portal/${stok}/ai-mode`, { mode: 'text' });
    assert.equal((await (await makeClient().get('/api/crm-public/sub-portal/' + stok)).json()).aiMode, 'text');
  });
});
