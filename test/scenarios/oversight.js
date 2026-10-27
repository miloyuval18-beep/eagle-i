// Copied to keep an eye on things: the owner (and admins, and anyone switched on)
// who is only copied on an email gets no reminder and nothing on their calendar;
// it's kept in the loop instead, on the project and in the morning email as "no
// action needed". Sent to them, or naming them, and it's theirs as usual. An
// email to a teammate who hasn't connected Gmail reminds that teammate, not the
// person on copy.
const { R } = require('./_local');
const assert = require('assert/strict');
delete process.env.RESEND_API_KEY; delete process.env.ANTHROPIC_API_KEY;
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const { query, pool } = require(R + '/db');
const w = require(R + '/lib/crmEmailWatch');
const crm = require(R + '/lib/crm');
const team = require(R + '/lib/crmTeam');
const daily = require(R + '/lib/crmDaily');
const tag = Date.now().toString(36);
const D = `lv${tag}.test`; // the company's domain

// A Wednesday, 10am Central, in the last week (working hours).
const NOW = (() => { const d = new Date(); d.setUTCHours(15, 0, 0, 0); while (d.getUTCDay() !== 3 || d > new Date()) d.setUTCDate(d.getUTCDate() - 1); return d; })();
let n = 0;
const msg = ({ from, to = [], cc = [], subject, snippet = '', thread = null, at = NOW }) => {
  n++;
  return { id: `g${tag}${n}`, threadId: thread || `t${tag}${n}`, internalDate: String(at.getTime()), labelIds: ['INBOX'], snippet,
    payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: to.join(', ') }, ...(cc.length ? [{ name: 'Cc', value: cc.join(', ') }] : []), { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<m${tag}${n}@x.test>` }] } };
};

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Levi Homes', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email) VALUES ($1, $2)`, [t, `office@${D}`]);
    const add = async (local, name, role, extra = '') => (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app${extra ? ', permissions' : ''}) VALUES ($1, $2, 'x', $3, $4, 'crm'${extra ? ', $5' : ''}) RETURNING *`, [t, `${local}@${D}`, name, role, ...(extra ? [extra] : [])])).rows[0];
    const levi = await add('levi', 'Levi Stone', 'owner');
    const ann = await add('ann', 'Ann Park', 'admin');
    const dana = await add('dana', 'Dana Cruz', 'project_manager');
    const joe = await add('joe', 'Joe Diaz', 'superintendent');
    const ray = await add('ray', 'Ray Long', 'superintendent'); // no money; switched on below
    for (const u of [levi, ann, dana, ray]) await query(`INSERT INTO crm_mailboxes (tenant_id, email, name) VALUES ($1, $2, $3)`, [t, u.email, u.name]);
    const mailboxes = new Set([levi, ann, dana, ray].map(u => u.email));
    const isCompany = (e) => e.endsWith('@' + D);
    const see = (u, m, readBody = null) => w.observe({ tenantId: t, mailbox: { email: u.email }, msg: m, isCompany, mailboxes, userId: u.id, readBody, now: NOW });
    const threads = async (u) => (await query(`SELECT * FROM crm_mail_threads WHERE tenant_id = $1 AND mailbox_email = $2 ORDER BY id`, [t, u.email])).rows;
    const loop = async (u) => (await query(`SELECT * FROM crm_mail_loop WHERE tenant_id = $1 AND user_id = $2 ORDER BY id`, [t, u.id])).rows;
    const deal = await crm.createDeal({ tenantId: t, name: 'Rita Ruiz', email: 'rita@home.test', title: 'Ruiz kitchen', userId: dana.id, ownerUserId: dana.id });

    // Defaults: on for the owner and admins, off for everyone else.
    assert.equal(team.oversightOf(levi), true); assert.equal(team.oversightOf(ann), true); assert.equal(team.oversightOf(dana), false);
    // Ann switches it off for herself; the owner switches it on for Ray. Dana can't change someone else's.
    await team.setOversight({ tenantId: t, actor: ann, userId: ann.id, on: false });
    await team.setOversight({ tenantId: t, actor: levi, userId: ray.id, on: true });
    await assert.rejects(team.setOversight({ tenantId: t, actor: dana, userId: joe.id, on: true }), /permission/);
    await assert.rejects(team.setOversight({ tenantId: t, actor: ann, userId: levi.id, on: false }), /Only the owner/);
    const fresh = async (u) => (await query('SELECT * FROM users WHERE id = $1', [u.id])).rows[0];
    assert.equal(team.oversightOf(await fresh(ann)), false); assert.equal(team.oversightOf(await fresh(ray)), true);

    // 1. To Dana, Levi copied: Dana answers it; Levi is kept in the loop (on the project).
    const m1 = msg({ from: 'Rita Ruiz <rita@home.test>', to: [`Dana Cruz <${dana.email}>`], cc: [`Levi Stone <${levi.email}>`], subject: 'Cabinet color', snippet: 'Hi Dana, we went with the sage green for the uppers.' });
    assert.equal(await see(levi, m1), null);
    assert.ok((await see(dana, m1)).changed);
    assert.equal((await threads(levi)).length, 0, 'no reminder for the person on copy');
    let L = await loop(levi);
    assert.equal(L.length, 1); assert.equal(L[0].deal_id, deal.id); assert.equal(L[0].from_name, 'Rita Ruiz'); assert.equal(L[0].to_names, 'Dana Cruz');
    assert.equal((await threads(dana))[0].user_id, dana.id);

    // 2. Sent to Levi's address: his, like any other.
    assert.ok((await see(levi, msg({ from: 'rita@home.test', to: [levi.email], subject: 'Payment question', snippet: 'Can I pay the deposit by card?' }))).changed);
    assert.equal((await threads(levi)).length, 1);

    // 3. Copied, but the email names him ("Levi, can you…"): his. The company name doesn't count.
    assert.equal(await see(levi, msg({ from: 'rita@home.test', to: [dana.email], cc: [levi.email], subject: 'Thanks Levi Homes', snippet: 'Loving the work from Levi Homes so far.' })), null);
    assert.ok(await see(levi, msg({ from: 'rita@home.test', to: [dana.email], cc: [levi.email], subject: 'Budget', snippet: 'Dana and Levi, can one of you call me about the budget?' })));
    // Named only further down the email: read once to check.
    const bodies = [];
    const named = await see(levi, msg({ from: 'rita@home.test', to: [dana.email], cc: [levi.email], subject: 'Tile', snippet: 'Quick update on the tile order.' }), async (id) => { bodies.push(id); return 'Quick update on the tile order.\n\nLevi, could you sign off on the upgrade?'; });
    assert.ok(named && named.changed); assert.equal(bodies.length, 1);
    // Someone else called Levi signing it: not him.
    assert.equal(await see(levi, msg({ from: 'Levi Grant <levi@supply.test>', to: [dana.email], cc: [levi.email], subject: 'Lumber', snippet: 'Order is in. Thanks, Levi' })), null);
    assert.equal((await threads(levi)).length, 3);

    // 4. To someone outside, Levi copied: kept in the loop, nothing to answer.
    assert.equal(await see(levi, msg({ from: 'rita@home.test', to: ['bids@tile.test'], cc: [levi.email], subject: 'Tile delivery', snippet: 'Please deliver Thursday at 9.' })), null);
    assert.equal((await threads(levi)).length, 3);
    // Ann (switched off) copied the same way: treated like any other email, as before.
    assert.ok(await see(ann, msg({ from: 'rita@home.test', to: ['bids@tile.test'], cc: [ann.email], subject: 'Tile delivery', snippet: 'Please deliver Thursday at 9.' })));

    // 5. To Joe, who hasn't connected Gmail; Levi and Ann copied: the reminder is Joe's.
    const m5 = msg({ from: 'Rita Ruiz <rita@home.test>', to: [`Joe Diaz <${joe.email}>`], cc: [levi.email, ann.email], subject: 'Gate code', snippet: 'What time will the crew arrive tomorrow?', at: new Date(NOW.getTime() - 3 * 86400000) });
    assert.ok(await see(levi, m5));
    const forJoe = (await threads(levi)).find(x => x.subject === 'Gate code');
    assert.equal(forJoe.user_id, joe.id); assert.equal(forJoe.addressed_to, joe.email);
    assert.equal(await see(ann, m5), null, 'one reminder for Joe, not one per copy');
    assert.ok((await loop(levi)).some(x => x.subject === 'Gate code'), 'and Levi is still kept in the loop');
    // Reminders go to Joe; the follow-up's replies would go to him too.
    await query(`UPDATE crm_mail_threads SET expects = true, importance = 'high', classified_at = now() WHERE id = $1`, [forJoe.id]);
    sent.length = 0;
    await w.processWatch({ now: NOW, onlyTenantId: t, appUrl: 'https://app.test' });
    assert.ok(sent.some(s => s.to === joe.email && /waiting for your reply/.test(s.subject)), 'Joe is reminded');
    assert.ok(!sent.some(s => s.to === levi.email), 'Levi is not');
    const listed = await w.list(t, { userId: joe.id });
    assert.equal(listed.toReply.length, 1); assert.equal(listed.toReply[0].gmail, null); assert.equal(listed.toReply[0].seenOn, levi.email);
    // Joe answers from his own email, Levi still copied: seen on Levi's copy, now waiting on Rita.
    assert.ok(await see(levi, msg({ from: joe.email, to: ['rita@home.test'], cc: [levi.email], subject: 'Re: Gate code', snippet: 'Crew is there at 7.', thread: forJoe.thread_id, at: new Date(NOW.getTime() - 3600000) })));
    const after = (await threads(levi)).find(x => x.id === forJoe.id);
    assert.equal(after.state, 'waiting'); assert.equal(after.user_id, joe.id);
    await query(`UPDATE crm_mail_threads SET expects = true, last_at = now() - interval '6 days', followup_draft = '{"subject":"Re: Gate code","body":"Any update?"}' WHERE id = $1`, [forJoe.id]);
    sent.length = 0;
    await w.sendFollowUp({ tenantId: t, id: forJoe.id, userId: joe.id });
    assert.equal(sent[0].replyTo, joe.email, 'answers go to Joe, not the person on copy');

    // 6. A colleague's email I'm copied on: kept in the loop; and it settles what was waiting on me there.
    const annThread = (await threads(ann))[0];
    assert.equal(annThread.state, 'to_reply');
    assert.equal(await see(ann, msg({ from: dana.email, to: ['rita@home.test'], cc: [ann.email], subject: 'Re: Tile delivery', snippet: 'Thursday at 9 works.', thread: annThread.thread_id, at: new Date(NOW.getTime() + 60000) })), null);
    assert.equal((await threads(ann))[0].state, 'closed');
    assert.equal(await see(levi, msg({ from: `Dana Cruz <${dana.email}>`, to: ['rita@home.test'], cc: [levi.email], subject: 'Schedule', snippet: 'Demo starts Monday.' })), null);
    L = await loop(levi);
    assert.ok(L.some(x => x.subject === 'Schedule' && x.from_name === 'Dana Cruz' && x.deal_id === deal.id));
    // The same conversation again is one line with a count.
    const again = msg({ from: 'rita@home.test', to: [dana.email], cc: [levi.email], subject: 'Re: Cabinet color', snippet: 'And brass pulls.', thread: m1.threadId, at: new Date(NOW.getTime() + 60000) });
    await see(levi, again);
    const cab = (await loop(levi)).filter(x => x.thread_id === m1.threadId);
    assert.equal(cab.length, 1); assert.equal(cab[0].messages, 2);

    // 7. On the project: Levi's own only.
    assert.ok((await w.loopFor({ tenantId: t, userId: levi.id, dealId: deal.id })).length >= 2);
    assert.equal((await w.loopFor({ tenantId: t, userId: dana.id, dealId: deal.id })).length, 0);

    // 8. No email about what needs no action: copied emails aren't in the morning email, and alone don't send one.
    const u = await fresh(levi);
    const d = await daily.digestFor(u, new Date(NOW.getTime() + 2 * 3600000));
    assert.equal(d.loop, undefined);
    const r = daily.renderDigest({ name: 'Levi Stone', company: 'Levi Homes', d, appUrl: 'https://app.test', now: NOW });
    assert.ok(!/Kept in the loop|Cabinet color|Lumber/.test(r.html + r.text), 'nothing about copied emails');
    sent.length = 0;
    await query(`UPDATE users SET crm_digest_sent_on = NULL WHERE tenant_id = $1`, [t]);
    await query(`UPDATE crm_mail_threads SET status = 'done' WHERE tenant_id = $1`, [t]);
    await query(`UPDATE crm_inbox SET status = 'done' WHERE tenant_id = $1`, [t]);
    const morning = new Date(NOW.getTime() - 3 * 3600000); // 7am Central that Wednesday
    await daily.processDigests({ now: morning, send: async (m) => { sent.push(m); } });
    assert.ok(!sent.some(m => m.to === levi.email), 'only copied emails: no morning email at all');

    // 9. No dollar figures for someone without "See money" (Today's list is hidden the same way).
    await see(ray, msg({ from: 'rita@home.test', to: [dana.email], cc: [ray.email], subject: 'Deposit', snippet: 'I sent the $4,500 deposit today.' }));
    const rl = team.hideMoney(await w.loopRecent({ tenantId: t, userId: ray.id, days: 30 }));
    assert.equal(rl.length, 1); assert.ok(!/4,500/.test(JSON.stringify(rl)), 'amount hidden');

    // 11. Emails from before the rule: looked at once more.
    const old = async (subject, gid) => (await query(`INSERT INTO crm_mail_threads (tenant_id, mailbox_email, user_id, thread_id, counterpart_email, subject, last_dir, last_at, state, status, expects, last_gmail_id, last_snippet)
      VALUES ($1, $2, $3, $4, 'rita@home.test', $5, 'in', now() - interval '2 days', 'to_reply', 'open', true, $6, 'Older email') RETURNING *`, [t, levi.email, levi.id, 'old-' + gid, subject, gid])).rows[0];
    const oCopied = await old('Old copied', 'gA'), oMine = await old('Old mine', 'gB'), oJoe = await old('Old for Joe', 'gC');
    await query(`INSERT INTO crm_inbox (tenant_id, kind, title, dedupe_key) VALUES ($1, 'email_reply', 'Rita is waiting', $2)`, [t, `mw:re:${oCopied.id}:1`]);
    await query(`INSERT INTO crm_events (tenant_id, user_id, title, kind, starts_at, ends_at, source, source_key, mail_thread_id) VALUES ($1, $2, 'Walkthrough', 'meeting', now() + interval '2 days', now() + interval '2 days 1 hour', 'email', $3, $4)`, [t, levi.id, 'mail:' + oCopied.id, oCopied.id]);
    await query(`INSERT INTO crm_events (tenant_id, user_id, title, kind, starts_at, ends_at, source, source_key, mail_thread_id) VALUES ($1, $2, 'Gate', 'meeting', now() + interval '2 days', now() + interval '2 days 1 hour', 'email', $3, $4)`, [t, levi.id, 'mail:' + oJoe.id, oJoe.id]);
    const HEAD = { gA: { to: [dana.email], cc: [levi.email] }, gB: { to: [levi.email], cc: [] }, gC: { to: [joe.email], cc: [levi.email] } };
    const head = (id) => HEAD[id] || { to: [levi.email], cc: [] }; // the others in his inbox were sent to him
    const getMsg = async (id) => ({ id, snippet: 'Older email', payload: { headers: [{ name: 'From', value: 'Rita Ruiz <rita@home.test>' }, { name: 'To', value: head(id).to.join(', ') }, { name: 'Cc', value: head(id).cc.join(', ') }, { name: 'Subject', value: 'Old' }] } });
    const rc = await w.recheckCopied({ tenantId: t, mailbox: { email: levi.email }, isCompany, mailboxes, userId: levi.id, getMsg, readBody: async () => 'Nothing addressed to anyone here.' });
    assert.ok(rc.checked >= 3); assert.equal(rc.kept, 1); assert.equal(rc.handedOn, 1);
    const after2 = async (x) => (await query('SELECT * FROM crm_mail_threads WHERE id = $1', [x.id])).rows[0];
    assert.equal((await after2(oCopied)).state, 'closed', 'copied only: no longer waiting on Levi');
    assert.equal((await query(`SELECT status FROM crm_inbox WHERE dedupe_key = $1`, [`mw:re:${oCopied.id}:1`])).rows[0].status, 'done', 'its reminder cleared');
    assert.equal((await query('SELECT 1 FROM crm_events WHERE mail_thread_id = $1', [oCopied.id])).rows.length, 0, 'off his calendar');
    assert.ok((await loop(levi)).some(x => x.thread_id === oCopied.thread_id), 'kept in the loop instead');
    assert.equal((await after2(oMine)).state, 'to_reply', 'sent to him: still his');
    assert.equal((await after2(oJoe)).user_id, joe.id, 'for Joe: his reminder');
    assert.equal((await query('SELECT user_id FROM crm_events WHERE mail_thread_id = $1', [oJoe.id])).rows[0].user_id, joe.id, 'and his calendar');
    assert.deepEqual(await w.recheckCopied({ tenantId: t, mailbox: { email: levi.email }, isCompany, mailboxes, userId: levi.id, getMsg }), { checked: 0, kept: 0, handedOn: 0 }, 'only once');

    // 10. A role change puts it back to the new role's default.
    await team.setRole({ tenantId: t, actor: levi, userId: ray.id, role: 'project_manager' });
    assert.equal(team.oversightOf(await fresh(ray)), false);
    console.log('OVERSIGHT SCENARIO PASSED');
  } catch (e) {
    console.error('OVERSIGHT SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
