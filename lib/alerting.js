// Minimal crash/error alerting — no new external account needed, reuses the
// Resend wiring that already exists for transactional email. This is not a
// substitute for real uptime monitoring (which watches from outside and
// catches the server being unreachable at all) — it only catches errors the
// process itself is still alive to report. See ADMIN_ALERT_EMAIL below.
const { sendEmail } = require('./email');

const ALERT_TO = process.env.ADMIN_ALERT_EMAIL || 'miloyuval18@gmail.com';
const COOLDOWN_MS = 10 * 60 * 1000; // one alert per kind per 10 min — a crash loop shouldn't flood the inbox
const lastSentAt = new Map();

async function sendCrashAlert(kind, message, extra = '') {
  // Never let alerting itself take down the process or mask the real error.
  try {
    if (!process.env.RESEND_API_KEY) {
      console.error(`[alert suppressed — RESEND_API_KEY not set] ${kind}: ${message}`);
      return;
    }
    const now = Date.now();
    const last = lastSentAt.get(kind) || 0;
    if (now - last < COOLDOWN_MS) return; // already alerted recently for this kind
    lastSentAt.set(kind, now);

    await sendEmail({
      to: ALERT_TO,
      subject: `⚠ Eagle I server error: ${kind}`,
      text: `${message}\n\n${extra}\n\nTime: ${new Date().toISOString()}`,
      html: `<p><strong>${kind}</strong></p><pre style="white-space:pre-wrap;font-size:13px">${message}</pre><pre style="white-space:pre-wrap;font-size:11px;color:#666">${extra}</pre><p style="color:#888;font-size:12px">${new Date().toISOString()}</p>`
    });
  } catch (alertErr) {
    console.error('Failed to send crash alert email:', alertErr.message);
  }
}

module.exports = { sendCrashAlert };
