// Service worker: lets the browser install Otterdeck as an app, and keeps one small page on the
// phone for when this Otterdeck can't be reached (laptop off): "Laptop ist offline – Zum Server".
// Everything else is served live; nothing of the app itself is cached.
const CACHE = 'otter-offline-v2';
const LINKS = '/__otter/links';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/offline.html'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      // Older versions of this cache could hold outdated links.
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('otter-offline-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

// The app tells us where the other Otterdeck is (server ↔ laptop), so the offline page can link there.
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'links') return;
  e.waitUntil(
    caches.open(CACHE).then((c) => c.put(LINKS, new Response(JSON.stringify(e.data.links), { headers: { 'content-type': 'application/json' } }))),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).catch(async () => (await caches.match('/offline.html', { cacheName: CACHE })) ?? Response.error()),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const tab = e.notification.data?.tab;
      for (const c of list) {
        c.postMessage({ type: 'open-tab', tab });
        return c.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
