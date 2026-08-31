// Real ad-campaign creation for Meta Ads and Google Ads.
//
// IMPORTANT — read before assuming this "just works": both integrations are
// built against each platform's real, documented API shape, but neither has
// been exercised against a live ad account, because that requires things
// only the business owner can provide (a funded ad account, and — for
// Meta — the `ads_management` permission approved on top of the existing
// Meta App Review). Every other real-data integration in this codebase
// (Places, weather, permits, HCAD) was verified against a live response
// during development; these two could not be. Treat the request-shape code
// below as "correct per the docs, unverified live" until someone with a
// real connected account exercises it and any surface-level errors get
// fixed against the real API's actual error messages.
//
// Every campaign this creates is created PAUSED. Nothing in this file ever
// sets a campaign to an active/spending state — activating a campaign (and
// therefore spending real money) is left to the owner, done by hand in
// Meta Ads Manager / Google Ads, on purpose. That's a deliberate line, not
// a missing feature — see the "Can't be fully run through AI" section of
// the readiness report for why fully autonomous ad spend isn't something
// this product does.
const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { encrypt, decrypt } = require('../lib/crypto');
const { connectPage } = require('./social');

const router = express.Router();

// A daily budget above this is rejected outright — a sanity ceiling against
// a typo (an extra zero) turning into a very expensive mistake. Not
// configurable via the UI on purpose; raising it means editing this file.
const MAX_DAILY_BUDGET_CENTS = 100000; // $1,000/day
const MIN_DAILY_BUDGET_CENTS = 100; // $1/day — under most platforms' own floor anyway

function budgetError(dailyBudgetCents) {
  if (!Number.isFinite(dailyBudgetCents) || dailyBudgetCents <= 0) return 'dailyBudgetCents must be a positive number.';
  if (dailyBudgetCents < MIN_DAILY_BUDGET_CENTS) return `Daily budget must be at least $${MIN_DAILY_BUDGET_CENTS / 100}.`;
  if (dailyBudgetCents > MAX_DAILY_BUDGET_CENTS) return `Daily budget above $${MAX_DAILY_BUDGET_CENTS / 100}/day is blocked as a safety ceiling — lower the amount, or this product's code needs to change to allow more.`;
  return null;
}

/* ============================== META ADS ============================== */
// Reuses the same Meta app / OAuth connection as organic posting
// (routes/social.js) — a tenant that's already connected Facebook/Instagram
// just needs to add their real ad account id on top. Requires the
// `ads_management` permission on the stored access token; connections made
// before this feature existed only have the original posting scopes and
// must reconnect (see OAUTH_SCOPES in routes/social.js).

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function requireMetaConfig(req, res, next) {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    return res.status(503).json({ error: { message: 'Meta Ads is not configured on this server yet (missing META_APP_ID/META_APP_SECRET).' } });
  }
  next();
}

async function graphGet(pathAndQuery) {
  const r = await fetch(`${GRAPH_BASE}${pathAndQuery}`);
  const body = await r.json();
  if (!r.ok || body.error) throw new Error(body.error?.message || `Graph API request failed (${r.status})`);
  return body;
}

async function graphPost(path, params) {
  const r = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const body = await r.json();
  if (!r.ok || body.error) throw new Error(body.error?.message || `Graph API request failed (${r.status})`);
  return body;
}

async function getMetaConnection(tenantId) {
  const r = await query(
    `SELECT page_id, meta_ad_account_id, access_token_encrypted, access_token_iv, access_token_tag
     FROM social_connections WHERE tenant_id = $1 AND platform = 'meta'`,
    [tenantId]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    pageId: row.page_id,
    adAccountId: row.meta_ad_account_id,
    accessToken: decrypt({ ciphertext: row.access_token_encrypted, iv: row.access_token_iv, tag: row.access_token_tag })
  };
}

// A tenant who connected Facebook/Instagram before ads existed only has the
// original posting scopes on their stored token — Meta doesn't let a scope
// be added quietly, so this re-runs the OAuth dialog with ads_management
// added on top of the full original scope list, then re-saves the same
// social_connections row via the shared connectPage() from routes/social.js.
const META_ADS_OAUTH_SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts',
  'business_management', 'instagram_basic', 'instagram_content_publish',
  'ads_management'
].join(',');

// A separate config gate from requireMetaConfig: the ads OAuth flow needs
// its own redirect URI (a different callback path, `/api/ads/meta/callback`
// vs `/api/social/meta/callback`), and Meta requires every redirect URI to
// be exactly whitelisted in the App dashboard — silently falling back to
// the organic-posting redirect URI would send Meta's callback to the wrong
// route entirely, not just a wrong-but-harmless URL.
function requireMetaAdsOAuthConfig(req, res, next) {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET || !process.env.META_ADS_REDIRECT_URI) {
    return res.status(503).json({
      error: { message: 'Meta Ads connection is not configured on this server yet (missing META_APP_ID/META_APP_SECRET/META_ADS_REDIRECT_URI — this must be its own registered redirect URI in the Meta App dashboard, distinct from META_REDIRECT_URI).' }
    });
  }
  next();
}

router.get('/api/ads/meta/connect', requireAuth, requireMetaAdsOAuthConfig, async (req, res) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    await query(`INSERT INTO oauth_states (state, tenant_id, platform) VALUES ($1, $2, 'meta_ads')`, [state, req.tenantId]);
    const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    url.searchParams.set('client_id', process.env.META_APP_ID);
    url.searchParams.set('redirect_uri', process.env.META_ADS_REDIRECT_URI);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', META_ADS_OAUTH_SCOPES);
    url.searchParams.set('response_type', 'code');
    res.redirect(url.toString());
  } catch (err) {
    res.status(500).json({ error: { message: 'Could not start Meta Ads connection: ' + err.message } });
  }
});

router.get('/api/ads/meta/callback', requireAuth, requireMetaAdsOAuthConfig, async (req, res) => {
  const { code, state, error: oauthError, error_description: oauthErrorDesc } = req.query;
  if (oauthError) return res.redirect('/?ads_error=' + encodeURIComponent(oauthErrorDesc || oauthError));
  try {
    const stateRow = await query(
      `DELETE FROM oauth_states WHERE state = $1 AND tenant_id = $2 AND platform = 'meta_ads' RETURNING state`,
      [state, req.tenantId]
    );
    if (!stateRow.rows.length) return res.redirect('/?ads_error=' + encodeURIComponent('Login session expired — please try connecting again.'));

    const redirectUri = process.env.META_ADS_REDIRECT_URI;
    const shortLived = await graphGet(
      `/oauth/access_token?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${process.env.META_APP_SECRET}&code=${code}`
    );
    const longLived = await graphGet(
      `/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${shortLived.access_token}`
    );
    const accounts = await graphGet(`/me/accounts?access_token=${longLived.access_token}`);
    const pages = accounts.data || [];
    if (!pages.length) return res.redirect('/?ads_error=' + encodeURIComponent('No Facebook Pages found — you must be an admin of a Facebook Page to connect ads.'));

    // Same "pick one if there's more than one Page" flow as organic connect.
    if (pages.length === 1) {
      await connectPage(req.tenantId, pages[0]);
      return res.redirect('/?ads_connected=meta');
    }
    req.session.pendingMetaPages = pages.map(p => ({ id: p.id, name: p.name, access_token: p.access_token }));
    res.redirect('/social-connect.html?provider=meta_ads');
  } catch (err) {
    res.redirect('/?ads_error=' + encodeURIComponent(err.message));
  }
});

router.get('/api/ads/meta/status', requireAuth, async (req, res) => {
  try {
    const conn = await getMetaConnection(req.tenantId);
    res.json({
      configured: !!(process.env.META_APP_ID && process.env.META_APP_SECRET),
      pageConnected: !!conn,
      adAccountId: conn ? conn.adAccountId : null
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load ad status: ' + err.message } });
  }
});

router.patch('/api/ads/meta/ad-account', requireAuth, async (req, res) => {
  try {
    let { adAccountId } = req.body || {};
    if (!adAccountId || !String(adAccountId).trim()) {
      return res.status(400).json({ error: { message: 'adAccountId is required — find it in Meta Ads Manager (Account Overview), formatted like act_1234567890.' } });
    }
    adAccountId = String(adAccountId).trim();
    if (!adAccountId.startsWith('act_')) adAccountId = 'act_' + adAccountId.replace(/^act_/, '');
    if (!/^act_\d+$/.test(adAccountId)) {
      return res.status(400).json({ error: { message: 'That doesn\'t look like a Meta ad account id — it should be digits, optionally prefixed with act_.' } });
    }
    const result = await query(
      `UPDATE social_connections SET meta_ad_account_id = $1 WHERE tenant_id = $2 AND platform = 'meta' RETURNING id`,
      [adAccountId, req.tenantId]
    );
    if (!result.rows.length) {
      return res.status(400).json({ error: { message: 'Connect Facebook/Instagram first (Social HQ → Credentials), then add your ad account.' } });
    }
    res.json({ ok: true, adAccountId });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save ad account: ' + err.message } });
  }
});

router.post('/api/ads/meta/campaign', requireAuth, requireMetaConfig, async (req, res) => {
  try {
    const { name, dailyBudgetCents, message, link, headline, imageUrl, countries, ageMin, ageMax } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: { message: 'Campaign name is required.' } });
    if (!message || !message.trim()) return res.status(400).json({ error: { message: 'Ad text (message) is required.' } });
    if (!link || !/^https?:\/\//.test(link)) return res.status(400).json({ error: { message: 'A valid destination link (https://...) is required.' } });
    const budgetErr = budgetError(Number(dailyBudgetCents));
    if (budgetErr) return res.status(400).json({ error: { message: budgetErr } });

    const conn = await getMetaConnection(req.tenantId);
    if (!conn) return res.status(400).json({ error: { message: 'No Facebook/Instagram account connected yet — connect one in Social HQ first.' } });
    if (!conn.adAccountId) return res.status(400).json({ error: { message: 'No Meta ad account connected yet. Add your ad account id (Social HQ → Ads) before creating a campaign.' } });

    const campaign = await graphPost(`/${conn.adAccountId}/campaigns`, {
      name,
      objective: 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      special_ad_categories: JSON.stringify([]),
      access_token: conn.accessToken
    });

    const targeting = {
      geo_locations: { countries: (Array.isArray(countries) && countries.length ? countries : ['US']) },
      age_min: Number.isFinite(Number(ageMin)) ? Number(ageMin) : 18,
      age_max: Number.isFinite(Number(ageMax)) ? Number(ageMax) : 65
    };
    const adset = await graphPost(`/${conn.adAccountId}/adsets`, {
      name: name + ' — Ad Set',
      campaign_id: campaign.id,
      daily_budget: String(Math.round(Number(dailyBudgetCents))),
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LINK_CLICKS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify(targeting),
      status: 'PAUSED',
      access_token: conn.accessToken
    });

    const linkData = { message, link, name: headline || name };
    if (imageUrl) linkData.picture = imageUrl;
    const creative = await graphPost(`/${conn.adAccountId}/adcreatives`, {
      name: name + ' — Creative',
      object_story_spec: JSON.stringify({ page_id: conn.pageId, link_data: linkData }),
      access_token: conn.accessToken
    });

    const ad = await graphPost(`/${conn.adAccountId}/ads`, {
      name: name + ' — Ad',
      adset_id: adset.id,
      creative: JSON.stringify({ creative_id: creative.id }),
      status: 'PAUSED',
      access_token: conn.accessToken
    });

    res.json({
      ok: true,
      campaignId: campaign.id,
      adSetId: adset.id,
      adId: ad.id,
      status: 'PAUSED',
      manageUrl: `https://business.facebook.com/adsmanager/manage/campaigns?act=${conn.adAccountId.replace('act_', '')}`,
      note: 'Created paused. Review it and turn it on in Meta Ads Manager — Eagle I never activates spend automatically.'
    });
  } catch (err) {
    res.status(502).json({ error: { message: 'Meta Ads campaign creation failed: ' + err.message } });
  }
});

router.get('/api/ads/meta/campaigns', requireAuth, requireMetaConfig, async (req, res) => {
  try {
    const conn = await getMetaConnection(req.tenantId);
    if (!conn || !conn.adAccountId) return res.json({ campaigns: [] });
    const result = await graphGet(`/${conn.adAccountId}/campaigns?fields=name,status,objective,effective_status&access_token=${conn.accessToken}`);
    res.json({ campaigns: result.data || [] });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to load campaigns: ' + err.message } });
  }
});

/* ============================= GOOGLE ADS ============================== */
// A separate OAuth relationship from Google Places (different scope,
// different consent), so it gets its own connect/callback pair and its own
// storage table (google_ads_connections) rather than reusing anything from
// lib/googlePlaces.js. Requires a Google Ads *developer token* — a
// separate approval from Google on top of the OAuth client id/secret,
// applied for at https://ads.google.com/aw/apicenter — not something
// Claude can obtain on your behalf.
const GOOGLE_ADS_API_VERSION = 'v17';
const GOOGLE_ADS_API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/adwords';

function requireGoogleAdsConfig(req, res, next) {
  const missing = ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REDIRECT_URI']
    .filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(503).json({ error: { message: `Google Ads is not configured on this server yet (missing ${missing.join(', ')}).` } });
  }
  next();
}

async function googleAdsFetch(path, { method = 'GET', accessToken, body, loginCustomerId } = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json'
  };
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;
  const r = await fetch(`${GOOGLE_ADS_API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const parsed = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = parsed?.error?.message || `Google Ads API request failed (${r.status})`;
    throw new Error(msg);
  }
  return parsed;
}

async function refreshGoogleAccessToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const body = await r.json();
  if (!r.ok || !body.access_token) throw new Error(body.error_description || body.error || 'Failed to refresh Google access token.');
  return body.access_token;
}

async function getGoogleAdsConnection(tenantId) {
  const r = await query(
    `SELECT customer_id, refresh_token_encrypted, refresh_token_iv, refresh_token_tag
     FROM google_ads_connections WHERE tenant_id = $1`,
    [tenantId]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const refreshToken = decrypt({ ciphertext: row.refresh_token_encrypted, iv: row.refresh_token_iv, tag: row.refresh_token_tag });
  return { customerId: row.customer_id, refreshToken };
}

router.get('/api/ads/google/status', requireAuth, async (req, res) => {
  try {
    const conn = await getGoogleAdsConnection(req.tenantId);
    res.json({
      configured: !['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REDIRECT_URI'].some(k => !process.env[k]),
      connected: !!conn,
      customerId: conn ? conn.customerId : null
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load Google Ads status: ' + err.message } });
  }
});

router.get('/api/ads/google/connect', requireAuth, requireGoogleAdsConfig, async (req, res) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    await query(`INSERT INTO oauth_states_google_ads (state, tenant_id) VALUES ($1, $2)`, [state, req.tenantId]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', process.env.GOOGLE_ADS_CLIENT_ID);
    url.searchParams.set('redirect_uri', process.env.GOOGLE_ADS_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_OAUTH_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent'); // forces a refresh_token even on a re-consent
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  } catch (err) {
    res.status(500).json({ error: { message: 'Could not start Google Ads connection: ' + err.message } });
  }
});

router.get('/api/ads/google/callback', requireAuth, requireGoogleAdsConfig, async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  if (oauthError) return res.redirect('/?ads_error=' + encodeURIComponent(String(oauthError)));
  try {
    const stateRow = await query(`DELETE FROM oauth_states_google_ads WHERE state = $1 AND tenant_id = $2 RETURNING state`, [state, req.tenantId]);
    if (!stateRow.rows.length) return res.redirect('/?ads_error=' + encodeURIComponent('Login session expired — please try connecting again.'));

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_ADS_CLIENT_ID,
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_ADS_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const tokenBody = await tokenResp.json();
    if (!tokenResp.ok || !tokenBody.refresh_token) {
      return res.redirect('/?ads_error=' + encodeURIComponent(tokenBody.error_description || 'Google did not return a refresh token — try disconnecting Eagle I in your Google account permissions and reconnecting.'));
    }

    const list = await googleAdsFetch('/customers:listAccessibleCustomers', { accessToken: tokenBody.access_token });
    const resourceNames = list.resourceNames || [];
    if (!resourceNames.length) {
      return res.redirect('/?ads_error=' + encodeURIComponent('No accessible Google Ads accounts found on that Google login.'));
    }
    // resourceNames look like "customers/1234567890" — same "pick one if
    // multiple" shape as Meta's multi-Page flow in routes/social.js.
    const customerIds = resourceNames.map(rn => rn.split('/')[1]);
    if (customerIds.length > 1) {
      req.session.pendingGoogleAdsCustomers = { customerIds, refreshToken: tokenBody.refresh_token };
      return res.redirect('/social-connect.html?provider=google_ads');
    }

    await saveGoogleAdsConnection(req.tenantId, customerIds[0], tokenBody.refresh_token);
    res.redirect('/?ads_connected=google');
  } catch (err) {
    res.redirect('/?ads_error=' + encodeURIComponent(err.message));
  }
});

async function saveGoogleAdsConnection(tenantId, customerId, refreshToken) {
  const enc = encrypt(refreshToken);
  await query(
    `INSERT INTO google_ads_connections (tenant_id, customer_id, refresh_token_encrypted, refresh_token_iv, refresh_token_tag)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET
       customer_id = EXCLUDED.customer_id,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       refresh_token_iv = EXCLUDED.refresh_token_iv,
       refresh_token_tag = EXCLUDED.refresh_token_tag,
       connected_at = now()`,
    [tenantId, customerId, enc.ciphertext, enc.iv, enc.tag]
  );
}

router.get('/api/ads/google/pending-customers', requireAuth, (req, res) => {
  const pending = req.session.pendingGoogleAdsCustomers;
  res.json({ customerIds: pending ? pending.customerIds : [] });
});

router.post('/api/ads/google/select-customer', requireAuth, async (req, res) => {
  const { customerId } = req.body || {};
  const pending = req.session.pendingGoogleAdsCustomers;
  if (!pending || !pending.customerIds.includes(customerId)) {
    return res.status(400).json({ error: { message: 'That account was not part of the current connection attempt.' } });
  }
  try {
    await saveGoogleAdsConnection(req.tenantId, customerId, pending.refreshToken);
    delete req.session.pendingGoogleAdsCustomers;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Could not save that account: ' + err.message } });
  }
});

router.post('/api/ads/google/campaign', requireAuth, requireGoogleAdsConfig, async (req, res) => {
  try {
    const { name, dailyBudgetCents, finalUrl, headlines, descriptions, keywords } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: { message: 'Campaign name is required.' } });
    if (!finalUrl || !/^https?:\/\//.test(finalUrl)) return res.status(400).json({ error: { message: 'A valid landing page URL (https://...) is required.' } });
    const budgetErr = budgetError(Number(dailyBudgetCents));
    if (budgetErr) return res.status(400).json({ error: { message: budgetErr } });
    const headlineList = (Array.isArray(headlines) ? headlines : []).filter(h => h && h.trim()).slice(0, 15);
    const descList = (Array.isArray(descriptions) ? descriptions : []).filter(d => d && d.trim()).slice(0, 4);
    if (headlineList.length < 3) return res.status(400).json({ error: { message: 'At least 3 ad headlines are required (Google requires 3–15).' } });
    if (descList.length < 2) return res.status(400).json({ error: { message: 'At least 2 ad descriptions are required (Google requires 2–4).' } });
    const keywordList = (Array.isArray(keywords) ? keywords : []).filter(k => k && k.trim()).slice(0, 20);

    const conn = await getGoogleAdsConnection(req.tenantId);
    if (!conn) return res.status(400).json({ error: { message: 'No Google Ads account connected yet — connect one in Social HQ → Ads first.' } });

    const accessToken = await refreshGoogleAccessToken(conn.refreshToken);
    const customerId = conn.customerId;
    const amountMicros = String(Math.round(Number(dailyBudgetCents)) * 10000); // cents -> micros ($1 = 1,000,000 micros = 100 cents)

    const budgetResp = await googleAdsFetch(`/customers/${customerId}/campaignBudgets:mutate`, {
      method: 'POST',
      accessToken,
      body: { operations: [{ create: { name: `${name} — Budget`, amountMicros, deliveryMethod: 'STANDARD' } }] }
    });
    const budgetResourceName = budgetResp.results[0].resourceName;

    const campaignResp = await googleAdsFetch(`/customers/${customerId}/campaigns:mutate`, {
      method: 'POST',
      accessToken,
      body: {
        operations: [{
          create: {
            name,
            status: 'PAUSED',
            advertisingChannelType: 'SEARCH',
            campaignBudget: budgetResourceName,
            networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false }
          }
        }]
      }
    });
    const campaignResourceName = campaignResp.results[0].resourceName;

    const adGroupResp = await googleAdsFetch(`/customers/${customerId}/adGroups:mutate`, {
      method: 'POST',
      accessToken,
      body: { operations: [{ create: { name: `${name} — Ad Group`, campaign: campaignResourceName, status: 'ENABLED', type: 'SEARCH_STANDARD' } }] }
    });
    const adGroupResourceName = adGroupResp.results[0].resourceName;

    if (keywordList.length) {
      await googleAdsFetch(`/customers/${customerId}/adGroupCriteria:mutate`, {
        method: 'POST',
        accessToken,
        body: {
          operations: keywordList.map(k => ({
            create: { adGroup: adGroupResourceName, status: 'ENABLED', keyword: { text: k.trim(), matchType: 'BROAD' } }
          }))
        }
      });
    }

    const adResp = await googleAdsFetch(`/customers/${customerId}/adGroupAds:mutate`, {
      method: 'POST',
      accessToken,
      body: {
        operations: [{
          create: {
            adGroup: adGroupResourceName,
            status: 'PAUSED',
            ad: {
              finalUrls: [finalUrl],
              responsiveSearchAd: {
                headlines: headlineList.map(h => ({ text: h.trim().slice(0, 30) })),
                descriptions: descList.map(d => ({ text: d.trim().slice(0, 90) }))
              }
            }
          }
        }]
      }
    });

    res.json({
      ok: true,
      campaignResourceName,
      adGroupResourceName,
      adResourceName: adResp.results[0].resourceName,
      status: 'PAUSED',
      manageUrl: `https://ads.google.com/aw/campaigns?ocid=${customerId}`,
      note: 'Created paused. Review it and turn it on in Google Ads — Eagle I never activates spend automatically.'
    });
  } catch (err) {
    res.status(502).json({ error: { message: 'Google Ads campaign creation failed: ' + err.message } });
  }
});

router.get('/api/ads/google/campaigns', requireAuth, requireGoogleAdsConfig, async (req, res) => {
  try {
    const conn = await getGoogleAdsConnection(req.tenantId);
    if (!conn) return res.json({ campaigns: [] });
    const accessToken = await refreshGoogleAccessToken(conn.refreshToken);
    const result = await googleAdsFetch(`/customers/${conn.customerId}/googleAds:search`, {
      method: 'POST',
      accessToken,
      body: { query: 'SELECT campaign.id, campaign.name, campaign.status FROM campaign ORDER BY campaign.id DESC LIMIT 50' }
    });
    res.json({ campaigns: (result.results || []).map(r => r.campaign) });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to load campaigns: ' + err.message } });
  }
});

// budgetError is attached to the router (not a separate named export) so
// server.js's existing `const adsRoutes = require('./routes/ads')` /
// `app.use(adsRoutes)` pattern (same shape as routes/permits.js,
// routes/signals.js, routes/images.js) doesn't need to change, while
// test/unit.test.js can still reach the pure validation logic directly.
router.budgetError = budgetError;
module.exports = router;
