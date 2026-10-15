// Texting and calls in Eagle I CRM, through Twilio.
//
// Each company gets its own local number (bought through Eagle I's Twilio
// account: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN). Calls to it ring the
// company's real phone; texts to it land on the right deal.
//
// What happens on its own:
//  - a text from a number Eagle I doesn't know becomes a new lead (they
//    reached out, so replying by text is fine);
//  - any text in counts as a reply: that deal's sales follow-ups stop, it's on
//    the timeline, in "Needs you", and the deal owner gets an email;
//  - a call nobody answers gets one text back right away, in words the owner
//    approved once ("Sorry we missed you..."), and shows up as a lead;
//  - playbook steps can be sent as texts.
//
// The rules that keep it legal and polite:
//  - automatic texts (playbooks) only go to people who said yes to texts (the
//    form's checkbox, or they texted first), never to anyone who texted STOP,
//    and always end with how to stop;
//  - STOP / START are honoured the moment they arrive (Twilio's carrier-level
//    opt-out handles the confirmation reply);
//  - a missed-call text goes at most once per number every 12 hours.
// US business texting also needs the company registered for A2P 10DLC with
// the carriers; that's done once in Twilio (see README).
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('./email');
const crm = require('./crm');

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
const MAX_SMS = 600;
const DEFAULT_MISSED_TEXT = 'Hi, this is {company}. Sorry we missed your call! How can we help? You can reply right here by text.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

let httpOverride = null;
function setHttp(h) { httpOverride = h; }
const http = (...a) => (httpOverride || fetch)(...a);
const creds = () => (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN ? { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN } : null);

// US numbers to E.164 (+1XXXXXXXXXX); null when it isn't one.
function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10 && /^[2-9]/.test(d)) return '+1' + d;
  if (d.length === 11 && d[0] === '1' && /^[2-9]/.test(d[1])) return '+' + d;
  return null;
}
const pretty = (n) => { const d = String(n || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(n || ''); };

async function twilio(method, path, params = null) {
  const c = creds();
  if (!c) throw err('Texting is not set up on the Eagle I server yet.', 503);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${c.sid}${path}`;
  const opts = { method, headers: { Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64') } };
  if (params) { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(params).toString(); }
  const r = await http(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw err(body.message ? `Twilio: ${body.message}` : `Twilio request failed (${r.status}).`, 502);
  return body;
}

// Twilio signs every webhook: HMAC-SHA1 of the full URL plus the sorted form fields.
function signatureFor(url, params, token) {
  const data = url + Object.keys(params || {}).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}
function validSignature(url, params, signature) {
  const c = creds();
  if (!c || !signature) return false;
  const expected = signatureFor(url, params, c.token);
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const xmlEsc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const twiml = (inner = '') => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const textHash = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex');

// ---------- the company's number and settings ----------

async function status(tenantId) {
  const t = (await query('SELECT sms_number, company_name FROM tenants WHERE id = $1', [tenantId])).rows[0] || {};
  const s = await crm.getSettings(tenantId);
  const missedText = s.missedCallText || DEFAULT_MISSED_TEXT;
  return {
    available: !!creds(), number: t.sms_number || null, numberPretty: t.sms_number ? pretty(t.sms_number) : null,
    forwardTo: s.smsForwardTo || null, missedCallText: missedText, missedCallApproved: !!s.missedCallApproved && s.missedCallApproved === textHash(missedText)
  };
}

async function provisionNumber({ tenantId, areaCode, baseUrl }) {
  const ac = String(areaCode || '').replace(/\D/g, '');
  if (!/^[2-9]\d{2}$/.test(ac)) throw err('Enter a 3-digit area code, like 713.');
  const t = (await query('SELECT sms_number FROM tenants WHERE id = $1', [tenantId])).rows[0];
  if (t && t.sms_number) throw err('Your company already has a number.');
  const found = await twilio('GET', `/AvailablePhoneNumbers/US/Local.json?AreaCode=${ac}&SmsEnabled=true&VoiceEnabled=true&PageSize=1`);
  const pick = found.available_phone_numbers && found.available_phone_numbers[0];
  if (!pick) throw err(`No numbers are free in area code ${ac} right now. Try a nearby one.`);
  const bought = await twilio('POST', '/IncomingPhoneNumbers.json', {
    PhoneNumber: pick.phone_number, SmsUrl: `${baseUrl}/api/twilio/sms`, SmsMethod: 'POST', VoiceUrl: `${baseUrl}/api/twilio/voice`, VoiceMethod: 'POST',
    FriendlyName: `Eagle I CRM ${tenantId}`.slice(0, 64)
  });
  await query('UPDATE tenants SET sms_number = $2, sms_number_sid = $3 WHERE id = $1', [tenantId, bought.phone_number, bought.sid]);
  return status(tenantId);
}

async function saveSettings({ tenantId, forwardTo, missedCallText, approve }) {
  const patch = {};
  if (forwardTo !== undefined) {
    if (forwardTo && !e164(forwardTo)) throw err('Enter the US phone number calls should ring, like 713-555-0100.');
    patch.smsForwardTo = forwardTo ? e164(forwardTo) : null;
  }
  const cur = await crm.getSettings(tenantId);
  if (missedCallText !== undefined) {
    const t = String(missedCallText || '').trim().slice(0, 300);
    if (!t) throw err('Write the text that goes out after a missed call.');
    if (t !== (cur.missedCallText || DEFAULT_MISSED_TEXT)) { patch.missedCallText = t; patch.missedCallApproved = null; } // new words need a new OK
  }
  if (approve) patch.missedCallApproved = textHash(patch.missedCallText || cur.missedCallText || DEFAULT_MISSED_TEXT);
  if (approve === false) patch.missedCallApproved = null;
  await crm.saveSettings(tenantId, patch);
  return status(tenantId);
}

// ---------- sending ----------

async function companyFor(tenantId) {
  return (await query('SELECT company_name, sms_number FROM tenants WHERE id = $1', [tenantId])).rows[0] || {};
}

// `automated`: playbook texts need the person's yes, and say how to stop.
async function sendSms({ tenantId, contactId, dealId = null, body, userId = null, automated = false, reason = null }) {
  const co = await companyFor(tenantId);
  if (!co.sms_number) throw err('Get your company texting number first (Company details).');
  const contact = (await query('SELECT * FROM crm_contacts WHERE id = $1 AND tenant_id = $2', [contactId, tenantId])).rows[0];
  if (!contact) throw err('Contact not found.', 404);
  const to = e164(contact.phone);
  if (!to) throw err('This contact has no US mobile number.');
  if (contact.sms_opt_out) throw err('This person texted STOP, so they can’t be texted.');
  if (automated && !contact.sms_consent) throw err('This person hasn’t agreed to automatic texts.');
  let text = String(body || '').trim();
  if (!text) throw err('Write the text first.');
  if (automated && !/reply stop/i.test(text)) text += ' Reply STOP to opt out.';
  if (text.length > MAX_SMS) throw err(`Keep texts under ${MAX_SMS} characters.`);
  const msg = await twilio('POST', '/Messages.json', { From: co.sms_number, To: to, Body: text });
  await query(
    `INSERT INTO crm_messages (tenant_id, contact_id, deal_id, direction, body, from_number, to_number, twilio_sid, status, automated, user_id)
     VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, $8, $9, $10)`,
    [tenantId, contactId, dealId, text, co.sms_number, to, msg.sid || null, msg.status || 'queued', automated || !!reason, userId]);
  if (dealId) await crm.logActivity({ tenantId, dealId, kind: 'text', actor: userId ? 'owner' : 'eagle_i', userId, body: `Text: ${text.slice(0, 300)}`, meta: { reason } });
  if (dealId && userId) await query('UPDATE crm_deals SET first_response_at = COALESCE(first_response_at, now()) WHERE id = $1', [dealId]);
  return { sid: msg.sid, body: text };
}

async function listMessages(tenantId, dealId) {
  const deal = (await query('SELECT contact_id FROM crm_deals WHERE id = $1 AND tenant_id = $2', [dealId, tenantId])).rows[0];
  if (!deal) throw err('Deal not found.', 404);
  const c = (await query('SELECT phone, sms_consent, sms_opt_out FROM crm_contacts WHERE id = $1', [deal.contact_id])).rows[0] || {};
  const messages = (await query(
    `SELECT m.id, m.direction, m.body, m.created_at, m.automated, COALESCE(u.name, u.email) AS sender FROM crm_messages m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND m.contact_id = $2 ORDER BY m.created_at ASC LIMIT 300`, [tenantId, deal.contact_id])).rows;
  const calls = (await query(`SELECT status, duration_seconds, texted_back, created_at FROM crm_calls WHERE tenant_id = $1 AND contact_id = $2 ORDER BY created_at DESC LIMIT 20`, [tenantId, deal.contact_id])).rows;
  return { messages, calls, phone: c.phone || null, canText: !!e164(c.phone) && !c.sms_opt_out, consent: !!c.sms_consent, optedOut: !!c.sms_opt_out };
}

async function setConsent({ tenantId, dealId, consent }) {
  const r = await query(
    `UPDATE crm_contacts c SET sms_consent = $3 FROM crm_deals d WHERE d.id = $1 AND d.tenant_id = $2 AND c.id = d.contact_id RETURNING c.id`, [dealId, tenantId, !!consent]);
  if (!r.rowCount) throw err('Deal not found.', 404);
}

// ---------- incoming ----------

async function tenantByNumber(to) {
  const n = e164(to);
  if (!n) return null;
  const t = (await query(`SELECT id, company_name, products FROM tenants WHERE sms_number = $1`, [n])).rows[0];
  return t && Array.isArray(t.products) && t.products.includes('crm') ? t : null;
}

// The person behind a number: an existing contact, or a new lead.
async function contactFor({ tenant, from, firstWords, via, baseUrl = '' }) {
  const digits = crm.phoneDigits(from);
  let contact = digits ? (await query('SELECT * FROM crm_contacts WHERE tenant_id = $1 AND phone_digits = $2 ORDER BY created_at LIMIT 1', [tenant.id, digits])).rows[0] : null;
  let deal = null, isNew = false;
  if (contact) {
    deal = (await query(`SELECT * FROM crm_deals WHERE tenant_id = $1 AND contact_id = $2 ORDER BY (stage IN ('complete', 'lost')), updated_at DESC LIMIT 1`, [tenant.id, contact.id])).rows[0] || null;
  }
  if (!deal) {
    const settings = await crm.getSettings(tenant.id);
    deal = await crm.createDeal({
      tenantId: tenant.id, name: contact ? contact.name : `Caller ${pretty(from)}`, phone: pretty(from), title: null, stage: 'new', source: 'phone',
      note: firstWords || `Came in by ${via}.`, actor: 'contact', ownerUserId: settings.leadOwnerUserId, baseUrl
    });
    contact = (await query('SELECT * FROM crm_contacts WHERE id = $1', [deal.contact_id])).rows[0];
    isNew = true;
  }
  return { contact, deal, isNew };
}

async function tellTeam({ deal, subject, body }) {
  const r = (await query(
    `SELECT COALESCE(u.email, bp.email) AS e FROM crm_deals d LEFT JOIN users u ON u.id = d.owner_user_id LEFT JOIN business_profile bp ON bp.tenant_id = d.tenant_id WHERE d.id = $1`, [deal.id])).rows[0];
  if (r && EMAIL_RE.test(String(r.e || ''))) await sendEmail({ to: r.e, subject: subject.slice(0, 150), html: `<p>${String(body).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])).replace(/\n/g, '<br>')}</p><p>Open Eagle I CRM to reply.</p>`, text: `${body}\n\nOpen Eagle I CRM to reply.` }).catch(() => {});
}

async function handleIncomingSms(p, { baseUrl = '' } = {}) {
  const tenant = await tenantByNumber(p.To);
  if (!tenant) return twiml();
  const from = e164(p.From);
  const body = String(p.Body || '').trim().slice(0, 1600);
  if (p.MessageSid && (await query('SELECT 1 FROM crm_messages WHERE twilio_sid = $1', [p.MessageSid])).rows.length) return twiml(); // Twilio retried
  const word = body.toLowerCase().replace(/[^a-z]/g, '');
  const digits = crm.phoneDigits(from);
  if (STOP_WORDS.has(word)) {
    await query('UPDATE crm_contacts SET sms_opt_out = true, sms_consent = false WHERE tenant_id = $1 AND phone_digits = $2', [tenant.id, digits]);
    await require('./crmPlaybooks').cancelForPhone(tenant.id, digits, 'opted_out');
    return twiml(); // the carrier-level opt-out sends the confirmation
  }
  if (START_WORDS.has(word) && word !== 'yes') {
    await query('UPDATE crm_contacts SET sms_opt_out = false WHERE tenant_id = $1 AND phone_digits = $2', [tenant.id, digits]);
    return twiml();
  }
  const { contact, deal, isNew } = await contactFor({ tenant, from, firstWords: body, via: 'text', baseUrl });
  // They texted first: replying by text, including automatic follow-ups, is fine.
  await query('UPDATE crm_contacts SET sms_consent = true, sms_opt_out = false WHERE id = $1', [contact.id]);
  await query(
    `INSERT INTO crm_messages (tenant_id, contact_id, deal_id, direction, body, from_number, to_number, twilio_sid, status) VALUES ($1, $2, $3, 'in', $4, $5, $6, $7, 'received')`,
    [tenant.id, contact.id, deal.id, body || '(no text)', from, e164(p.To), p.MessageSid || null]);
  if (!isNew) {
    await crm.logActivity({ tenantId: tenant.id, dealId: deal.id, kind: 'reply', actor: 'contact', body: `Text: ${body.slice(0, 300)}` });
    await require('./crmPlaybooks').cancelForDeal(deal.id, 'replied', { trigger: 'stage' });
  }
  await crm.addInboxItem({ tenantId: tenant.id, dealId: deal.id, kind: isNew ? 'waiting_lead' : 'reply', dedupeKey: isNew ? `waiting:${deal.id}` : `text:${p.MessageSid || Date.now()}`, title: isNew ? `New lead by text from ${pretty(from)}` : `${contact.name} texted`, detail: body.slice(0, 600) });
  await tellTeam({ deal, subject: isNew ? `New lead by text: ${pretty(from)}` : `Text from ${contact.name}`, body: `${isNew ? 'A new lead texted your Eagle I number' : `${contact.name} texted`}:\n\n${body}` });
  return twiml();
}

async function handleIncomingCall(p, { baseUrl = '' } = {}) {
  const tenant = await tenantByNumber(p.To);
  if (!tenant) return twiml('<Say>This number is not in service.</Say><Hangup/>');
  await query(`INSERT INTO crm_calls (tenant_id, from_number, call_sid, status) VALUES ($1, $2, $3, 'ringing') ON CONFLICT (call_sid) DO NOTHING`, [tenant.id, e164(p.From), p.CallSid || null]);
  const s = await crm.getSettings(tenant.id);
  if (s.smsForwardTo) {
    // Ring the company's real phone; /call-done hears whether anyone picked up.
    return twiml(`<Dial timeout="20" answerOnBridge="true" action="${xmlEsc(baseUrl + '/api/twilio/call-done')}" method="POST">${xmlEsc(s.smsForwardTo)}</Dial>`);
  }
  await callFinished({ ...p, DialCallStatus: 'no-answer' }, { baseUrl });
  return twiml(`<Say>Thanks for calling ${xmlEsc(tenant.company_name)}. We’ll text you right back.</Say><Hangup/>`);
}

// After the forward: answered, or missed (no answer / busy / failed).
async function callFinished(p, { baseUrl = '' } = {}) {
  const tenant = await tenantByNumber(p.To);
  if (!tenant) return twiml();
  const answered = p.DialCallStatus === 'completed';
  const from = e164(p.From);
  const { contact, deal, isNew } = await contactFor({ tenant, from, firstWords: answered ? 'Called in (answered).' : 'Called in; nobody picked up.', via: 'phone call', baseUrl });
  await query(
    `UPDATE crm_calls SET status = $2, duration_seconds = $3, contact_id = $4, deal_id = $5 WHERE call_sid = $1`,
    [p.CallSid || null, answered ? 'answered' : 'missed', answered ? parseInt(p.DialCallDuration, 10) || null : null, contact.id, deal.id]);
  if (answered) {
    await crm.logActivity({ tenantId: tenant.id, dealId: deal.id, kind: 'call', actor: 'contact', body: `Phone call, answered (${Math.round((parseInt(p.DialCallDuration, 10) || 0) / 60)} min).` });
    await query('UPDATE crm_deals SET first_response_at = COALESCE(first_response_at, now()) WHERE id = $1', [deal.id]);
    await crm.resolveInbox(tenant.id, `waiting:${deal.id}`);
    return twiml();
  }
  await crm.logActivity({ tenantId: tenant.id, dealId: deal.id, kind: 'call', actor: 'contact', body: 'Missed call.' });
  let texted = false;
  const st = await status(tenant.id);
  const recent = (await query(`SELECT 1 FROM crm_calls WHERE tenant_id = $1 AND from_number = $2 AND texted_back = true AND created_at > now() - interval '12 hours'`, [tenant.id, from])).rows.length;
  if (st.missedCallApproved && !recent && !contact.sms_opt_out && from) {
    const text = st.missedCallText.replace(/\{company\}/g, tenant.company_name || 'us');
    try {
      await sendSms({ tenantId: tenant.id, contactId: contact.id, dealId: deal.id, body: text, reason: 'missed_call' });
      await query('UPDATE crm_calls SET texted_back = true WHERE call_sid = $1', [p.CallSid || null]);
      texted = true;
    } catch (e) { console.error('[crmSms] missed-call text failed:', e.message); }
  }
  await crm.addInboxItem({ tenantId: tenant.id, dealId: deal.id, kind: 'waiting_lead', dedupeKey: `call:${p.CallSid || Date.now()}`, title: `Missed call from ${isNew ? pretty(from) : contact.name}`, detail: texted ? 'Eagle I texted them back right away.' : 'Call them back.' });
  await tellTeam({ deal, subject: `Missed call: ${isNew ? pretty(from) : contact.name}`, body: `You missed a call from ${isNew ? pretty(from) : `${contact.name} (${pretty(from)})`}.${texted ? ' Eagle I texted them back right away.' : ''}` });
  return twiml(`<Say>Sorry we missed you. We’ll be in touch shortly.</Say><Hangup/>`);
}

module.exports = {
  DEFAULT_MISSED_TEXT, e164, pretty, signatureFor, validSignature, setHttp, textHash,
  status, provisionNumber, saveSettings, sendSms, listMessages, setConsent, handleIncomingSms, handleIncomingCall, callFinished
};
