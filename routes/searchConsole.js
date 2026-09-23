// Real Google Search Console connection — the honest fix for "Hottest
// Keywords" being AI's guess, not real data. Search Console can only
// report on a site Google already has data for (it has been indexed and
// has actually received some search traffic) — a brand-new or very small
// site may show nothing yet, which is a real limit of the data, not a bug
// here.
const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { encrypt, decrypt } = require('../lib/crypto');

const router = express.Router();

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const SC_BASE = 'https://www.googleapis.com/webmasters/v3';

function requireScConfig(req, res, next) {
  const missing = ['GOOGLE_SC_CLIENT_ID', 'GOOGLE_SC_CLIENT_SECRET', 'GOOGLE_SC_REDIRECT_URI'].filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(503).json({ error: { message: `Search Console is not configured on this server yet (missing ${missing.join(', ')}).` } });
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
  if (!r.ok) throw new Error(parsed?.error?.message || `Search Console API request failed (${r.status})`);
  return parsed;
}

async function refreshAccessToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_SC_CLIENT_ID,
      client_secret: process.env.GOOGLE_SC_CLIENT_SECRET,
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
    `SELECT site_url, refresh_token_encrypted, refresh_token_iv, refresh_token_tag FROM search_console_connections WHERE tenant_id = $1`,
    [tenantId]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    siteUrl: row.site_url,
    refreshToken: decrypt({ ciphertext: row.refresh_token_encrypted, iv: row.refresh_token_iv, tag: row.refresh_token_tag })
  };
}

router.get('/api/search-console/status', requireAuth, async (req, res) => {
  try {
    const conn = await getConnection(req.tenantId);
    res.json({
      configured: !['GOOGLE_SC_CLIENT_ID', 'GOOGLE_SC_CLIENT_SECRET', 'GOOGLE_SC_REDIRECT_URI'].some(k => !process.env[k]),
      connected: !!conn,
      siteUrl: conn ? conn.siteUrl : null
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load status: ' + err.message } });
  }
});

router.get('/api/search-console/connect', requireAuth, requireScConfig, async (req, res) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    await query(`INSERT INTO oauth_states_sc (state, tenant_id) VALUES ($1, $2)`, [state, req.tenantId]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', process.env.GOOGLE_SC_CLIENT_ID);
    url.searchParams.set('redirect_uri', process.env.GOOGLE_SC_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', OAUTH_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  } catch (err) {
    res.status(500).json({ error: { message: 'Could not start Search Console connection: ' + err.message } });
  }
});

// Deliberately no requireAuth here — some browsers don't reliably carry
// the session cookie through the full round-trip (our /connect -> Google
// consent/account-picker -> our /callback), which produced a bogus "Not
// logged in" right after picking a Google account. The `state` value
// already ties this to exactly one tenant (set server-side, single-use,
// unforgeable) and IS the identity check — no active session required.
router.get('/api/search-console/callback', requireScConfig, async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  if (oauthError) return res.redirect('/?sc_error=' + encodeURIComponent(String(oauthError)));
  try {
    const stateLookup = await query(
      `SELECT tenant_id FROM oauth_states_sc WHERE state = $1 AND created_at > now() - interval '1 hour'`, [state]);
    if (!stateLookup.rows.length) return res.redirect('/?sc_error=' + encodeURIComponent('This connection link expired — please try connecting again.'));
    const tenantId = stateLookup.rows[0].tenant_id;

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_SC_CLIENT_ID,
        client_secret: process.env.GOOGLE_SC_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_SC_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const tokenBody = await tokenResp.json();
    if (!tokenResp.ok || !tokenBody.refresh_token) {
      await query('DELETE FROM oauth_states_sc WHERE state = $1', [state]);
      return res.redirect('/?sc_error=' + encodeURIComponent(tokenBody.error_description || 'Google did not return a refresh token — try disconnecting Eagle I in your Google account permissions and reconnecting.'));
    }

    // Every site this login has Search Console access to — a login could
    // have several verified properties; the tenant picks one, same
    // "pick if more than one" shape as GBP locations and Meta Pages.
    const sitesResp = await googleFetch(`${SC_BASE}/sites`, { accessToken: tokenBody.access_token });
    const sites = (sitesResp.siteEntry || []).filter(s => s.permissionLevel && s.permissionLevel !== 'siteUnverifiedUser');
    if (!sites.length) {
      await query('DELETE FROM oauth_states_sc WHERE state = $1', [state]);
      return res.redirect('/?sc_error=' + encodeURIComponent('No verified Search Console sites found on that Google login. Verify your site in Search Console first.'));
    }

    if (sites.length === 1) {
      await saveConnection(tenantId, sites[0].siteUrl, tokenBody.refresh_token);
      await query('DELETE FROM oauth_states_sc WHERE state = $1', [state]);
      return res.redirect('/?sc_connected=1');
    }
    // More than one site: stash the choice against the SAME state row
    // (still keyed by the unforgeable state, not a session) and let the
    // picker page read it back by that state, passed through the URL.
    const enc = encrypt(tokenBody.refresh_token);
    await query(
      `UPDATE oauth_states_sc SET pending_sites = $2, refresh_token_encrypted = $3, refresh_token_iv = $4, refresh_token_tag = $5 WHERE state = $1`,
      [state, JSON.stringify(sites.map(s => s.siteUrl)), enc.ciphertext, enc.iv, enc.tag]
    );
    res.redirect('/social-connect.html?provider=sc&state=' + encodeURIComponent(state));
  } catch (err) {
    res.redirect('/?sc_error=' + encodeURIComponent(err.message));
  }
});

async function saveConnection(tenantId, siteUrl, refreshToken) {
  const enc = encrypt(refreshToken);
  await query(
    `INSERT INTO search_console_connections (tenant_id, site_url, refresh_token_encrypted, refresh_token_iv, refresh_token_tag)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET
       site_url = EXCLUDED.site_url, refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       refresh_token_iv = EXCLUDED.refresh_token_iv, refresh_token_tag = EXCLUDED.refresh_token_tag, connected_at = now()`,
    [tenantId, siteUrl, enc.ciphertext, enc.iv, enc.tag]
  );
}

// Also stateless (no requireAuth) for the same reason as the callback —
// identity comes from the `state` value the picker page was redirected
// here with, not from a session that may not have survived the redirect.
router.get('/api/search-console/pending-sites', async (req, res) => {
  const state = req.query.state;
  if (!state) return res.json({ options: [] });
  const r = await query(
    `SELECT pending_sites FROM oauth_states_sc WHERE state = $1 AND created_at > now() - interval '1 hour'`, [state]);
  res.json({ options: (r.rows[0] && r.rows[0].pending_sites) || [] });
});

router.post('/api/search-console/select-site', async (req, res) => {
  const { siteUrl, state } = req.body || {};
  if (!state) return res.status(400).json({ error: { message: 'Missing connection reference — try connecting again.' } });
  try {
    const r = await query(
      `SELECT tenant_id, pending_sites, refresh_token_encrypted, refresh_token_iv, refresh_token_tag
       FROM oauth_states_sc WHERE state = $1 AND created_at > now() - interval '1 hour'`, [state]);
    const row = r.rows[0];
    const chosen = row && Array.isArray(row.pending_sites) && row.pending_sites.find(o => o === siteUrl);
    if (!chosen) return res.status(400).json({ error: { message: 'That site was not part of the current connection attempt — try connecting again.' } });
    const refreshToken = decrypt({ ciphertext: row.refresh_token_encrypted, iv: row.refresh_token_iv, tag: row.refresh_token_tag });
    await saveConnection(row.tenant_id, chosen, refreshToken);
    await query('DELETE FROM oauth_states_sc WHERE state = $1', [state]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Could not save that site: ' + err.message } });
  }
});

router.delete('/api/search-console', requireAuth, async (req, res) => {
  try {
    await query(`DELETE FROM search_console_connections WHERE tenant_id = $1`, [req.tenantId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to disconnect: ' + err.message } });
  }
});

// Real ranking data: for each keyword your site actually shows up for in
// Google Search, its average position, impressions and clicks over the
// last N days. Nothing here is estimated — it's Google's own numbers for
// this exact site, which is also the honest limit: a keyword with zero
// real impressions in this window just won't appear, even if it's a
// keyword you'd like to rank for.
router.get('/api/search-console/rankings', requireAuth, async (req, res) => {
  try {
    const conn = await getConnection(req.tenantId);
    if (!conn) return res.status(400).json({ error: { message: 'Connect Search Console first.', code: 'not_connected' } });

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 28, 7), 90);
    const end = new Date(); end.setUTCDate(end.getUTCDate() - 3); // SC data typically lags ~2-3 days
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - days);
    const fmt = (d) => d.toISOString().slice(0, 10);

    const accessToken = await refreshAccessToken(conn.refreshToken);
    const result = await googleFetch(
      `${SC_BASE}/sites/${encodeURIComponent(conn.siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST', accessToken,
        body: { startDate: fmt(start), endDate: fmt(end), dimensions: ['query'], rowLimit: 100 }
      }
    );
    const rows = (result.rows || []).map(r => ({
      keyword: r.keys[0], clicks: r.clicks, impressions: r.impressions,
      ctr: r.ctr, position: Math.round(r.position * 10) / 10
    })).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

    res.json({ siteUrl: conn.siteUrl, startDate: fmt(start), endDate: fmt(end), rankings: rows });
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to load rankings: ' + err.message } });
  }
});

module.exports = router;
