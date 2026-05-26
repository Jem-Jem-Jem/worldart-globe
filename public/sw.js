const CACHE = 'worldart-v1';

// Shell assets to precache on install.
const PRECACHE = [
  '/',
  'https://esm.sh/globe.gl@2.34.0?bundle',
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-night.jpg',
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-blue-marble.jpg',
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-topology.png',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&display=swap',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // NASA GIBS satellite imagery: always network (too large, date-varying).
  if (url.hostname === 'gibs.earthdata.nasa.gov') return;

  // API data feeds: stale-while-revalidate (serve cached if offline, refresh in bg).
  if (url.pathname.startsWith('/api/feed')) {
    e.respondWith(
      caches.open(CACHE).then(async cache => {
        const cached = await cache.match(e.request);
        const fetchPromise = fetch(e.request).then(resp => {
          if (resp.ok) cache.put(e.request, resp.clone());
          return resp;
        }).catch(() => null);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Everything else: cache-first, fall back to network.
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
      if (resp.ok && e.request.method === 'GET') {
        caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
      }
      return resp;
    }))
  );
});
