import { derived, get } from 'svelte/store';
import {
	assetCacheIndex,
	assetCacheReady,
	readCached,
	writeCached,
	deleteCached,
	fetchCached
} from './assetCache';
import { urlKey, urlOfKey } from './assetCacheCore.js';

// 39 P5 — PACK DOWNLOADS: the files of pack items this device has fetched, so the Explorer can
// say which items are downloaded (and how big they are), "Delete cache" can free one item's bytes
// while the item stays in its pack, and Storage can clear them all.
//
// 60 Q6: the bytes live in the LOCAL ASSET CACHE now (assetCache.js — OPFS, keyed by content
// hash, LRU under the Settings ▸ Storage cap) as kind `pack`. This module keeps its API — every
// caller (placement, scene pack refs, the Explorer badges, Storage) is unchanged — and is the
// url-keyed VIEW of that cache. The 39 P5 CacheStorage copies are moved over once
// (`migrateLegacy`) and that cache is deleted.
//
// LOCAL by construction — what a device has downloaded is a fact about this machine; nothing
// here travels, saves or undoes. Every call degrades to a plain network fetch where no store
// works (an exported game on file://, a non-secure origin, a private window that refuses it).

/** 39 P5's CacheStorage name — only read once, to migrate what it holds */
export const PACK_CACHE_NAME = 'tp-pack-files-v1';

/** url -> cached bytes, for every pack file held. The Explorer's badges and the Storage row read
 * it; it follows the asset cache's index. @type {import('svelte/store').Readable<Map<string, number>>} */
export const packCacheIndex = derived(assetCacheIndex, (idx) => {
	/** @type {Map<string, number>} */
	const map = new Map();
	for (const [key, e] of Object.entries(idx.entries)) {
		if (e.kind !== 'pack') continue;
		const url = urlOfKey(key);
		if (url) map.set(url, e.bytes);
	}
	return map;
});

/** Only real network files are cached — a blob:/data: url is already in memory. @param {string} url */
export function cacheableUrl(url) {
	return typeof url === 'string' && /^https?:\/\//.test(url);
}

/** @type {Promise<void> | null} */
let migrateJob = null;
/** 60 Q6: move 39 P5's CacheStorage pack copies into the asset cache, then delete that cache. */
function migrateLegacy() {
	if (migrateJob) return migrateJob;
	migrateJob = (async () => {
		try {
			if (typeof caches === 'undefined' || !(await caches.has(PACK_CACHE_NAME))) return;
			const old = await caches.open(PACK_CACHE_NAME);
			for (const req of await old.keys()) {
				const res = await old.match(req);
				if (!res) continue;
				const buffer = await res.arrayBuffer();
				await writeCached(urlKey(req.url), buffer, {
					kind: 'pack',
					type: res.headers.get('content-type') || undefined
				});
			}
			await caches.delete(PACK_CACHE_NAME);
		} catch {}
	})();
	return migrateJob;
}

/** Open the cache and read its index (and migrate the old one), once. */
export async function loadPackCacheIndex() {
	await assetCacheReady();
	await migrateLegacy();
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
 * The cached bytes of `url`, or null when it is not downloaded (or no store works).
 * @param {string} url @returns {Promise<ArrayBuffer | null>}
 */
export async function cachedPackBuffer(url) {
	if (!cacheableUrl(url)) return null;
	await loadPackCacheIndex();
	return readCached(urlKey(url));
}

/**
 * Keep `buffer` as the downloaded copy of `url`. Best effort.
 * @param {string} url @param {ArrayBuffer} buffer @param {string} [type]
 */
export async function putPackBuffer(url, buffer, type = 'model/gltf-binary') {
	if (!cacheableUrl(url) || !buffer) return false;
	return !!(await writeCached(urlKey(url), buffer, { kind: 'pack', type }));
}

/**
 * The bytes of a pack file: the downloaded copy when there is one, else the network (and the
 * result is kept). The one fetch every placement path shares.
 * @param {string} url @param {RequestInit} [init] @returns {Promise<ArrayBuffer>}
 */
export async function fetchPackBuffer(url, init) {
	if (!cacheableUrl(url)) {
		const res = await fetch(url, init);
		if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
		return res.arrayBuffer();
	}
	await loadPackCacheIndex();
	return fetchCached(url, { kind: 'pack', init });
}

/**
 * Forget the downloaded copies of `urls`. Resolves the bytes freed.
 * @param {string[]} urls @returns {Promise<number>}
 */
export async function deletePackCache(urls) {
	const keys = urls.map((u) => urlKey(u)).filter((k) => k !== null);
	return deleteCached(/** @type {string[]} */ (keys));
}

/** "Clear all pack downloads" (Storage). @returns {Promise<number>} the bytes freed */
export async function clearPackCache() {
	await loadPackCacheIndex();
	return deletePackCache([...get(packCacheIndex).keys()]);
}
