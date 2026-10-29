// Server-side helper for structured JSON generation calls to Claude —
// mirrors the client-side claude() pattern from the original single-tenant
// app, but runs server-side during onboarding (so results can be cached in
// Postgres instead of regenerated on every page load).
// Which Claude model to use. AI_MODEL (or CRM_AI_MODEL) picks one; if the API
// says a model doesn't exist, the next name is tried and the one that works is
// remembered, so a renamed model never takes the AI features down.
const MODEL_CANDIDATES = () => [...new Set([process.env.AI_MODEL, process.env.CRM_AI_MODEL, 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5'].filter(Boolean))];
let workingModel = null;
const BASE = () => process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

// One Messages API call, trying each model name until one exists.
async function post(body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error('ANTHROPIC_API_KEY is not set on the server.'); e.status = 503; throw e; }
  const names = workingModel ? [workingModel, ...MODEL_CANDIDATES().filter(m => m !== workingModel)] : MODEL_CANDIDATES();
  let last = null;
  for (const model of names) {
    const r = await fetch(`${BASE()}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ ...body, model })
    });
    if (r.ok) { workingModel = model; return r.json(); }
    const e = await r.json().catch(() => ({}));
    const msg = (e.error && e.error.message) || `HTTP ${r.status}`;
    last = new Error(msg);
    last.status = r.status === 429 || r.status >= 500 ? 503 : r.status === 401 || r.status === 403 ? 503 : 502;
    // Only a missing model moves on to the next name; anything else is the answer.
    if (!(r.status === 404 || (r.status === 400 && /model/i.test(msg)))) throw last;
    if (workingModel === model) workingModel = null;
  }
  throw last;
}

// `images`: optional [{ mediaType, data (base64) }] sent ahead of the prompt
// (for example a receipt photo to read). A PDF (mediaType application/pdf)
// goes as a document, page by page.
async function generateJSON(prompt, maxTokens = 1500, { images = [], effort = 'low' } = {}) {
  // Adaptive thinking spends part of max_tokens even when told not to;
  // effort:"low" keeps it shallow for simple structured-output tasks like
  // these and leaves enough of the budget for the actual JSON.
  const d = await post({
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    messages: [{
      role: 'user',
      content: images.length
        ? [...images.map(i => (i.mediaType === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: i.data } }
          : { type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text: prompt }]
        : prompt
    }]
  });
  const raw = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  // Ran out of room thinking before writing the answer: once more, thinking less.
  if (d.stop_reason === 'max_tokens' && !/\}\s*$/.test(raw.trim())) {
    if (effort !== 'low') return generateJSON(prompt, maxTokens, { images, effort: 'low' });
    throw new Error('The AI’s answer was too long to finish. Try again with fewer files.');
  }
  return parseClaudeJson(raw);
}

// Extracted from generateJSON so it's unit-testable without a network call.
function parseClaudeJson(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in Claude response');
  try {
    return JSON.parse(m[0]);
  } catch (err) {
    // Claude occasionally slips a single-quoted property name into
    // otherwise-valid JSON (e.g. 'p':"..." instead of "p":"..."), most
    // often right after a string containing an apostrophe. Only repairs
    // keys (word-chars immediately followed by a colon) — never touches
    // string VALUES, so a legitimate apostrophe inside content survives.
    const repaired = m[0].replace(/'([a-zA-Z_][a-zA-Z0-9_]*)'(\s*:)/g, '"$1"$2');
    return JSON.parse(repaired);
  }
}

// One turn of a conversation with tools (lib/crmAssistant.js runs the loop).
// Returns the raw response: { content: [...blocks], stop_reason }. Thinking
// blocks come back in `content` and must be sent back unchanged next turn.
let clientOverride = null; // tests swap in a scripted model
function setClient(fn) { clientOverride = fn; }
const hasClientOverride = () => !!clientOverride;
async function createMessage({ system, messages, tools = [], maxTokens = 4000, effort = 'medium' }) {
  if (clientOverride) return clientOverride({ system, messages, tools });
  return post({ max_tokens: maxTokens, system, messages, tools, thinking: { type: 'adaptive' }, output_config: { effort } });
}

// A tiny real call: is the key good, and which model answers?
async function checkConnection() {
  const d = await post({ max_tokens: 64, messages: [{ role: 'user', content: 'Reply with the single word: ready' }] });
  return { ok: true, model: workingModel, reply: (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim().slice(0, 40) };
}
const currentModel = () => workingModel;

module.exports = { generateJSON, parseClaudeJson, createMessage, setClient, hasClientOverride, checkConnection, currentModel, MODEL_CANDIDATES };
