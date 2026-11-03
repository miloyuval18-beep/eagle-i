// Pausing all outgoing email: while it's on, nothing is sent and each one is logged;
// sign-in codes and password resets (essential) still go, so people can get in.
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
    await E.setPaused(false);
    await E.sendEmail({ to: `ana${tag}@x.test`, subject: 'Back on', text: 'Hi' });
    assert.equal(got.length, 2, 'off: sends again');
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
