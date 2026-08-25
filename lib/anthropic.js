// Server-side helper for structured JSON generation calls to Claude —
// mirrors the client-side claude() pattern from the original single-tenant
// app, but runs server-side during onboarding (so results can be cached in
// Postgres instead of regenerated on every page load).
const MODEL = 'claude-sonnet-5';

async function generateJSON(prompt, maxTokens = 1500) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set on the server.');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    // Sonnet 5 runs adaptive thinking by default and spends part of
    // max_tokens on it regardless — explicitly disabling thinking doesn't
    // reliably stop that spend. effort:"low" keeps thinking shallow instead,
    // which is the documented approach for simple structured-output tasks
    // like these and leaves enough of the budget for the actual JSON.
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error?.message || `HTTP ${r.status}`);
  }
  const d = await r.json();
  const raw = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in Claude response');
  return JSON.parse(m[0]);
}

module.exports = { generateJSON };
