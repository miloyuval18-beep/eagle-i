// A small in-memory limit on how often something can be tried: signing in,
// creating accounts, checking company codes. Stops password guessing and
// code guessing. Per server process, which is fine for one Render instance.
const buckets = new Map(); // key -> [timestamps]

// true when `key` has been used `max` times in the last `windowMs`; counts this try.
function hit(key, max, windowMs, now = Date.now()) {
  const list = (buckets.get(key) || []).filter(t => now - t < windowMs);
  list.push(now);
  buckets.set(key, list);
  if (buckets.size > 20000) for (const k of [...buckets.keys()].slice(0, 5000)) buckets.delete(k);
  return list.length > max;
}
// Express: limit by the caller's address (and, for sign-in, the email typed).
function limit(name, max, windowMs, { byEmail = false } = {}) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const email = byEmail ? String((req.body || {}).email || '').trim().toLowerCase() : '';
    const tooMany = hit(`${name}:ip:${ip}`, max, windowMs) || (email && hit(`${name}:email:${email}`, Math.ceil(max / 2), windowMs));
    if (tooMany) return res.status(429).json({ error: { message: 'Too many tries. Wait about 15 minutes and try again, or use “Forgot password”.', code: 'rate' } });
    next();
  };
}
const reset = () => buckets.clear();
module.exports = { hit, limit, reset };
