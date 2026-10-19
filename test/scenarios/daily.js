delete process.env.ANTHROPIC_API_KEY; delete process.env.RESEND_API_KEY;
const assert = require('assert/strict');
const { R } = require('./_local');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const daily = require(R + '/lib/crmDaily'); const assist = require(R + '/lib/crmAssist');
const tasks = require(R + '/lib/crmTasks');
const sent = []; const send = async (m) => { sent.push(m); return { id: 'x' }; };
const calls = [];
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Day Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, email, address) VALUES ($1, 'o@day.test', '1001 S Dairy Ashford, Houston TX 77077')`, [t]);
    const owner = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'sam@day.test', 'x', 'Sam Rivera', 'owner') RETURNING id`, [t])).rows[0].id;
    const member = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'alex@day.test', 'x', 'Alex Kim', 'member') RETURNING id`, [t])).rows[0].id;
    // Tomorrow 10am Central: a visit for Alex; a framing phase; a task.
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const [y, m, d] = tomorrow.split('-').map(Number);
    const visitAt = require(R + '/lib/outreachQueue').zonedToUtc(y, m, d, 10, 0);
    const deal = await crm.createDeal({ tenantId: t, name: 'Ana, Ruiz', email: 'ana@day.test', phone: '713-555-0100', address: '12 Oak Ln, Houston TX 77024', title: 'Kitchen; phase 1', stage: 'qualified' });
    await query('UPDATE crm_deals SET site_visit_at = $2, site_visit_user_id = $3, brief = $4 WHERE id = $1', [deal.id, visitAt, member, 'Wants: Kitchen\nBudget: $50k–$100k']);
    const job = await crm.createDeal({ tenantId: t, name: 'Bo Lee', email: 'bo@day.test', address: '4 Pine St, Houston TX 77079', title: 'Deck', stage: 'signed' });
    await query(`DELETE FROM crm_job_items WHERE deal_id = $1`, [job.id]);
    const item = (await query(`INSERT INTO crm_job_items (tenant_id, deal_id, title, start_date, end_date, assignee_user_id, position) VALUES ($1, $2, 'Framing the deck', $3, $3, $4, 0) RETURNING id`, [t, job.id, tomorrow, member])).rows[0].id;
    await tasks.createTask({ tenantId: t, dealId: deal.id, title: 'Bring tile samples', dueAt: visitAt, assigneeUserId: member });
    // Calendar: Alex sees their visit, phase and task, escaped and folded.
    const tok = await daily.calendarToken(member);
    assert.equal(await daily.calendarToken(member), tok);
    const ics = await daily.calendarFor(tok);
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/); assert.match(ics, /END:VCALENDAR\r\n$/);
    assert.match(ics, /SUMMARY:Site visit: Ana\\, Ruiz/);
    assert.match(ics, /SUMMARY:Framing the deck · Deck/);
    assert.match(ics, /SUMMARY:To do: Bring tile samples/);
    assert.match(ics, new RegExp(`DTSTART;VALUE=DATE:${tomorrow.replace(/-/g, '')}`));
    assert.ok(ics.includes('DESCRIPTION:Kitchen\\; phase 1'));
    assert.ok(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'lines folded');
    const newTok = await daily.resetCalendarToken(member);
    assert.equal(await daily.calendarFor(tok), null); assert.ok(await daily.calendarFor(newTok));
    // Morning email for tomorrow at 7:30am: Alex gets theirs, once; switching off stops it.
    const morning = require(R + '/lib/outreachQueue').zonedToUtc(y, m, d, 7, 30);
    const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(morning);
    if (dow !== 'Sun') {
      let r = await daily.processDigests({ now: morning, send, appUrl: 'https://x' });
      const alex = sent.find(s => s.to === 'alex@day.test');
      assert.ok(alex, JSON.stringify(sent.map(s => s.to)));
      assert.match(alex.text, /SITE VISITS/); assert.match(alex.text, /10:00 AM · Ana, Ruiz · 12 Oak Ln/);
      assert.match(alex.text, /STARTING TODAY\n- Framing the deck · Deck/); assert.match(alex.text, /Bring tile samples/);
      assert.match(alex.subject, /1 visit/);
      sent.length = 0;
      r = await daily.processDigests({ now: new Date(morning.getTime() + 600000), send });
      assert.equal(r.sent, 0, 'once a day');
      await daily.setDigest(member, false);
      await query('UPDATE users SET crm_digest_sent_on = NULL WHERE tenant_id = $1', [t]);
      await daily.processDigests({ now: morning, send });
      assert.ok(!sent.some(s => s.to === 'alex@day.test'), 'switched off');
    }
    assert.equal((await daily.processDigests({ now: require(R + '/lib/outreachQueue').zonedToUtc(y, m, d, 13, 0), send })).sent, 0, 'only in the morning');
    // Rain: geocode once, forecast, flag the outdoor phase once.
    daily.setHttp(async (url) => {
      calls.push(url);
      if (/geocoding/.test(url)) return { json: async () => ({ result: { addressMatches: [{ coordinates: { x: -95.55, y: 29.77 } }] } }) };
      if (/\/points\//.test(url)) return { json: async () => ({ properties: { forecast: 'https://api.weather.gov/gridpoints/HGX/1,1/forecast' } }) };
      return { json: async () => ({ properties: { periods: [{ isDaytime: true, startTime: tomorrow + 'T06:00:00-05:00', probabilityOfPrecipitation: { value: 80 }, shortForecast: 'Showers and thunderstorms' }] } }) };
    });
    let w = await daily.scanWeather({ force: true });
    assert.equal(w.flagged, 1);
    assert.ok((await crm.listInbox(t)).some(i => i.kind === 'weather' && /80% chance of rain/.test(i.title) && /Framing the deck/.test(i.title)));
    const geoCalls = calls.filter(u => /geocoding/.test(u)).length;
    w = await daily.scanWeather({ force: true });
    assert.equal(w.flagged, 0, 'once per phase and day');
    assert.equal(calls.filter(u => /geocoding/.test(u)).length, geoCalls, 'the house is only looked up once');
    const p = (await query('SELECT lat, lon FROM crm_properties WHERE id = (SELECT property_id FROM crm_deals WHERE id = $1)', [job.id])).rows[0];
    assert.equal(Number(p.lat), 29.77);
    // Indoor work isn't checked.
    assert.equal(daily.OUTDOOR.test('Cabinets & millwork'), false); assert.equal(daily.OUTDOOR.test('Roofing'), true);
    // Duplicates: same email → one group; merging moves the deals and history.
    const c2 = (await query(`INSERT INTO crm_contacts (tenant_id, name, email) VALUES ($1, 'Ana Ruiz', 'ANA@day.test') RETURNING id`, [t])).rows[0].id;
    const dup = (await query(`INSERT INTO crm_deals (tenant_id, contact_id, title, stage, source) VALUES ($1, $2, 'Bath', 'new', 'manual') RETURNING *`, [t, c2])).rows[0];
    await query(`INSERT INTO crm_activities (tenant_id, deal_id, kind, actor, body) VALUES ($1, $2, 'note', 'owner', 'Old note')`, [t, dup.id]);
    const groups = await assist.findDuplicates(t);
    const g = groups.find(x => x.people.some(pp => pp.id === dup.contact_id));
    assert.ok(g); assert.equal(g.why, 'email'); assert.equal(g.people.length, 2);
    const r = await assist.mergeContacts({ tenantId: t, keepId: deal.contact_id, mergeIds: [dup.contact_id] });
    assert.equal(r.merged, 1);
    assert.equal((await query('SELECT contact_id FROM crm_deals WHERE id = $1', [dup.id])).rows[0].contact_id, deal.contact_id);
    assert.equal((await query('SELECT 1 FROM crm_contacts WHERE id = $1', [dup.contact_id])).rows.length, 0);
    assert.equal((await assist.findDuplicates(t)).length, 0);
    await assert.rejects(assist.mergeContacts({ tenantId: t, keepId: deal.contact_id, mergeIds: [] }), /who to merge/);
    console.log('DAILY SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
