// Eagle I's natural voice: Google Cloud Text-to-Speech (Neural2 voices).
//
// Google gives 1 million Neural2 characters free each month. Every character sent is
// counted here (tts_usage, by Google's billing month, Pacific time) and reserved
// BEFORE the call, so two people talking at once can't push past the limit. At
// TTS_MONTHLY_CHAR_CAP (800,000 unless set) it stops calling Google until the next
// month and the pages use the browser's own voice instead (public/talk.js). Sentences
// said before (the talking walk-through, greetings) come from memory and aren't counted.
const crypto = require('crypto');
const { query } = require('../db');

const CAP = Math.max(0, parseInt(process.env.TTS_MONTHLY_CHAR_CAP || '800000', 10) || 0);
const MAX_TEXT = 1500;
const VOICES = { en: { languageCode: 'en-US', name: 'en-US-Neural2-F' }, es: { languageCode: 'es-US', name: 'es-US-Neural2-A' } };
const on = () => !!process.env.GOOGLE_TTS_API_KEY && CAP > 0;
const monthNow = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 7);

// Recently said: the same words in the same voice aren't sent (or counted) twice.
const cache = new Map(); const CACHE_MAX = 400;
const keyOf = (lang, rate, text) => crypto.createHash('sha1').update(`${lang}|${rate}|${text}`).digest('hex');
function remember(k, buf) { cache.set(k, buf); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }

// Holds n characters of this month's allowance; false once that would pass the cap.
async function reserve(n, now) {
  const r = await query(
    `INSERT INTO tts_usage (month, chars) VALUES ($1, $2)
     ON CONFLICT (month) DO UPDATE SET chars = tts_usage.chars + EXCLUDED.chars, updated_at = now()
       WHERE tts_usage.chars + EXCLUDED.chars <= $3
     RETURNING chars`, [monthNow(now), n, CAP]);
  if (r.rows.length && Number(r.rows[0].chars) <= CAP) return true;
  if (r.rows.length) { await release(n, now); }
  await query(`UPDATE tts_usage SET capped_at = COALESCE(capped_at, now()) WHERE month = $1`, [monthNow(now)]).catch(() => {});
  return false;
}
async function release(n, now) { await query(`UPDATE tts_usage SET chars = GREATEST(0, chars - $2), updated_at = now() WHERE month = $1`, [monthNow(now), n]).catch(() => {}); }

async function usage(now = new Date()) {
  const r = (await query(`SELECT chars, capped_at FROM tts_usage WHERE month = $1`, [monthNow(now)]).catch(() => ({ rows: [] }))).rows[0];
  return { on: on(), month: monthNow(now), chars: r ? Number(r.chars) : 0, cap: CAP, cappedAt: r ? r.capped_at : null };
}

// → { audio: Buffer (MP3) } or { fallback: 'off' | 'limit' | 'error' } (use the browser's voice).
async function speak({ text, lang = 'en', rate = 0.9, now = new Date(), fetchImpl = fetch } = {}) {
  if (!on()) return { fallback: 'off' };
  const words = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!words) return { fallback: 'error' };
  const l = lang === 'es' ? 'es' : 'en';
  const r = Math.min(1.2, Math.max(0.7, Number(rate) || 0.9));
  const k = keyOf(l, r, words);
  if (cache.has(k)) return { audio: cache.get(k), cached: true };
  if (!(await reserve(words.length, now))) return { fallback: 'limit' };
  try {
    const res = await fetchImpl(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(process.env.GOOGLE_TTS_API_KEY)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text: words }, voice: VOICES[l], audioConfig: { audioEncoding: 'MP3', speakingRate: r } })
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.audioContent) throw new Error((d.error && d.error.message) || `Google said ${res.status}`);
    const audio = Buffer.from(d.audioContent, 'base64');
    remember(k, audio);
    return { audio };
  } catch (e) {
    await release(words.length, now); // not said, so not counted
    console.error('[tts] Google voice failed:', e.message);
    return { fallback: 'error' };
  }
}

module.exports = { speak, usage, monthNow, CAP, MAX_TEXT, VOICES, _cache: cache };
