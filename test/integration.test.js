// Integration tests against a real running instance of the server and the
// real Postgres DB (see helpers.js for why there's no separate test DB).
// Every tenant a test creates is registered with trackTenant() and deleted
// in the top-level `after` hook, whether tests pass or fail.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  startServer, stopServer, makeClient, trackTenant, cleanupTenants, uniqueEmail, getTestPool
} = require('./helpers');
const { checkAndIncrementCounter } = require('../lib/usage');

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
