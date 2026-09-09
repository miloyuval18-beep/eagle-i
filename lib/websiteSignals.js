// Shared, subject-agnostic website-fetching and signal-detection used by
// both lib/competitorPromoAnalysis.js (checking a competitor's site) and
// lib/websiteCheckup.js (checking the tenant's own site). Nothing in here
// knows or cares whose site it is — it just fetches a URL (safely) and
// reports real, confirmable facts about the page source.

const FETCH_TIMEOUT_MS = 9000;
const MAX_HTML_CHARS = 300000;

// A plain, self-identifying UA like "EagleIBot" gets silently blocked (403,
// or a JS challenge page) by most WAFs (Cloudflare, Sucuri, Wordfence, etc.)
// that pattern-match "bot" in the User-Agent — which, on a lot of small
// local-business hosting, was turning nearly every real lookup into a
// silent failure. This is a single, human-initiated page fetch (triggered
// by one business owner checking one site), not a crawler, so a normal
// browser UA is the honest, working choice here.
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Basic SSRF guard — a "website" URL sourced from a Google Business
// Profile listing, or typed into this tenant's own Company Profile, isn't
// a fully trusted URL either way. Block obvious non-web schemes and
// IP-literal hosts in private/reserved ranges before this server makes an
// outbound request to it.
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

async function fetchHtml(website, logPrefix) {
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
      console.warn(`[${logPrefix || 'websiteSignals'}] ${website} -> HTTP ${r.status}, skipping.`);
      return null;
    }
    const text = await r.text();
    // r.url is where redirects actually landed — what a visitor's browser
    // sees — so checks based on it reflect reality, not just what was
    // typed into a profile field.
    return { html: text.slice(0, MAX_HTML_CHARS), finalUrl: r.url || website };
  } catch (e) {
    console.warn(`[${logPrefix || 'websiteSignals'}] ${website} -> ${e.name === 'AbortError' ? 'timed out' : e.message}, skipping.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const BUILDER_SUBDOMAIN_RE = /\.(wixsite\.com|weebly\.com|squarespace\.com|godaddysites\.com|business\.site|blogspot\.com|webs\.com|jimdo\.com)$/i;

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
    hasHttps: /^https:/i.test(finalUrl || ''),
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    hasAdTracking: /(fbq\(|connect\.facebook\.net\/[^"'\s]+\/fbevents\.js|googleadservices\.com|gtag\(\s*['"]config['"]\s*,\s*['"]AW-)/i.test(html),
    hasSocialLinks: /(facebook\.com\/|instagram\.com\/|linkedin\.com\/company|tiktok\.com\/@)/i.test(html),
    hasMetaDescription: /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}["']/i.test(html),
    hasOg: /<meta[^>]+property=["']og:(title|description|image)["']/i.test(html),
    hasBlog: /href=["'][^"']*\/(blog|news|updates)(\/|["'])/i.test(html),
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

module.exports = { isSafeWebsiteUrl, fetchHtml, analyzeHtml, BUILDER_SUBDOMAIN_RE };
