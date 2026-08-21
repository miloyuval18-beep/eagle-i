// Real Facebook Page + Instagram Business posting via the Meta Graph API.
//
// This is gated by Meta's own app review process — see README/DEPLOY notes.
// Until Eagle I's Meta app is approved for pages_manage_posts /
// instagram_content_publish at standard access, only Facebook users added
// as testers/admins on that Meta app can complete this OAuth flow. The code
// path itself is real (not a demo/simulation) and was verified end-to-end
// against a live tester account.
const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { encrypt, decrypt } = require('../lib/crypto');

const router = express.Router();

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const OAUTH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
  'instagram_basic',
  'instagram_content_publish'
].join(',');

function requireMetaConfig(req, res, next) {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET || !process.env.META_REDIRECT_URI) {
    return res.status(503).json({
      error: { message: 'Facebook/Instagram connection is not configured on this server yet (missing META_APP_ID/META_APP_SECRET/META_REDIRECT_URI).' }
    });
  }
  next();
}

async function graphGet(pathAndQuery) {
  const r = await fetch(`${GRAPH_BASE}${pathAndQuery}`);
  const body = await r.json();
  if (!r.ok || body.error) {
    throw new Error(body.error?.message || `Graph API request failed (${r.status})`);
  }
  return body;
}

async function graphPost(path, params) {
  const r = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const body = await r.json();
  if (!r.ok || body.error) {
    throw new Error(body.error?.message || `Graph API request failed (${r.status})`);
  }
  return body;
}

// Step 1: kick off the Facebook OAuth dialog.
router.get('/api/social/meta/connect', requireAuth, requireMetaConfig, async (req, res) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    await query(
      `INSERT INTO oauth_states (state, tenant_id, platform) VALUES ($1, $2, 'meta')`,
      [state, req.tenantId]
    );
    const url = new URL('https://www.facebook.com/' + GRAPH_VERSION + '/dialog/oauth');
    url.searchParams.set('client_id', process.env.META_APP_ID);
    url.searchParams.set('redirect_uri', process.env.META_REDIRECT_URI);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', OAUTH_SCOPES);
    url.searchParams.set('response_type', 'code');
    res.redirect(url.toString());
  } catch (err) {
    res.status(500).json({ error: { message: 'Could not start Facebook connection: ' + err.message } });
  }
});

// Step 2: Facebook redirects back here with a one-time code.
router.get('/api/social/meta/callback', requireAuth, requireMetaConfig, async (req, res) => {
  const { code, state, error: oauthError, error_description: oauthErrorDesc } = req.query;
  if (oauthError) {
    return res.redirect('/?social_error=' + encodeURIComponent(oauthErrorDesc || oauthError));
  }
  try {
    const stateRow = await query(
      `DELETE FROM oauth_states WHERE state = $1 AND tenant_id = $2 AND platform = 'meta' RETURNING state`,
      [state, req.tenantId]
    );
    if (!stateRow.rows.length) {
      return res.redirect('/?social_error=' + encodeURIComponent('Login session expired — please try connecting again.'));
    }

    const shortLived = await graphGet(
      `/oauth/access_token?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(process.env.META_REDIRECT_URI)}&client_secret=${process.env.META_APP_SECRET}&code=${code}`
    );
    const longLived = await graphGet(
      `/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${shortLived.access_token}`
    );

    const accounts = await graphGet(`/me/accounts?access_token=${longLived.access_token}`);
    const pages = accounts.data || [];

    if (!pages.length) {
      return res.redirect('/?social_error=' + encodeURIComponent('No Facebook Pages found — you must be an admin of a Facebook Page to connect it.'));
    }

    if (pages.length === 1) {
      await connectPage(req.tenantId, pages[0]);
      return res.redirect('/?social_connected=facebook');
    }

    // Multiple Pages — let the tenant choose which one to connect.
    req.session.pendingMetaPages = pages.map(p => ({ id: p.id, name: p.name, access_token: p.access_token }));
    res.redirect('/social-connect.html');
  } catch (err) {
    res.redirect('/?social_error=' + encodeURIComponent(err.message));
  }
});

async function connectPage(tenantId, page) {
  let igBusinessId = null;
  let igUsername = null;
  try {
    const igLookup = await graphGet(
      `/${page.id}?fields=instagram_business_account{id,username}&access_token=${page.access_token}`
    );
    if (igLookup.instagram_business_account) {
      igBusinessId = igLookup.instagram_business_account.id;
      igUsername = igLookup.instagram_business_account.username;
    }
  } catch {
    // No linked Instagram Business account — Facebook-only connection is still valid.
  }

  const enc = encrypt(page.access_token);
  await query(
    `INSERT INTO social_connections
       (tenant_id, platform, page_id, page_name, ig_business_id, ig_username,
        access_token_encrypted, access_token_iv, access_token_tag)
     VALUES ($1, 'meta', $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, platform) DO UPDATE SET
       page_id = EXCLUDED.page_id, page_name = EXCLUDED.page_name,
       ig_business_id = EXCLUDED.ig_business_id, ig_username = EXCLUDED.ig_username,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       access_token_iv = EXCLUDED.access_token_iv, access_token_tag = EXCLUDED.access_token_tag,
       connected_at = now()`,
    [tenantId, page.id, page.name, igBusinessId, igUsername, enc.ciphertext, enc.iv, enc.tag]
  );
}

router.get('/api/social/meta/pending-pages', requireAuth, (req, res) => {
  const pages = (req.session.pendingMetaPages || []).map(p => ({ id: p.id, name: p.name }));
  res.json({ pages });
});

router.post('/api/social/meta/select-page', requireAuth, async (req, res) => {
  const { pageId } = req.body || {};
  const pending = req.session.pendingMetaPages || [];
  const chosen = pending.find(p => p.id === pageId);
  if (!chosen) {
    return res.status(400).json({ error: { message: 'That page was not part of the current connection attempt.' } });
  }
  try {
    await connectPage(req.tenantId, chosen);
    delete req.session.pendingMetaPages;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Could not connect that page: ' + err.message } });
  }
});

router.get('/api/social/connections', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT platform, page_name, ig_username, connected_at FROM social_connections WHERE tenant_id = $1`,
      [req.tenantId]
    );
    res.json({ connections: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load connections: ' + err.message } });
  }
});

router.delete('/api/social/meta', requireAuth, async (req, res) => {
  try {
    await query(`DELETE FROM social_connections WHERE tenant_id = $1 AND platform = 'meta'`, [req.tenantId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to disconnect: ' + err.message } });
  }
});

// Real publish. Facebook accepts a text-only post; Instagram's API requires
// a publicly reachable image URL (no base64/file upload support) — Eagle I
// has no image hosting configured yet, so an Instagram target without
// imageUrl is rejected with a clear explanation rather than silently no-op'ing.
// Shared by the live "Post Now" route below and the scheduled-posts
// background worker (lib/scheduledPostsWorker.js), so both paths publish
// through the exact same logic.
async function publishToMeta(tenantId, { message, imageUrl, targets }) {
  if (!message || !message.trim()) {
    throw new Error('Post text is required.');
  }
  const wantFacebook = !targets || targets.includes('facebook');
  const wantInstagram = targets && targets.includes('instagram');

  const connRes = await query(
    `SELECT page_id, ig_business_id, access_token_encrypted, access_token_iv, access_token_tag
     FROM social_connections WHERE tenant_id = $1 AND platform = 'meta'`,
    [tenantId]
  );
  if (!connRes.rows.length) {
    throw new Error('No Facebook/Instagram account connected yet.');
  }
  const conn = connRes.rows[0];
  const pageToken = decrypt({
    ciphertext: conn.access_token_encrypted,
    iv: conn.access_token_iv,
    tag: conn.access_token_tag
  });

  const results = {};

  if (wantFacebook) {
    try {
      const post = await graphPost(`/${conn.page_id}/feed`, { message, access_token: pageToken });
      results.facebook = { ok: true, postId: post.id };
    } catch (err) {
      results.facebook = { ok: false, error: err.message };
    }
  }

  if (wantInstagram) {
    if (!conn.ig_business_id) {
      results.instagram = { ok: false, error: 'No Instagram Business account is linked to the connected Facebook Page.' };
    } else if (!imageUrl) {
      results.instagram = { ok: false, error: 'Instagram requires a publicly reachable image URL — Eagle I does not host images yet, so paste a link to an already-hosted image.' };
    } else {
      try {
        const media = await graphPost(`/${conn.ig_business_id}/media`, {
          image_url: imageUrl,
          caption: message,
          access_token: pageToken
        });
        const published = await graphPost(`/${conn.ig_business_id}/media_publish`, {
          creation_id: media.id,
          access_token: pageToken
        });
        results.instagram = { ok: true, postId: published.id };
      } catch (err) {
        results.instagram = { ok: false, error: err.message };
      }
    }
  }

  return results;
}

router.post('/api/social/meta/post', requireAuth, async (req, res) => {
  const { message, imageUrl, targets } = req.body || {};
  try {
    const results = await publishToMeta(req.tenantId, { message, imageUrl, targets });
    res.json({ results });
  } catch (err) {
    const status = err.message === 'Post text is required.' || err.message === 'No Facebook/Instagram account connected yet.' ? 400 : 500;
    res.status(status).json({ error: { message: (status === 500 ? 'Publish failed: ' : '') + err.message } });
  }
});

module.exports = { router, publishToMeta };
