// 60 Q4 — share target / file handlers: the manifest keys, the service worker's share
// inbox (static/sw.js run in a fake worker scope), the app's inbox reader and the router's
// classification. The browser halves (an installed PWA receiving a share, launchQueue) are
// the e2e suite `launch-inbox` and the owner rows.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	SHARE_INBOX,
	SHARE_PARAM,
	classifyLaunchFiles,
	readShareInbox
} from '../../src/lib/launchInbox.js';

const manifest = JSON.parse(
	readFileSync(new URL('../../static/manifest.webmanifest', import.meta.url), 'utf8')
);
const swSource = readFileSync(new URL('../../static/sw.js', import.meta.url), 'utf8');

/** a CacheStorage good enough for both halves */
function fakeCaches() {
	/** @type {Map<string, Map<string, Response>>} */
	const stores = new Map();
	const open = async (/** @type {string} */ name) => {
		if (!stores.has(name)) stores.set(name, new Map());
		const m = /** @type {Map<string, Response>} */ (stores.get(name));
		return {
			put: async (/** @type {Request} */ req, /** @type {Response} */ res) =>
				void m.set(new URL(req.url, 'https://app.test').pathname, res),
			keys: async () => [...m.keys()].map((p) => new Request('https://app.test' + p)),
			match: async (/** @type {Request} */ req) => m.get(new URL(req.url).pathname)?.clone()
		};
	};
	return { stores, open, delete: async (/** @type {string} */ name) => stores.delete(name) };
}

/** run static/sw.js in a fake ServiceWorkerGlobalScope and hand back its fetch listener
 * @param {any} caches */
function loadWorker(caches) {
	/** @type {Record<string, Function>} */
	const listeners = {};
	const self = {
		location: new URL('https://app.test/sw.js'),
		addEventListener: (/** @type {string} */ t, /** @type {Function} */ fn) => (listeners[t] = fn),
		skipWaiting() {},
		clients: { claim() {} }
	};
	let fetched = 0;
	const fetchStub = async () => (fetched++, new Response('net'));
	new Function('self', 'caches', 'fetch', swSource)(self, caches, fetchStub);
	return { fetch: listeners.fetch, fetched: () => fetched };
}

/** @param {any} listener @param {Request} request */
async function dispatch(listener, request) {
	/** @type {Promise<Response> | null} */
	let answer = null;
	listener({
		request,
		respondWith: (/** @type {Promise<Response>} */ p) => (answer = Promise.resolve(p))
	});
	return /** @type {any} */ (answer);
}

describe('manifest (60 Q4)', () => {
	it('share_target POSTs multipart files to the path the worker takes', () => {
		const st = manifest.share_target;
		expect(st.action).toBe('/share-target');
		expect(st.method).toBe('POST');
		expect(st.enctype).toBe('multipart/form-data');
		expect(swSource).toContain(`const SHARE_PATH = '${st.action}'`);
		const files = st.params.files;
		expect(files).toHaveLength(1);
		expect(files[0].name).toBe('files');
		expect(swSource).toMatch(/form\s*\.getAll\('files'\)/);
		for (const a of [
			'image/*',
			'.glb',
			'.gltf',
			'.tpscene',
			'model/gltf-binary',
			'model/gltf+json'
		])
			expect(files[0].accept).toContain(a);
	});
	it('file_handlers open .tpscene, .glb and .gltf in the app', () => {
		const exts = manifest.file_handlers.flatMap((/** @type {any} */ h) =>
			Object.values(h.accept).flat()
		);
		expect(exts.sort()).toEqual(['.glb', '.gltf', '.tpscene']);
		for (const h of manifest.file_handlers) expect(h.action.startsWith('/')).toBe(true);
	});
	it('launch_handler focuses the window already open', () => {
		expect(manifest.launch_handler.client_mode[0]).toBe('focus-existing');
	});
	it('the worker and the app agree on the inbox name and the param', () => {
		expect(swSource).toContain(`const SHARE_INBOX = '${SHARE_INBOX}'`);
		expect(swSource).toContain(`const SHARE_PARAM = '${SHARE_PARAM}'`);
	});
});

describe('sw.js share inbox', () => {
	const share = (/** @type {FormData} */ form) =>
		new Request('https://app.test/share-target', { method: 'POST', body: form });

	it('parks every shared file and redirects to /?shared=<n>', async () => {
		const caches = fakeCaches();
		const sw = loadWorker(caches);
		const form = new FormData();
		form.append('title', 'look');
		form.append(
			'files',
			new File([new Uint8Array([1, 2, 3])], 'chair model.glb', { type: 'model/gltf-binary' })
		);
		form.append('files', new File(['png'], 'ref.png', { type: 'image/png' }));
		const res = await dispatch(sw.fetch, share(form));
		expect(res.status).toBe(303);
		expect(
			new URL(/** @type {string} */ (res.headers.get('Location'))).pathname +
				new URL(/** @type {string} */ (res.headers.get('Location'))).search
		).toBe('/?shared=2');
		expect(sw.fetched()).toBe(0);
		const inbox = /** @type {Map<string, Response>} */ (caches.stores.get(SHARE_INBOX));
		expect([...inbox.keys()]).toEqual(['/share-inbox/0', '/share-inbox/1']);
		const first = /** @type {Response} */ (inbox.get('/share-inbox/0'));
		expect(decodeURIComponent(/** @type {string} */ (first.headers.get('X-File-Name')))).toBe(
			'chair model.glb'
		);
		expect(new Uint8Array(await first.clone().arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('a text-only share opens the app and parks nothing', async () => {
		const caches = fakeCaches();
		const sw = loadWorker(caches);
		const form = new FormData();
		form.append('url', 'https://example.com');
		const res = await dispatch(sw.fetch, share(form));
		expect(res.status).toBe(303);
		expect(new URL(/** @type {string} */ (res.headers.get('Location'))).search).toBe('');
		expect(caches.stores.has(SHARE_INBOX)).toBe(false);
	});

	it('a new share replaces an uncollected one', async () => {
		const caches = fakeCaches();
		const sw = loadWorker(caches);
		const a = new FormData();
		a.append('files', new File(['a'], 'a.png'));
		a.append('files', new File(['b'], 'b.png'));
		await dispatch(sw.fetch, share(a));
		const b = new FormData();
		b.append('files', new File(['c'], 'c.glb'));
		await dispatch(sw.fetch, share(b));
		expect([
			.../** @type {Map<string, Response>} */ (caches.stores.get(SHARE_INBOX)).keys()
		]).toEqual(['/share-inbox/0']);
	});

	it('everything else still goes straight to the network (no shell cache)', async () => {
		const caches = fakeCaches();
		const sw = loadWorker(caches);
		await dispatch(sw.fetch, new Request('https://app.test/'));
		await dispatch(sw.fetch, new Request('https://app.test/other', { method: 'POST', body: 'x' }));
		expect(sw.fetched()).toBe(2);
		expect(caches.stores.size).toBe(0);
	});

	it('the round trip: what the worker parks, the app reads back once', async () => {
		const caches = fakeCaches();
		const sw = loadWorker(caches);
		const form = new FormData();
		form.append('files', new File(['scene-bytes'], 'Yard.tpscene'));
		form.append('files', new File(['img'], 'photo 1.jpg', { type: 'image/jpeg' }));
		const res = await dispatch(sw.fetch, share(form));
		const loc = new URL(/** @type {string} */ (res.headers.get('Location')));
		/** @type {string[]} */
		const replaced = [];
		const env = {
			caches: /** @type {any} */ (caches),
			location: /** @type {any} */ ({ href: loc.href + '#peer', search: loc.search }),
			history: /** @type {any} */ ({
				state: null,
				replaceState: (
					/** @type {any} */ _s,
					/** @type {string} */ _t,
					/** @type {string} */ url
				) => replaced.push(url)
			})
		};
		const files = await readShareInbox(env);
		expect(files.map((f) => f.name)).toEqual(['Yard.tpscene', 'photo 1.jpg']);
		expect(await files[0].text()).toBe('scene-bytes');
		expect(files[1].type).toBe('image/jpeg');
		expect(replaced).toEqual(['/#peer']);
		expect(caches.stores.has(SHARE_INBOX)).toBe(false);
		// a second read (a reload with the param still there) finds nothing
		expect(await readShareInbox(env)).toEqual([]);
	});

	it('no ?shared= param = the inbox is not touched', async () => {
		const caches = fakeCaches();
		await (
			await caches.open(SHARE_INBOX)
		).put(new Request('https://app.test/share-inbox/0'), new Response('x'));
		const files = await readShareInbox({
			caches: /** @type {any} */ (caches),
			location: /** @type {any} */ ({ href: 'https://app.test/', search: '' })
		});
		expect(files).toEqual([]);
		expect(caches.stores.has(SHARE_INBOX)).toBe(true);
	});
});

describe('classifyLaunchFiles', () => {
	const f = (/** @type {string} */ name, type = '') => ({ name, type });
	const names = (/** @type {any[]} */ xs) => xs.map((x) => x.name);

	it('scenes open, models import, a lone image goes to the library', () => {
		const c = classifyLaunchFiles([
			f('Yard.tpscene'),
			f('chair.GLB'),
			f('tree.gltf'),
			f('notes.txt')
		]);
		expect(names(c.scenes)).toEqual(['Yard.tpscene']);
		expect(names(c.models)).toEqual(['chair.GLB', 'tree.gltf']);
		expect(names(c.skipped)).toEqual(['notes.txt']);
		const img = classifyLaunchFiles([f('photo.jpg'), f('IMG_0001', 'image/heic')]);
		expect(names(img.images)).toEqual(['photo.jpg', 'IMG_0001']);
		expect(img.companions).toEqual([]);
	});
	it('images WITH a model are its companions (an .obj and its textures)', () => {
		const c = classifyLaunchFiles([f('house.obj'), f('house.mtl'), f('bricks.png')]);
		expect(names(c.models)).toEqual(['house.obj']);
		expect(names(c.companions)).toEqual(['house.mtl', 'bricks.png']);
		expect(c.images).toEqual([]);
	});
	it('a lone .mtl is not an image and is skipped', () => {
		expect(names(classifyLaunchFiles([f('house.mtl')]).skipped)).toEqual(['house.mtl']);
	});
	it('nothing in, nothing out', () => {
		const c = classifyLaunchFiles([]);
		expect(c.scenes.length + c.models.length + c.images.length + c.skipped.length).toBe(0);
	});
});
