const SHELL = 'ekitag-shell-__BUILD_ID__';
const SAVED = 'saved-art-v1';
const ALL = 'all-art-v1';
self.addEventListener('install', event => event.waitUntil((async () => {
  const assets = await fetch('/precache.json').then(r => r.json());
  await (await caches.open(SHELL)).addAll(assets);
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('ekitag-shell-') && name !== SHELL) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const u = new URL(event.request.url);
  if (u.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (u.pathname === '/sw.js' || u.pathname === '/precache.json') return;
  if (u.pathname.startsWith('/images/') || u.pathname.startsWith('/thumbs/')) {
    event.respondWith((async () => (await (await caches.open(SAVED)).match(event.request)) || (await (await caches.open(ALL)).match(event.request)) || fetch(event.request))());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    if (event.request.mode === 'navigate') {
      try { const fresh = await fetch(event.request, { cache: 'no-store' }); if (fresh.ok) { cache.put('/', fresh.clone()); return fresh; } }
      catch { return (await cache.match('/')) || Response.error(); }
    }
    const stored = await cache.match(event.request);
    if (stored) return stored;
    try { const fresh = await fetch(event.request); if (fresh.ok) cache.put(event.request, fresh.clone()); return fresh; }
    catch { if (event.request.mode === 'navigate') return (await cache.match('/')) || Response.error(); return Response.error(); }
  })());
});
