// Rancher PWA service worker — push + click-through only.
// Deliberately NO caching/offline layer: the dashboard is money-truth
// (capacity, orders, deposits) and a stale cached view is worse than a
// spinner. This worker exists so the installed app can receive Web Push.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'BuyHalfCow', body: 'something happened on your ranch page', url: '/rancher' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    /* malformed payload — show the generic notification */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/apple-touch-icon.png',
      badge: '/apple-touch-icon.png',
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/rancher';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/rancher') && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
