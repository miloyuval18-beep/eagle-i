// Real analysis of a competitor's own marketing — not their reviews.
// Fetches their public website (briefly, capped) and looks for concrete,
// confirmable gaps in how they promote themselves online: no mobile
// support, no sign of running paid ads, no visible social presence, weak
// SEO basics, no ongoing content. Every signal is a real fact pulled from
// their actual page source — never guessed or AI-estimated. Shares its
// fetch/signal-detection with lib/websiteCheckup.js (which runs the same
// kind of check on the tenant's OWN site) via lib/websiteSignals.js.

const { isSafeWebsiteUrl, fetchHtml, analyzeHtml, BUILDER_SUBDOMAIN_RE } = require('./websiteSignals');

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
    exploit: "A real domain name is an easy, low-cost way to look more professional than a competitor still on a free subdomain."
  };
  if (/^http:\/\//i.test(website)) return {
    weakness: "Google lists their website as a plain http:// link, not https:// — browsers flag that as \"Not Secure.\"",
    exploit: "Make sure your own website is secure (most hosts turn this on for free) — that's a real trust signal they're missing."
  };
  return null;
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

  const fetched = await fetchHtml(website, 'competitorPromoAnalysis');
  if (!fetched) return null;
  const s = analyzeHtml(fetched.html, fetched.finalUrl);

  if (!s.hasHttps) return {
    weakness: "Their website loads over plain HTTP, not HTTPS — browsers flag that as \"Not Secure,\" and it's an SEO penalty too.",
    exploit: "Make sure your own website is secure — check it under Website Checkup — and you can mention that trust signal is missing on their end when it's relevant."
  };
  if (!s.hasViewport) return {
    weakness: "Their website has no mobile-friendly setup — it likely looks broken or is hard to use on a phone.",
    exploit: "Most local searches happen on a phone. Make sure your own website looks good on mobile (Website Checkup will tell you), and lead with that in your ads — it's an easy, visible edge over a site that isn't."
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
    exploit: "This is an easy one to beat: make sure your own website has a clear description and preview image (Website Checkup checks for this), so you look more credible in search and whenever your link gets shared."
  };
  if (!s.hasBlog) return {
    weakness: "No blog, news, or updates section on their site — they aren't publishing any ongoing content.",
    exploit: "Regular posts from Social HQ, plus keeping your own website visibly current, can make you look more active and trustworthy than a competitor whose site never changes."
  };
  if (!s.hasTelLink) return {
    weakness: "Their phone number isn't a tap-to-call link on their site — mobile visitors have to copy and dial it manually.",
    exploit: "A small thing, but it adds up: make sure your own website's phone number is a real tap-to-call link, so a mobile visitor can reach you in one tap instead of giving up."
  };
  if (!s.hasStructuredData) return {
    weakness: "Their site has no structured data (schema.org markup) — they're missing out on richer, more eye-catching Google search results.",
    exploit: "Google Business Profile still gives you a lot of this automatically — keep yours fully filled out (hours, services, photos) so your listing looks more complete than theirs in search."
  };
  if (!s.hasCta) return {
    weakness: "No clear call-to-action wording on their homepage (no \"Get a Quote,\" \"Book Now,\" or \"Call Today\") — visitors may not know what to do next.",
    exploit: "Make sure your own website has one obvious next step in big, clear wording — a simple, direct call-to-action often out-converts a nicer-looking site that doesn't have one."
  };
  if (!s.hasFavicon) return {
    weakness: "Their site has no favicon (the small icon in a browser tab) — a small polish detail that's missing.",
    exploit: "It's a five-minute fix on your end if you haven't done it either — small details like this add up to looking more established and trustworthy."
  };
  if (s.hasGenericTitle) return {
    weakness: `Their homepage's browser-tab title is generic${s.title?` ("${s.title}")`:' (blank)'} instead of naming their business and service — a missed, easy chance at search ranking.`,
    exploit: "Make sure your own website's title clearly states your business name, service, and area — it's one of the simplest SEO wins available, and a lot of competitors skip it."
  };
  if (!s.hasContactForm) return {
    weakness: "No contact form on their site — a visitor has to already know their phone number or email to reach them.",
    exploit: "Make it easier to become your customer than theirs: make sure your own website has a working contact form, so you capture visitors who'd otherwise leave without contacting anyone."
  };
  if (!s.hasTrustBadge) return {
    weakness: "Nothing on their homepage visibly says licensed, insured, certified, or BBB-accredited — even if they are, a visitor can't tell at a glance.",
    exploit: "If you're licensed/insured/certified, say so clearly and visibly on your own website and in your ads — it's a real trust signal they're leaving on the table."
  };
  if (!s.hasTestimonials) return {
    weakness: "No testimonials or \"what our customers say\" section on their homepage, even with reviews elsewhere on Google.",
    exploit: "Pull a few of your best reviews straight onto your own website — seeing praise right on the page you're already looking at is more convincing than having to go find it on Google."
  };
  if (s.copyrightYear && s.copyrightYear < new Date().getFullYear()) return {
    weakness: `Their site's footer copyright year is out of date (${s.copyrightYear}) — a sign it hasn't been updated in a while.`,
    exploit: "Keep your own website and social posts visibly current — an up-to-date presence quietly signals you're the more active, reliable business to hire."
  };
  if (s.wordCount>0 && s.wordCount<150) return {
    weakness: `Their homepage is very thin on content (roughly ${s.wordCount} words) — it doesn't give a visitor much reason to trust or choose them.`,
    exploit: "Your own website can say more — services, service area, what makes you different — which gives visitors more reasons to pick you over a bare-bones competitor site."
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
