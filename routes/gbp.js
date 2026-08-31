// Real Google Business Profile posting — unlike Yelp/Houzz/Nextdoor (no
// public write API exists at all, see the readiness report's "Can't be
// fully run through AI" section), Google genuinely does publish a write
// API for "local posts" on a Business Profile listing. It's real, but
// gated behind Google's own manual approval ("Basic API Access" request,
// reviewed by a human at Google, typically 7-10 business days, requires
// the Business Profile itself to be 60+ days old and verified) — the same
// class of external blocker as Google Ads' developer token and Meta's App
// Review, not something this code can shortcut.
//
// A local post is organic content, not ad spend — there's no financial
// risk in posting it immediately (unlike routes/ads.js, nothing here is
// ever created "paused"). It publishes for real as soon as you click.
const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { encrypt, decrypt } = require('../lib/crypto');

const router = express.Router();

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const ACCOUNT_MGMT_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const BUSINESS_INFO_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const LOCAL_POSTS_BASE = 'https://mybusiness.googleapis.com/v4'; // local posts still live on the legacy v4 surface

function requireGbpConfig(req, res, next) {
  const missing = ['GOOGLE_GBP_CLIENT_ID', 'GOOGLE_GBP_CLIENT_SECRET', 'GOOGLE_GBP_REDIRECT_URI'].filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(503).json({ error: { message: `Google Business Profile is not configured on this server yet (missing ${missing.join(', ')}).` } });
  }
  next();
}

async function googleFetch(url, { method = 'GET', accessToken, body } = {}) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const parsed = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(parsed?.error?.message || `Google Business Profile API request failed (${r.status})`);
  return parsed;
}

async function refreshAccessToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_GBP_CLIENT_ID,
      client_secret: process.env.GOOGLE_GBP_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const body = await r.json();
  if (!r.ok || !body.access_token) throw new Error(body.error_description || body.error || 'Failed to refresh Google access token.');
  return body.access_token;
}

async function getConnection(tenantId) {
  const r = await query(
    `SELECT account_id, location_id, location_name, refresh_token_encrypted, refresh_token_iv, refresh_token_tag
     FROM google_business_connections WHERE tenant_id = $1`,
    [tenantId]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    accountId: row.account_id,
    locationId: row.location_id,
    locationName: row.location_name,
    refreshToken: decrypt({ ciphertext: row.refresh_token_encrypted, iv: row.refresh_token_iv, tag: row.refresh_token_tag })
  };
}

router.get('/api/gbp/status', requireAuth, async (req, res) => {
  try {
    const conn = await getConnection(req.tenantId);
    res.json({
      configured: !['GOOGLE_GBP_CLIENT_ID', 'GOOGLE_GBP_CLIENT_SECRET', 'GOOGLE_GBP_REDIRECT_URI'].some(k => !process.env[k]),
      connected: !!conn,
      locationName: conn ? conn.locationName : null
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load status: ' + err.message } });
  }
});

router.get('/api/gbp/connect', requireAuth, requireGbpConfig, async (req, res) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    await query(`INSERT INTO oauth_states_gbp (state, tenant_id) VALUES ($1, $2)`, [state, req.tenantId]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', process.env.GOOGLE_GBP_CLIENT_ID);
    url.searchParams.set('redirect_uri', process.env.GOOGLE_GBP_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', OAUTH_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  } catch (err) {
    res.status(500).json({ error: { message: 'Could not start Google Business Profile connection: ' + err.message } });
  }
});

router.get('/api/gbp/callback', requireAuth, requireGbpConfig, async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  if (oauthError) return res.redirect('/?gbp_error=' + encodeURIComponent(String(oauthError)));
  try {
    const stateRow = await query(`DELETE FROM oauth_states_gbp WHERE state = $1 AND tenant_id = $2 RETURNING state`, [state, req.tenantId]);
    if (!stateRow.rows.length) return res.redirect('/?gbp_error=' + encodeURIComponent('Login session expired — please try connecting again.'));

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_GBP_CLIENT_ID,
        client_secret: process.env.GOOGLE_GBP_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_GBP_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const tokenBody = await tokenResp.json();
    if (!tokenResp.ok || !tokenBody.refresh_token) {
      return res.redirect('/?gbp_error=' + encodeURIComponent(tokenBody.error_description || 'Google did not return a refresh token — try disconnecting Eagle I in your Google account permissions and reconnecting.'));
    }

    // Discover every (account, location) pair this login can manage — a
    // business could have several locations; the tenant picks one, same
    // "pick if more than one" shape as Meta Pages and Google Ads customers.
    const accountsResp = await googleFetch(`${ACCOUNT_MGMT_BASE}/accounts`, { accessToken: tokenBody.access_token });
    const accounts = accountsResp.accounts || [];
    if (!accounts.length) return res.redirect('/?gbp_error=' + encodeURIComponent('No Google Business Profile accounts found on that Google login.'));

    const options = [];
    for (const acct of accounts) {
      try {
        const locResp = await googleFetch(
          `${BUSINESS_INFO_BASE}/${acct.name}/locations?readMask=name,title&pageSize=100`,
          { accessToken: tokenBody.access_token }
        );
        for (const loc of (locResp.locations || [])) {
          options.push({ accountId: acct.name, locationId: loc.name, locationName: loc.title || loc.name });
        }
      } catch {
        // One account failing to list locations shouldn't block the others.
      }
    }
    if (!options.length) return res.redirect('/?gbp_error=' + encodeURIComponent('No locations found on your Google Business Profile accounts.'));

    if (options.length === 1) {
      await saveConnection(req.tenantId, options[0], tokenBody.refresh_token);
      return res.redirect('/?gbp_connected=1');
    }
    req.session.pendingGbpLocations = { options, refreshToken: tokenBody.refresh_token };
    res.redirect('/social-connect.html?provider=gbp');
  } catch (err) {
    res.redirect('/?gbp_error=' + encodeURIComponent(err.message));
  }
});

async function saveConnection(tenantId, { accountId, locationId, locationName }, refreshToken) {
  const enc = encrypt(refreshToken);
  await query(
    `INSERT INTO google_business_connections (tenant_id, account_id, location_id, location_name, refresh_token_encrypted, refresh_token_iv, refresh_token_tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id) DO UPDATE SET
       account_id = EXCLUDED.account_id, location_id = EXCLUDED.location_id, location_name = EXCLUDED.location_name,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted, refresh_token_iv = EXCLUDED.refresh_token_iv,
       refresh_token_tag = EXCLUDED.refresh_token_tag, connected_at = now()`,
    [tenantId, accountId, locationId, locationName, enc.ciphertext, enc.iv, enc.tag]
  );
}

router.get('/api/gbp/pending-locations', requireAuth, (req, res) => {
  const pending = req.session.pendingGbpLocations;
  res.json({ options: pending ? pending.options : [] });
});

router.post('/api/gbp/select-location', requireAuth, async (req, res) => {
  const { locationId } = req.body || {};
  const pending = req.session.pendingGbpLocations;
  const chosen = pending && pending.options.find(o => o.locationId === locationId);
  if (!chosen) return res.status(400).json({ error: { message: 'That location was not part of the current connection attempt.' } });
  try {
    await saveConnection(req.tenantId, chosen, pending.refreshToken);
    delete req.session.pendingGbpLocations;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Could not save that location: ' + err.message } });
  }
});

router.delete('/api/gbp', requireAuth, async (req, res) => {
  try {
    await query(`DELETE FROM google_business_connections WHERE tenant_id = $1`, [req.tenantId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to disconnect: ' + err.message } });
  }
});

router.post('/api/gbp/post', requireAuth, requireGbpConfig, async (req, res) => {
  try {
    const { summary, ctaUrl, imageUrl } = req.body || {};
    if (!summary || !summary.trim()) return res.status(400).json({ error: { message: 'Post text is required.' } });

    const conn = await getConnection(req.tenantId);
    if (!conn) return res.status(400).json({ error: { message: 'No Google Business Profile connected yet — connect one in Social HQ first.' } });

    const accessToken = await refreshAccessToken(conn.refreshToken);
    const body = { languageCode: 'en-US', summary: summary.trim(), topicType: 'STANDARD' };
    if (ctaUrl && /^https?:\/\//.test(ctaUrl)) body.callToAction = { actionType: 'LEARN_MORE', url: ctaUrl };
    if (imageUrl) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }];

    const result = await googleFetch(`${LOCAL_POSTS_BASE}/${conn.accountId}/${conn.locationId}/localPosts`, {
      method: 'POST', accessToken, body
    });
    res.json({ ok: true, postId: result.name, searchUrl: result.searchUrl || null });
  } catch (err) {
    res.status(502).json({ error: { message: 'Google Business Profile post failed: ' + err.message } });
  }
});

router.get('/api/gbp/posts', requireAuth, requireGbpConfig, async (req, res) => {
  try {
    const conn = await getConnection(req.tenantId);
    if (!conn) return res.json({ posts: [] });
    const accessToken = await refreshAccessToken(conn.refreshToken);
    const result = await googleFetch(`${LOCAL_POSTS_BASE}/${conn.accountId}/${conn.locationId}/localPosts`, { accessToken });
    res.json({ posts: result.localPosts || [] });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to load posts: ' + err.message } });
  }
});

module.exports = router;
