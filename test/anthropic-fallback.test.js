// The AI helper tries the next model name when one doesn't exist, and remembers the one that works.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

test('a missing model falls back to the next; other errors do not', async () => {
  const seen = [];
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const { model } = JSON.parse(b);
      seen.push(model);
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'down') { res.statusCode = 529; return res.end(JSON.stringify({ error: { message: 'Overloaded' } })); }
      if (model === 'claude-sonnet-5-5') { res.statusCode = 404; return res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'model: claude-sonnet-5-5' } })); }
      res.end(JSON.stringify({ content: [{ type: 'text', text: '{"ok": true}' }], stop_reason: 'end_turn' }));
    });
  });
  await new Promise(r => server.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'test';
  delete process.env.AI_MODEL; delete process.env.CRM_AI_MODEL;
  const ai = require('../lib/anthropic');
  try {
    assert.deepEqual(await ai.generateJSON('x'), { ok: true });
    assert.deepEqual(seen, ['claude-sonnet-5-5', 'claude-opus-5-5']);
    assert.equal(ai.currentModel(), 'claude-opus-5-5');
    seen.length = 0;
    await ai.createMessage({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(seen, ['claude-opus-5-5'], 'remembered');
    mode = 'down'; seen.length = 0;
    await assert.rejects(ai.generateJSON('x'), /Overloaded/);
    assert.equal(seen.length, 1, 'an overloaded API isn’t a missing model: no retries across names');
  } finally {
    server.close(); delete process.env.ANTHROPIC_BASE_URL; delete process.env.ANTHROPIC_API_KEY;
  }
});
