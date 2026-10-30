// The daily check-in: the 3:30pm weekday email (from Thu Oct 29 2026, never to test
// addresses), the short chat with Eagle I, the summary with problems raised to the
// owners and admins (urgent ones by email), everyone's earlier days, Team / Projects /
// Problems for owners and admins only, the full chat, and the 6pm summary once a day.
const { R, endOfDay } = require('./_local');
const assert = require('assert/strict');
process.env.RESEND_API_KEY = 'test-only'; process.env.ANTHROPIC_API_KEY = 'test-only';
const sent = [];
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { sent.push(m); return { id: 'e' + sent.length }; } };
const { query, pool } = require(R + '/db');
// Stand-in AI: the chat asks two questions then wraps up; the summary names a problem.
const A = require(R + '/lib/crmAssistant');
let turns = 0; const seen = [];
A.runTurn = async (ctx, { threadId, text, voice }) => {
  seen.push({ text, voice, extra: ctx.extra });
  await query(`INSERT INTO crm_ai_messages (thread_id, role, content, display) VALUES ($1, 'user', '[]', $2)`, [threadId, JSON.stringify({ text })]);
  turns++;
  const reply = turns === 1 ? 'Nice. Anything that went wrong or is stuck?' : turns === 2 ? 'Got it. What’s next tomorrow?' : 'Thanks, that’s everything. [[DONE]]';
  await query(`INSERT INTO crm_ai_messages (thread_id, role, content, display) VALUES ($1, 'assistant', '[]', $2)`, [threadId, JSON.stringify({ text: reply })]);
  return { text: reply, steps: [] };
};
let DEAL = null;
require.cache[require.resolve(R + '/lib/anthropic')].exports = { ...require(R + '/lib/anthropic'), generateJSON: async (p) => /Summarize this end-of-day check-in/.test(p)
  ? { headline: 'Hung cabinets at Ruiz, counters held up', projects: [{ name: 'Ruiz kitchen', dealId: DEAL, did: 'Hung all upper cabinets.', progress: 'Cabinets 80% done' }], problems: [{ text: 'Countertop template missed; fabricator needs a new date.', project: 'Ruiz kitchen', dealId: DEAL, urgent: true }], next: 'Lowers and hardware.', other: '' }
  : {} };
const ci = require(R + '/lib/crmCheckins');
const crm = require(R + '/lib/crm');
const tag = Date.now().toString(36);
// Thu Oct 29 2026, 3:45pm Central (20:45 UTC); Wed Oct 28 (the day before it starts); Sat Oct 31.
const THU = new Date('2026-10-29T20:45:00Z'), WED = new Date('2026-10-28T20:45:00Z'), SAT = new Date('2026-10-31T20:45:00Z');
const THU_EARLY = new Date('2026-10-29T19:00:00Z'), THU_6PM = new Date('2026-10-29T23:10:00Z');
// 8:30pm Central on Thursday is already Friday in UTC.
const THU_830PM = new Date('2026-10-30T01:30:00Z');

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Checkin Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const add = async (local, name, role, dom = 'ck.dev') => (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', $3, $4, 'crm') RETURNING *`, [t, `${local}.${tag}@${dom}`, name, role])).rows[0];
    const owner = await add('olive', 'Olive Owner', 'owner');
    const dana = await add('dana', 'Dana Cruz', 'project_manager');
    const sam = await add('sam', 'Sam Crew', 'member');
    const robot = await add('robot', 'Test Bot', 'member', 'eagle-i-test.com');
    // Left out of the check-in altogether (like it@levihomes.com): an owner, but no emails and not on the list.
    const it = await add('it', 'IT Login', 'owner');
    await query(`UPDATE users SET checkin_excluded = true WHERE id = $1`, [it.id]);
    DEAL = (await crm.createDeal({ tenantId: t, name: 'Rita Ruiz', title: 'Ruiz kitchen', stage: 'production', userId: owner.id, ownerUserId: dana.id })).id;
    await query(`INSERT INTO crm_job_items (tenant_id, deal_id, title, start_date, end_date, assignee_user_id, position) VALUES ($1, $2, 'Cabinets', '2026-10-28', '2026-10-30', $3, 0)`, [t, DEAL, dana.id]);
    // Dana is a project manager: Ruiz kitchen (handling it) and Chen bath (its project manager, signed, tile next week).
    const CHEN = (await crm.createDeal({ tenantId: t, name: 'Mark Chen', title: 'Chen bath', stage: 'signed', userId: owner.id, ownerUserId: owner.id })).id;
    await query(`UPDATE crm_deals SET pm_user_id = $2 WHERE id = $1`, [CHEN, dana.id]);
    await query(`INSERT INTO crm_job_items (tenant_id, deal_id, title, start_date, end_date, position) VALUES ($1, $2, 'Tile', '2026-11-02', '2026-11-04', 0)`, [t, CHEN]);
    // Someone else's project she doesn't manage.
    await crm.createDeal({ tenantId: t, name: 'Ann Other', title: 'Other kitchen', stage: 'production', userId: owner.id, ownerUserId: owner.id });
    const mine = (u) => sent.filter(m => m.to === u.email);
    const at = (now) => ci.processCheckins({ now, appUrl: 'https://app.test' });

    // Not before Thursday, not before 3:30, not on weekends, never to test addresses.
    assert.equal((await at(WED)).notYet, true);
    assert.equal((await at(THU_EARLY)).sent, 0, 'before 3:30');
    sent.length = 0;
    await at(THU);
    for (const u of [owner, dana, sam]) assert.equal(mine(u).length, 1, `${u.name} gets their own email`);
    assert.equal(mine(robot).length, 0, 'not to a test address');
    assert.equal(mine(it).length, 0, 'not to a login left out');
    assert.equal((await ci.view(it.id, { now: THU })).checkin, null);
    await assert.rejects(ci.message(it.id, 'hi', { now: THU }), /not part of the daily check-in/);
    assert.match(mine(dana)[0].subject, /Your daily check-in, Dana/);
    assert.match(mine(dana)[0].html, /https:\/\/app\.test\/crm\/app#checkin/);
    sent.length = 0; await at(THU);
    assert.equal(sent.filter(m => m.to.includes(tag)).length, 0, 'once a day');
    // A send that fails is tried again on the next round.
    const flaky = await add('flaky', 'Fay Flaky', 'member');
    let tries = 0;
    await ci.processCheckins({ now: THU, appUrl: 'https://app.test', send: async (m) => { if (m.to === flaky.email) { tries++; throw new Error('down'); } } });
    await ci.processCheckins({ now: new Date(THU.getTime() + 5 * 60000), appUrl: 'https://app.test', send: async (m) => { if (m.to === flaky.email) tries++; } });
    assert.equal(tries, 2, 'retried after a failed send');
    await query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [flaky.id]);
    assert.equal((await at(SAT)).sent, 0, 'not on weekends');

    // Dana opens it: Eagle I opens with what she was down for.
    const v = await ci.view(dana.id, { now: THU });
    assert.equal(v.checkin.opener, 'Hi Dana! Quick check-in for Thursday. Let’s go through your projects: Ruiz kitchen and Chen bath. Starting with Ruiz kitchen (Cabinets is underway): what got done there today?'.replace('’', "'"));
    assert.deepEqual(v.myProjects, ['Ruiz kitchen', 'Chen bath'], 'the short form names her projects');
    // Sam (not a project manager): the usual question.
    assert.match((await ci.view(sam.id, { now: THU })).checkin.opener, /What did you work on today/);
    assert.equal(v.checkin.status, 'sent');
    // The chat: two answers, then Eagle I wraps up and it's summarized.
    let r = await ci.message(dana.id, 'Hung all the uppers at Ruiz.', { now: THU, voice: true });
    assert.equal(r.done, false); assert.equal(seen[0].voice, true); assert.match(seen[0].extra, /daily check-in for Thursday, October 29, about the projects they manage/); assert.match(seen[0].extra, /Cabinets/);
    // The questions are about her projects, with what's coming up; not anyone else's.
    assert.match(seen[0].extra, /Chen bath/); assert.match(seen[0].extra, /Tile from 2026-11-02/); assert.match(seen[0].extra, /one at a time, by name/);
    assert.ok(!/Other kitchen/.test(seen[0].extra), 'not a project she doesn’t manage');
    assert.equal((await query(`SELECT kind FROM crm_ai_threads WHERE title LIKE 'Daily check-in%' AND user_id = $1`, [dana.id])).rows[0].kind, 'checkin', 'kept out of the Ask chat list');
    await ci.message(dana.id, 'The counter template guy never showed.', { now: THU });
    sent.length = 0;
    r = await ci.message(dana.id, 'Lowers and hardware tomorrow.', { now: THU });
    assert.equal(r.done, true); assert.equal(r.reply, 'Thanks, that’s everything.');
    assert.equal(r.summary.status, 'done'); assert.equal(r.summary.summary.projects[0].dealId, DEAL);
    // The problem: kept, in Needs you, and (urgent) emailed to the owner straight away, not to Dana.
    const probs = await ci.problems(owner);
    assert.equal(probs.length, 1); assert.equal(probs[0].urgent, true); assert.equal(probs[0].person, 'Dana Cruz');
    assert.ok((await query(`SELECT 1 FROM crm_inbox WHERE tenant_id = $1 AND kind = 'checkin_problem'`, [t])).rows.length);
    // Not emailed one by one: it waits for the owner's end-of-day email (first in it), not Dana's.
    assert.equal(mine(owner).length + mine(dana).length, 0, 'nothing one by one');
    assert.deepEqual((await query(`SELECT to_email, urgent FROM crm_team_mail WHERE tenant_id = $1 AND subject LIKE 'Urgent from Dana Cruz%'`, [t])).rows, [{ to_email: owner.email.toLowerCase(), urgent: true }]);
    assert.equal(mine(it).length, 0, 'no urgent email to a login left out');
    // Finishing again doesn't raise it twice.
    await ci.finish(dana.id, { now: THU });
    assert.equal((await ci.problems(owner)).length, 1);

    // Sam has no AI chat (the form): still summarized.
    await ci.finish(sam.id, { now: THU, form: { did: 'Demo at the Chen bath.', problems: 'none', next: 'Haul-off.' } });
    assert.equal((await ci.mine(sam.id))[0].summary.projects[0].did, 'Demo at the Chen bath.');

    // Who sees what: the owner sees everyone; Sam only his own.
    const day = await ci.teamDay(owner, '2026-10-29');
    const d = day.people.find(p => p.name === 'Dana Cruz');
    assert.equal(d.status, 'done'); assert.match(d.summary.headline, /Hung cabinets/);
    assert.equal(day.people.find(p => p.name === 'Olive Owner').status, 'sent', 'asked, not yet');
    await assert.rejects(ci.teamDay(sam, '2026-10-29'), /Only the owner/);
    await assert.rejects(ci.problems(sam), /Only the owner/);
    const chat = await ci.chat(owner, d.checkinId);
    assert.equal(chat.person, 'Dana Cruz'); assert.equal(chat.messages.length, 6); assert.ok(!chat.messages.some(m => m.text.includes('[[DONE]]')));
    await assert.rejects(ci.chat(sam, d.checkinId), /Not found/);
    assert.equal((await ci.chat(dana, d.checkinId)).messages.length, 6, 'your own');
    // Progress by project.
    const pr = await ci.projects(owner, { days: 400 });
    const g = pr.projects.find(x => x.dealId === DEAL);
    assert.equal(g.name, 'Ruiz kitchen'); assert.equal(g.latest, 'Cabinets 80% done'); assert.equal(g.entries[0].person, 'Dana Cruz');
    // Marking it handled.
    await ci.handleProblem(owner, probs[0].id);
    assert.equal((await ci.problems(owner)).length, 0);
    await assert.rejects(ci.handleProblem(owner, probs[0].id), /isn’t open/);

    // Olive starts her chat but stops partway: at 6pm it's summarized from what she said.
    turns = 0;
    assert.equal((await ci.message(owner.id, 'Walked the Ruiz job with the homeowner.', { now: THU })).done, false);
    // 6pm: the owners' and admins' summary of the day, once.
    sent.length = 0;
    // Sent late (8:30pm Central, Friday in UTC): still Thursday's progress.
    await ci.processTeamDigest({ now: THU_830PM, appUrl: 'https://app.test' });
    assert.equal(mine(owner).length, 0, 'part of the end-of-day email, not one of its own');
    await endOfDay(t);
    // One email for the owner: the urgent problem first, then the day's check-ins.
    const dg = mine(owner);
    assert.equal(dg.length, 1); assert.match(dg[0].subject, /^Your day at Checkin Co: \d+ updates, 1 needs you first/);
    assert.match(dg[0].html, /Today’s check-ins: 3 of 3, 2 problems/);
    assert.ok(dg[0].html.indexOf('Urgent from Dana Cruz') < dg[0].html.indexOf('3 of 3'), 'what needs her first');
    assert.match(dg[0].html, /Ruiz kitchen/); assert.match(dg[0].html, /<b>Olive Owner<\/b> <span[^>]*>\(stopped partway\)/);
    assert.equal((await ci.mine(owner.id))[0].status, 'done', 'her unfinished chat is wrapped up');
    assert.equal(mine(dana).length + mine(sam).length, 0, 'only owners and admins');
    assert.equal(mine(it).length, 0, 'no summary to a login left out');
    assert.ok(!(await ci.teamDay(owner, '2026-10-29')).people.some(p => p.name === 'IT Login'), 'not on the Team list');
    sent.length = 0; await ci.processTeamDigest({ now: THU_6PM, appUrl: 'https://app.test' }); await endOfDay(t);
    assert.equal(mine(owner).length, 0, 'once a day');
    assert.equal((await ci.processTeamDigest({ now: WED })).notYet, true);
    console.log('CHECKIN SCENARIO PASSED');
  } catch (e) {
    console.error('CHECKIN SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
