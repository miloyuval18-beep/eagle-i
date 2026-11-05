// The Eagle I connector for Claude and ChatGPT (MCP, Streamable HTTP, JSON responses).
// Each person connects their own app (lib/crmOAuth.js); every call runs as them, with their
// permissions, through the same tools Ask Eagle I uses (lib/crmAssistant.js), so what they
// can see and change is exactly what they could in Eagle I. Only tools that stay inside
// Eagle I are offered: nothing here emails, texts or sends anything to a customer or a sub.
const { query } = require('../db');
const assistant = require('./crmAssistant');
const team = require('./crmTeam');

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const READ = ['search_crm', 'get_deal', 'list_deals', 'needs_you', 'upcoming', 'calendar', 'money', 'list_vendors', 'list_permits', 'list_bids', 'job_outlook', 'job_margins', 'weekly_report', 'team_members', 'win_rates', 'lead_sources', 'next_move'];
const WRITE = ['create_task', 'add_note', 'log_work', 'add_to_calendar', 'create_deal', 'add_punch_item', 'add_vendor', 'add_cost', 'update_permit', 'draft_estimate', 'move_stage'];
const TITLES = {
  search_crm: 'Find projects, customers and subs', get_deal: 'Open a project', list_deals: 'List projects', needs_you: 'What needs me', upcoming: 'What’s coming up', calendar: 'The team calendar',
  money: 'Money: invoices and payments', list_vendors: 'Subs and vendors', list_permits: 'A job’s permits', list_bids: 'A job’s bids', job_outlook: 'Where a job is heading', job_margins: 'Job margins',
  weekly_report: 'This week’s numbers', team_members: 'The team', win_rates: 'Win rates', lead_sources: 'Where leads come from', next_move: 'The next move on a deal',
  create_task: 'Add a task', add_note: 'Add a note to a project', log_work: 'Log work on a job', add_to_calendar: 'Add to the calendar', create_deal: 'Add a customer and project',
  add_punch_item: 'Add a punch list item', add_vendor: 'Add a sub or vendor', add_cost: 'Log a cost', update_permit: 'Update a permit', draft_estimate: 'Draft an estimate', move_stage: 'Change a project’s status',
  save_document: 'Save a document to a project', search: 'Search Eagle I', fetch: 'Open an Eagle I record'
};

const INSTRUCTIONS = `Eagle I is this person's construction CRM: their customers, projects (deals and jobs), schedules, subs and vendors, permits, estimates and money.
- Start with search_crm (or list_deals) to find the project, then use its id. Never guess an id.
- When they ask to keep something from this chat (a scope, a decision, a list, notes, a summary, a document you wrote), save it to the right project: save_document for anything longer than a few lines, add_note for a short note, create_task for to-dos. Say which project you saved it to.
- Ask which project if it isn't clear. Everything runs as this person, with their permissions.
- Nothing here emails or texts anyone directly; to send something, they do it in Eagle I. Changing a project's status starts that status's approved automatic emails, the same as in Eagle I, so say so before you change one.`;

const SAVE_DOCUMENT = {
  description: 'Save a document from this conversation to a project in Eagle I: a scope of work, meeting notes, a summary, a checklist, a plan, a letter draft, specs. It becomes a file in the project’s files (in the folder you pick), so the whole team has it. Use the full text, in Markdown.',
  input_schema: { type: 'object', properties: {
    deal_id: { type: 'string', description: 'the project (from search_crm)' }, title: { type: 'string', description: 'a short name, e.g. "Kitchen scope of work"' },
    content: { type: 'string', description: 'the document, in Markdown' },
    folder: { type: 'string', enum: ['plans', 'permits', 'contracts', 'photos', 'selections', 'receipts', 'warranties', 'other'], description: 'where it goes; contracts for scopes and agreements, selections for finish choices, other for notes' }
  }, required: ['deal_id', 'title', 'content'] },
  async run(ctx, i) {
    const d = await require('./crm').getDeal(ctx.tenantId, i.deal_id);
    if (!d) throw new Error('That project isn’t in Eagle I. Search for it first.');
    const scope = await require('./crmScope').scopeFor(ctx.tenantId, { id: ctx.userId, role: ctx.role, permissions: ctx.perms }).catch(() => null);
    if (scope && !scope.allowed.has(d.id)) throw new Error('That isn’t one of your projects.');
    const text = String(i.content || '').trim();
    if (!text) throw new Error('The document is empty.');
    if (text.length > 400000) throw new Error('That’s too long to save in one go. Save it in parts.');
    const title = String(i.title || 'Document').trim().slice(0, 100) || 'Document';
    const f = await require('./crmPortal').addFile({ tenantId: ctx.tenantId, dealId: d.id, filename: `${title.replace(/[\\/:*?"<>|]+/g, ' ')}.md`, buffer: Buffer.from(`# ${title}\n\n${text}\n`, 'utf8'),
      caption: `Saved from ${ctx.app}`, shared: false, folder: i.folder || 'other', userId: ctx.userId });
    await require('./crm').logActivity({ tenantId: ctx.tenantId, dealId: d.id, kind: 'system', userId: ctx.userId, body: `Saved from ${ctx.app}: “${title}”.` });
    return { done: true, saved: f.filename, project: d.title, folder: f.folder, link: `${ctx.baseUrl}/crm/app#deal/${d.id}` };
  }
};

// The two tools ChatGPT looks for by name (search, then fetch by id).
const SEARCH = {
  description: 'Search Eagle I for projects, customers and subs by name, address, phone, email or project name. Returns ids to open with fetch.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  async run(ctx, { query: q }) {
    const r = await assistant.TOOLS.search_crm.run(ctx, { query: q });
    const results = [
      ...(r.deals || []).map(d => ({ id: `deal:${d.id}`, title: `${d.title} · ${d.contact || ''}`.trim(), text: [d.stage, d.address].filter(Boolean).join(' · '), url: `${ctx.baseUrl}/crm/app#deal/${d.id}` })),
      ...(r.vendors || []).map(v => ({ id: `vendor:${v.id}`, title: `${v.name}${v.trade ? ' · ' + v.trade : ''}`, text: [v.email, v.phone].filter(Boolean).join(' · '), url: `${ctx.baseUrl}/crm/app#jobs` }))
    ];
    return { results };
  }
};
const FETCH = {
  description: 'Open one Eagle I record by the id search returned (a project, or a sub/vendor): its full details.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async run(ctx, { id }) {
    const [kind, key] = String(id || '').split(':');
    if (kind === 'deal') {
      const d = await assistant.TOOLS.get_deal.run(ctx, { deal_id: key });
      return { id, title: d.title, text: JSON.stringify(d), url: `${ctx.baseUrl}/crm/app#deal/${key}`, metadata: { stage: d.stage } };
    }
    if (kind === 'vendor') {
      const v = (await query(`SELECT name, trade, contact_name, email, phone, website, license_no, insurance_expires, notes FROM crm_vendors WHERE id::text = $1 AND tenant_id = $2`, [key, ctx.tenantId])).rows[0];
      if (!v) throw new Error('Not found.');
      return { id, title: v.name, text: JSON.stringify(v), url: `${ctx.baseUrl}/crm/app#jobs`, metadata: { trade: v.trade } };
    }
    throw new Error('Use an id from search, like deal:… or vendor:….');
  }
};
const EXTRA = { save_document: SAVE_DOCUMENT, search: SEARCH, fetch: FETCH };

const defOf = (name) => EXTRA[name] || assistant.TOOLS[name];
function toolList(ctx) {
  return [...READ, ...WRITE, ...Object.keys(EXTRA)].filter(n => defOf(n) && assistant.toolAllowed(ctx, n)).map(name => {
    const t = defOf(name);
    const read = READ.includes(name) || name === 'search' || name === 'fetch';
    let schema = t.input_schema;
    if (name === 'log_work') { const { share_with_homeowner, ...props } = schema.properties || {}; schema = { ...schema, properties: props }; }
    return { name, title: TITLES[name] || name, description: t.description.replace(/The person confirms on a card[^.]*\.?/g, '').replace(/\(shared with the homeowner only if asked\)/, '(for the team)').trim(), inputSchema: schema,
      annotations: { title: TITLES[name] || name, readOnlyHint: read, destructiveHint: false, idempotentHint: read, openWorldHint: false } };
  });
}

async function callTool(ctx, name, args) {
  const t = defOf(name);
  if (!t || ![...READ, ...WRITE, ...Object.keys(EXTRA)].includes(name)) throw new Error('That tool isn’t available.');
  if (!assistant.toolAllowed(ctx, name)) throw new Error('That isn’t turned on for you in Eagle I. Ask the owner or an admin.');
  let result;
  if (name === 'log_work') args = { ...(args || {}), share_with_homeowner: false }; // from outside, never on the homeowner's page
  if (t.confirm) {
    // In Claude and ChatGPT the person approves the call itself, so it's done straight away.
    const prep = await t.prepare(ctx, args || {});
    const done = await t.execute(ctx, prep.payload);
    result = { done: true, ...(done && done.text ? { result: done.text } : {}), ...(prep.summary && prep.summary.title ? { what: prep.summary.title } : {}) };
  } else result = await t.run(ctx, args || {});
  // Without "See money", dollar figures never leave; a project manager only sees their projects.
  const may = ctx.perms ? !!ctx.perms.money : !!ctx.manager;
  if (!may) result = team.hideMoney(result);
  const scope = await require('./crmScope').scopeFor(ctx.tenantId, { id: ctx.userId, role: ctx.role, permissions: ctx.perms }).catch(() => null);
  if (scope) result = require('./crmScope').prune(scope, result);
  return result;
}

const hits = new Map();
function overLimit(userId) {
  const now = Date.now();
  const l = (hits.get(userId) || []).filter(t => now - t < 3600000);
  l.push(now); hits.set(userId, l);
  return l.length > 400;
}

// One JSON-RPC message → its answer (null for a notification).
async function handle(ctx, msg) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const bad = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return bad(-32600, 'Invalid request');
  if (id === null || id === undefined) return null; // notifications (initialized, cancelled…)
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[1], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'eagle-i', title: 'Eagle I', version: '1.0.0' }, instructions: INSTRUCTIONS });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: toolList(ctx) });
    case 'resources/list': return ok({ resources: [] });
    case 'resources/templates/list': return ok({ resourceTemplates: [] });
    case 'prompts/list': return ok({ prompts: [] });
    case 'tools/call': {
      if (overLimit(ctx.userId)) return ok({ content: [{ type: 'text', text: 'That’s a lot of requests for one hour. Give it a few minutes.' }], isError: true });
      try {
        const result = await callTool(ctx, String(p.name || ''), p.arguments || {});
        let text = JSON.stringify(result === undefined ? { done: true } : result);
        if (text.length > 60000) text = text.slice(0, 60000) + '… (cut short)';
        const structured = result && typeof result === 'object' && !Array.isArray(result) ? result : { items: result };
        return ok({ content: [{ type: 'text', text }], structuredContent: structured, isError: false });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: e.message || 'That didn’t work.' }], isError: true });
      }
    }
    default: return bad(-32601, `Method not found: ${msg.method}`);
  }
}

function ctxFor(who, baseUrl) {
  const u = who.user;
  return { tenantId: u.tenant_id, userId: u.id, name: u.name || u.email, role: u.role, manager: team.isManager(u.role), perms: team.aiPermsOf(u), baseUrl, app: who.app };
}

module.exports = { PROTOCOLS, READ, WRITE, toolList, callTool, handle, ctxFor, INSTRUCTIONS };
