// 60 Q6 — THE LOCAL ASSET CACHE, its pure half: keys, the index shape and the LRU plan.
//
// A ZERO-IMPORT LEAF (the wireBatch / alignCore shape), so every rule that decides WHAT is kept
// and WHAT goes is unit-testable with no OPFS and no browser. `assetCache.js` is the runtime
// that reads and writes bytes; this file only does arithmetic over the index.
//
// THE MODEL. Bytes are stored ONCE per content hash (a "blob"); the index maps a KEY to the hash
// it resolved to. Two keys may share a blob — the same file reached at two urls, or a converted
// texture identical to one already held — and a blob is freed only when no key refers to it.
//  * url:<absolute url>[#v=<version>] — a network file (pack files, skies, CC0 downloads). The
//    hash is learned when the bytes arrive; the key is what a later load asks for. A version tag
//    is part of the key where the url alone does not pin the bytes (a same-origin sky ships with
//    the build, so it is keyed by the build too).
//  * derived:<kind>:<source hash>:<params> — the OUTPUT of a conversion (an optimized import's
//    KTX2 textures), keyed by the INPUT's content hash and the exact settings. The same file
//    imported again with the same settings never converts twice.
//
// LRU: every read stamps `lastUsed`; when the blobs' total passes the cap, keys go oldest first
// (never the protected ones — the key just written) until the blobs still referenced fit.

/** @typedef {{hash: string, bytes: number, kind: string, type?: string, lastUsed: number, at: number, meta?: any}} CacheEntry */
/** @typedef {{v: 1, entries: Record<string, CacheEntry>}} CacheIndex */

export const INDEX_VERSION = 1;
export const CACHE_KINDS = ['pack', 'sky', 'texture', 'import'];
/** the cap choices Settings offers, in MB (0 is not offered: Clear is the off switch) */
export const CAP_CHOICES_MB = [256, 512, 1024, 2048];
export const DEFAULT_CAP_MB = 1024;

/**
 * JSON with SORTED keys at every depth, so two equal settings objects give one key whatever
 * order their fields were written in.
 * @param {any} value @returns {string}
 */
export function stableStringify(value) {
	if (value === undefined) return 'null';
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
	const keys = Object.keys(value)
		.filter((k) => value[k] !== undefined)
		.sort();
	return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * The key of a network file. Only absolute http(s) urls are cacheable — a blob:/data: url is
 * already in memory, and a relative one must be resolved by the caller first.
 * @param {string} url @param {string} [version] @returns {string | null}
 */
export function urlKey(url, version) {
	if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
	const bare = url.replace(/#.*$/, '');
	return 'url:' + bare + (version ? '#v=' + version : '');
}

/** the url a `url:` key was made from (without its version tag), else null @param {string} key */
export function urlOfKey(key) {
	if (typeof key !== 'string' || !key.startsWith('url:')) return null;
	return key.slice(4).replace(/#v=.*$/, '');
}

/**
 * The key of a conversion's output.
 * @param {string} kind @param {string} sourceHash @param {any} params @returns {string | null}
 */
export function derivedKey(kind, sourceHash, params) {
	if (!kind || typeof sourceHash !== 'string' || !/^[0-9a-f]{16,}$/i.test(sourceHash)) return null;
	return 'derived:' + kind + ':' + sourceHash.toLowerCase() + ':' + stableStringify(params ?? null);
}

/** @returns {CacheIndex} */
export function emptyIndex() {
	return { v: INDEX_VERSION, entries: {} };
}

/**
 * Bring a stored index back to shape: an unknown version or a malformed row is dropped (the
 * cache is a cache — losing a row costs one download), never trusted.
 * @param {any} raw @returns {CacheIndex}
 */
export function normalizeIndex(raw) {
	const out = emptyIndex();
	if (
		!raw ||
		typeof raw !== 'object' ||
		raw.v !== INDEX_VERSION ||
		!raw.entries ||
		typeof raw.entries !== 'object'
	)
		return out;
	for (const [key, e] of Object.entries(raw.entries)) {
		if (!e || typeof e !== 'object') continue;
		if (typeof e.hash !== 'string' || !/^[0-9a-f]{16,}$/.test(e.hash)) continue;
		if (!Number.isFinite(e.bytes) || e.bytes < 0) continue;
		out.entries[key] = {
			hash: e.hash,
			bytes: e.bytes,
			kind: CACHE_KINDS.includes(e.kind) ? e.kind : 'import',
			...(typeof e.type === 'string' ? { type: e.type } : {}),
			lastUsed: Number.isFinite(e.lastUsed) ? e.lastUsed : 0,
			at: Number.isFinite(e.at) ? e.at : 0,
			...(e.meta !== undefined ? { meta: e.meta } : {})
		};
	}
	return out;
}

/**
 * The blobs the index refers to: hash -> {bytes, refs}. A blob's size is counted ONCE however
 * many keys share it.
 * @param {CacheIndex} index @returns {Map<string, {bytes: number, refs: number}>}
 */
export function blobsOf(index) {
	/** @type {Map<string, {bytes: number, refs: number}>} */
	const blobs = new Map();
	for (const e of Object.values(index.entries)) {
		const b = blobs.get(e.hash);
		if (b) b.refs++;
		else blobs.set(e.hash, { bytes: e.bytes, refs: 1 });
	}
	return blobs;
}

/**
 * What the cache holds: total bytes (blobs counted once), keys, blobs, and bytes per kind (a
 * shared blob counts toward the kind of the first key that names it, so the kinds sum to the
 * total).
 * @param {CacheIndex} index
 */
export function usageOf(index) {
	/** @type {Record<string, number>} */
	const byKind = Object.fromEntries(CACHE_KINDS.map((k) => [k, 0]));
	const seen = new Set();
	let bytes = 0;
	for (const e of Object.values(index.entries)) {
		if (seen.has(e.hash)) continue;
		seen.add(e.hash);
		bytes += e.bytes;
		byKind[e.kind] = (byKind[e.kind] ?? 0) + e.bytes;
	}
	return { bytes, keys: Object.keys(index.entries).length, blobs: seen.size, byKind };
}

/**
 * THE LRU PLAN: which keys to drop so the referenced blobs fit `capBytes`, oldest `lastUsed`
 * first (ties by key, so the plan is deterministic), never a `protect`ed key; and which blobs
 * that frees (a blob goes only when its LAST key goes). Pure — the caller applies it.
 * @param {CacheIndex} index @param {number} capBytes @param {Iterable<string>} [protect]
 * @returns {{keys: string[], hashes: string[], bytesAfter: number}}
 */
export function planEviction(index, capBytes, protect = []) {
	const keep = new Set(protect);
	const blobs = blobsOf(index);
	let total = 0;
	for (const b of blobs.values()) total += b.bytes;
	/** @type {string[]} */
	const keys = [];
	/** @type {string[]} */
	const hashes = [];
	if (total <= capBytes) return { keys, hashes, bytesAfter: total };
	const order = Object.entries(index.entries)
		.filter(([k]) => !keep.has(k))
		.sort((a, b) => a[1].lastUsed - b[1].lastUsed || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	for (const [key, e] of order) {
		if (total <= capBytes) break;
		keys.push(key);
		const b = /** @type {{bytes: number, refs: number}} */ (blobs.get(e.hash));
		b.refs--;
		if (b.refs === 0) {
			hashes.push(e.hash);
			total -= b.bytes;
		}
	}
	return { keys, hashes, bytesAfter: total };
}

/**
 * Which blobs no key refers to any more once `keys` are removed (the delete/clear-one path).
 * @param {CacheIndex} index @param {Iterable<string>} keys @returns {string[]}
 */
export function orphanedBy(index, keys) {
	const gone = new Set(keys);
	const still = new Set();
	const touched = new Set();
	for (const [k, e] of Object.entries(index.entries)) {
		if (gone.has(k)) touched.add(e.hash);
		else still.add(e.hash);
	}
	return [...touched].filter((h) => !still.has(h));
}
