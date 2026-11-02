// For your information: what needs nothing from someone is still worth knowing about.
//  - Sent to them with nothing to answer (not a sales pitch): in their 4pm email under
//    "For your information" ("nothing to answer"), not in Needs you.
//  - The same email sent separately to two of the team, naming one ("Moran - Please
//    complete this checklist"): only Moran's to answer; the other's closed and kept in
//    the loop ("for Moran Levi"). Naming neither: both stay.
const { R, endOfDay } = require('./_local');
const assert = require('assert/strict');
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
process.env.ANTHROPIC_API_KEY = 'test';
let verdicts = {};
const ai = require(R + '/lib/anthropic');
require.cache[require.resolve(R + '/lib/anthropic')].exports = { ...ai, generateJSON: async () => ({ emails: Object.entries(verdicts).map(([id, v]) => ({ id, ...v })) }) };
const { query, pool } = require(R + '/db');
const w = require(R + '/lib/crmEmailWatch');
const tag = Date.now().toString(36);

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Fyi Homes', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const add = async (local, name, role) => (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', $3, $4, 'crm') RETURNING *`, [t, `${local}@fy${tag}.test`, name, role])).rows[0];
    const sam = await add('admin', 'Samantha Valenzuela', 'admin'), levi = await add('levi', 'Moran Levi', 'owner');
    const thread = async (u, threadId, from, name, subject, snippet, ago = 0) => (await query(`INSERT INTO crm_mail_threads (tenant_id, mailbox_email, user_id, thread_id, counterpart_email, counterpart_name, subject, last_dir, last_at, last_snippet, state, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'in', now() - ($8 || ' seconds')::interval, $9, 'to_reply', 'open') RETURNING *`, [t, u.email, u.id, threadId, from, name, subject, String(ago), snippet])).rows[0];

    // 1. Sent to Samantha, nothing to answer: for her information. A sales pitch: not even that.
    const st = await thread(sam, 'st' + tag, 'ar@supply.test', 'Supply Co', 'Your October statement', 'Attached is your statement.');
    const pitch = await thread(sam, 'pi' + tag, 'sales@seo.test', 'SEO Pros', 'Rank #1 on Google', 'We can get you to the top.');
    const ask = await thread(sam, 'as' + tag, 'kim@home.test', 'Kim Lee', 'Tile', 'Can you send the tile sample?');
    verdicts = { [st.id]: { expects: false, importance: 'normal', reason: 'Automated statement; nothing asked' }, [pitch.id]: { expects: false, importance: 'low' }, [ask.id]: { expects: true, importance: 'high', reason: 'Wants the tile sample' } };
    await w.classifyPending({ tenantId: t, mailboxEmail: sam.email });
    const loop = (await query(`SELECT subject, why FROM crm_mail_loop WHERE tenant_id = $1 AND user_id = $2 ORDER BY subject`, [t, sam.id])).rows;
    assert.deepEqual(loop.map(x => [x.subject, x.why]), [['Your October statement', 'fyi']], 'the statement only; not the pitch, not the one to answer');

    // 2. The same checklist to Samantha and to Moran, naming Moran: his to answer.
    const a = await thread(sam, 'ca' + tag, 'caitlyn@monthend.test', 'Caitlyn M', 'Moran - Please complete this checklist - Nov', 'Hi, please complete…', 13);
    const b = await thread(levi, 'cb' + tag, 'caitlyn@monthend.test', 'Caitlyn M', 'Moran - Please complete this checklist - Nov', 'Hi, please complete…');
    await require(R + '/lib/crmTeamMail').later({ tenantId: t, to: sam.email, subject: 'Caitlyn M is waiting for your reply', ref: `mw:${a.id}` });
    // And one naming nobody, to both: both stay.
    const c = await thread(sam, 'cc' + tag, 'bank@b.test', 'Bank', 'Year-end documents', 'Please send the documents.');
    const d = await thread(levi, 'cd' + tag, 'bank@b.test', 'Bank', 'Year-end documents', 'Please send the documents.');
    assert.equal(await w.sameEmailTwice({ tenantId: t }), 1);
    const state = async (x) => (await query(`SELECT state, reason FROM crm_mail_threads WHERE id = $1`, [x.id])).rows[0];
    assert.deepEqual(await state(a), { state: 'closed', reason: 'For Moran Levi: kept in the loop' });
    assert.equal((await state(b)).state, 'to_reply', 'Moran’s');
    assert.equal((await state(c)).state, 'to_reply'); assert.equal((await state(d)).state, 'to_reply');
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_team_mail WHERE tenant_id = $1 AND sent_at IS NULL`, [t])).rows[0].n, 0, 'her reminder taken out');

    // 3. Her 4pm email: both under "For your information", each saying why.
    sent.length = 0;
    await endOfDay(t);
    const mine = sent.find(m => m.to === sam.email);
    assert.ok(mine, 'she gets one');
    assert.match(mine.subject, /2 emails for your information/);
    assert.match(mine.html, /Your October statement <span[^>]*>\(nothing to answer\)/);
    assert.match(mine.html, /Moran - Please complete this checklist - Nov <span[^>]*>\(for Moran Levi\)/);
    assert.ok(!/Rank #1/.test(mine.html));
    console.log('FYI SCENARIO PASSED');
  } catch (e) {
    console.error('FYI SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
