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
