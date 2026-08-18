// 21-D1 — an Explorer content HASH resolved to an OBJECT URL, for the DOM HUD layer.
//
// `shaderTextures.js` already solves the hard half of this — the cache, the in-flight
// dedupe, the assetShare pull on a miss, and the listener-driven RETRY for bytes that
// arrive later (golden rule 9, and the LUT lesson: an asset that arrives later needs a
// WATCH, not a rebuild). This is deliberately the same shape, with one difference that
// matters: a HUD element is an `<img>`, so it needs a URL, not a `THREE.Texture`.
//
// Same reason for a hash rather than a dataURL as everywhere else: a HUD document
// replicates WHOLE on every edit, so an embedded image would re-send the bytes to every
// peer on each slider nudge.
//
// The URL is REVOKED when it is evicted, never on every read — an `<img src>` that is
// still mounted must keep working, and a URL created per read leaks one per frame.

import { explorerItems, itemByHash, itemBlob } from './explorer';
import { requestAsset, sendAsset } from './assetShare';

/** hash -> object URL. Shared: two elements naming one image share one URL.
 * @type {Map<string, string>} */
const cache = new Map();

/** hash -> the in-flight load, so N elements on one hash decode ONCE.
 * @type {Map<string, Promise<string|null>>} */
const loading = new Map();

/** hashes we have asked the mesh for and are still missing locally. @type {Set<string>} */
const awaiting = new Set();

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Be told when an image lands. A component cannot see this any other way: a blob URL being
 * created is not a store write and `hudImageFor` is a plain Map read, so a `$derived` over
 * it never re-runs (the `$derived`-cannot-see-a-plain-read family).
 * @param {() => void} fn @returns {() => void}
 */
export function registerHudImageListener(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function notify() {
	for (const fn of listeners) {
		try {
			fn();
		} catch (error) {
			console.log('hud image listener failed', error);
		}
	}
}

/** The URL for a hash, or null while it is missing/decoding. SYNCHRONOUS — the render path
 * must never await. @param {string} hash */
export function hudImageFor(hash) {
	return hash ? cache.get(hash) ?? null : null;
}

/**
 * Resolve a hash to an object URL, pulling the bytes from a peer when they are not local.
 * `requestAsset` is a no-op when we already asked, so this is safe to reach on every render.
 * @param {string} hash @returns {Promise<string|null>}
 */
export async function resolveHudImage(hash) {
	if (!hash) return null;
	const hit = cache.get(hash);
	if (hit) return hit;
	const inFlight = loading.get(hash);
	if (inFlight) return inFlight;

	const item = itemByHash(hash);
	if (!item) {
		// not local: ask for it, and let the explorerItems watch below finish the job
		awaiting.add(hash);
		requestAsset(hash);
		return null;
	}
	const job = (async () => {
		try {
			const blob = await itemBlob(item.id);
			if (!blob) return null;
			const url = URL.createObjectURL(blob);
			cache.set(hash, url);
			return url;
		} catch (error) {
			console.log('hud image decode failed', error);
			return null;
		} finally {
			loading.delete(hash);
		}
	})();
	loading.set(hash, job);
	return job;
}

/** Push the bytes on assign, so a peer does not have to ask first. @param {string} hash */
export function shareHudImage(hash) {
	if (hash) void sendAsset(hash);
}

/** @type {(() => void)|null} */
let itemsStop = null;

/** The retry watch. Idempotent. */
export function startHudImages() {
	if (itemsStop) return;
	itemsStop = explorerItems.subscribe((items) => {
		if (!awaiting.size || !Array.isArray(items)) return;
		// read the wanted set FIRST: resolving notifies listeners, which read stores, and
		// writing a store from inside its own subscriber is the documented flush loop
		const landed = [...awaiting].filter((hash) => items.some((item) => item?.hash === hash));
		if (!landed.length) return;
		for (const hash of landed) awaiting.delete(hash);
		void Promise.all(landed.map((hash) => resolveHudImage(hash))).then((urls) => {
			if (urls.some(Boolean)) notify();
		});
	});
}

/** Test seam. */
export function stopHudImages() {
	if (itemsStop) itemsStop();
	itemsStop = null;
}

/** Drop one hash (or everything) and revoke its URL. @param {string} [hash] */
export function forgetHudImage(hash) {
	const drop = hash ? [hash] : [...cache.keys()];
	for (const key of drop) {
		const url = cache.get(key);
		if (url) URL.revokeObjectURL(url);
		cache.delete(key);
		loading.delete(key);
		awaiting.delete(key);
	}
}

/** test/debug view */
export function hudImagesDebug() {
	return { cached: [...cache.keys()], awaiting: [...awaiting], loading: [...loading.keys()], listeners: listeners.size };
}
