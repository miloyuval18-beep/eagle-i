// Checks whether a stored vendor email is safe to send to. What this can
// and cannot prove, plainly:
//
//   CAN:  the address is well-formed; its domain exists and accepts mail
//         (MX, or A as the RFC fallback); the address sits on the same
//         domain as the business's own website (or is a webmail address
//         published on it); and — for older rows whose Google match was
//         never validated — that the website actually mentions this
//         business, so the email wasn't scraped off an unrelated company.
//   CANNOT: prove a specific mailbox exists. Only sending can, and probing
//         mail servers directly (SMTP RCPT) is blocked by many hosts, is
//         answered "yes" to everything by catch-all servers, and can hurt
//         the sending IP's reputation — so it isn't done here.
const dns = require('dns').promises;
const { fetchPublicPage } = require('./vendorContactFinder');
const { distinctiveTokens, stripLegalSuffix } = require('./placesMatch');

const STRICT_EMAIL_RE = /^[a-z0-9._%+-]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/i;
const DNS_TIMEOUT_MS = 5000;

// People often use these for a small business, and when one is published on
// the business's own site it is that business's real contact — so a webmail
// address can't be "mismatched" against the website's domain.
const WEBMAIL = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'comcast.net', 'sbcglobal.net', 'att.net', 'verizon.net', 'bellsouth.net', 'yahoo.co.uk'
]);
const TWO_LEVEL_TLDS = new Set(['co.uk', 'com.au', 'co.nz', 'com.br', 'co.za']);

function registrableDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return TWO_LEVEL_TLDS.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

function hostOf(website) {
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : 'https://' + website);
    return u.hostname;
  } catch {
    return null;
  }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms))]);

// true = domain can receive mail, false = definitely cannot (doesn't exist /
// no mail records at all), null = couldn't tell (DNS timeout/server error) —
// callers must NOT treat null as a failure.
async function domainAcceptsMail(domain) {
  try {
    const mx = await withTimeout(dns.resolveMx(domain), DNS_TIMEOUT_MS);
    if (mx.length) return mx.some(r => r.exchange && r.exchange !== '.') ; // "." = "null MX": explicitly accepts no mail
  } catch (err) {
    if (err.code === 'ENOTFOUND') return false;
    if (err.code !== 'ENODATA') return null;
  }
  // No MX records: mail falls back to the domain's own A/AAAA record.
  try {
    const a = await withTimeout(dns.resolve4(domain), DNS_TIMEOUT_MS);
    return a.length > 0;
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') return false;
    return null;
  }
}

const pageText = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .toLowerCase();

// Does the site read as belonging to this business? >= 60% of the name's
// distinctive words must appear as whole words in the page.
async function siteMentionsBusiness(website, businessName) {
  // Two-letter tokens ("la", "jm") match almost any page, so they can't vouch for a business.
  const want = distinctiveTokens(stripLegalSuffix(businessName)).filter(t => t.length >= 3);
  if (!want.length) return { ok: null, note: 'name too short or generic to check against the website' };
  let html;
  try {
    html = await fetchPublicPage(/^https?:\/\//i.test(website) ? website : 'https://' + website);
  } catch (err) {
    return { ok: null, note: 'website could not be opened' };
  }
  const words = new Set(pageText(html).split(/[^a-z0-9]+/).filter(Boolean));
  const hits = want.filter(t => words.has(t)).length;
  return { ok: hits / want.length >= 0.6 };
}

// True when the email's own domain carries a distinctive word from the
// business's name (miradorgroup.com for "Mirador Group, Inc."). That is
// strong evidence the address belongs to this business even when its website
// can't be read (many sites are built in JavaScript and show no text).
function domainReflectsName(domain, businessName) {
  const label = registrableDomain(domain).split('.')[0].replace(/[^a-z0-9]/g, '');
  const want = distinctiveTokens(stripLegalSuffix(businessName)).filter(t => t.length >= 4);
  if (want.some(t => label.includes(t))) return true;
  // Short names ("MG Architects" -> mgarchitects.com): no single word is long
  // enough to trust alone, but ALL of the name's words appearing in the domain is.
  const all = String(stripLegalSuffix(businessName)).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !['of', 'the', 'and'].includes(t));
  return all.length >= 2 && all.every(t => label.includes(t));
}

// -> { status, reason }
//   verified       safe to send
//   invalid        malformed, or its domain cannot receive mail — never send
//   mismatch       address is on a different domain than the business's website
//   wrong_business the website doesn't appear to be this business
//   unreachable    couldn't open the website to confirm it (older rows only)
//   unknown        DNS was unavailable, so deliverability couldn't be checked
// checkSite: also confirm the website is this business. Only needed for rows
// whose Google match was never validated; new lookups already passed
// lib/placesMatch.js before the email was even looked for.
async function verifyEmail({ email, website, businessName, checkSite = false }) {
  const m = STRICT_EMAIL_RE.exec(String(email || '').trim());
  if (!m) return { status: 'invalid', reason: 'not a valid email address' };
  const domain = m[1].toLowerCase();

  const accepts = await domainAcceptsMail(domain);
  if (accepts === false) return { status: 'invalid', reason: `${domain} can't receive email` };
  if (accepts === null) return { status: 'unknown', reason: 'could not check whether the domain accepts email' };

  if (!WEBMAIL.has(domain) && domainReflectsName(domain, businessName)) return { status: 'verified', reason: null };

  const siteHost = website ? hostOf(website) : null;
  if (siteHost && !WEBMAIL.has(domain) && registrableDomain(siteHost) !== registrableDomain(domain)) {
    return { status: 'mismatch', reason: `email is on ${domain} but their website is ${registrableDomain(siteHost)}` };
  }

  // The email was published on this website, and the website's own domain
  // carries the business's name (livetobuild.com for "Live To Build, LLC") —
  // so the address is that business's even when the page text can't be read.
  if (siteHost && domainReflectsName(siteHost, businessName)) return { status: 'verified', reason: null };

  if (checkSite) {
    if (!website) return { status: 'unreachable', reason: 'no website on file to confirm this business' };
    const s = await siteMentionsBusiness(website, businessName);
    if (s.ok === false) return { status: 'wrong_business', reason: "their website doesn't appear to be this business" };
    if (s.ok === null) return { status: 'unreachable', reason: s.note };
  }
  return { status: 'verified', reason: null };
}

module.exports = { verifyEmail, domainAcceptsMail, registrableDomain, WEBMAIL };
