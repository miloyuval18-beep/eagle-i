delete process.env.ANTHROPIC_API_KEY; delete process.env.RESEND_API_KEY;
const assert = require('assert/strict');
const { R } = require('./_local');
const { query, pool } = require(R + '/db');
const crm = require(R + '/lib/crm'); const pb = require(R + '/lib/crmPlaybooks'); const intake = require(R + '/lib/crmIntake');
const est = require(R + '/lib/crmEstimates'); const pay = require(R + '/lib/crmPayments'); const q = require(R + '/lib/crmQualify');
const sent = []; const send = async (m) => { sent.push(m); return { id: 'x' + sent.length }; };
(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Es Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    await query(`INSERT INTO business_profile (tenant_id, phone, email, address, founder_name) VALUES ($1, '713-555-0100', 'o@es.test', '1001 S Dairy Ashford, Houston TX 77077', 'Levi')`, [t]);
    const list = await pb.listPlaybooks(t);
    const reply = list.find(p => p.key === 'new_lead_reply');
    assert.ok(reply.stepsEs && reply.stepsEs.length === 2, 'new companies get the Spanish starters');
    await pb.approvePlaybook({ tenantId: t, id: reply.id });
    await pb.approvePlaybook({ tenantId: t, id: list.find(p => p.key === 'site_visit_reminder').id });
    // A lead from the Spanish form gets the Spanish instant reply; an English one gets English.
    const key = await intake.getIntakeKey(t);
    await intake.submitForm({ key, body: { name: 'María López', email: 'maria@es.test', lang: 'es' } });
    await intake.submitForm({ key, body: { name: 'John Smith', email: 'john@es.test' } });
    await new Promise(r => setTimeout(r, 500)); // the form's own instant-send attempt (no mail key here) settles first
    await query(`UPDATE crm_playbook_sends SET status = 'pending', error = NULL WHERE tenant_id = $1 AND status IN ('failed', 'sending')`, [t]);
    await query(`DELETE FROM crm_inbox WHERE tenant_id = $1 AND kind = 'send_failed'`, [t]);
    await pb.processDueSends({ send });
    const toMaria = sent.find(m => m.to === 'maria@es.test'), toJohn = sent.find(m => m.to === 'john@es.test');
    assert.match(toMaria.subject, /Gracias por comunicarse con Es Co/); assert.match(toMaria.text, /Hola María/);
    assert.match(toJohn.subject, /Thanks for reaching out/);
    const maria = (await query(`SELECT d.* FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE c.email = 'maria@es.test'`)).rows[0];
    assert.equal((await crm.getDeal(t, maria.id)).contact_language, 'es');
    // Site-visit reminder with the date in Spanish.
    const at = new Date(Date.now() + 3 * 86400000); at.setUTCHours(16, 0, 0, 0);
    await crm.updateDeal({ tenantId: t, dealId: maria.id, patch: { siteVisitAt: at.toISOString() } });
    const N = new Date(Date.now() + 86400000); N.setUTCHours(17, 0, 0, 0); // tomorrow at noon Central
    await query(`UPDATE crm_playbook_sends SET due_at = $2 WHERE deal_id = $1 AND status = 'pending'`, [maria.id, new Date(N - 60000)]);
    sent.length = 0;
    await pb.processDueSends({ now: N, send, onlyDealId: maria.id });
    const rem = sent.find(m => /Nos vemos/.test(m.subject));
    assert.ok(rem, JSON.stringify(sent.map(m => m.subject)));
    assert.match(rem.subject, /(lunes|martes|miércoles|jueves|viernes|sábado|domingo)/);
    // Editing the Spanish withdraws the approval; removing it keeps the English.
    const r1 = await pb.savePlaybook({ tenantId: t, id: reply.id, steps: reply.steps, stepsEs: [{ subject: 'Hola', message: 'Hola {name}' }, reply.stepsEs[1]] });
    assert.equal(r1.changed, true);
    assert.equal((await pb.listPlaybooks(t)).find(p => p.id === reply.id).approved, false);
    assert.equal((await pb.savePlaybook({ tenantId: t, id: reply.id, steps: [reply.steps[0]] })).spanishRemoved, true);
    await pb.savePlaybook({ tenantId: t, id: reply.id, steps: [reply.steps[0]], stepsEs: [] });
    assert.equal((await pb.listPlaybooks(t)).find(p => p.id === reply.id).stepsEs, null);
    // The starter Spanish comes back for the starter wording.
    const draft = await pb.spanishDraft({ tenantId: t, id: reply.id, steps: reply.steps });
    assert.equal(draft.from, 'starter');
    await assert.rejects(pb.spanishDraft({ tenantId: t, id: reply.id, steps: [{ days: 0, subject: 'Custom', message: 'Custom {name}' }] }), /translation/);
    // Estimate and invoice emails in Spanish.
    const e = await est.createEstimate({ tenantId: t, dealId: maria.id });
    await est.saveEstimate({ tenantId: t, id: e.id, body: { title: 'Cocina', lines: [{ description: 'Gabinetes', quantity: 1, unit_cost: 1000, markup_pct: 20 }] } });
    sent.length = 0;
    await est.sendEstimate({ tenantId: t, id: e.id, send, baseUrl: 'https://x' });
    assert.match(sent[0].subject, /^Su presupuesto de Es Co/); assert.match(sent[0].text, /Puede revisarlo/);
    const view = await est.getByToken((await est.getEstimate(t, e.id)).public_token);
    assert.equal(view.view.lang, 'es');
    const inv = await pay.createInvoice({ tenantId: t, dealId: maria.id, kind: 'progress', amount: 500, title: 'Avance', dueDate: '2030-01-15' });
    sent.length = 0;
    await pay.sendInvoice({ tenantId: t, id: inv.id, send, baseUrl: 'https://x' });
    assert.match(sent[0].subject, /^Factura #/); assert.match(sent[0].text, /con vencimiento el 15 de enero/);
    // Pages know the language.
    const token = await require(R + '/lib/crmPortal').portalToken(t, maria.id);
    assert.equal((await q.questionnaireInfo(token)).lang, 'es');
    assert.equal((await require(R + '/lib/crmPortal').portalView(token)).lang, 'es');
    // Switching back to English on the deal.
    await crm.updateDeal({ tenantId: t, dealId: maria.id, patch: { language: 'en' } });
    assert.equal((await crm.getDeal(t, maria.id)).contact_language, null);
    console.log('SPANISH SCENARIO PASSED');
  } finally { await query('DELETE FROM tenants WHERE id = $1', [t]); await pool.end(); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
