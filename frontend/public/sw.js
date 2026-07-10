/**
 * Tombstone service worker — immediately unregisters itself and any other
 * service workers so stale workers from previous deployments cannot intercept
 * API calls and redirect them to the wrong origin.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.registration.unregister().then(() => self.clients.matchAll({ type: 'window' })).then((clients) => {
      clients.forEach((client) => client.navigate(client.url));
    }),
  );
});
