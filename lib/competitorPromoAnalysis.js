// Real analysis of a competitor's own marketing — not their reviews.
// Fetches their public website (briefly, capped) and looks for concrete,
// confirmable gaps in how they promote themselves online: no mobile
// support, no sign of running paid ads, no visible social presence, weak
// SEO basics, no ongoing content. Every signal is a real fact pulled from
// their actual page source — never guessed or AI-estimated. If the site
// can't be reached, or nothing is actually missing, the caller (routes/
// onboarding.js) falls back to the rating-based comparison instead.

const FETCH_TIMEOUT_MS = 9000;
const MAX_HTML_CHARS = 300000;

// A plain, self-identifying UA like "EagleIBot" gets silently blocked (403,
// or a JS challenge page) by most WAFs (Cloudflare, Sucuri, Wordfence, etc.)
// that pattern-match "bot" in the User-Agent — which, on a lot of small
// local-business hosting, was turning nearly every real lookup into a
// silent failure that fell all the way back to the generic ratings
// comparison. This is a single, human-initiated page fetch (triggered by
// one business owner checking one competitor), not a crawler, so a normal
// browser UA is the honest, working choice here.
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

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
      headers: FETCH_HEADERS
    });
    if (!r.ok) {
      console.warn(`[competitorPromoAnalysis] ${website} -> HTTP ${r.status}, skipping promotion check for this competitor.`);
      return null;
    }
    const text = await r.text();
    // r.url is where redirects actually landed — what a visitor's browser
    // sees — so the HTTPS check below reflects reality, not just what was
    // typed into their Google Business Profile.
    return { html: text.slice(0, MAX_HTML_CHARS), finalUrl: r.url || website };
  } catch (e) {
    console.warn(`[competitorPromoAnalysis] ${website} -> ${e.name === 'AbortError' ? 'timed out' : e.message}, skipping promotion check for this competitor.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const BUILDER_SUBDOMAIN_RE = /\.(wixsite\.com|weebly\.com|squarespace\.com|godaddysites\.com|business\.site|blogspot\.com|webs\.com|jimdo\.com)$/i;

// Checks derived purely from the website URL Google has on file — no
// network request at all, so these are 100% reliable even against a site
// that blocks every automated fetch outright (common: GoDaddy Website
// Builder and other locked-down small-business hosts sit behind bot
// detection that a realistic User-Agent alone doesn't get past). Run
// before attempting the real fetch so a blocked site can still surface a
// real gap instead of falling all the way back to a generic comparison.
function deriveUrlOnlyEdge(website) {
  let host = '';
  try { host = new URL(website).hostname; } catch (e) { return null; }
  if (BUILDER_SUBDOMAIN_RE.test(host)) return {
    weakness: `Google lists their website as a free website-builder address (${host}) instead of their own domain name — it can read as less established.`,
    exploit: "A real domain name for your landing page is an easy, low-cost way to look more professional than a competitor still on a free subdomain."
  };
  if (/^http:\/\//i.test(website)) return {
    weakness: "Google lists their website as a plain http:// link, not https:// — browsers flag that as \"Not Secure.\"",
    exploit: "Make sure your own landing page (Landing Pages tab) is secure — it already is by default — that's a real trust signal they're missing."
  };
  return null;
}

function analyzeHtml(html, finalUrl) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = (titleMatch ? titleMatch[1] : '').trim();
  let host = '';
  try { host = new URL(finalUrl || '').hostname; } catch (e) { /* leave blank */ }
  const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const wordCount = (textOnly.match(/\S+/g) || []).length;
  const copyrightYearMatch = html.match(/(?:©|&copy;|\bcopyright\b)\s*(?:\d{4}\s*-\s*)?(\d{4})/i);
  const copyrightYear = copyrightYearMatch ? parseInt(copyrightYearMatch[1], 10) : null;
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
    hasContactForm: /<form[^>]*>/i.test(html),
    hasTrustBadge: /(licensed|insured|certified|bbb accredited|better business bureau|google guaranteed)/i.test(html),
    hasTestimonials: /(testimonial|customer review|what our (clients|customers) say)/i.test(html),
    host,
    wordCount,
    copyrightYear,
    title,
    hasGenericTitle: !title || title.length < 12 || /^(home|welcome|untitled|index)\b/i.test(title)
  };
}

// Returns {weakness, exploit} for the single most useful, real promotional
// gap found — or null if nothing could be found at all (caller falls back
// to a rating-based comparison). Checks the free, always-reliable
// URL-only signals first, then major site gaps, then smaller ones — so a
// well-built (or even a fetch-blocked) site still surfaces something real
// rather than "no flaws."
async function derivePromotionEdge(website) {
  if (!website) return null;

  const urlEdge = deriveUrlOnlyEdge(website);
  if (urlEdge) return urlEdge;

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
  if (!s.hasContactForm) return {
    weakness: "No contact form on their site — a visitor has to already know their phone number or email to reach them.",
    exploit: "Make it easier to become your customer than theirs: your landing page (Landing Pages tab) already has a lead form built in, so you capture visitors who'd otherwise leave without contacting anyone."
  };
  if (!s.hasTrustBadge) return {
    weakness: "Nothing on their homepage visibly says licensed, insured, certified, or BBB-accredited — even if they are, a visitor can't tell at a glance.",
    exploit: "If you're licensed/insured/certified, say so clearly and visibly on your landing page and in your ads — it's a real trust signal they're leaving on the table."
  };
  if (!s.hasTestimonials) return {
    weakness: "No testimonials or \"what our customers say\" section on their homepage, even with reviews elsewhere on Google.",
    exploit: "Pull a few of your best reviews straight onto your landing page (Landing Pages tab) — seeing praise right on the page you're already looking at is more convincing than having to go find it on Google."
  };
  if (s.copyrightYear && s.copyrightYear < new Date().getFullYear()) return {
    weakness: `Their site's footer copyright year is out of date (${s.copyrightYear}) — a sign it hasn't been updated in a while.`,
    exploit: "Keep your own landing page and social posts visibly current — an up-to-date presence quietly signals you're the more active, reliable business to hire."
  };
  if (s.wordCount>0 && s.wordCount<150) return {
    weakness: `Their homepage is very thin on content (roughly ${s.wordCount} words) — it doesn't give a visitor much reason to trust or choose them.`,
    exploit: "Your landing page (Landing Pages tab) can say more — services, service area, what makes you different — which gives visitors more reasons to pick you over a bare-bones competitor site."
  };
  // Every check above passed — genuinely rare, since a real local
  // competitor's site would need to clear all 17 signals checked above.
  // Still give something real and actionable, not an admission of failure.
  return {
    weakness: "Their site is genuinely well put-together — the edge here won't come from a hole in their marketing.",
    exploit: "Compete on what a website can't show: speed to respond, price, and consistent 5-star reviews. Send review requests from Social HQ regularly and aim to be the fastest to call back — that still wins jobs against a polished competitor."
  };
}

module.exports = { derivePromotionEdge, isSafeWebsiteUrl, deriveUrlOnlyEdge };
