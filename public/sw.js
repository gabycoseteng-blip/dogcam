// Service worker for Dog Cam PWA — handles background notifications only.
// No caching layer: the app is always online (WebRTC requires connectivity).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const { type, title, body, tag } = event.data || {};
  if (type !== 'notify') return;

  event.waitUntil(
    self.registration.showNotification(title || 'Dog Cam', {
      body: body || '',
      tag: tag || 'dogcam',
      renotify: true,
      requireInteraction: false,
    })
  );
});

// Web Push from the server (camera on/off, bark) — delivered even when the
// app is closed. Payload is JSON: { title, body, tag, url }.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Dog Cam', {
      body: data.body || '',
      tag: data.tag || 'dogcam',
      data: { url: data.url || '/' },
      renotify: true,
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
