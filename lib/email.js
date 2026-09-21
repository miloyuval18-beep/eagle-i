// Transactional email via Resend, called with plain fetch — matches this
// codebase's hand-rolled fetch-wrapper style (routes/social.js, lib/anthropic.js)
// rather than pulling in an SDK dependency for one endpoint.
async function sendEmail({ to, subject, html, text, replyTo, fromName, fromAddress, headers }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not set on the server.');
  }
  const defaultFrom = process.env.RESEND_FROM_EMAIL || 'Eagle I <onboarding@resend.dev>';
  // The actual send address has to stay on a domain this Resend account has
  // verified (SPF/DKIM) — Resend, like any provider, rejects (or spam-flags)
  // a From address on a domain it doesn't control. What we CAN honestly do
  // is swap the display name to the tenant's business name, so a recipient
  // sees e.g. "ABC Roofing" <onboarding@resend.dev> instead of "Eagle I"
  // <...> — real per-tenant sending would need each tenant to verify their
  // own domain with Resend, a whole separate setup flow, not something
  // this code can do on their behalf.
  const addressMatch = defaultFrom.match(/<([^>]+)>\s*$/);
  // A company that has verified its own sending domain (lib/sendingDomain.js)
  // sends from its own address instead of the shared one.
  const senderAddress = fromAddress && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(fromAddress) ? fromAddress
    : (addressMatch ? addressMatch[1] : defaultFrom);
  // Quoted per RFC 5322 so a company name containing a comma, colon, or
  // quote (e.g. "Smith, Jones & Co") can't be misread as a second address
  // or break the header.
  const quotedName = fromName ? `"${fromName.replace(/[\\"]/g, '\\$&')}"` : null;
  const from = quotedName ? `${quotedName} <${senderAddress}>` : defaultFrom;

  const payload = { from, to: [to], subject, html, text };
  // Reply-To is either a reply+<kind>-<id>@<inbound domain> address this
  // app controls (see buildReplyToAddress — lets a reply be captured by
  // routes/inboundEmail.js and shown on the dashboard, then relayed on),
  // or — when inbound isn't configured — the tenant's own email directly,
  // so a reply still reaches them via plain email routing either way.
  // Omitted entirely when neither is available (reply then just goes to
  // `from`).
  if (replyTo) payload.reply_to = replyTo;
  // Extra message headers (e.g. List-Unsubscribe on outreach email).
  if (headers) payload.headers = headers;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });
  const body = await r.json();
  if (!r.ok) {
    throw new Error(body.message || `Resend request failed (${r.status})`);
  }
  return body; // { id }
}

// Fetches the full body of an email Resend received on our behalf — the
// email.received webhook itself only carries metadata (from/to/subject),
// not text/html, so this is a required second call to actually show a
// reply's content anywhere.
async function getReceivedEmail(emailId) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not set on the server.');
  }
  const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const body = await r.json();
  if (!r.ok) {
    throw new Error(body.message || `Resend request failed (${r.status})`);
  }
  return body; // { from, to, subject, html, text, ... }
}

const REPLY_KINDS = new Set(['vendor', 'review', 'partner']);

// A reply+<kind>-<id>@<inbound domain> address, unique per outreach send —
// how routes/inboundEmail.js's webhook matches an incoming reply back to
// the exact vendor_outreach/review_requests row it's for. Returns null
// when RESEND_INBOUND_DOMAIN isn't configured, so callers can fall back to
// reply-straight-to-the-tenant instead.
function buildReplyToAddress(kind, id) {
  if (!REPLY_KINDS.has(kind)) throw new Error(`Unknown reply kind "${kind}".`);
  const domain = process.env.RESEND_INBOUND_DOMAIN;
  if (!domain) return null;
  return `reply+${kind}-${id}@${domain}`;
}

module.exports = { sendEmail, getReceivedEmail, buildReplyToAddress };
