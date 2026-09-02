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
