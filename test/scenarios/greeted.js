// Who a sent-to-several email belongs to, and who's on the team:
//  - Sent to Samantha and Maria, "Hi Maria, …": Maria's to answer (her reminder);
//    Samantha's is kept in the loop. Greeting Samantha, or nobody, or both: Samantha's as before.
//  - Maria hasn't connected her Gmail: the reminder is still hers (from Samantha's copy).
//  - Already waiting on Samantha from before: looked at again and handed to Maria.
//  - Everyone with a login is a teammate, connected or not: their emails aren't chased
//    like a customer's, and conversations already tracked that way are closed, with
//    their end-of-day reminders taken out.
const { R } = require('./_local');
const assert = require('assert/strict');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
const { query, pool } = require(R + '/db');
const w = require(R + '/lib/crmEmailWatch');
const tag = Date.now().toString(36);
const D = `gr${tag}.test`;
const NOW = (() => { const d = new Date(); d.setUTCHours(15, 0, 0, 0); while (d.getUTCDay() !== 3 || d > new Date()) d.setUTCDate(d.getUTCDate() - 1); return d; })();
let n = 0;
const msg = ({ from, to = [], cc = [], subject, snippet = '', thread = null }) => {
  n++;
  return { id: `g${tag}${n}`, threadId: thread || `t${tag}${n}`, internalDate: String(NOW.getTime()), labelIds: ['INBOX'], snippet,
    payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: to.join(', ') }, ...(cc.length ? [{ name: 'Cc', value: cc.join(', ') }] : []), { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<m${tag}${n}@x.test>` }] } };
};

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Levi Homes', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const add = async (local, name, role) => (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', $3, $4, 'crm') RETURNING *`, [t, `${local}@${D}`, name, role])).rows[0];
    const sam = await add('admin', 'Samantha Valenzuela', 'admin');
    const maria = await add('office', 'Maria Vidal', 'member');
    const levi = await add('levi', 'Moran Levi', 'owner');
    // Only Samantha's Gmail is connected. Everyone with a login is the team (lib/crmGoogle.js).
    await query(`INSERT INTO crm_mailboxes (tenant_id, email, name) VALUES ($1, $2, $3)`, [t, sam.email, sam.name]);
    const mailboxes = new Set([sam.email]);
    const team = new Set([sam.email, maria.email, levi.email]);
    const isCompany = (e) => team.has(e);
    const see = (m) => w.observe({ tenantId: t, mailbox: { email: sam.email }, msg: m, isCompany, mailboxes, userId: sam.id, now: NOW });
    const thread = async (id) => (await query(`SELECT * FROM crm_mail_threads WHERE tenant_id = $1 AND thread_id = $2`, [t, id])).rows[0];
    const looped = async (id) => (await query(`SELECT 1 FROM crm_mail_loop WHERE tenant_id = $1 AND user_id = $2 AND thread_id = $3`, [t, sam.id, id])).rows.length > 0;

    // 1. To Samantha and Maria, greeting Maria: Maria's reminder (from Samantha's copy, Maria has no Gmail connected); Samantha kept in the loop.
    const m1 = msg({ from: 'Veronica Hemmi <vh@home.test>', to: [`Samantha <${sam.email}>`, `Maria <${maria.email}>`], subject: 'Hemmi Residence', snippet: 'Hi Maria, Can you please send over where you found the flooring?' });
    await see(m1);
    let th = await thread(m1.threadId);
    assert.equal(th.addressed_to, maria.email, 'Maria’s to answer'); assert.equal(th.user_id, maria.id);
    assert.ok(await looped(m1.threadId), 'Samantha kept in the loop');
    // 2. Greeting Samantha: hers, nothing in the loop.
    const m2 = msg({ from: 'LJ <lj@books.test>', to: [`<${sam.email}>`, `<${maria.email}>`], subject: 'Updated Suspense', snippet: 'Hi Samantha, We have updated the suspense tab.' });
    await see(m2);
    th = await thread(m2.threadId);
    assert.equal(th.addressed_to, null); assert.equal(th.user_id, sam.id); assert.equal(await looped(m2.threadId), false);
    // 3. Greeting nobody: as before (on the To line, hers).
    const m3 = msg({ from: 'Bob <bob@vendor.test>', to: [sam.email, maria.email], subject: 'Order', snippet: 'Hello, the order shipped today.' });
    await see(m3);
    assert.equal((await thread(m3.threadId)).user_id, sam.id);
    // 4. Only to Samantha, "Hi Maria": she's the only one it was sent to, so it's hers.
    const m4 = msg({ from: 'Ann <ann@home.test>', to: [sam.email], subject: 'Plans', snippet: 'Hi Maria, plans attached.' });
    await see(m4);
    assert.equal((await thread(m4.threadId)).user_id, sam.id);
    // 5. Maria connects her Gmail: her own mailbox reminds her, Samantha's copy doesn't track it at all.
    mailboxes.add(maria.email);
    const m5 = msg({ from: 'Jason <jt@home.test>', to: [sam.email, maria.email], subject: 'Project Update', snippet: 'Thanks Maria. We will need one more towel rack.' });
    assert.equal(await see(m5), null);
    assert.equal(await thread(m5.threadId), undefined); assert.ok(await looped(m5.threadId));
    mailboxes.delete(maria.email);

    // 6. Already waiting on Samantha from before: looked at again and handed to Maria; then once Maria's connected, closed and kept in the loop.
    const old1 = msg({ from: 'Floor & Decor <fd@store.test>', to: [sam.email, maria.email], subject: 'Quote', snippet: 'Hi Maria, Please find the quote attached.' });
    const old2 = msg({ from: 'Memorial Postal <mp@print.test>', to: [sam.email, maria.email], subject: 'Plans printed', snippet: 'Hi Maria, Ready for pickup' });
    for (const [i, m] of [old1, old2].entries()) {
      await query(`INSERT INTO crm_mail_threads (tenant_id, mailbox_email, user_id, thread_id, counterpart_email, counterpart_name, subject, last_dir, last_at, last_message_key, last_gmail_id, state, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'in', now() - interval '3 days', $8, $9, 'to_reply', 'open')`, [t, sam.email, sam.id, m.threadId, i ? 'mp@print.test' : 'fd@store.test', i ? 'Memorial Postal' : 'Floor & Decor', m.payload.headers.find(x => x.name === 'Subject').value, `<k${i}${tag}>`, m.id]);
    }
    const byId = { [old1.id]: old1, [old2.id]: old2 };
    await require(R + '/lib/crmTeamMail').later({ tenantId: t, to: sam.email, subject: 'Floor & Decor is waiting for your reply', kind: 'customer' });
    let r = await w.recheckCopied({ tenantId: t, mailbox: { email: sam.email }, isCompany, mailboxes, userId: sam.id, getMsg: async (id) => byId[id] });
    assert.equal(r.handedOn, 2);
    th = await thread(old1.threadId);
    assert.equal(th.addressed_to, maria.email); assert.ok(await looped(old1.threadId));
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_team_mail WHERE tenant_id = $1 AND sent_at IS NULL AND subject LIKE 'Floor & Decor%'`, [t])).rows[0].n, 0, 'out of Samantha’s end-of-day email');

    // 7. Teammates: Maria's and Levi's emails (no Gmail connected) aren't chased like a customer's.
    const m7 = msg({ from: `Moran Levi <${levi.email}>`, to: [sam.email], subject: 'Fwd: New lead', snippet: 'Forwarded message' });
    assert.equal(await see(m7), null, 'from a teammate: not tracked');
    // Conversations already tracked that way (from before) are closed, and their unsent reminders taken out.
    await query(`INSERT INTO crm_mail_threads (tenant_id, mailbox_email, user_id, thread_id, counterpart_email, counterpart_name, subject, last_dir, last_at, state, status)
      VALUES ($1, $2, $3, 'tlevi', $4, 'Moran Levi', 'Initial meeting', 'in', now() - interval '2 days', 'to_reply', 'open'),
             ($1, $2, $3, 'tmaria', $5, 'Maria Vidal', 'Invoice', 'out', now() - interval '2 days', 'waiting', 'open')`, [t, sam.email, sam.id, levi.email, maria.email]);
    const TM = require(R + '/lib/crmTeamMail');
    await TM.later({ tenantId: t, to: sam.email, subject: 'Moran Levi is waiting for your reply', kind: 'customer' });
    await TM.later({ tenantId: t, to: sam.email, subject: 'No reply from Maria Vidal: Invoice', kind: 'customer' });
    await TM.later({ tenantId: t, to: sam.email, subject: 'Veronica Hemmi is waiting for your reply', kind: 'customer' });
    assert.equal(await w.forgetTeammates({ tenantId: t, mailboxEmail: sam.email, isCompany }), 2);
    assert.deepEqual((await query(`SELECT thread_id, state, reason FROM crm_mail_threads WHERE tenant_id = $1 AND thread_id IN ('tlevi', 'tmaria') ORDER BY thread_id`, [t])).rows.map(x => [x.thread_id, x.state, x.reason]),
      [['tlevi', 'closed', 'A teammate: not tracked'], ['tmaria', 'closed', 'A teammate: not tracked']]);
    assert.deepEqual((await query(`SELECT subject FROM crm_team_mail WHERE tenant_id = $1 AND sent_at IS NULL`, [t])).rows.map(x => x.subject), ['Veronica Hemmi is waiting for your reply'], 'a customer’s stays');
    assert.equal((await thread(m1.threadId)).state, 'to_reply', 'customers untouched');
    // Needs you is each person's own: an email reminder only for the person it's for; "still no reply" for the owners and admins.
    const crm = require(R + '/lib/crm');
    const levis = (await query(`INSERT INTO crm_mail_threads (tenant_id, mailbox_email, user_id, thread_id, counterpart_email, subject, last_dir, last_at, state, status)
      VALUES ($1, $2, $3, 'tl2', 'bank@b.test', 'Loan', 'in', now(), 'to_reply', 'open') RETURNING id`, [t, levi.email, levi.id])).rows[0].id;
    const sams = (await thread(m2.threadId)).id;
    await crm.addInboxItem({ tenantId: t, kind: 'email_reply', title: 'Bank is waiting for a reply', dedupeKey: `mw:re:${levis}:1` });
    await crm.addInboxItem({ tenantId: t, kind: 'email_reply', title: 'LJ is waiting for a reply', dedupeKey: `mw:re:${sams}:1` });
    await crm.addInboxItem({ tenantId: t, kind: 'email_reply', title: 'Bank still has no reply', dedupeKey: `mw:esc:${levis}:1` });
    await crm.addInboxItem({ tenantId: t, kind: 'checkin_problem', title: 'A problem', dedupeKey: `ci:x:${tag}` });
    const titles = async (u, all = false) => (await crm.listInbox(t, { user: u, all })).map(i => i.title).sort();
    assert.deepEqual(await titles(sam), ['A problem', 'Bank still has no reply', 'LJ is waiting for a reply'], 'not Levi’s email');
    assert.deepEqual(await titles(levi), ['A problem', 'Bank is waiting for a reply'], 'not about himself');
    assert.equal((await titles(sam, true)).length, 4, 'the whole team');
    console.log('GREETED SCENARIO PASSED');
  } catch (e) {
    console.error('GREETED SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
