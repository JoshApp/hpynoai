/* HPYNO service worker — v2.
 * Session packages (json + audio) are cache-first so a started session keeps
 * working offline and listen mode never re-downloads. Everything else is
 * network-first with cache fallback. */
const VERSION = 'hpyno-v2-1';
const CONTENT = `${VERSION}-content`;
const SHELL = `${VERSION}-shell`;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isContent = (url) => /\/sessions\/[^/]+\/.+\.(webm|mp3|json)$/.test(url.pathname);
const isRangeRequest = (req) => req.headers.has('range');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (isContent(url)) {
    // Media elements issue range requests; serve those from network but
    // opportunistically fill the cache with the full file.
    if (isRangeRequest(req)) {
      event.respondWith((async () => {
        const cache = await caches.open(CONTENT);
        const full = await cache.match(url.pathname);
        if (full) return rangeFrom(full, req);
        const net = await fetch(req);
        if (net.status === 200) cache.put(url.pathname, net.clone());
        return net;
      })());
      return;
    }
    event.respondWith((async () => {
      const cache = await caches.open(CONTENT);
      const hit = await cache.match(url.pathname);
      if (hit) return hit;
      const net = await fetch(req);
      if (net.ok) cache.put(url.pathname, net.clone());
      return net;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      const net = await fetch(req);
      if (net.ok && (req.mode === 'navigate' || url.pathname.includes('/assets/'))) cache.put(req, net.clone());
      return net;
    } catch {
      const hit = await cache.match(req) ?? (req.mode === 'navigate' ? await cache.match(new URL('./', self.registration.scope).pathname) : undefined);
      return hit ?? Response.error();
    }
  })());
});

async function rangeFrom(response, req) {
  const buf = await response.arrayBuffer();
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  const slice = buf.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(slice.byteLength),
      'Accept-Ranges': 'bytes',
    },
  });
}
