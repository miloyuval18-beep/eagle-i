// The team calendar: filled from everything with a date, who sees what,
// clashes and rain, adding and moving things, appointments found in email,
// the person's own Google Calendar, the calendar link and the assistant.
const { R } = require('./_local');
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.RESEND_API_KEY; delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
process.env.ANTHROPIC_API_KEY = 'test-only';
process.env.GOOGLE_CRM_CLIENT_ID = 'cid.apps.googleusercontent.com'; process.env.GOOGLE_CRM_CLIENT_SECRET = 'secret';
process.env.SOCIAL_CREDENTIALS_KEY = process.env.SOCIAL_CREDENTIALS_KEY || crypto.randomBytes(32).toString('hex');
const realEmail = require(R + '/lib/email');
require.cache[require.resolve(R + '/lib/email')].exports = { ...realEmail, sendEmail: async () => ({ id: 'x' }) };
let APPT = null;
require.cache[require.resolve(R + '/lib/anthropic')] = { exports: { ...require(R + '/lib/anthropic'), generateJSON: async (p) => {
  if (/sort a remodeling/.test(p)) {
    const items = JSON.parse(p.split('<emails>')[1].split('</emails>')[0]);
    return { emails: items.map(i => ({ id: i.id, expects: false, importance: 'high', reason: '', deadline: null, promise: null, appointment: APPT })) };
  }
  return {};
} } };
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const jobs = require(R + '/lib/crmJobs'); const tasks = require(R + '/lib/crmTasks');
const cal = require(R + '/lib/crmCalendar'); const daily = require(R + '/lib/crmDaily'); const watch = require(R + '/lib/crmEmailWatch');
const A = require(R + '/lib/crmAssistant');
const zoned = require(R + '/lib/outreachQueue').zonedToUtc;
const TZ = 'America/Chicago';
const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const add = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const at = (day, h, m = 0) => zoned(...day.split('-').map(Number), h, m);
const D1 = add(today, 1), D2 = add(today, 2), D3 = add(today, 3), D5 = add(today, 5);

// A fake Google Calendar for the owner.
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
let gcalls = 0;
async function fakeGoogle(url, opts = {}) {
  const u = new URL(url);
  if (u.hostname === 'oauth2.googleapis.com') return json({ access_token: 'at-cal', expires_in: 3600 });
  if (u.pathname === '/calendar/v3/calendars/primary/events') {
    gcalls++;
    assert.equal(opts.headers.Authorization, 'Bearer at-cal');
    return json({ items: [
      { id: 'g1', summary: 'Bank: construction loan', start: { dateTime: at(D2, 15).toISOString() }, end: { dateTime: at(D2, 16).toISOString() }, htmlLink: 'https://www.google.com/calendar/event?eid=g1' },
      { id: 'g2', summary: 'Declined lunch', start: { dateTime: at(D2, 12).toISOString() }, end: { dateTime: at(D2, 13).toISOString() }, attendees: [{ self: true, responseStatus: 'declined' }] },
      { id: 'g3', summary: 'Inspection (from invite)', start: { dateTime: at(D5, 10).toISOString() }, end: { dateTime: at(D5, 11).toISOString() } },
      { id: 'g4', summary: 'Kid’s recital', start: { date: D3 }, end: { date: add(D3, 1) } }
    ] });
  }
  return json({ error: { message: 'unexpected ' + url } }, 400);
}

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Cal Homes', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Cal Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email) VALUES ($1, 'o@cal.test')`, [t]);
    const ownerId = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'moran@cal.test', 'x', 'Moran', 'owner') RETURNING id`, [t])).rows[0].id;
    const alexId = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'alex@cal.test', 'x', 'Alex', 'member') RETURNING id`, [t])).rows[0].id;
    const strangerId = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'x@other.test', 'x', 'X', 'owner') RETURNING id`, [t2])).rows[0].id;
    const owner = { id: ownerId, role: 'owner' }, alex = { id: alexId, role: 'member' }, stranger = { id: strangerId, role: 'owner' };

    // Alex's sale: a site visit tomorrow at 10.
    const sale = await crm.createDeal({ tenantId: t, name: 'Ana Ruiz', email: 'ana@cal.test', phone: '713-555-0100', address: '12 Oak Ln, Houston TX 77024', title: 'Ruiz kitchen', ownerUserId: alexId });
    await query('UPDATE crm_deals SET site_visit_at = $2, site_visit_user_id = $3 WHERE id = $1', [sale.id, at(D1, 10), alexId]);
    // Moran's two jobs, with the same framer on overlapping days.
    const job = await crm.createDeal({ tenantId: t, name: 'Bo Lee', email: 'bo@cal.test', address: '4 Pine St, Houston TX 77079', title: 'Lee addition', ownerUserId: ownerId });
    await crm.changeStage({ tenantId: t, dealId: job.id, stage: 'production', userId: ownerId });
    const job2 = await crm.createDeal({ tenantId: t, name: 'Cy Park', email: 'cy@cal.test', title: 'Park deck', ownerUserId: ownerId });
    await crm.changeStage({ tenantId: t, dealId: job2.id, stage: 'production', userId: ownerId });
    await query('DELETE FROM crm_job_items WHERE deal_id = ANY($1::uuid[])', [[job.id, job2.id]]);
    const framer = await jobs.saveVendor({ tenantId: t, body: { name: 'Gulf Framing', trade: 'Framing', email: 'gulf@sub.test', phone: '713-555-0199' } });
    await query('UPDATE crm_vendors SET insurance_expires = $2 WHERE id = $1', [framer.id, D5]);
    const framing = await jobs.saveItem({ tenantId: t, dealId: job.id, body: { title: 'Framing', startDate: D1, endDate: D3, vendorId: framer.id, assigneeUserId: alexId } });
    await query(`UPDATE crm_job_items SET confirm_status = 'confirmed' WHERE id = $1`, [framing.id]);
    const deckFraming = await jobs.saveItem({ tenantId: t, dealId: job2.id, body: { title: 'Deck framing', startDate: D2, endDate: D2, vendorId: framer.id } });
    await tasks.createTask({ tenantId: t, dealId: sale.id, title: 'Bring tile samples', dueAt: at(D1, 9), assigneeUserId: alexId });
    const late = await tasks.createTask({ tenantId: t, title: 'Call the city', dueAt: new Date(Date.now() - 3600000), assigneeUserId: ownerId });
    // Dates already on Moran's job: a delivery, a payment, a selection, a bid, an expiring estimate, a warranty.
    await jobs.createPO({ tenantId: t, dealId: job.id, vendorId: framer.id, title: 'Lumber package', lines: [{ description: 'Studs', quantity: 1, unit_cost: 100 }] });
    await query(`UPDATE crm_purchase_orders SET needed_by = $2 WHERE deal_id = $1`, [job.id, D2]);
    await query(`INSERT INTO crm_invoices (tenant_id, deal_id, number, title, amount, status, due_date, public_token) VALUES ($1, $2, 9001, 'Framing draw', 12500, 'sent', $3, $4)`, [t, job.id, D3, crypto.randomBytes(16).toString('hex')]);
    await query(`INSERT INTO crm_selections (tenant_id, deal_id, category, due_date) VALUES ($1, $2, 'Tile', $3)`, [t, job.id, D2]);
    await query(`INSERT INTO crm_bid_requests (tenant_id, deal_id, vendor_id, token, scope, due_date, status) VALUES ($1, $2, $3, $4, 'Roof framing', $5, 'sent')`, [t, job.id, framer.id, crypto.randomBytes(16).toString('hex'), D3]);
    await query(`INSERT INTO crm_estimates (tenant_id, deal_id, number, title, status, valid_until, public_token) VALUES ($1, $2, 7001, 'Addition', 'sent', $3, $4)`, [t, job.id, D5, crypto.randomBytes(16).toString('hex')]);
    await require(R + '/lib/crmLifetime').saveHomeItem({ tenantId: t, dealId: job.id, body: { name: 'Water heater', category: 'appliance', warrantyUntil: D5 } });
    // Rain on the framing (lib/crmDaily.js's morning check).
    await crm.addInboxItem({ tenantId: t, dealId: job.id, kind: 'weather', dedupeKey: `rain:${framing.id}:${D2}`, title: `70% chance of rain Thu during Framing (Lee addition)` });

    const keys = (r) => r.items.map(i => i.type);
    const find = (r, re) => r.items.find(i => re.test(i.title));
    const span = { from: today, to: add(today, 6) };

    // 1. Alex sees their own: the visit, the phase they're on, their task. Not Moran's money or the other job.
    const ra = await cal.range({ tenantId: t, viewer: alex, ...span });
    assert.ok(find(ra, /^Site visit: Ana Ruiz/) && find(ra, /^Framing$/) && find(ra, /Bring tile samples/));
    for (const re of [/Payment due/, /Deck framing/, /Call the city/, /Insurance runs out/, /Delivery/]) assert.ok(!find(ra, re), `Alex doesn't see ${re}`);
    await assert.rejects(cal.range({ tenantId: t, viewer: alex, ...span, who: 'all' }), /owner or an admin/);
    await assert.rejects(cal.range({ tenantId: t, viewer: alex, ...span, who: ownerId }), /owner or an admin/);

    // 2. Moran sees everyone's: every kind of date, with the details that matter.
    const ro = await cal.range({ tenantId: t, viewer: owner, ...span, who: 'all' });
    for (const k of ['visit', 'phase', 'task', 'delivery', 'money', 'selection', 'bid', 'estimate', 'compliance']) assert.ok(keys(ro).includes(k), `everyone's calendar has ${k}`);
    const fr = find(ro, /^Framing$/);
    assert.equal(fr.start, D1); assert.equal(fr.end, D3); assert.equal(fr.confirm, 'confirmed'); assert.equal(fr.vendor, 'Gulf Framing');
    assert.deepEqual(fr.rain, [{ day: D2, chance: 70 }], 'rain is on the phase');
    assert.match(fr.clash, /also on Park deck/, 'the sub is on two jobs at once');
    assert.match(find(ro, /Deck framing/).clash, /also on Lee addition/);
    assert.match(find(ro, /Payment due: \$12,500 from Bo Lee/).sub, /#9001/);
    assert.match(find(ro, /Delivery: Lumber package/).warn, /hasn’t been sent/);
    assert.equal(find(ro, /Call the city/).warn, 'Overdue');
    assert.ok(find(ro, /Insurance runs out: Gulf Framing/) && find(ro, /Warranty ends: Water heater/) && find(ro, /Estimate expires: Bo Lee/) && find(ro, /Bid due: Gulf Framing/) && find(ro, /Bo Lee picks Tile/));
    assert.ok(ro.items.findIndex(i => i.allDay && i.start === D1) < ro.items.findIndex(i => !i.allDay && i.start === at(D1, 9).toISOString()), 'all-day first, then by time');
    // Moran's own: their deals and what's on nobody's plate, not Alex's sale.
    const rm = await cal.range({ tenantId: t, viewer: owner, ...span });
    assert.ok(find(rm, /Payment due/) && find(rm, /Deck framing/) && !find(rm, /Site visit: Ana/));
    // One person.
    const rAlexByOwner = await cal.range({ tenantId: t, viewer: owner, ...span, who: alexId });
    assert.ok(find(rAlexByOwner, /Site visit: Ana/) && !find(rAlexByOwner, /Payment due/));

    // 3. Adding: members to their own; owners to anyone's or everyone's. One person in two places is flagged.
    const mtg = await cal.createEvent({ tenantId: t, actor: alex, body: { title: 'Cabinet showroom with Ana', kind: 'meeting', date: D1, time: '10:30', minutes: 45, dealId: sale.id } });
    assert.equal(mtg.location, '12 Oak Ln, Houston TX 77024', 'no place given: the job’s address');
    assert.equal((new Date(mtg.ends_at) - new Date(mtg.starts_at)) / 60000, 45);
    await assert.rejects(cal.createEvent({ tenantId: t, actor: alex, body: { title: 'x', date: D1, userId: ownerId } }), /your own calendar/);
    await assert.rejects(cal.createEvent({ tenantId: t, actor: alex, body: { title: 'x', date: D1, dealId: job.id.replace(/.$/, '0') } }), /isn’t at this company/);
    await assert.rejects(cal.createEvent({ tenantId: t, actor: alex, body: { title: '', date: D1 } }), /Say what it is/);
    await assert.rejects(cal.createEvent({ tenantId: t, actor: alex, body: { title: 'x', date: D1, time: '10:00', endTime: '09:00' } }), /ends before/);
    const allHands = await cal.createEvent({ tenantId: t, actor: owner, body: { title: 'Team safety meeting', date: D2, time: '07:00', userId: null } });
    const ra2 = await cal.range({ tenantId: t, viewer: alex, ...span });
    assert.match(find(ra2, /Cabinet showroom/).clash, /Site visit: Ana Ruiz/, 'a meeting during the visit');
    assert.match(find(ra2, /^Site visit: Ana/).clash, /Cabinet showroom/);
    assert.equal(find(ra2, /Team safety meeting/).who, 'Everyone', 'company-wide shows for everyone');
    assert.ok((await query(`SELECT 1 FROM crm_activities WHERE deal_id = $1 AND body LIKE 'On the calendar: Cabinet showroom%'`, [sale.id])).rows.length, 'noted on the deal');
    await assert.rejects(cal.updateEvent({ tenantId: t, actor: alex, id: allHands.id, body: { title: 'Mine now' } }), /Only the person/);
    await assert.rejects(cal.deleteEvent({ tenantId: t, actor: alex, id: allHands.id }), /Only the person/);
    await assert.rejects(cal.deleteEvent({ tenantId: t2, actor: stranger, id: mtg.id }), /not on the calendar/);

    // 4. Moving: each kind goes through its own rules; the sub is asked to confirm a moved phase.
    await cal.move({ tenantId: t, actor: alex, type: 'event', id: mtg.id, date: D2 });
    const moved = (await query('SELECT * FROM crm_events WHERE id = $1', [mtg.id])).rows[0];
    assert.equal(new Date(moved.starts_at).toISOString(), at(D2, 10, 30).toISOString(), 'same time, new day');
    assert.equal((new Date(moved.ends_at) - new Date(moved.starts_at)) / 60000, 45, 'same length');
    await cal.move({ tenantId: t, actor: alex, type: 'visit', id: sale.id, date: D3, time: '14:00' });
    assert.equal(new Date((await crm.getDeal(t, sale.id)).site_visit_at).toISOString(), at(D3, 14).toISOString());
    const tid = find(ra, /Bring tile samples/).id;
    await cal.move({ tenantId: t, actor: alex, type: 'task', id: tid, date: D2 });
    assert.equal(new Date((await query('SELECT due_at FROM crm_tasks WHERE id = $1', [tid])).rows[0].due_at).toISOString(), at(D2, 9).toISOString(), 'keeps its time');
    await cal.move({ tenantId: t, actor: alex, type: 'phase', id: framing.id, date: D2 });
    const fr2 = (await query('SELECT start_date, end_date, confirm_status FROM crm_job_items WHERE id = $1', [framing.id])).rows[0];
    assert.equal(require(R + '/lib/crmCalendar').addBusinessDays(D1, 0), D1);
    const dOnly = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    assert.equal(dOnly(fr2.start_date), D2); assert.equal(dOnly(fr2.end_date), add(D3, 1), 'keeps its length');
    assert.notEqual(fr2.confirm_status, 'confirmed', 'the sub confirms the new dates');
    await assert.rejects(cal.move({ tenantId: t, actor: alex, type: 'task', id: late.id, date: D2 }), /someone else’s/);
    await assert.rejects(cal.move({ tenantId: t, actor: alex, type: 'phase', id: deckFraming.id, date: D2 }), /isn’t yours/);
    await assert.rejects(cal.move({ tenantId: t2, actor: stranger, type: 'task', id: tid, date: D2 }), /not found/);
    await assert.rejects(cal.move({ tenantId: t, actor: alex, type: 'visit', id: sale.id, date: add(today, -2), time: '09:00' }), /already passed/);

    // 5. Found in email: an inspection set in an email goes on the calendar, once.
    await query(`INSERT INTO crm_mailboxes (tenant_id, email, name, included) VALUES ($1, 'moran@cal.test', 'Moran', true) ON CONFLICT DO NOTHING`, [t]);
    const th = (await query(`INSERT INTO crm_mail_threads (tenant_id, mailbox_email, user_id, thread_id, counterpart_email, counterpart_name, subject, deal_id, last_dir, last_at, last_snippet, state)
      VALUES ($1, 'moran@cal.test', $2, 'th-insp', 'inspector@city.test', 'City Inspector', 'Framing inspection', $3, 'in', now(), 'I will be out Thursday at 10 for framing.', 'to_reply') RETURNING id`, [t, ownerId, job.id])).rows[0].id;
    APPT = { title: 'Framing inspection, Lee addition', kind: 'inspection', date: D5, time: '10:00', minutes: null, location: null };
    await watch.classifyPending({ tenantId: t, mailboxEmail: 'moran@cal.test' });
    await query('UPDATE crm_mail_threads SET classified_at = NULL, state = $2 WHERE id = $1', [th, 'to_reply']);
    await watch.classifyPending({ tenantId: t, mailboxEmail: 'moran@cal.test' });
    const found = (await query(`SELECT * FROM crm_events WHERE tenant_id = $1 AND source = 'email'`, [t])).rows;
    assert.equal(found.length, 1, 'once, however often the email is read');
    assert.equal(found[0].kind, 'inspection'); assert.equal(found[0].user_id, ownerId); assert.equal(found[0].deal_id, job.id);
    assert.equal(found[0].location, '4 Pine St, Houston TX 77079');
    assert.equal(new Date(found[0].starts_at).toISOString(), at(D5, 10).toISOString());
    assert.match(found[0].notes, /City Inspector/);
    APPT = { title: 'Old thing', kind: 'meeting', date: add(today, -3), time: '10:00' };
    await query('UPDATE crm_mail_threads SET classified_at = NULL, state = $2 WHERE id = $1', [th, 'to_reply']);
    await watch.classifyPending({ tenantId: t, mailboxEmail: 'moran@cal.test' });
    assert.equal((await query(`SELECT COUNT(*)::int AS n FROM crm_events WHERE tenant_id = $1 AND source = 'email'`, [t])).rows[0].n, 1, 'nothing in the past');
    // The follow-up due on an email nobody answered (Moran's own email only).
    await query(`INSERT INTO crm_mail_threads (tenant_id, mailbox_email, user_id, thread_id, counterpart_email, counterpart_name, subject, reason, last_dir, last_at, state, classified_at)
      VALUES ($1, 'moran@cal.test', $2, 'th-fu', 'gulf@sub.test', 'Gulf Framing', 'Framing price', 'Waiting on their framing price', 'out', now() - interval '9 days', 'waiting', now())`, [t, ownerId]);
    const rf = await cal.range({ tenantId: t, viewer: owner, from: today, to: add(today, 30) });
    const fu = find(rf, /Follow up: Gulf Framing/);
    assert.equal(fu.start, today); assert.equal(fu.warn, 'No reply yet');
    assert.ok(!find(await cal.range({ tenantId: t, viewer: owner, from: today, to: add(today, 30), who: 'all' }), /Follow up:/), 'email follow-ups aren’t on everyone’s');

    // 6. Moran's Google Calendar, only for Moran: declined skipped, the email inspection shows once.
    await query(`UPDATE crm_mailboxes SET refresh_token_enc = $2, scopes = $3, connected_by = $4 WHERE tenant_id = $1 AND email = 'moran@cal.test'`,
      [t, JSON.stringify(require(R + '/lib/crypto').encrypt('rt-moran')), 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly', ownerId]);
    assert.equal((await cal.googleStatus(t, ownerId)).on, true); assert.equal((await cal.googleStatus(t, alexId)).on, false);
    const rg = await cal.range({ tenantId: t, viewer: owner, ...span, http: fakeGoogle });
    assert.ok(find(rg, /Bank: construction loan/) && !find(rg, /Declined lunch/));
    assert.equal(find(rg, /Kid’s recital/).start, D3); assert.equal(find(rg, /Kid’s recital/).end, D3);
    assert.ok(find(rg, /Inspection \(from invite\)/) && !find(rg, /Framing inspection, Lee addition/), 'the email one and the invite show once');
    const calls = gcalls;
    await cal.range({ tenantId: t, viewer: owner, ...span, http: fakeGoogle });
    assert.equal(gcalls, calls, 'read again from a short cache');
    assert.ok(!(await cal.range({ tenantId: t, viewer: owner, ...span, who: 'all', http: fakeGoogle })).items.some(i => i.type === 'google'), 'not on everyone’s view');
    assert.ok(!(await cal.range({ tenantId: t, viewer: alex, ...span, http: fakeGoogle })).items.some(i => i.type === 'google'), 'never on anyone else’s');
    // The calendar sign-in asks Google for the calendar too.
    const url = new URL(await require(R + '/lib/crmGoogle').signInUrl({ tenantId: t, userId: alexId, wantCalendar: true, redirectUri: 'https://app.test/cb' }));
    assert.match(url.searchParams.get('scope'), /calendar\.events\.readonly/);
    assert.equal((await query('SELECT want_calendar FROM crm_google_oauth_states WHERE state = $1', [url.searchParams.get('state')])).rows[0].want_calendar, true);

    // 7. The calendar link (Google/Apple) carries meetings, deliveries and payments too.
    const ics = await daily.calendarFor(await daily.calendarToken(ownerId));
    for (const s of ['SUMMARY:Team safety meeting', 'SUMMARY:Framing inspection\\, Lee addition', 'SUMMARY:Delivery: Lumber package', 'SUMMARY:Payment due: $12\\,500 from Bo Lee', 'SUMMARY:Insurance runs out: Gulf Framing']) assert.ok(ics.includes(s), `the link has ${s}`);
    assert.ok(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75));
    const icsAlex = await daily.calendarFor(await daily.calendarToken(alexId));
    assert.ok(icsAlex.includes('Team safety meeting') && !icsAlex.includes('Payment due'));

    // 8. Another company sees none of it.
    const rx = await cal.range({ tenantId: t2, viewer: stranger, from: today, to: add(today, 30), who: 'all' });
    assert.equal(rx.items.length, 0);
    await assert.rejects(cal.range({ tenantId: t2, viewer: stranger, ...span, who: ownerId }), /No one on the team/);

    // 9. The assistant reads it and adds to it.
    const ctx = { tenantId: t, userId: alexId, manager: false, baseUrl: 'https://app.test' };
    const ar = await A.TOOLS.calendar.run(ctx, { from: today, to: add(today, 6) });
    assert.ok(ar.items.some(i => /Site visit: Ana/.test(i.title)) && !ar.items.some(i => /Payment due/.test(i.title)));
    await assert.rejects(A.TOOLS.calendar.run(ctx, { person: 'Moran' }), /owner or an admin/);
    const added = await A.TOOLS.add_to_calendar.run(ctx, { title: 'Walkthrough with Ana', kind: 'walkthrough', date: D3, time: '16:00', deal_id: sale.id });
    assert.equal(added.done, true);
    assert.equal((await query('SELECT source, user_id FROM crm_events WHERE id = $1', [added.event_id])).rows[0].source, 'assistant');
    await assert.rejects(A.TOOLS.add_to_calendar.run(ctx, { title: 'For Moran', date: D3, person: 'Moran' }), /your own calendar/);
    const octx = { tenantId: t, userId: ownerId, manager: true, baseUrl: 'https://app.test' };
    const oall = await A.TOOLS.calendar.run(octx, { person: 'everyone', from: today, to: add(today, 6) });
    assert.ok(oall.items.some(i => i.clash) && oall.items.some(i => i.rain));
    console.log('CALENDAR SCENARIO PASSED');
  } catch (e) {
    console.error('CALENDAR SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
