// 15-N — the PWA service worker, deliberately a NO-CACHE passthrough.
//
// Its only job is to make the app installable: Chrome wants a service worker
// with a fetch handler before it offers "Install app". It must NEVER cache,
// because a cached app shell would silently serve a STALE build and fight the
// existing update path (static/version.json is polled and offers a reload
// toast — see whatsNew/version). Offline support is not meaningful here anyway:
// the whole point is peer-to-peer collaboration over the network.
//
// If precaching is ever added, wire skipWaiting()/clients.claim() to the
// version poll first, or the update toast will be lying.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
	// straight to the network — no caches.match, no caches.put
	event.respondWith(fetch(event.request));
});
