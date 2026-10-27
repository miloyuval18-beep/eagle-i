// Where links in Eagle I's emails point: always the real address people sign
// in at (https://myeaglei.com), never Render's own *.onrender.com name. Google
// sign-in only allows the real one, and a session on one name isn't signed in
// on the other.
const CANONICAL = 'https://myeaglei.com';
const RENDER_HOST = /\.onrender\.com$/i;
function appUrl() {
  const set = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (set && !RENDER_HOST.test(set.replace(/^https?:\/\//, ''))) return set;
  if (process.env.RENDER || process.env.NODE_ENV === 'production') return CANONICAL;
  return String(process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
}
// A stored or request-made address on Render's name becomes the real one.
const fixUrl = (u) => { try { const x = new URL(u); return RENDER_HOST.test(x.hostname) ? CANONICAL + x.pathname.replace(/\/$/, '') : String(u).replace(/\/+$/, ''); } catch (e) { return u; } };
module.exports = { appUrl, fixUrl, CANONICAL, RENDER_HOST };
