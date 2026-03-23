/**
 * HPYNO Service Worker — caches audio manifests and voice files
 * for offline playback. Uses a cache-first strategy for audio
 * and network-first for everything else.
 */

const CACHE_NAME = 'hpyno-v1';

// Static assets to pre-cache on install
const PRECACHE = [
  '/',
  '/index.html',
];

// ── Install: pre-cache shell ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE);
    })
  );
  // Activate immediately
  self.skipWaiting();
});

// ── Activate: clean old caches ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// ── Fetch: strategy depends on request type ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Audio files (manifests + voice): cache-first
  // These are large and rarely change — serve from cache, update in background
  if (url.pathname.startsWith('/audio/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;

        // Not cached yet — fetch, cache, return
        try {
          const response = await fetch(event.request);
          if (response.ok) {
            cache.put(event.request, response.clone());
          }
          return response;
        } catch {
          // Offline and not cached — return 404
          return new Response('Audio not available offline', { status: 404 });
        }
      })
    );
    return;
  }

  // JS/CSS/HTML: network-first (always get latest), fall back to cache
  if (
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/'
  ) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache the fresh response
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => {
          // Offline — serve from cache
          return caches.match(event.request);
        })
    );
    return;
  }

  // Everything else: network only (don't cache images, external APIs, etc.)
  event.respondWith(fetch(event.request));
});
