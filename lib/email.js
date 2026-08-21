// Transactional email via Resend, called with plain fetch — matches this
// codebase's hand-rolled fetch-wrapper style (routes/social.js, lib/anthropic.js)
// rather than pulling in an SDK dependency for one endpoint.
async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not set on the server.');
  }
  const from = process.env.RESEND_FROM_EMAIL || 'Eagle I <onboarding@resend.dev>';

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ from, to: [to], subject, html, text })
  });
  const body = await r.json();
  if (!r.ok) {
    throw new Error(body.message || `Resend request failed (${r.status})`);
  }
  return body; // { id }
}

module.exports = { sendEmail };
