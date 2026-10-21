// The homeowner pulse in Eagle I CRM: hearing early when someone is unhappy.
//
// While a job is under construction, the homeowner gets a two-line email every
// two weeks: "How is it going? Tap a number, 1 to 5." One tap answers (with
// room for a comment). A 3 or lower lands in Needs you and emails whoever owns
// the deal, while there's still time to fix it; every answer shows on the
// deal and in the weekly report. Off until the company switches it on (which
// is their approval of the fixed wording), in the homeowner's language, never
// to anyone who unsubscribed, weekdays 9-5 Central.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('./email');
const crm = require('./crm');

const EVERY_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const WORDS = {
  en: { subject: 'How is your project going?', hi: 'Hi {first},', ask: 'Quick question from {company}: how is your {title} project going so far? Tap a number.', low: 'Not happy', high: 'Very happy', why: 'Every answer goes straight to the team, and if something isn’t right we want to fix it now.' },
  es: { subject: '¿Cómo va su proyecto?', hi: 'Hola {first}:', ask: 'Una pregunta rápida de {company}: ¿cómo va su proyecto ({title}) hasta ahora? Toque un número.', low: 'Nada contento', high: 'Muy contento', why: 'Cada respuesta llega directo al equipo, y si algo no está bien queremos arreglarlo ahora.' }
};
const fill = (t, v) => t.replace(/\{(\w+)\}/g, (m, k) => (v[k] == null ? '' : String(v[k]))).replace(/ +([:,])/g, '$1');

async function pulseOn(tenantId) {
  const r = (await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [tenantId])).rows[0];
  return !!(r && r.crm_settings && r.crm_settings.pulseOn);
}
async function setPulse(tenantId, on) {
  const r = (await query('SELECT crm_settings FROM business_profile WHERE tenant_id = $1', [tenantId])).rows[0];
  await query('UPDATE business_profile SET crm_settings = $1 WHERE tenant_id = $2', [JSON.stringify({ ...((r && r.crm_settings) || {}), pulseOn: !!on }), tenantId]);
  return { on: !!on };
}

function composePulse({ lang, first, company, title, link, unsubscribeUrl, address }) {
  const w = WORDS[lang] || WORDS.en;
  const v = { first, company, title };
  const btn = (n) => `<a href="${link}?s=${n}" style="display:inline-block;width:44px;height:44px;line-height:44px;margin:0 4px 4px 0;text-align:center;border:1.5px solid #8794a0;border-radius:8px;color:#14202b;text-decoration:none;font-weight:bold;font-size:20px">${n}</a>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:17px;color:#14202b;max-width:560px;line-height:1.5"><p>${esc(fill(w.hi, v))}</p><p>${esc(fill(w.ask, v))}</p>
<p style="margin:16px 0 4px">${[1, 2, 3, 4, 5].map(btn).join('')}</p><p style="font-size:14px;color:#55636f;margin:0 0 16px">1 = ${esc(w.low)} · 5 = ${esc(w.high)}</p><p>${esc(w.why)}</p>
<p style="color:#55636f;font-size:14px;margin-top:24px">${esc(company)}${address ? ' · ' + esc(address) : ''}${unsubscribeUrl ? ` · <a href="${unsubscribeUrl}" style="color:#55636f">${lang === 'es' ? 'Cancelar suscripción' : 'Unsubscribe'}</a>` : ''}</p></div>`;
  const text = `${fill(w.hi, v)}\n\n${fill(w.ask, v)}\n\n${[1, 2, 3, 4, 5].map(n => `${n}: ${link}?s=${n}`).join('\n')}\n(1 = ${w.low}, 5 = ${w.high})\n\n${w.why}\n\n${company}${address ? ' · ' + address : ''}${unsubscribeUrl ? `\n${lang === 'es' ? 'Cancelar suscripción' : 'Unsubscribe'}: ${unsubscribeUrl}` : ''}`;
  return { subject: w.subject, html, text };
}

// Every tick: jobs under construction that are due a check-in.
async function processPulses({ now = new Date(), send = sendEmail, baseUrl = process.env.RENDER_EXTERNAL_URL || '' } = {}) {
  if (!require('./followUps').inSendWindow(now)) return { sent: 0 };
  const due = (await query(
    `SELECT d.id, d.tenant_id, d.title, c.name, c.email, c.language, t.company_name, bp.address
     FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id JOIN tenants t ON t.id = d.tenant_id JOIN business_profile bp ON bp.tenant_id = d.tenant_id
     WHERE d.stage = 'production' AND 'crm' = ANY(t.products) AND (bp.crm_settings->>'pulseOn')::boolean = true
       AND d.stage_entered_at < $1::timestamptz - interval '6 days'
       AND NOT EXISTS (SELECT 1 FROM crm_pulses p WHERE p.deal_id = d.id AND p.sent_at > $1::timestamptz - make_interval(days => $2))
       AND NOT EXISTS (SELECT 1 FROM outreach_suppressions s WHERE s.tenant_id = d.tenant_id AND LOWER(s.email) = LOWER(c.email))
     LIMIT 50`, [now, EVERY_DAYS])).rows;
  let sent = 0;
  const outreach = require('./vendorOutreach');
  for (const d of due) {
    if (!EMAIL_RE.test(String(d.email || '').trim())) continue;
    const token = crypto.randomBytes(24).toString('hex');
    const base = ((await query(`SELECT base_url FROM crm_playbook_sends WHERE tenant_id = $1 AND base_url <> '' ORDER BY due_at DESC LIMIT 1`, [d.tenant_id])).rows[0] || {}).base_url || baseUrl;
    const mail = composePulse({ lang: d.language === 'es' ? 'es' : 'en', first: String(d.name || '').split(/\s+/)[0], company: d.company_name, title: d.title, link: `${base}/pulse/${token}`, unsubscribeUrl: outreach.buildUnsubscribeUrl(base, d.tenant_id, d.email.trim()) + (d.language === 'es' ? '&lang=es' : ''), address: d.address });
    try {
      await query('INSERT INTO crm_pulses (tenant_id, deal_id, token, sent_at) VALUES ($1, $2, $3, $4)', [d.tenant_id, d.id, token, now]);
      const fromAddress = await require('./sendingDomain').getVerifiedFromAddress(d.tenant_id);
      await send({ to: d.email.trim(), ...mail, fromName: d.company_name, fromAddress: fromAddress || undefined });
      await crm.logActivity({ tenantId: d.tenant_id, dealId: d.id, kind: 'email', actor: 'eagle_i', body: 'Sent the “how is it going?” check-in.' });
      sent++;
    } catch (e) { console.error('[crmPulse] send failed:', e.message); }
  }
  return { sent };
}

async function pulseByToken(token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ''))) return null;
  return (await query(
    `SELECT p.*, d.title, d.owner_user_id, c.name AS contact_name, c.language, t.company_name FROM crm_pulses p JOIN crm_deals d ON d.id = p.deal_id
     JOIN crm_contacts c ON c.id = d.contact_id JOIN tenants t ON t.id = p.tenant_id WHERE p.token = $1`, [token])).rows[0] || null;
}
async function pulseInfo(token) {
  const p = await pulseByToken(token);
  if (!p) return null;
  return { company: p.company_name, title: p.title, name: p.contact_name, lang: p.language || null, score: p.score, comment: p.comment };
}

// One tap (from the email) sets the score; the page can add a comment or change it.
async function answer({ token, score, comment }) {
  const p = await pulseByToken(token);
  if (!p) throw err('This link is not valid.', 404);
  const s = parseInt(score, 10);
  if (!(s >= 1 && s <= 5)) throw err('Pick a number from 1 to 5.');
  if (new Date() - new Date(p.sent_at) > 60 * 86400000) throw err('This check-in has closed. Please reach out to the team directly.');
  const note = String(comment || '').trim().slice(0, 2000) || null;
  const first = !p.answered_at;
  await query('UPDATE crm_pulses SET score = $2, comment = COALESCE($3, comment), answered_at = now() WHERE id = $1', [p.id, s, note]);
  if (first || note || s !== p.score) {
    await crm.logActivity({ tenantId: p.tenant_id, dealId: p.deal_id, kind: 'reply', actor: 'contact', body: `Check-in: ${s} out of 5${note ? ` · “${note.slice(0, 300)}”` : ''}` });
  }
  if (s <= 3) {
    await crm.addInboxItem({ tenantId: p.tenant_id, dealId: p.deal_id, kind: 'unhappy', dedupeKey: `pulse:${p.id}`, title: `${p.contact_name} rated the job ${s} out of 5`, detail: note || 'Give them a call today, before it turns into a bad review.' });
    // A comment added (or the score changed) after the first answer: the item says so.
    await query(`UPDATE crm_inbox SET title = $3, detail = COALESCE($4, detail) WHERE tenant_id = $1 AND dedupe_key = $2`, [p.tenant_id, `pulse:${p.id}`, `${p.contact_name} rated the job ${s} out of 5`, note ? `“${note.slice(0, 600)}” Give them a call today, while it’s easy to fix.` : null]);
    const who = (await query(`SELECT COALESCE(u.email, bp.email) AS e FROM crm_deals d LEFT JOIN users u ON u.id = d.owner_user_id LEFT JOIN business_profile bp ON bp.tenant_id = d.tenant_id WHERE d.id = $1`, [p.deal_id])).rows[0];
    if (who && EMAIL_RE.test(String(who.e || '')) && (first || note)) {
      const body = `${p.contact_name} answered the check-in on “${p.title}” with ${s} out of 5.${note ? `\n\nThey wrote: “${note}”` : ''}\n\nCall them today, while it’s easy to fix.`;
      await sendEmail({ to: who.e, subject: `${p.contact_name} rated the job ${s}/5`, html: `<p style="white-space:pre-wrap">${esc(body)}</p>`, text: body }).catch(() => {});
    }
  }
  return { score: s };
}

async function dealPulses(tenantId, dealId) {
  return (await query('SELECT score, comment, sent_at, answered_at FROM crm_pulses WHERE tenant_id = $1 AND deal_id = $2 ORDER BY sent_at DESC LIMIT 20', [tenantId, dealId])).rows;
}

module.exports = { EVERY_DAYS, WORDS, composePulse, pulseOn, setPulse, processPulses, pulseInfo, answer, dealPulses };
