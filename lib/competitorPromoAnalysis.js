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
    // r.url is where redirects actually landed — what a visitor's browser
    // sees — so the HTTPS check below reflects reality, not just what was
    // typed into their Google Business Profile.
    return { html: text.slice(0, MAX_HTML_CHARS), finalUrl: r.url || website };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function analyzeHtml(html, finalUrl) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = (titleMatch ? titleMatch[1] : '').trim();
  return {
    // Major gaps — checked first, most impactful when found.
    hasHttps: /^https:/i.test(finalUrl || ''),
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    hasAdTracking: /(fbq\(|connect\.facebook\.net\/[^"'\s]+\/fbevents\.js|googleadservices\.com|gtag\(\s*['"]config['"]\s*,\s*['"]AW-)/i.test(html),
    hasSocialLinks: /(facebook\.com\/|instagram\.com\/|linkedin\.com\/company|tiktok\.com\/@)/i.test(html),
    hasMetaDescription: /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}["']/i.test(html),
    hasOg: /<meta[^>]+property=["']og:(title|description|image)["']/i.test(html),
    hasBlog: /href=["'][^"']*\/(blog|news|updates)(\/|["'])/i.test(html),
    // Minor/secondary gaps — smaller, but still real and confirmable, for
    // sites that already clear all of the above.
    hasTelLink: /href=["']tel:/i.test(html),
    hasStructuredData: /application\/ld\+json|itemscope[^>]+itemtype=["']https?:\/\/schema\.org/i.test(html),
    hasFavicon: /<link[^>]+rel=["'](?:shortcut )?icon["']/i.test(html),
    hasCta: /(get a (free )?quote|book now|schedule (a |an )?(free )?(estimate|appointment|consultation)|free estimate|request (a )?quote|call (us |today|now))/i.test(html),
    title,
    hasGenericTitle: !title || title.length < 12 || /^(home|welcome|untitled|index)\b/i.test(title)
  };
}

// Returns {weakness, exploit} for the single most useful, real promotional
// gap found — or null if the site couldn't be checked at all (caller
// falls back to a rating-based comparison). Checks major gaps first, then
// falls through to smaller ones, so a well-built site still surfaces
// something real rather than "no flaws."
async function derivePromotionEdge(website) {
  if (!website) return null;
  const fetched = await fetchHtml(website);
  if (!fetched) return null;
  const s = analyzeHtml(fetched.html, fetched.finalUrl);

  if (!s.hasHttps) return {
    weakness: "Their website loads over plain HTTP, not HTTPS — browsers flag that as \"Not Secure,\" and it's an SEO penalty too.",
    exploit: "Make sure your own landing page (Landing Pages tab) is secure — it already is by default — and you can mention that trust signal is missing on their end when it's relevant."
  };
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
  if (!s.hasTelLink) return {
    weakness: "Their phone number isn't a tap-to-call link on their site — mobile visitors have to copy and dial it manually.",
    exploit: "A small thing, but it adds up: make sure your landing page's phone number is a real tap-to-call link, so a mobile visitor can reach you in one tap instead of giving up."
  };
  if (!s.hasStructuredData) return {
    weakness: "Their site has no structured data (schema.org markup) — they're missing out on richer, more eye-catching Google search results.",
    exploit: "Google Business Profile still gives you a lot of this automatically — keep yours fully filled out (hours, services, photos) so your listing looks more complete than theirs in search."
  };
  if (!s.hasCta) return {
    weakness: "No clear call-to-action wording on their homepage (no \"Get a Quote,\" \"Book Now,\" or \"Call Today\") — visitors may not know what to do next.",
    exploit: "Make sure your own landing page has one obvious next step in big, clear wording — a simple, direct call-to-action often out-converts a nicer-looking site that doesn't have one."
  };
  if (!s.hasFavicon) return {
    weakness: "Their site has no favicon (the small icon in a browser tab) — a small polish detail that's missing.",
    exploit: "It's a five-minute fix on your end if you haven't done it either — small details like this add up to looking more established and trustworthy."
  };
  if (s.hasGenericTitle) return {
    weakness: `Their homepage's browser-tab title is generic${s.title?` ("${s.title}")`:' (blank)'} instead of naming their business and service — a missed, easy chance at search ranking.`,
    exploit: "Make sure your landing page's title clearly states your business name, service, and area — it's one of the simplest SEO wins available, and a lot of competitors skip it."
  };
  return null;
}

module.exports = { derivePromotionEdge, isSafeWebsiteUrl };
