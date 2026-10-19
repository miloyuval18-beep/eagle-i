process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'tok';
const assert = require('assert/strict');
const { R } = require('./_local');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const pb = require(R + '/lib/crmPlaybooks'); const sms = require(R + '/lib/crmSms'); const intake = require(R + '/lib/crmIntake');
const texts = []; let bought = null;
sms.setHttp(async (url, opts) => {
  const j = (s, b) => ({ ok: s < 300, status: s, json: async () => b });
  if (/AvailablePhoneNumbers/.test(url)) return j(200, { available_phone_numbers: [{ phone_number: '+17135550199' }] });
  if (/IncomingPhoneNumbers/.test(url)) { bought = Object.fromEntries(new URLSearchParams(opts.body)); return j(201, { phone_number: bought.PhoneNumber, sid: 'PN1' }); }
  if (/Messages\.json/.test(url)) { const m = Object.fromEntries(new URLSearchParams(opts.body)); texts.push(m); return j(201, { sid: 'SM' + texts.length, status: 'queued' }); }
  return j(404, {});
});
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Text Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, address) VALUES ($1, '1001 S Dairy Ashford, Houston TX 77077')`, [t]);
    await assert.rejects(sms.provisionNumber({ tenantId: t, areaCode: '12', baseUrl: 'https://app.test' }), /area code/);
    const st = await sms.provisionNumber({ tenantId: t, areaCode: '713', baseUrl: 'https://app.test' });
    assert.equal(st.number, '+17135550199');
    assert.equal(bought.SmsUrl, 'https://app.test/api/twilio/sms');
    assert.equal(bought.VoiceUrl, 'https://app.test/api/twilio/voice');

    // A text from an unknown number: a new lead, consent from texting first.
    await sms.handleIncomingSms({ To: '+17135550199', From: '+17135550101', Body: 'Hi, do you do bathroom remodels?', MessageSid: 'SMin1' });
    await sms.handleIncomingSms({ To: '+17135550199', From: '+17135550101', Body: 'Hi, do you do bathroom remodels?', MessageSid: 'SMin1' }); // Twilio retry
    let deals = (await crm.listPipeline(t)).deals;
    assert.equal(deals.length, 1); assert.equal(deals[0].source, 'phone');
    const contact = (await query('SELECT * FROM crm_contacts WHERE tenant_id = $1', [t])).rows[0];
    assert.equal(contact.sms_consent, true);
    assert.equal((await query('SELECT COUNT(*)::int n FROM crm_messages WHERE tenant_id = $1', [t])).rows[0].n, 1, 'a retried webhook is stored once');
    assert.ok((await crm.listInbox(t)).some(i => /New lead by text/.test(i.title)));

    // Replying by hand.
    await sms.sendSms({ tenantId: t, contactId: contact.id, dealId: deals[0].id, body: 'Yes! When works for a visit?', userId: null });
    assert.equal(texts[0].To, '+17135550101'); assert.equal(texts[0].From, '+17135550199');
    assert.ok(!/STOP/.test(texts[0].Body), 'a one-to-one reply has no opt-out line');

    // A text playbook step: sent with the opt-out line.
    const list = await pb.listPlaybooks(t);
    const prop = list.find(x => x.key === 'proposal_follow_up');
    await pb.savePlaybook({ tenantId: t, id: prop.id, steps: [{ days: 0, channel: 'sms', message: 'Hi {name}, your proposal from {company} is in your inbox.' }] });
    await pb.approvePlaybook({ tenantId: t, id: prop.id });
    await crm.changeStage({ tenantId: t, dealId: deals[0].id, stage: 'proposal' });
    let r = await pb.processDueSends({ onlyDealId: deals[0].id });
    assert.equal(r.sent, 1, JSON.stringify(r));
    assert.match(texts[1].Body, /your proposal from Text Co is in your inbox\. Reply STOP to opt out\.$/);

    // STOP: no more automatic anything.
    await crm.changeStage({ tenantId: t, dealId: deals[0].id, stage: 'site_visit' });
    await crm.changeStage({ tenantId: t, dealId: deals[0].id, stage: 'proposal' });
    await sms.handleIncomingSms({ To: '+17135550199', From: '+17135550101', Body: 'STOP', MessageSid: 'SMin2' });
    assert.equal((await query('SELECT sms_opt_out FROM crm_contacts WHERE id = $1', [contact.id])).rows[0].sms_opt_out, true);
    assert.equal((await query(`SELECT COUNT(*)::int n FROM crm_playbook_sends WHERE deal_id = $1 AND status = 'pending'`, [deals[0].id])).rows[0].n, 0);
    await assert.rejects(sms.sendSms({ tenantId: t, contactId: contact.id, body: 'hello' }), /STOP/);

    // Missed calls: nothing goes out until the wording is approved; then once per 12 hours.
    await sms.saveSettings({ tenantId: t, forwardTo: '713-555-0100' });
    const ring = await sms.handleIncomingCall({ To: '+17135550199', From: '+18325550144', CallSid: 'CA1' }, { baseUrl: 'https://app.test' });
    assert.match(ring, /<Dial timeout="20"[^>]*action="https:\/\/app\.test\/api\/twilio\/call-done"[^>]*>\+17135550100<\/Dial>/);
    const before = texts.length;
    await sms.callFinished({ To: '+17135550199', From: '+18325550144', CallSid: 'CA1', DialCallStatus: 'no-answer' });
    assert.equal(texts.length, before, 'not approved: no text');
    assert.ok((await crm.listInbox(t)).some(i => /Missed call from \(832\) 555-0144/.test(i.title)));
    await sms.saveSettings({ tenantId: t, approve: true });
    await sms.handleIncomingCall({ To: '+17135550199', From: '+18325550144', CallSid: 'CA2' });
    await sms.callFinished({ To: '+17135550199', From: '+18325550144', CallSid: 'CA2', DialCallStatus: 'busy' });
    assert.equal(texts.length, before + 1);
    assert.match(texts[texts.length - 1].Body, /^Hi, this is Text Co\. Sorry we missed your call!/);
    await sms.handleIncomingCall({ To: '+17135550199', From: '+18325550144', CallSid: 'CA3' });
    await sms.callFinished({ To: '+17135550199', From: '+18325550144', CallSid: 'CA3', DialCallStatus: 'no-answer' });
    assert.equal(texts.length, before + 1, 'once per 12 hours');
    // Changing the wording needs a new OK.
    const st2 = await sms.saveSettings({ tenantId: t, missedCallText: 'Sorry we missed you! — {company}' });
    assert.equal(st2.missedCallApproved, false);
    // An answered call counts as picking the lead up.
    await sms.handleIncomingCall({ To: '+17135550199', From: '+12815550177', CallSid: 'CA4' });
    await sms.callFinished({ To: '+17135550199', From: '+12815550177', CallSid: 'CA4', DialCallStatus: 'completed', DialCallDuration: '240' });
    const ans = (await crm.listPipeline(t)).deals.find(d => d.contact_phone === '(281) 555-0177');
    assert.ok(ans.first_response_at);
    const callRow = (await query(`SELECT status, duration_seconds FROM crm_calls WHERE call_sid = 'CA4'`)).rows[0];
    assert.deepEqual(callRow, { status: 'answered', duration_seconds: 240 });

    // Website form: the "OK to text me" box records consent.
    const key = await intake.getIntakeKey(t);
    await intake.submitForm({ key, body: { name: 'Form Texter', phone: '713-555-0122', sms_consent: true } });
    assert.equal((await query(`SELECT sms_consent FROM crm_contacts WHERE tenant_id = $1 AND phone_digits = '7135550122'`, [t])).rows[0].sms_consent, true);
    console.log('SMS SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
