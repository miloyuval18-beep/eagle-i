// Pausing automatic email: while it's on, automatic emails aren't sent and each one is logged;
// sign-in codes and password resets (essential) still go, and so does whatever a person sends themselves.
// Off again: everything sends as before.
const { R } = require('./_local');
const assert = require('assert/strict');
const http = require('http');
const { query, pool } = require(R + '/db');
const tag = Date.now().toString(36);

(async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { got.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"id":"e1"}'); }); }).listen(0);
  await new Promise(r => srv.once('listening', r));
  process.env.RESEND_API_BASE = `http://127.0.0.1:${srv.address().port}`; process.env.RESEND_API_KEY = 'test';
  const E = require(R + '/lib/email');
  const was = await E.paused();
  try {
    await E.setPaused(true);
    const r = await E.sendEmail({ to: `ana${tag}@x.test`, subject: `Your estimate ${tag}`, text: 'Hi' });
    assert.deepEqual(r, { id: null, paused: true }); assert.equal(got.length, 0, 'nothing sent');
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM email_held WHERE subject = $1`, [`Your estimate ${tag}`])).rows[0].n, 1, 'logged');
    await E.sendEmail({ essential: true, to: `ana${tag}@x.test`, subject: `123456 is your Eagle I sign-in code`, text: 'code' });
    assert.equal(got.length, 1, 'a sign-in code still goes');
    // Sent by a person (inside their own signed-in request): goes. An automatic email their
    // action sets off (a stage's emails, an alert): still held. A background job: held.
    const asPerson = (fn) => new Promise((resolve, reject) => E.asPerson({ method: 'POST', session: { userId: 'u1' } }, {}, () => fn().then(resolve, reject)));
    await asPerson(() => E.sendEmail({ to: `ana${tag}@x.test`, subject: `Samantha invited you ${tag}`, text: 'Join' }));
    assert.equal(got.length, 2, 'an invite someone sent goes');
    const held = await asPerson(() => E.sendEmail({ automatic: true, to: `ana${tag}@x.test`, subject: `Stage email ${tag}`, text: 'Hi' }));
    assert.equal(held.paused, true, 'an automatic email set off by their action is held');
    await asPerson(() => new Promise(r => setTimeout(r, 5)).then(() => E.sendEmail({ to: `ana${tag}@x.test`, subject: `Later in the same request ${tag}`, text: 'Hi' })));
    assert.equal(got.length, 3, 'still theirs after waiting inside the request');
    const viewing = await new Promise(r => E.asPerson({ method: 'GET', session: { userId: 'u1' } }, {}, () => E.sendEmail({ to: `ana${tag}@x.test`, subject: `On a page load ${tag}`, text: 'Hi' }).then(r)));
    assert.equal(viewing.paused, true, 'opening a page never sends');
    const anon = await new Promise(r => E.asPerson({ method: 'POST', session: {} }, {}, () => E.sendEmail({ to: `ana${tag}@x.test`, subject: `Website form ${tag}`, text: 'Hi' }).then(r)));
    assert.equal(anon.paused, true, 'not signed in (a website visitor): held');
    // An invite Eagle I staff queued for a resend goes, pause or not, with a fresh link.
    const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Pause Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
    try {
      const boss = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', 'Sam', 'owner', 'crm') RETURNING id`, [t, `sam${tag}@x.test`])).rows[0].id;
      const team = require(R + '/lib/crmTeam');
      await team.createInvite({ tenantId: t, invitedBy: boss, email: `desk${tag}@x.test`, role: 'member', baseUrl: 'https://x.test', send: async () => ({ id: null, paused: true }) });
      await query(`INSERT INTO app_flags (key, value) VALUES ('resend_invites', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ emails: [`desk${tag}@x.test`, `nobody${tag}@x.test`] })]);
      const before = got.length;
      const rq = await team.processResendQueue({ baseUrl: 'https://x.test' });
      assert.equal(rq.sent, 1); assert.equal(got.length, before + 1, 'the invite went out during the pause');
      assert.match(got[got.length - 1].subject, /Sam invited you/);
      assert.equal(rq.out.find(o => o.email === `nobody${tag}@x.test`).why, 'no open invite');
      assert.equal((await team.processResendQueue()).out.length, 0, 'the queue empties');
      assert.equal((await query(`SELECT COUNT(*)::int n FROM crm_invites WHERE tenant_id = $1 AND revoked_at IS NULL`, [t])).rows[0].n, 1, 'one open invite, the fresh one');
    } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await query(`DELETE FROM app_flags WHERE key = 'resend_invites_result'`); }
    await E.setPaused(false);
    await E.sendEmail({ to: `ana${tag}@x.test`, subject: 'Back on', text: 'Hi' });
    assert.equal(got.length, 5, 'off: sends again');
    console.log('EMAIL PAUSE SCENARIO PASSED');
  } catch (e) {
    console.error('EMAIL PAUSE SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await E.setPaused(was).catch(() => {});
    await query(`DELETE FROM email_held WHERE subject LIKE $1`, [`%${tag}%`]).catch(() => {});
    srv.close(); await pool.end();
  }
})();
