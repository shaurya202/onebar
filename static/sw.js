const CACHE_NAME = 'onebar-v6';

const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/static/app.css',
  '/static/js/app.js',
  '/static/js/api.js',
  '/static/js/map.js',
  '/static/js/haptics.js',
  '/static/js/offline-store.js',
  '/static/js/config.js',
  '/static/js/device.js',
  '/static/js/contacts.js',
  '/static/js/focus-trap.js',
  '/static/js/search.js',
  '/static/js/trip-store.js',
  '/static/js/pack-search.js',
  '/static/js/pack-format.js',
  '/static/js/pack-store.js',
  '/static/js/route-engine.js',
  '/static/js/router-worker.js',
  '/static/js/offline-router.js',
  '/static/js/voice.js',
  '/static/js/push-client.js',
  '/static/vendor/leaflet/leaflet.css',
  '/static/vendor/leaflet/leaflet.js',
];

// Install: cache app shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).catch((err) => {
      console.warn('SW pre-cache warning:', err);
    })
  );
  self.skipWaiting();
});

// Activate: purge old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // OSM tiles: cache-first (aggressive — tiles rarely change)
  if (url.hostname.endsWith('openstreetmap.org')) {
    e.respondWith(cacheFirst(request));
    return;
  }

  // Static assets and shell: cache-first
  if (url.pathname.startsWith('/static/') || url.pathname === '/' || url.pathname === '/manifest.webmanifest') {
    e.respondWith(cacheFirst(request));
    return;
  }

  // Dynamic API calls (/health, /hazards, /route, /region): network-first, no stale cache
  e.respondWith(
    fetch(request).catch(() => new Response(JSON.stringify({ detail: 'Offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }))
  );
});

async function cacheFirst(request) {
  // `ignoreSearch`: the manifest's home-screen shortcuts open "/?action=evacuate" and
  // friends, and an exact-URL match never finds the cached "/" — so the one-tap
  // evacuate shortcut rendered an "Offline" error page in exactly the situation it
  // exists for.
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return cached || new Response('Offline', { status: 503 });
  }
}

// --- Push notifications ------------------------------------------------------

// A push must always show a notification (`userVisibleOnly` is the browser's term
// for this deal). Even an unparseable payload shows a generic alert rather than
// nothing, or the browser revokes the subscription.
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: 'OneBar', body: 'Tap to open OneBar.' };
  }

  e.waitUntil(self.registration.showNotification(data.title || 'OneBar hazard alert', {
    body: data.body || 'A new hazard was reported in your area.',
    tag: data.tag || 'onebar-hazard',
    renotify: Boolean(data.tag),
    data: { hazard_id: data.hazard_id || null },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const hazardId = e.notification.data?.hazard_id;
  e.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      if ('focus' in client && 'postMessage' in client) {
        client.postMessage({ type: 'open-hazard', hazard_id: hazardId });
        return client.focus();
      }
    }
    const target = hazardId ? `/?action=hazard&hazard=${encodeURIComponent(hazardId)}` : '/?action=hazard';
    return self.clients.openWindow(target);
  })());
});
