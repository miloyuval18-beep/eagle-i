// Integration tests against a real running instance of the server and the
// real Postgres DB (see helpers.js for why there's no separate test DB).
// Every tenant a test creates is registered with trackTenant() and deleted
// in the top-level `after` hook, whether tests pass or fail.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { Webhook } = require('svix');

const {
  startServer, stopServer, makeClient, trackTenant, cleanupTenants, uniqueEmail, getTestPool, TEST_WEBHOOK_SECRET
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
  test('Stripe checkout returns a clean 500 with a clear message, not a crash', async () => {
    const client = makeClient();
    const signup = await client.post('/api/auth/signup', {
      email: uniqueEmail('stripecheck'), password: 'TestPass1234!', companyName: 'Stripe Check', industry: 'home_services', acceptedTerms: true
    });
    trackTenant((await signup.json()).tenantId);

    const r = await client.post('/api/stripe/create-checkout-session', {});
    assert.equal(r.status, 500);
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
    const home = await client.get('/');
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/crm');
    assert.equal((await client.get('/crm')).status, 200);
    assert.equal((await makeClient().get('/crm')).headers.get('location'), '/crm/login');
  });

  test('a marketing company cannot use the CRM until it switches it on, and its leads stay out of it until then', async () => {
    const client = await signup('mkt-only', 'marketing');
    const blocked = await client.get('/api/crm/pipeline');
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, 'no_crm');
    const pool = getTestPool();
    try {
      await pool.query(`INSERT INTO landing_pages (tenant_id, slug, headline, status) VALUES ($1, $2, 'H', 'published')`, [client.tenantId, `mkt-${client.tenantId.slice(0, 8)}`]);
    } finally { await pool.end(); }
    await makeClient().post(`/lp/mkt-${client.tenantId.slice(0, 8)}/submit`, { name: 'Form Person', email: 'form@example.test' });
    assert.equal((await client.post('/api/crm/activate', {})).status, 200);
    const pipe = await (await client.get('/api/crm/pipeline')).json();
    // Switching it on brings existing leads in.
    assert.equal(pipe.deals.length, 1);
    assert.equal(pipe.deals[0].contact_name, 'Form Person');
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
    assert.equal(list.length, 10);
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
    const home = await m.get('/');
    assert.equal(home.headers.get('location'), '/crm');
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

describe('CRM Twilio webhooks', () => {
  test('unsigned webhooks are refused; texting says plainly when it is not set up', async () => {
    const r = await makeClient().raw('/api/twilio/sms', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'From=%2B17135550101&To=%2B17135550199&Body=hi' });
    assert.equal(r.status, 403);
    const o = makeClient();
    const s = await o.post('/api/auth/signup', { email: uniqueEmail('sms'), password: 'TestPass1234!', companyName: 'SMS Co', industry: 'home_services', acceptedTerms: true, product: 'crm' });
    trackTenant((await s.json()).tenantId);
    const st = await (await o.get('/api/crm/sms')).json();
    assert.equal(st.available, false);
    assert.equal((await o.post('/api/crm/sms/number', { areaCode: '713' })).status, 503);
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
