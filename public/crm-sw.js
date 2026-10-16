// Eagle I CRM on a phone's home screen. Pages always come from the network
// (so a deploy shows at once); the last good copy of the app opens when there's
// no signal. Business data (/api) is never cached here.
const CACHE = 'eaglei-crm-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.pathname !== '/crm' && url.pathname !== '/crm/') return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/crm', copy)); }
    return res;
  }).catch(() => caches.match('/crm').then(r => r || new Response('<p style="font-family:sans-serif;padding:24px">You’re offline. Eagle I will open again when you have a signal.</p>', { headers: { 'Content-Type': 'text/html' } }))));
});
