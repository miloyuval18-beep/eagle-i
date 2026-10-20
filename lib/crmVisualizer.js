// The design visualizer in Eagle I CRM: "show me this kitchen with white
// shaker cabinets and a quartz island."
//
// Takes a photo of the homeowner's room (from the deal's files) and a few
// words on the design, and returns an edited picture of the same room. It's
// a picture to talk around, not a rendering to build from, and every result
// is labelled as an AI design idea. Results are saved on the deal (team only);
// sharing one with the homeowner is a deliberate tap like any other file.
//
// Anthropic doesn't make images, so this uses OpenAI's image model through
// OPENAI_API_KEY (CRM_IMAGE_MODEL to change the model). Off until that key is
// set. Each company gets CRM_VISUALS_PER_MONTH pictures a month (default 40)
// so the cost stays predictable.
const { query } = require('../db');
const crm = require('./crm');

const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const perMonth = () => Math.max(0, parseInt(process.env.CRM_VISUALS_PER_MONTH || '40', 10) || 0);
const available = () => !!process.env.OPENAI_API_KEY;

let httpOverride = null;
function setHttp(fn) { httpOverride = fn; }
const http = (...a) => (httpOverride || fetch)(...a);

async function usedThisMonth(tenantId) {
  return (await query(`SELECT COUNT(*)::int AS n FROM crm_visuals WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())`, [tenantId])).rows[0].n;
}
async function status(tenantId) {
  return { available: available(), used: await usedThisMonth(tenantId), limit: perMonth() };
}

// Pure: the instruction sent with the photo.
function promptFor(design) {
  return `Edit this photo of a room in a real home to show a remodel: ${clip(design, 800)}. Keep the same room, camera angle, walls, windows, doors and proportions; change only what the remodel would change. Photorealistic, natural daylight, no people, no text or watermarks.`;
}

async function visualize({ tenantId, dealId, fileId, design, userId = null }) {
  if (!available()) throw err('The design visualizer isn’t switched on yet: the server needs an image AI key (OPENAI_API_KEY).', 503);
  const words = clip(design, 800);
  if (words.length < 5) throw err('Describe the design, like “white shaker cabinets, quartz counters, brass pulls”.');
  if ((await usedThisMonth(tenantId)) >= perMonth()) throw err(`You’ve used this month’s ${perMonth()} design pictures. It resets on the 1st.`, 402);
  const f = await require('./crmPortal').getFile(tenantId, fileId);
  if (!f || f.deal_id !== dealId) throw err('Photo not found on this deal.', 404);
  if (!/^image\/(jpeg|png|webp)$/.test(f.content_type)) throw err('Pick a photo of the room (JPEG, PNG or WebP).');
  const form = new FormData();
  form.append('model', process.env.CRM_IMAGE_MODEL || 'gpt-image-1');
  form.append('prompt', promptFor(words));
  form.append('image', new Blob([await require('./crmPortal').fileData(f)], { type: f.content_type }), f.filename || 'room.jpg');
  form.append('size', 'auto');
  form.append('quality', 'medium');
  form.append('output_format', 'jpeg');
  const r = await http('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw err(`The image AI said: ${(body.error && body.error.message) || `error ${r.status}`}`, r.status === 429 || r.status >= 500 ? 503 : 502);
  const b64 = body.data && body.data[0] && body.data[0].b64_json;
  if (!b64) throw err('The image AI returned no picture. Try again.', 502);
  const saved = await require('./crmPortal').addFile({ tenantId, dealId, filename: `design-idea-${Date.now()}.jpg`, dataBase64: b64, caption: clip(`AI design idea: ${words}`, 300), shared: false, userId });
  await query(`INSERT INTO crm_visuals (tenant_id, deal_id, source_file_id, result_file_id, prompt, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [tenantId, dealId, f.id, saved.id, words, userId]);
  await crm.logActivity({ tenantId, dealId, kind: 'system', userId, body: `Made a design picture: ${clip(words, 160)}` });
  return { file: saved, ...(await status(tenantId)) };
}

module.exports = { available, status, promptFor, visualize, setHttp };
