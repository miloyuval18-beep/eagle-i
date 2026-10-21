// Email watch: from the team's Gmail, who owes whom an answer. Follow-ups for
// unanswered emails, reminders for emails waiting on us, owners told when it
// drags on, promises and deadlines as tasks, newsletters and robots skipped,
// a colleague's answer settling it, and the morning email.
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-only';
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const prompts = [];
// The stand-in AI: judges each email by its subject.
const JUDGE = {
  'Framing price for the Ruiz addition': { expects: true, importance: 'normal', reason: 'Waiting on their framing price' },
  'Water leaking under the sink!': { expects: true, importance: 'urgent', reason: 'Active leak under the new sink' },
  'Inspection Thursday': { expects: true, importance: 'high', reason: 'Needs the permit card on site', deadline: 'DEADLINE' },
  'Thanks!': { expects: false, importance: 'low', reason: '' },
  'Revised estimate': { expects: false, importance: 'normal', reason: '', promise: { task: 'Send Dana the revised estimate', by: 'PROMISE' } },
  'Question about the bid': { expects: true, importance: 'high', reason: 'Asked what the bid includes' },
  'Cabinet delivery': { expects: true, importance: 'high', reason: 'Asked for a delivery window' },
  'Tile samples': { expects: true, importance: 'normal', reason: 'Waiting on tile samples' }
};
let DEADLINE = '', PROMISE = '';
require.cache[require.resolve(R + '/lib/anthropic')] = { exports: { ...require(R + '/lib/anthropic'), generateJSON: async (p) => {
  prompts.push(p);
  if (/sort a remodeling/.test(p)) {
    const items = JSON.parse(p.split('<emails>')[1].split('</emails>')[0]);
    return { emails: items.map(i => { const j = JUDGE[String(i.subject).replace(/^Re:\s*/i, '')] || { expects: false, importance: 'low' }; return { id: i.id, ...j, deadline: j.deadline === 'DEADLINE' ? DEADLINE : null, promise: j.promise ? { ...j.promise, by: PROMISE } : null }; }) };
  }
  if (/follow-up email/.test(p)) return { body: 'Hi Gulf,\n\nAny update on the framing price for the Ruiz addition?\n\nThanks,\nSam' };
  return {};
} } };
const { query, pool } = require(R + '/db');
const g = require(R + '/lib/crmGoogle');
const w = require(R + '/lib/crmEmailWatch');
const crm = require(R + '/lib/crm'); const jobs = require(R + '/lib/crmJobs'); const daily = require(R + '/lib/crmDaily');
const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

// A Wednesday, 10am Central, in the last week (working hours).
const NOW = (() => { const d = new Date(); d.setUTCHours(15, 0, 0, 0); while (d.getUTCDay() !== 3 || d > new Date()) d.setUTCDate(d.getUTCDate() - 1); return d; })();
const ago = (days, hours = 0) => new Date(NOW.getTime() - days * 86400000 - hours * 3600000);
const ymd = (d) => d.toISOString().slice(0, 10);

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Levi Test Homes', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Watch Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const sa = { client_email: 'eaglei@sa.test', private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token' };
    await query(`INSERT INTO business_profile (tenant_id, email, phone) VALUES ($1, 'office@levi.test', '713-555-0300')`, [t]);
    await query(`INSERT INTO crm_google_connections (tenant_id, domain, admin_email) VALUES ($1, 'levi.test', 'pat@levi.test')`, [t]);
    const pat = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'pat@levi.test', 'x', 'Pat Owner', 'owner') RETURNING id`, [t])).rows[0].id;
    const sam = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'sam@levi.test', 'x', 'Sam Builder', 'member') RETURNING id`, [t])).rows[0].id;
    const kim = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'kim@levi.test', 'x', 'Kim Office', 'member') RETURNING id`, [t])).rows[0].id;
    const mbSam = (await query(`INSERT INTO crm_mailboxes (tenant_id, email, name) VALUES ($1, 'sam@levi.test', 'Sam') RETURNING *`, [t])).rows[0];
    const mbKim = (await query(`INSERT INTO crm_mailboxes (tenant_id, email, name) VALUES ($1, 'kim@levi.test', 'Kim') RETURNING *`, [t])).rows[0];
    const deal = await crm.createDeal({ tenantId: t, name: 'Dana Ruiz', email: 'dana@owner.test', title: 'Ruiz addition', userId: sam, ownerUserId: sam });
    const gulf = await jobs.saveVendor({ tenantId: t, body: { name: 'Gulf Framing', trade: 'Framing', email: 'bids@gulfframing.test' } });
    DEADLINE = ymd(new Date(NOW.getTime() + 1 * 86400000)); PROMISE = ymd(new Date(NOW.getTime() + 2 * 86400000));

    // Sam's mailbox.
    const M = (id, thread, { from, to, cc = '', subject, at, body = '', extra = {}, labels = ['INBOX'] }) => ({ id, threadId: thread, labelIds: labels, internalDate: String(at.getTime()), snippet: body.slice(0, 120),
      payload: { mimeType: 'text/plain', headers: [['From', from], ['To', to], ['Cc', cc], ['Subject', subject], ['Date', at.toUTCString()], ['Message-ID', `<${id}@mail.test>`], ...Object.entries(extra)].filter(h => h[1]).map(([name, value]) => ({ name, value })), body: { data: b64(body) } } });
    const box = [
      M('m1', 't1', { from: 'Sam Builder <sam@levi.test>', to: 'Gulf Framing <bids@gulfframing.test>', subject: 'Framing price for the Ruiz addition', at: ago(7), body: 'Can you get me a price for framing the Ruiz addition by Friday?', labels: ['SENT'] }),
      M('m2', 't2', { from: 'Dana Ruiz <dana@owner.test>', to: 'sam@levi.test', subject: 'Water leaking under the sink!', at: ago(0, 3), body: 'There is water all over the floor under the new sink. Can someone come today?' }),
      M('m3', 't3', { from: 'Builder Weekly <news@builderweekly.test>', to: 'sam@levi.test', subject: 'This week in building', at: ago(1), body: 'Top stories', extra: { 'List-Unsubscribe': '<mailto:unsub@builderweekly.test>' } }),
      M('m4', 't4', { from: 'Home Depot <noreply@homedepot.test>', to: 'sam@levi.test', subject: 'Your order shipped', at: ago(1), body: 'Order 123 shipped' }),
      M('m5', 't5', { from: 'City Inspector <inspector@city.test>', to: 'sam@levi.test', subject: 'Inspection Thursday', at: ago(2), body: 'Framing inspection Thursday 9am. Please have the permit card on site and reply to confirm.' }),
      M('m6', 't6', { from: 'sam@levi.test', to: 'bob@supplier.test', subject: 'Thanks!', at: ago(5), body: 'Thanks Bob, got it.', labels: ['SENT'] }),
      M('m7', 't7', { from: 'sam@levi.test', to: 'Dana Ruiz <dana@owner.test>', subject: 'Revised estimate', at: ago(1), body: 'I will send you the revised estimate by Friday.', labels: ['SENT'] }),
      M('m8', 't8', { from: 'Lee Park <lee@client.test>', to: 'sam@levi.test', subject: 'Question about the bid', at: ago(6), body: 'What does the bid include for trim?' }),
      M('m9', 't9', { from: 'Promo <deals@lumber.test>', to: 'sam@levi.test', subject: '20% off lumber', at: ago(1), body: 'Sale', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
      M('m10', 't10', { from: 'Old Friend <old@client.test>', to: 'sam@levi.test', subject: 'Long ago', at: ago(40), body: 'Hello?' }),
      M('m11', 't11', { from: 'Ann Cabinets <ann@cabinets.test>', to: 'info@levi.test', subject: 'Cabinet delivery', at: ago(3), body: 'What delivery window works for the Ruiz job?' }),
      M('m12', 't12', { from: 'Kim Office <kim@levi.test>', to: 'sam@levi.test', subject: 'Lunch?', at: ago(1), body: 'Lunch today?' })
    ];
    const reads = [];
    const httpFor = (msgs) => async (url) => {
      const json = (o) => ({ ok: true, status: 200, json: async () => o });
      const u = String(url);
      if (/oauth2/.test(u)) return json({ access_token: 'tok', expires_in: 3600 });
      if (/messages\?/.test(u)) return json({ messages: [...msgs].sort((a, b) => b.internalDate - a.internalDate).map(m => ({ id: m.id })) });
      const id = decodeURIComponent(u.split('/messages/')[1].split('?')[0]);
      const m = msgs.find(x => x.id === id);
      if (/format=full/.test(u)) reads.push(id);
      return json(m);
    };
    await g.syncMailbox({ tenantId: t, domain: 'levi.test', mailbox: { ...mbSam, last_internal_date: String(ago(45).getTime()) }, http: httpFor(box), sa, now: NOW });

    // 1. What's watched: not the newsletter, the robot, the promotion, the old one, or the colleague.
    const rows = (await query('SELECT thread_id, state, importance, expects, user_id FROM crm_mail_threads WHERE tenant_id = $1 ORDER BY thread_id', [t])).rows;
    const by = Object.fromEntries(rows.map(r => [r.thread_id, r]));
    for (const skip of ['t3', 't4', 't9', 't10', 't12']) assert.ok(!by[skip], `skips ${skip}`);
    assert.equal(by.t1.state, 'waiting'); assert.equal(by.t2.state, 'to_reply'); assert.equal(by.t2.importance, 'urgent');
    assert.equal(by.t6.state, 'closed', 'a thank-you expects nothing'); assert.equal(by.t7.state, 'closed');
    assert.ok(by.t11, 'email to the shared address is watched once');
    assert.equal(by.t1.user_id, sam);
    assert.ok(!reads.includes('m3') && !reads.includes('m4'), 'skipped email is never read');
    const cols = (await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'crm_mail_threads'`)).rows.map(r => r.column_name);
    assert.ok(!cols.some(c => /body|text/.test(c)), 'no email text is kept');
    // Promises and deadlines become tasks.
    const tasks = (await query(`SELECT title, due_at, assignee_user_id FROM crm_tasks WHERE tenant_id = $1 ORDER BY title`, [t])).rows;
    assert.ok(tasks.some(x => x.title === 'Send Dana the revised estimate' && x.assignee_user_id === sam && ymd(new Date(x.due_at)) === PROMISE), 'the promise is a task');
    assert.ok(tasks.some(x => /permit card/.test(x.title)), 'the deadline is a task');

    // 2. Kim's mailbox has the shared-address email too (watched once), and Kim answered Lee.
    await w.observe({ tenantId: t, mailbox: mbKim, msg: box.find(m => m.id === 'm11'), isCompany: (e) => e.endsWith('@levi.test'), mailboxes: new Set(['sam@levi.test', 'kim@levi.test']), userId: kim, now: NOW });
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_mail_threads WHERE tenant_id = $1 AND subject = 'Cabinet delivery'`, [t])).rows[0].n, 1);
    await w.observe({ tenantId: t, mailbox: mbKim, msg: M('k1', 'kt1', { from: 'kim@levi.test', to: 'lee@client.test', subject: 'RE: Question about the bid', at: ago(5), body: 'Trim is included.', labels: ['SENT'] }), isCompany: (e) => e.endsWith('@levi.test'), userId: kim, now: NOW });
    assert.equal((await query(`SELECT state FROM crm_mail_threads WHERE tenant_id = $1 AND thread_id = 't8'`, [t])).rows[0].state, 'closed', 'a colleague answered');

    // 3. The check: a follow-up written for the unanswered email, reminders for what's waiting on us.
    sent.length = 0;
    const r1 = await w.processWatch({ now: NOW, onlyTenantId: t, appUrl: 'https://app.test' });
    assert.ok(r1.followups >= 1 && r1.reminders >= 2, JSON.stringify(r1));
    const inbox = await crm.listInbox(t);
    const fu = inbox.find(i => i.kind === 'email_followup');
    assert.match(fu.title, /No reply from Gulf Framing in \d+ business days/);
    assert.ok(inbox.some(i => i.kind === 'email_reply' && /Urgent: Dana Ruiz is waiting/.test(i.title)));
    assert.ok(inbox.some(i => i.kind === 'email_reply' && /City Inspector/.test(i.title) && /needed by [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+ ·/.test(i.detail)), 'deadline shown as a plain date');
    assert.equal((await w.list(t, { userId: sam })).toReply.find(x => x.who === 'City Inspector').deadline, DEADLINE);
    assert.ok(sent.some(m => m.to === 'sam@levi.test' && /No reply from Gulf Framing/.test(m.subject) && /Any update on the framing price/.test(m.text)), 'Sam gets the follow-up, ready');
    assert.ok(sent.some(m => m.to === 'sam@levi.test' && /Urgent: Dana Ruiz is waiting for your reply/.test(m.subject)));
    sent.length = 0;
    await w.processWatch({ now: NOW, onlyTenantId: t });
    assert.equal(sent.length, 0, 'each reminder once');

    // 4. Sending the follow-up: same conversation, replies to Sam.
    const t1 = (await query(`SELECT id FROM crm_mail_threads WHERE tenant_id = $1 AND thread_id = 't1'`, [t])).rows[0].id;
    const res = await w.sendFollowUp({ tenantId: t, id: t1, userId: sam });
    assert.equal(res.to, 'bids@gulfframing.test');
    const f = sent[sent.length - 1];
    assert.equal(f.headers['In-Reply-To'], '<m1@mail.test>'); assert.equal(f.headers['X-Eagle-I'], 'follow-up');
    assert.equal(f.replyTo, 'sam@levi.test'); assert.deepEqual(f.cc, ['sam@levi.test']); assert.equal(f.subject, 'Re: Framing price for the Ruiz addition');
    assert.ok(!(await crm.listInbox(t)).some(i => i.kind === 'email_followup'), 'the item clears');
    // Our own copy of the follow-up isn't treated as an email from outside.
    assert.equal(await w.observe({ tenantId: t, mailbox: mbSam, msg: M('cc1', 't1', { from: 'Sam Builder · Levi <onboarding@resend.dev>', to: 'bids@gulfframing.test', subject: 'Re: Framing price', at: NOW, extra: { 'X-Eagle-I': 'follow-up' } }), isCompany: (e) => e.endsWith('@levi.test'), now: NOW }), null);
    // They answer: it flips to us owing them, nothing chased.
    await w.observe({ tenantId: t, mailbox: mbSam, msg: M('m13', 't1', { from: 'bids@gulfframing.test', to: 'sam@levi.test', subject: 'Re: Framing price for the Ruiz addition', at: new Date(Date.now() + 60000), body: '$14,200 for the framing.' }), isCompany: (e) => e.endsWith('@levi.test'), userId: sam, now: new Date(Date.now() + 120000) });
    assert.equal((await query(`SELECT state, followups_sent FROM crm_mail_threads WHERE id = $1`, [t1])).rows[0].state, 'to_reply');

    // 5. Automatic follow-ups (customers and subs), at most twice, then the person is told.
    await w.saveSettings(t, { autoFollowUp: 'known' });
    const samples = await w.observe({ tenantId: t, mailbox: mbSam, msg: M('m14', 't14', { from: 'sam@levi.test', to: 'bids@gulfframing.test', subject: 'Tile samples', at: ago(6), body: 'Can you drop off the tile samples?', labels: ['SENT'] }), isCompany: (e) => e.endsWith('@levi.test'), userId: sam, now: NOW });
    await w.classifyPending({ tenantId: t, mailboxEmail: 'sam@levi.test' });
    sent.length = 0;
    const r2 = await w.processWatch({ now: NOW, onlyTenantId: t });
    assert.equal(r2.autoSent, 1); assert.ok(sent.some(m => m.to === 'bids@gulfframing.test' && m.headers['X-Eagle-I']));
    await query(`UPDATE crm_mail_threads SET last_at = $2, followups_sent = 2 WHERE id = $1`, [samples.id, ago(6)]);
    sent.length = 0;
    const r3 = await w.processWatch({ now: NOW, onlyTenantId: t });
    assert.equal(r3.autoSent, 0, 'never more than twice');
    assert.ok(sent.some(m => m.to === 'sam@levi.test' && /No reply from Gulf Framing/.test(m.subject) && /2 follow-ups/.test(m.text)));

    // 6. Still no reply to the customer 2 business days after the reminder: the owner hears.
    await query(`UPDATE crm_mail_threads SET nudged_at = $2 WHERE tenant_id = $1 AND thread_id = 't2'`, [t, ago(4)]);
    sent.length = 0;
    const r4 = await w.processWatch({ now: NOW, onlyTenantId: t });
    assert.ok(r4.escalated >= 1);
    assert.ok(sent.some(m => m.to === 'pat@levi.test' && /Dana Ruiz hasn’t had a reply/.test(m.subject)));
    assert.ok(!sent.some(m => m.to === 'sam@levi.test' && /hasn’t had a reply/.test(m.subject)), 'the owner, not Sam again');

    // 7. Who sees what; the morning email; settings; other companies.
    const forKim = await w.list(t, { userId: kim });
    assert.ok(!forKim.toReply.some(x => x.who === 'Dana Ruiz'), 'Kim sees only her own');
    const forSam = await w.list(t, { userId: sam });
    assert.ok(forSam.toReply.some(x => x.who === 'Dana Ruiz' && /mail\.google\.com/.test(x.gmail)));
    const d = await daily.digestFor({ id: sam, tenant_id: t, role: 'member' }, NOW);
    const mail = daily.renderDigest({ name: 'Sam Builder', company: 'Levi Test Homes', d, appUrl: 'https://app.test', now: NOW });
    assert.match(mail.text, /EMAIL/); assert.match(mail.text, /Reply to Dana Ruiz: Water leaking/); assert.match(mail.subject, /email/);
    await w.act({ tenantId: t, id: (await query(`SELECT id FROM crm_mail_threads WHERE tenant_id = $1 AND thread_id = 't5'`, [t])).rows[0].id, action: 'done' });
    assert.ok(!(await w.list(t, { userId: sam })).toReply.some(x => x.who === 'City Inspector'));
    await assert.rejects(w.saveSettings(t, { followUpDays: 30 }), /1 to 10/);
    await w.saveSettings(t, { on: false });
    sent.length = 0;
    await query(`UPDATE crm_mail_threads SET nudged_at = NULL, escalated_at = NULL WHERE tenant_id = $1`, [t]);
    await w.processWatch({ now: NOW, onlyTenantId: t });
    assert.equal(sent.length, 0, 'off means off');
    assert.equal(await w.getThread(t2, t1), null, 'another company can’t see it');
    assert.equal(await w.getThread(t, 'abc'), null);
    console.log('EMAIL WATCH SCENARIO PASSED');
  } catch (e) {
    console.error('EMAIL WATCH SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
