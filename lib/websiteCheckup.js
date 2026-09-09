// Real analysis of the TENANT'S OWN website — not a competitor's. Reuses
// the same fetch/signal-detection as lib/competitorPromoAnalysis.js (see
// lib/websiteSignals.js), but returns every real gap found (a genuine
// checkup report an owner can work through), phrased as direct advice,
// rather than a single "gotcha" to exploit against someone else. Unlike
// the competitor version, it's fine — and honest — for this to come back
// clean; there's no requirement to invent a flaw when there isn't one.

const { isSafeWebsiteUrl, fetchHtml, analyzeHtml, BUILDER_SUBDOMAIN_RE } = require('./websiteSignals');

// business_profile.site is often stored bare (e.g. "yourcompany.com",
// typed into the Company Profile form with no scheme) rather than as a
// full URL — normalize before fetching.
function normalizeWebsite(site) {
  const trimmed = String(site || '').trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Returns:
//   { configured: false }                                    — no site on file
//   { configured: true, reachable: false, checkedUrl }        — couldn't fetch it at all
//   { configured: true, reachable: true, checkedUrl, findings: [{issue, fix}] } — findings empty means it looks solid
async function checkOwnWebsite(site) {
  const website = normalizeWebsite(site);
  if (!website) return { configured: false };
  if (!isSafeWebsiteUrl(website)) return { configured: true, reachable: false, checkedUrl: website };

  const findings = [];
  let host = '';
  try { host = new URL(website).hostname; } catch (e) { /* leave blank */ }
  if (BUILDER_SUBDOMAIN_RE.test(host)) findings.push({
    issue: `Your website is on a free website-builder address (${host}) instead of your own domain name.`,
    fix: "A real domain name (often $10–15/year) is worth it once you're taking this seriously — it looks more established and is easier for customers to remember and trust."
  });
  if (/^http:\/\//i.test(website)) findings.push({
    issue: "Your website loads over plain http://, not https:// — browsers show visitors a \"Not Secure\" warning.",
    fix: "Most hosts offer a free SSL certificate. Ask your web host or developer to turn HTTPS on — it's usually a quick, one-time fix."
  });

  const fetched = await fetchHtml(website, 'websiteCheckup');
  if (!fetched) return { configured: true, reachable: false, checkedUrl: website, findings };

  const s = analyzeHtml(fetched.html, fetched.finalUrl);

  if (!s.hasViewport) findings.push({
    issue: "Your site has no mobile-friendly setup — it likely looks broken or is hard to use on a phone.",
    fix: "Most local searches happen on a phone, so this matters a lot. Ask your web developer (or your site builder's settings) to add a responsive/mobile viewport — most modern templates support this out of the box."
  });
  if (!s.hasMetaDescription || !s.hasOg) findings.push({
    issue: "Your site is missing basic SEO/social-sharing tags (a search description, a preview image) — it can show up weaker in search results and look plain whenever the link is shared.",
    fix: "Add a meta description (one or two sentences about your business and service area) and an Open Graph image to your homepage's page settings — most site builders have a dedicated \"SEO\" section for this."
  });
  if (!s.hasBlog) findings.push({
    issue: "There's no blog, news, or updates section on your site — nothing signals it's actively maintained.",
    fix: "You don't need a full blog — even a simple \"recent work\" or \"updates\" section you touch every month or two helps, and gives you something fresh to link to from social posts."
  });
  if (!s.hasTelLink) findings.push({
    issue: "Your phone number isn't a tap-to-call link — mobile visitors have to copy and dial it manually instead of tapping once.",
    fix: "Make sure your phone number is wrapped in a real link, e.g. a link that starts with \"tel:\" followed by your number — ask your web developer or site builder to check this."
  });
  if (!s.hasStructuredData) findings.push({
    issue: "Your site has no structured data (schema.org markup) — a technical tag that helps Google show richer results for local businesses.",
    fix: "This one's optional and a bit technical — a web developer can add \"LocalBusiness\" schema markup in an afternoon. Lower priority than the other items here."
  });
  if (!s.hasCta) findings.push({
    issue: "There's no clear call-to-action wording on your homepage (nothing like \"Get a Quote,\" \"Book Now,\" or \"Call Today\") — visitors may not know what to do next.",
    fix: "Add one obvious next step in big, clear wording near the top of your homepage — a simple, direct call-to-action often converts better than a page that just describes your services."
  });
  if (!s.hasFavicon) findings.push({
    issue: "Your site has no favicon (the small icon shown in a browser tab).",
    fix: "A small polish detail, but an easy one — most site builders let you upload one in a few clicks under site settings."
  });
  if (s.hasGenericTitle) findings.push({
    issue: `Your homepage's browser-tab title is generic${s.title?` ("${s.title}")`:' (blank)'} instead of naming your business and service.`,
    fix: "Change your homepage's title to something like \"[Your Business] — [Your Service] in [Your City]\" — it's one of the simplest SEO wins available and takes a couple of minutes."
  });
  if (!s.hasContactForm) findings.push({
    issue: "There's no contact form on your site — a visitor has to already know your phone number or email to reach you.",
    fix: "Add a simple contact form (name, phone or email, message) to your homepage or a dedicated contact page — most site builders have a built-in form block."
  });
  if (!s.hasTrustBadge) findings.push({
    issue: "Nothing on your homepage visibly says licensed, insured, certified, or BBB-accredited.",
    fix: "If you're licensed, insured, or certified, say so clearly and visibly near the top of your homepage — it's a real trust signal a lot of visitors look for before calling."
  });
  if (!s.hasTestimonials) findings.push({
    issue: "There's no testimonials or \"what our customers say\" section on your homepage, even if you have reviews elsewhere.",
    fix: "Pull two or three of your best Google reviews straight onto your homepage. Seeing praise right on the page someone's already looking at is more convincing than sending them to go find it on Google."
  });
  if (s.copyrightYear && s.copyrightYear < new Date().getFullYear()) findings.push({
    issue: `Your site's footer copyright year is out of date (${s.copyrightYear}) — a small but visible sign it hasn't been touched in a while.`,
    fix: "Update the footer copyright year — a two-minute fix that quietly signals the site (and business) is active and current."
  });
  if (s.wordCount>0 && s.wordCount<150) findings.push({
    issue: `Your homepage is very thin on content (roughly ${s.wordCount} words) — it may not give visitors much reason to trust or choose you.`,
    fix: "Add more real detail to your homepage — your services, your service area, what makes you different, and a bit about your experience. More substance helps both visitors and search engines."
  });

  return { configured: true, reachable: true, checkedUrl: fetched.finalUrl, findings };
}

module.exports = { checkOwnWebsite };
