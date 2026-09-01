// Best-effort: reads a vendor's own public website — the same homepage or
// contact page a person would open in a browser — for a published contact
// email. Never touches anything private/authenticated, never crawls more
// than two pages, and returns null rather than guessing when nothing is
// published; the tenant enters an email manually in that case.
//
// The URL comes from the client (normally a Google Places `website` field,
// but this route has no way to prove that), so this guards against SSRF:
// only http(s), the resolved IP must be public (not loopback/private/
// link-local/cloud-metadata), redirects are followed manually and
// re-validated, and both time and response size are capped. DNS-rebinding
// (the resolved IP changing between this check and the actual fetch) isn't
// fully closed — full protection needs a fetch agent pinned to the
// resolved IP, which is more than this low-stakes, human-triggered,
// authenticated-only lookup needs — but the obvious targets (internal
// services, cloud metadata endpoints) are blocked.
const dns = require('dns').promises;
const net = require('net');

const FETCH_TIMEOUT_MS = 6000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB — plenty for a homepage/contact page
const USER_AGENT = 'EagleI-ContactLookup/1.0 (business directory tool; fetches public pages on demand)';

function isPrivateOrReservedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('::ffff:')) return isPrivateOrReservedIp(lower.slice(7));
    return false;
  }
  return true; // not a parseable IP at all — fail closed
}

async function resolveIsSafeHost(hostname) {
  if (!hostname || hostname === 'localhost') return false;
  if (net.isIP(hostname)) return !isPrivateOrReservedIp(hostname);
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(a => !isPrivateOrReservedIp(a.address));
}

async function safeFetch(url, redirectsLeft = 2) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are supported.');
  }
  if (!(await resolveIsSafeHost(parsed.hostname))) {
    throw new Error('That host cannot be reached.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(parsed.toString(), {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }
    });

    if ([301, 302, 303, 307, 308].includes(r.status) && redirectsLeft > 0) {
      const location = r.headers.get('location');
      if (!location) throw new Error('Redirected with no destination.');
      return safeFetch(new URL(location, parsed).toString(), redirectsLeft - 1);
    }
    if (!r.ok) throw new Error(`Request failed (${r.status}).`);

    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error('Not an HTML page.');
    }

    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    if (!reader) return await r.text();
    let received = 0;
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_BODY_BYTES) break; // stop reading, use what we have
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

const JUNK_EMAIL_RE = /@(wixpress\.com|sentry\.io|godaddy\.com|example\.com|domain\.com|schema\.org|w3\.org|.*\.png|.*\.jpe?g|.*\.gif|.*\.svg|.*\.webp)$/i;

function isCleanEmail(e) {
  return !JUNK_EMAIL_RE.test(e) && !e.startsWith('noreply@') && !e.startsWith('no-reply@');
}

function extractEmails(html) {
  // mailto: links are the highest-confidence signal — explicit "email us
  // here" markup, not just an address that happens to appear in the page.
  // Junk-filter those FIRST, then decide whether to fall back to a plain-
  // text scan: a page whose only mailto: is a noreply@ newsletter link
  // should still fall back and find a real address printed elsewhere,
  // rather than stopping because *a* mailto: existed.
  const mailtoRe = /mailto:([^"'?\s>]+)/gi;
  const mailtoFound = new Set();
  let m;
  while ((m = mailtoRe.exec(html))) {
    try { mailtoFound.add(decodeURIComponent(m[1]).toLowerCase()); } catch { /* skip malformed */ }
  }
  const cleanMailtos = [...mailtoFound].filter(isCleanEmail);
  if (cleanMailtos.length) return cleanMailtos;

  const genericRe = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const genericFound = new Set();
  while ((m = genericRe.exec(html))) genericFound.add(m[0].toLowerCase());
  return [...genericFound].filter(isCleanEmail);
}

function findContactPageUrl(html, baseUrl) {
  const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (/contact/i.test(text) || /contact/i.test(href)) {
      try { return new URL(href, baseUrl).toString(); } catch { continue; }
    }
  }
  return null;
}

async function findContactEmail(websiteUrl) {
  if (!websiteUrl || !websiteUrl.trim()) {
    return { email: null, reason: 'No website on file for this business.' };
  }
  let normalized = websiteUrl.trim();
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
  try {
    new URL(normalized);
  } catch {
    return { email: null, reason: 'Invalid website URL.' };
  }

  let homepageHtml;
  try {
    homepageHtml = await safeFetch(normalized);
  } catch (err) {
    return { email: null, reason: err.message };
  }

  const homeEmails = extractEmails(homepageHtml);
  if (homeEmails.length) return { email: homeEmails[0], source: 'homepage' };

  const contactUrl = findContactPageUrl(homepageHtml, normalized);
  if (contactUrl) {
    try {
      const contactHtml = await safeFetch(contactUrl);
      const contactEmails = extractEmails(contactHtml);
      if (contactEmails.length) return { email: contactEmails[0], source: 'contact_page', page: contactUrl };
    } catch {
      // Fall through to "not found" — the homepage attempt already succeeded structurally.
    }
  }

  return { email: null, reason: 'No published email address found on their website.' };
}

module.exports = { findContactEmail, isPrivateOrReservedIp, extractEmails, findContactPageUrl };
