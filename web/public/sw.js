// Minimal service worker: lets the browser install Otterdeck as an app.
// Everything is served live from the local server, nothing is cached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
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
