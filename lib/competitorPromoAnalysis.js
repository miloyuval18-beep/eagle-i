// Real analysis of a competitor's own marketing — not their reviews.
// Fetches their public website (briefly, capped) and looks for concrete,
// confirmable gaps in how they promote themselves online: no mobile
// support, no sign of running paid ads, no visible social presence, weak
// SEO basics, no ongoing content. Every signal is a real fact pulled from
// their actual page source — never guessed or AI-estimated. If the site
// can't be reached, or nothing is actually missing, the caller (routes/
// onboarding.js) falls back to the rating-based comparison instead.

const FETCH_TIMEOUT_MS = 6000;
const MAX_HTML_CHARS = 300000;

// Basic SSRF guard — the "website" field on a Google Business Profile is
// set by whoever owns that listing, so it isn't a fully trusted URL. Block
// obvious non-web schemes and IP-literal hosts in private/reserved ranges
// before this server makes an outbound request to it.
function isSafeWebsiteUrl(website) {
  let u;
  try { u = new URL(website); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) return false;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    const parts = host.split('.').map(n => parseInt(n, 10));
    if (parts[0] === 127) return false;
    if (parts[0] === 10) return false;
    if (parts[0] === 192 && parts[1] === 168) return false;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    if (parts[0] === 169 && parts[1] === 254) return false;
    if (parts[0] === 0) return false;
  }
  return true;
}

async function fetchHtml(website) {
  if (!isSafeWebsiteUrl(website)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(website, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EagleIBot/1.0; +https://eagle-i.app)' }
    });
    if (!r.ok) return null;
    const text = await r.text();
    return text.slice(0, MAX_HTML_CHARS);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function analyzeHtml(html) {
  return {
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    hasMetaDescription: /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}["']/i.test(html),
    hasOg: /<meta[^>]+property=["']og:(title|description|image)["']/i.test(html),
    hasSocialLinks: /(facebook\.com\/|instagram\.com\/|linkedin\.com\/company|tiktok\.com\/@)/i.test(html),
    hasAdTracking: /(fbq\(|connect\.facebook\.net\/[^"'\s]+\/fbevents\.js|googleadservices\.com|gtag\(\s*['"]config['"]\s*,\s*['"]AW-)/i.test(html),
    hasBlog: /href=["'][^"']*\/(blog|news|updates)(\/|["'])/i.test(html)
  };
}

// Returns {weakness, exploit} for the single most useful, real promotional
// gap found — or null if the site couldn't be checked or has no
// detectable gap (caller falls back to a rating-based comparison).
async function derivePromotionEdge(website) {
  if (!website) return null;
  const html = await fetchHtml(website);
  if (!html) return null;
  const s = analyzeHtml(html);

  if (!s.hasViewport) return {
    weakness: "Their website has no mobile-friendly setup — it likely looks broken or is hard to use on a phone.",
    exploit: "Most local searches happen on a phone. Make sure your own landing page (Landing Pages tab) looks good on mobile, and lead with that in your ads — it's an easy, visible edge over a site that isn't."
  };
  if (!s.hasAdTracking) return {
    weakness: "No sign of Facebook or Google ad-tracking code on their site — they likely aren't running paid ads right now.",
    exploit: "Paid search and social are wide open: launch a campaign in the Ad Generator targeting your shared service area before they start running ads of their own."
  };
  if (!s.hasSocialLinks) return {
    weakness: "Their website doesn't link to Facebook, Instagram, or LinkedIn — they may not have an active social presence.",
    exploit: "Own that space: post regularly from Social HQ so you're the business showing up in local social feeds and search, not them."
  };
  if (!s.hasMetaDescription || !s.hasOg) return {
    weakness: "Their site is missing basic SEO/social-sharing tags (a search description, a preview image) — it likely shows up weaker in search results and looks plain whenever it's shared.",
    exploit: "This is an easy one to beat: make sure your landing page (Landing Pages tab) has a clear description and preview image, so you look more credible in search and whenever your link gets shared."
  };
  if (!s.hasBlog) return {
    weakness: "No blog, news, or updates section on their site — they aren't publishing any ongoing content.",
    exploit: "Regular posts from Social HQ, plus a landing page that highlights recent work, can make you look more active and trustworthy than a competitor whose site never changes."
  };
  return null;
}

module.exports = { derivePromotionEdge, isSafeWebsiteUrl };
