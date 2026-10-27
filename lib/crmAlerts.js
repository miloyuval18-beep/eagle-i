// Telling the owner when something unusual happens on the account: a lot
// deleted at once, someone made an admin, the company's email or address
// changed, online payments set up. It lands in Today and is emailed to the
// owner and admins (except whoever did it, who already knows).
const { query } = require('../db');
const { sendEmail } = require('./email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function ownerAlert({ tenantId, actorId = null, title, detail = '', key, send = sendEmail, appUrl = require('./appUrl').appUrl() }) {
  const crm = require('./crm');
  const added = await crm.addInboxItem({ tenantId, kind: 'security', dedupeKey: `alert:${key}`, title, detail }).catch(() => false);
  if (!added) return false; // already told
  const who = actorId ? (await query('SELECT COALESCE(name, email) AS n FROM users WHERE id = $1', [actorId])).rows[0] : null;
  const to = (await query(`SELECT email FROM users WHERE tenant_id = $1 AND role IN ('owner', 'admin') AND ($2::uuid IS NULL OR id <> $2)`, [tenantId, actorId])).rows.map(r => r.email).filter(e => EMAIL_RE.test(e || ''));
  const text = `${title}${who ? ` (by ${who.n})` : ''}.\n\n${detail}\n\nIf this was expected, there's nothing to do. If not, open Eagle I CRM: ${appUrl}/crm#needs`;
  for (const addr of to) {
    await send({ to: addr, subject: `Eagle I: ${title}`, text, html: `<div style="font-family:Arial,sans-serif;font-size:17px;color:#14202b;line-height:1.55;max-width:560px"><p><b>${esc(title)}</b>${who ? ` (by ${esc(who.n)})` : ''}.</p><p>${esc(detail)}</p><p>If this was expected, there’s nothing to do. If not, <a href="${appUrl}/crm#needs">open Eagle I CRM</a>.</p></div>` }).catch(e => console.error('[crmAlerts] email failed:', e.message));
  }
  return true;
}

// Called after anything goes to the recycle bin: five or more by one person in ten minutes.
async function checkMassDelete({ tenantId, userId }) {
  if (!userId) return false;
  const n = (await query(`SELECT COUNT(*)::int AS n FROM crm_trash WHERE tenant_id = $1 AND deleted_by = $2 AND deleted_at > now() - interval '10 minutes' AND mode = 'deleted'`, [tenantId, userId])).rows[0].n;
  if (n < 5) return false;
  return ownerAlert({ tenantId, actorId: userId, title: `${n} things were deleted in the last few minutes`, detail: 'Everything deleted stays in the recycle bin for 30 days (Account → Recycle bin), so it can all be put back.', key: `mass-delete:${userId}:${Math.floor(Date.now() / 3600000)}` });
}

module.exports = { ownerAlert, checkMassDelete };
