// One email a day per person: what would have been separate update emails waits for
// the end of the day (6pm Central) and goes out together, to each person only what
// was for them, the things that need them first; nobody with nothing gets one; once;
// tried again if sending fails; made-up test addresses never get it.
const { R, endOfDay } = require('./_local');
const assert = require('assert/strict');
const sent = [];
let failFor = null;
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async (m) => { if (m.to === failFor) throw new Error('down'); sent.push(m); return { id: 'e' + sent.length }; },
  getReceivedEmail: async () => ({ from: 'Maria Tile <maria@tile.dev>', subject: 'Re: Bid request', text: 'We can do the tile at $3.50 a foot.' }) };
delete process.env.ANTHROPIC_API_KEY;
const { query, pool } = require(R + '/db');
const TM = require(R + '/lib/crmTeamMail');
const tag = Date.now().toString(36);

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Mail Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const add = async (local, name) => (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', $3, 'member', 'crm') RETURNING *`, [t, `${local}.${tag}@mail.dev`, name])).rows[0];
    const levi = await add('levi', 'Levi Stone'), dana = await add('dana', 'Dana Cruz'); await add('sam', 'Sam Crew');
    // During the day: Levi has four, Dana one, Sam none.
    await TM.later({ tenantId: t, to: levi.email, subject: 'New lead: Maria Garcia (website)', text: 'Kitchen with an island.', kind: 'lead', link: 'https://app.test/crm/app#pipeline' });
    await TM.later({ tenantId: t, to: levi.email.toUpperCase(), subject: 'Payment received: $5,000 from Kim Lee', html: '<p>Kim Lee paid invoice #12: <b>$5,000</b> by card.</p>', kind: 'customer' });
    await TM.later({ tenantId: t, to: levi.email, subject: 'Rita replied', text: 'Thursday works for us.', kind: 'customer', replyTo: 'rita@home.dev' });
    await TM.later({ tenantId: t, to: [levi.email, dana.email], subject: 'Urgent: Plumbing permit not approved yet: Lee kitchen', text: 'Rough plumbing starts Monday.', kind: 'job', urgent: true });
    await TM.later({ tenantId: t, to: 'not an email', subject: 'x' });

    // Before 6pm: nothing goes.
    assert.deepEqual(await TM.processEndOfDay({ now: new Date('2026-11-03T22:59:00Z'), tenantId: t }), { sent: 0 }, '4:59pm Central');
    assert.equal(sent.length, 0);
    // 6pm: one each, only their own.
    process.env.CRM_EMAIL_TEST_ADDRESSES = '1';
    const r = await TM.processEndOfDay({ now: new Date('2026-11-04T00:05:00Z'), tenantId: t, appUrl: 'https://app.test' });
    delete process.env.CRM_EMAIL_TEST_ADDRESSES;
    assert.equal(r.sent, 2);
    const L = sent.find(m => m.to === levi.email.toLowerCase()), D = sent.find(m => m.to === dana.email.toLowerCase());
    assert.equal(sent.length, 2, 'nobody with nothing gets one');
    assert.equal(L.subject, 'Your day at Mail Co: 4 updates, 1 needs you first');
    assert.match(L.html, /Hi Levi,/);
    // In order: what needs them first, then leads, then customers.
    const at = (x) => L.html.indexOf(x);
    assert.ok(at('Needs you first') < at('Plumbing permit') && at('Plumbing permit') < at('New leads') && at('New leads') < at('New lead: Maria') && at('Maria') < at('From customers') && at('From customers') < at('Payment received'));
    assert.match(L.html, /Kim Lee paid invoice #12: \$5,000 by card\./, 'an email’s words, without its markup');
    assert.match(L.html, /mailto:rita@home\.dev\?subject=Re%3A%20Rita%20replied/, 'a customer’s reply can be answered straight from it');
    assert.match(L.html, /href="https:\/\/app\.test\/crm\/app#pipeline"/);
    assert.match(L.text, /NEEDS YOU FIRST\n- Urgent: Plumbing permit/);
    assert.equal(D.subject, 'Your day at Mail Co: 1 update, 1 needs you first');
    assert.ok(!/Maria|Payment|Rita/.test(D.html), 'only what was for Dana');
    // Once.
    sent.length = 0;
    assert.equal((await endOfDay(t)).sent, 0); assert.equal(sent.length, 0);
    // Sending fails: kept and tried again next round.
    await TM.later({ tenantId: t, to: dana.email, subject: 'Order today for Lee kitchen', kind: 'job' });
    failFor = dana.email.toLowerCase();
    assert.equal((await endOfDay(t)).sent, 0);
    failFor = null;
    assert.equal((await endOfDay(t)).sent, 1); assert.match(sent[0].html, /Order today for Lee kitchen/);
    // A vendor's emailed reply about prices: on the deal, and in the company's end-of-day email with "Reply to them", not forwarded on its own.
    await query(`INSERT INTO business_profile (tenant_id, email) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET email = EXCLUDED.email`, [t, `office.${tag}@mail.dev`]);
    const deal = await require(R + '/lib/crm').createDeal({ tenantId: t, name: 'Kim Lee', title: 'Lee bath', stage: 'estimate', userId: levi.id });
    const v = (await query(`INSERT INTO crm_vendors (tenant_id, name, trade, email) VALUES ($1, 'Maria Tile', 'Tile', 'maria@tile.dev') RETURNING id`, [t])).rows[0];
    const bid = (await query(`INSERT INTO crm_bid_requests (tenant_id, deal_id, vendor_id, token, scope, file_ids) VALUES ($1, $2, $3, $4, 'Tile', '{}') RETURNING id`, [t, deal.id, v.id, require('crypto').randomBytes(24).toString('hex')])).rows[0];
    sent.length = 0;
    await require(R + '/routes/inboundEmail').processInboundEmail({ to: [`reply+bid-${bid.id}@in.mail.dev`], email_id: 'm1' });
    assert.equal(sent.length, 0, 'not forwarded on its own');
    const held = (await query(`SELECT to_email, kind, reply_to, subject, body FROM crm_team_mail WHERE tenant_id = $1 AND sent_at IS NULL`, [t])).rows;
    assert.deepEqual(held.map(h => [h.to_email, h.kind, h.reply_to]), [[`office.${tag}@mail.dev`, 'pricing', 'maria@tile.dev']]);
    assert.match(held[0].subject, /Maria Tile replied about prices/); assert.match(held[0].body, /\$3\.50 a foot/);
    await endOfDay(t);
    assert.match(sent[0].html, /mailto:maria@tile\.dev/);

    // Made-up test addresses never get it.
    const robot = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role, app) VALUES ($1, $2, 'x', 'Bot', 'member', 'crm') RETURNING *`, [t, `bot.${tag}@eagle-i-test.com`])).rows[0];
    sent.length = 0;
    await TM.later({ tenantId: t, to: robot.email, subject: 'Hello', kind: 'other' });
    await endOfDay(t, { realTestFilter: true });
    assert.equal(sent.length, 0);
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_team_mail WHERE tenant_id = $1 AND sent_at IS NULL`, [t])).rows[0].n, 0, 'and isn’t tried forever');
    console.log('TEAM MAIL SCENARIO PASSED');
  } catch (e) {
    console.error('TEAM MAIL SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {});
    await pool.end();
  }
})();
