// The natural voice (lib/tts.js): every character sent to Google is counted by month,
// it stops before the cap (falling back to the browser's voice), said-before
// sentences aren't counted again, failed calls aren't counted, and a new month starts over.
const { R } = require('./_local');
const assert = require('assert/strict');
process.env.GOOGLE_TTS_API_KEY = 'test-only';
process.env.TTS_MONTHLY_CHAR_CAP = '100';
const { query, pool } = require(R + '/db');
const tts = require(R + '/lib/tts');
let calls = 0, fail = false;
const fake = async (url, opts) => { calls++; const body = JSON.parse(opts.body);
  if (fail) return { ok: false, status: 500, json: async () => ({ error: { message: 'down' } }) };
  assert.equal(body.voice.name, body.voice.languageCode === 'es-US' ? 'es-US-Neural2-A' : 'en-US-Neural2-F');
  return { ok: true, status: 200, json: async () => ({ audioContent: Buffer.from('mp3:' + body.input.text).toString('base64') }) }; };
const OCT = new Date('2099-10-15T12:00:00Z'), NOV = new Date('2099-11-02T12:00:00Z');
const say = (text, now = OCT, extra = {}) => tts.speak({ text, now, fetchImpl: fake, ...extra });
const used = async (now = OCT) => (await tts.usage(now)).chars;

(async () => {
  try {
    await query(`DELETE FROM tts_usage WHERE month LIKE '2099-%'`);
    tts._cache.clear();
    const a = 'x'.repeat(60);
    let r = await say(a);
    assert.ok(r.audio); assert.equal(await used(), 60); assert.equal(calls, 1);
    r = await say(a);
    assert.ok(r.cached, 'said before: from memory'); assert.equal(await used(), 60, 'not counted again'); assert.equal(calls, 1);
    r = await say('y'.repeat(30));
    assert.ok(r.audio); assert.equal(await used(), 90);
    // 20 more would pass 100: refused, nothing sent, nothing counted; the browser's voice instead.
    r = await say('z'.repeat(20));
    assert.equal(r.fallback, 'limit'); assert.equal(calls, 2); assert.equal(await used(), 90);
    assert.ok((await tts.usage(OCT)).cappedAt, 'noted when it switched');
    // Still room for 10.
    r = await say('w'.repeat(10)); assert.ok(r.audio); assert.equal(await used(), 100);
    r = await say('v'); assert.equal(r.fallback, 'limit', 'at the cap: nothing more');
    // Two at once can't push past it together.
    await query(`DELETE FROM tts_usage WHERE month = '2099-11'`);
    const both = await Promise.all([say('a'.repeat(70), NOV), say('b'.repeat(70), NOV)]);
    assert.equal(both.filter(x => x.audio).length, 1); assert.equal(both.filter(x => x.fallback === 'limit').length, 1);
    assert.equal(await used(NOV), 70, 'a new month starts over');
    // Google down: not counted.
    fail = true; r = await say('c'.repeat(10), NOV); fail = false;
    assert.equal(r.fallback, 'error'); assert.equal(await used(NOV), 70);
    // Spanish uses the Spanish voice; no key means the browser's voice.
    assert.ok((await say('Hola', NOV, { lang: 'es' })).audio);
    const key = process.env.GOOGLE_TTS_API_KEY; delete process.env.GOOGLE_TTS_API_KEY;
    assert.equal((await say('Hello there', NOV)).fallback, 'off');
    process.env.GOOGLE_TTS_API_KEY = key;
    console.log('VOICE SCENARIO PASSED');
  } catch (e) { console.error('VOICE SCENARIO FAILED:', e); process.exitCode = 1; }
  finally { await query(`DELETE FROM tts_usage WHERE month LIKE '2099-%'`).catch(() => {}); await pool.end(); }
})();
