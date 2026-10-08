import { writable, get } from 'svelte/store';

// 39 P5 — PACK DOWNLOADS: the files of pack items this device has fetched, kept in ONE
// CacheStorage cache so the Explorer can say which items are downloaded (and how big they
// are), "Delete cache" can free one item's bytes while the item stays in its pack, and
// Storage can clear them all.
//
// Before this every pack file went through the browser's HTTP cache alone — invisible to
// the page, evictable at any time, and impossible to list or delete. CacheStorage is the
// one store a page can both enumerate and size. The HTTP cache still sits underneath (we
// cannot clear it), so "Delete cache" frees OUR copy: the next fetch goes to the network
// (or whatever the browser still holds) and is cached here again.
//
// A LEAF: svelte/store only. LOCAL by construction — what a device has downloaded is a fact
// about this machine; nothing here travels, saves or undoes. Every call degrades to a plain
// network fetch where CacheStorage is missing (an exported game on file://, a non-secure
// origin, a private window that refuses it), so no caller ever has to ask.

export const PACK_CACHE_NAME = 'tp-pack-files-v1';
/** the size header written beside each cached response (a Response's body cannot be sized
 * without reading it, and the index must not read every blob on boot) */
const BYTES_HEADER = 'x-tp-bytes';

/** url -> cached bytes, for every file in the cache. The Explorer's badges and the Storage
 * row read it; `loadPackCacheIndex` fills it once, every put/delete keeps it current.
 * @type {import('svelte/store').Writable<Map<string, number>>} */
export const packCacheIndex = writable(new Map());
let indexLoaded = false;
/** @type {Promise<void> | null} */
let indexJob = null;

/** Only real network files are cached — a blob:/data: url is already in memory. @param {string} url */
export function cacheableUrl(url) {
	return typeof url === 'string' && /^https?:\/\//.test(url);
}

/** @returns {Promise<Cache | null>} */
async function openCache() {
	try {
		if (typeof caches === 'undefined') return null;
		return await caches.open(PACK_CACHE_NAME);
	} catch {
		return null;
	}
}

/** Read the cache's keys (and sizes) into `packCacheIndex`, once. */
export function loadPackCacheIndex() {
	if (indexLoaded) return Promise.resolve();
	if (indexJob) return indexJob;
	indexJob = (async () => {
		const cache = await openCache();
		/** @type {Map<string, number>} */
		const map = new Map();
		if (cache) {
			try {
				for (const req of await cache.keys()) {
					const res = await cache.match(req);
					const bytes = Number(res?.headers.get(BYTES_HEADER)) || 0;
					map.set(req.url, bytes);
				}
			} catch {}
		}
		// a put that raced the scan is already in the store — keep it
		packCacheIndex.update((live) => new Map([...map, ...live]));
		indexLoaded = true;
	})();
	return indexJob;
}

/** @param {string} url @returns {boolean} */
export function isPackCached(url) {
	return get(packCacheIndex).has(url);
}

/** The cached bytes of a SET of urls (an item = its LOD0 + its LOD files). @param {string[]} urls @param {Map<string, number>} [index] */
export function cachedBytesOf(urls, index = get(packCacheIndex)) {
	let n = 0;
	for (const u of urls) n += index.get(u) ?? 0;
	return n;
}

/** Is ANY of an item's files downloaded? (LOD0 decides: it is what a placement fetches first.) @param {string} url @param {Map<string, number>} [index] */
export function cachedState(url, index = get(packCacheIndex)) {
	return index.has(url);
}

/**
 * The cached bytes of `url`, or null when it is not downloaded (or the cache is unusable).
 * @param {string} url @returns {Promise<ArrayBuffer | null>}
 */
export async function cachedPackBuffer(url) {
	if (!cacheableUrl(url)) return null;
	const cache = await openCache();
	if (!cache) return null;
	try {
		const res = await cache.match(url);
		if (!res) {
			// a stale index row (cleared in another tab) — forget it
			if (get(packCacheIndex).has(url)) packCacheIndex.update((m) => (m.delete(url), new Map(m)));
			return null;
		}
		return await res.arrayBuffer();
	} catch {
		return null;
	}
}

/**
 * Keep `buffer` as the downloaded copy of `url`. Best effort: a full quota or a refused
 * cache leaves the app exactly as it was (the bytes are already in memory).
 * @param {string} url @param {ArrayBuffer} buffer @param {string} [type]
 */
export async function putPackBuffer(url, buffer, type = 'model/gltf-binary') {
	if (!cacheableUrl(url) || !buffer) return false;
	const cache = await openCache();
	if (!cache) return false;
	try {
		await cache.put(
			url,
			new Response(buffer.slice(0), {
				headers: { 'content-type': type, [BYTES_HEADER]: String(buffer.byteLength), 'x-tp-cached-at': String(Date.now()) }
			})
		);
		packCacheIndex.update((m) => new Map(m).set(url, buffer.byteLength));
		return true;
	} catch {
		return false;
	}
}

/**
 * The bytes of a pack file: the downloaded copy when there is one, else the network (and
 * the result is kept). The one fetch every placement path shares.
 * @param {string} url @param {RequestInit} [init] @returns {Promise<ArrayBuffer>}
 */
export async function fetchPackBuffer(url, init) {
	const held = await cachedPackBuffer(url);
	if (held) return held;
	const res = await fetch(url, init);
	if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
	const buffer = await res.arrayBuffer();
	void putPackBuffer(url, buffer, res.headers.get('content-type') || undefined);
	return buffer;
}

/**
 * Forget the downloaded copies of `urls`. Resolves the bytes freed (by the index's count).
 * @param {string[]} urls @returns {Promise<number>}
 */
export async function deletePackCache(urls) {
	const cache = await openCache();
	let freed = 0;
	const index = get(packCacheIndex);
	for (const url of urls) {
		const bytes = index.get(url) ?? 0;
		let gone = false;
		try {
			gone = cache ? await cache.delete(url) : false;
		} catch {}
		if (gone || index.has(url)) freed += bytes;
	}
	packCacheIndex.update((m) => {
		const next = new Map(m);
		for (const url of urls) next.delete(url);
		return next;
	});
	return freed;
}

/** "Clear all pack downloads" (Storage). @returns {Promise<number>} the bytes freed */
export async function clearPackCache() {
	await loadPackCacheIndex();
	const freed = cachedBytesOf([...get(packCacheIndex).keys()]);
	try {
		if (typeof caches !== 'undefined') await caches.delete(PACK_CACHE_NAME);
	} catch {}
	packCacheIndex.set(new Map());
	return freed;
}
