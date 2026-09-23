// Real Reddit search via Reddit's own read-only OAuth API (app-only
// client_credentials grant — no per-tenant Reddit login, no credentials
// stored for any tenant, since this only ever reads public posts). The
// app never posts or replies on Reddit; the tenant does that manually,
// logged into their own account, from the permalink this returns.
//
// One shared OAuth client for the whole product (not per-tenant), so the
// free tier's ~100 req/min limit is a *shared* budget across every
// tenant's poll cycle — see lib/redditPollWorker.js for how calls are
// spaced out to respect that.
const USER_AGENT = 'EagleI-LeadListener/1.0 (https://myeaglei.com, admin@myeaglei.com)';
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';

let cachedToken = null; // { accessToken, expiresAt }

function isConfigured() {
  return !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

async function getAppToken() {
  if (!isConfigured()) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.accessToken;

  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT
    },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`Reddit token request failed (${r.status})`);
  const data = await r.json();
  if (!data.access_token) throw new Error('Reddit token response missing access_token');
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cachedToken.accessToken;
}

// One search call against a single subreddit for a single keyword phrase.
// A missing/private/banned subreddit comes back as a normal empty result
// (404), not thrown, since tenants can type a subreddit name that doesn't
// exist — that's a data-quality issue for them to fix in settings, not a
// system error.
async function searchSubreddit(subreddit, keyword) {
  if (!isConfigured()) return [];
  const sr = String(subreddit || '').trim().replace(/^r\//i, '');
  const q = String(keyword || '').trim();
  if (!sr || !q) return [];

  const token = await getAppToken();
  if (!token) return [];

  const url = `https://oauth.reddit.com/r/${encodeURIComponent(sr)}/search?` + new URLSearchParams({
    q, restrict_sr: 'true', sort: 'new', limit: '10', t: 'week'
  });
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT } });
  if (r.status === 404 || r.status === 403) return []; // subreddit doesn't exist / private / banned
  if (!r.ok) throw new Error(`Reddit search failed for r/${sr} (${r.status})`);

  const data = await r.json();
  const children = (data && data.data && data.data.children) || [];
  return children.map(c => {
    const p = c.data || {};
    return {
      postId: p.id,
      title: p.title || '',
      selftext: p.selftext || '',
      author: p.author || '',
      permalink: p.permalink ? `https://www.reddit.com${p.permalink}` : '',
      createdUtc: p.created_utc ? new Date(p.created_utc * 1000) : null
    };
  });
}

module.exports = { isConfigured, getAppToken, searchSubreddit };
