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

//
// 60 Q4 — the ONE exception, and it is not the app shell: the manifest's share_target
// POSTs "Share → theprototype" here (multipart, field `files`). A static site has no server
// to receive it, so the worker does: each shared file is parked in the `tp-share-inbox`
// cache under /share-inbox/<n> (name in X-File-Name), and the POST is answered with a 303
// to /?shared=<n files>. The app (src/lib/launchInbox.js) reads the inbox ONCE and deletes
// the whole cache, so nothing outlives the hand-over. Text/url shares carry no file and
// just open the app. Kept in step with launchInbox.js: SHARE_INBOX, SHARE_PATH, SHARE_PARAM.

const SHARE_INBOX = 'tp-share-inbox';
const SHARE_PATH = '/share-target';
const SHARE_PARAM = 'shared';
const SHARE_MAX_FILES = 20;

/** @param {Request} request */
async function receiveShare(request) {
	let count = 0;
	try {
		const form = await request.formData();
		const files = form
			.getAll('files')
			.filter((f) => typeof f === 'object' && f && 'arrayBuffer' in f)
			.slice(0, SHARE_MAX_FILES);
		if (files.length) {
			// a previous share nobody collected is not mixed into this one
			await caches.delete(SHARE_INBOX);
			const inbox = await caches.open(SHARE_INBOX);
			for (const file of files) {
				await inbox.put(
					new Request(new URL(`/share-inbox/${count++}`, self.location.origin).href),
					new Response(file, {
						headers: {
							'Content-Type': file.type || 'application/octet-stream',
							'X-File-Name': encodeURIComponent(file.name || `shared-${count}`)
						}
					})
				);
			}
		}
	} catch {
		count = 0;
	}
	return Response.redirect(
		new URL(count ? `/?${SHARE_PARAM}=${count}` : '/', self.location.origin).href,
		303
	);
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method === 'POST' && new URL(request.url).pathname === SHARE_PATH) {
		event.respondWith(receiveShare(request));
		return;
	}
	// straight to the network — no caches.match, no caches.put
	event.respondWith(fetch(request));
});
