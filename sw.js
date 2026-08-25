// ==========================================================================
// SERVICE WORKER (shared by the coach app and the athlete app)
// Lives at the repo root so its scope covers everything below it, including
// /athlete-app/ - see push.js's registerServiceWorker() for how both sides
// register this same file. Only handles push notifications; this app has
// no other reason for a service worker (no offline caching).
// ==========================================================================

self.addEventListener('push', function(event) {
  let payload = { title: 'TBFlog', body: '' }
  try { payload = event.data.json() } catch (e) { /* no/invalid payload - use defaults */ }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'TBFlog', {
      body: payload.body || '',
      // No leading slash - resolves relative to this file's own location
      // (the repo root), correctly regardless of what subpath the site is
      // hosted under.
      icon: 'logo.png',
      data: { url: payload.url || self.location.href }
    })
  )
})

self.addEventListener('notificationclick', function(event) {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || self.location.href

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      // Focus an already-open tab on the same page instead of opening a
      // duplicate one, matched by path (ignoring query string, since
      // ?id=123 vs no query still counts as "already there")
      for (const client of windowClients) {
        if (client.url.split('?')[0] === url.split('?')[0] && 'focus' in client) return client.focus()
      }
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})
