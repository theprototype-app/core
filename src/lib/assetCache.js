import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import {
	emptyIndex,
	normalizeIndex,
	usageOf,
	planEviction,
	orphanedBy,
	urlKey,
	CAP_CHOICES_MB,
	DEFAULT_CAP_MB
} from './assetCacheCore.js';

// 60 Q6 — THE LOCAL ASSET CACHE: packs, skies, converted textures and downloaded imports, kept
// on this device in the Origin Private File System, keyed by CONTENT HASH (assetCacheCore.js
// has the model: keys -> hash, one blob per hash, LRU under a cap).
//
// WHY OPFS. 39 P5 kept pack files in CacheStorage, which can be listed and sized but stores a
// whole Response per url — the same bytes at two urls twice — and gives a page no way to read a
// file without materialising the Response. OPFS is a real per-origin filesystem: a blob per hash,
// one small index file, a byte count that is the file's own. Where OPFS cannot write (no
// `createWritable`: old Safari, a non-secure origin) the SAME model runs on CacheStorage, and
// where neither exists every call degrades to a plain network fetch, so no caller ever asks.
//
// WHAT IT NEVER HOLDS: the app shell. index.html, the JS/CSS chunks and the service worker stay
// under the no-cache SW rule — an update must always reach the next load. Only CONTENT reaches
// this module: pack files from the packs CDN, sky images, CC0 downloads, conversion outputs.
//
// PERSISTENCE: browsers may evict an origin's storage under pressure unless the page asked
// `navigator.storage.persist()`. It is asked ONCE, from a toast that says why, the first time
// something lands here (`assetCache:persistAsked`), never on boot and never again.
//
// A LEAF for the app (svelte/store + safeStorage + the pure core); the toast is a dynamic import.

const DIR = 'tp-asset-cache';
const CACHE_NAME = 'tp-asset-cache-v1';
const CACHE_BASE = '/__tp-asset-cache/';
const INDEX_FLUSH_MS = 400;
const CAP_KEY = 'assetCache:capMB';
const ASKED_KEY = 'assetCache:persistAsked';

/** @typedef {{name: string, read(hash: string): Promise<ArrayBuffer | null>, write(hash: string, buf: ArrayBuffer): Promise<void>, remove(hash: string): Promise<void>, list(): Promise<string[]>, readIndex(): Promise<any>, writeIndex(text: string): Promise<void>, wipe(): Promise<void>}} Backend */

/** @returns {Promise<Backend | null>} */
async function opfsBackend() {
	const storage = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator.storage : null);
	if (!storage || typeof storage.getDirectory !== 'function') return null;
	const root = await storage.getDirectory();
	const dir = await root.getDirectoryHandle(DIR, { create: true });
	const blobs = await dir.getDirectoryHandle('blobs', { create: true });
	const probe = await dir.getFileHandle('.probe', { create: true });
	if (typeof probe.createWritable !== 'function') return null;
	/** @param {any} handle @param {ArrayBuffer | string} data */
	const writeFile = async (handle, data) => {
		const w = await handle.createWritable();
		await w.write(data);
		await w.close();
	};
	return {
		name: 'opfs',
		async read(hash) {
			try {
				const fh = await blobs.getFileHandle(hash);
				return await (await fh.getFile()).arrayBuffer();
			} catch {
				return null;
			}
		},
		async write(hash, buf) {
			await writeFile(await blobs.getFileHandle(hash, { create: true }), buf);
		},
		async remove(hash) {
			try {
				await blobs.removeEntry(hash);
			} catch {}
		},
		async list() {
			/** @type {string[]} */
			const out = [];
			for await (const name of blobs.keys()) out.push(name);
			return out;
		},
		async readIndex() {
			try {
				const fh = await dir.getFileHandle('index.json');
				return JSON.parse(await (await fh.getFile()).text());
			} catch {
				return null;
			}
		},
		async writeIndex(text) {
			await writeFile(await dir.getFileHandle('index.json', { create: true }), text);
		},
		async wipe() {
			for await (const name of blobs.keys()) {
				try {
					await blobs.removeEntry(name);
				} catch {}
			}
		}
	};
}

/** the same model on CacheStorage (one Response per blob, one for the index) @returns {Promise<Backend | null>} */
async function cacheBackend() {
	if (typeof caches === 'undefined') return null;
	const cache = await caches.open(CACHE_NAME);
	const blobUrl = (/** @type {string} */ hash) => CACHE_BASE + 'blob/' + hash;
	return {
		name: 'cachestorage',
		async read(hash) {
			const res = await cache.match(blobUrl(hash));
			return res ? res.arrayBuffer() : null;
		},
		async write(hash, buf) {
			await cache.put(blobUrl(hash), new Response(buf.slice(0)));
		},
		async remove(hash) {
			await cache.delete(blobUrl(hash));
		},
		async list() {
			return (await cache.keys())
				.map((r) => new URL(r.url).pathname)
				.filter((p) => p.startsWith(CACHE_BASE + 'blob/'))
				.map((p) => p.slice((CACHE_BASE + 'blob/').length));
		},
		async readIndex() {
			const res = await cache.match(CACHE_BASE + 'index.json');
			return res ? res.json() : null;
		},
		async writeIndex(text) {
			await cache.put(
				CACHE_BASE + 'index.json',
				new Response(text, { headers: { 'content-type': 'application/json' } })
			);
		},
		async wipe() {
			for (const req of await cache.keys()) await cache.delete(req);
		}
	};
}

/** @type {Promise<Backend | null> | null} */
let backendJob = null;
/** @type {Backend | null} */
let backend = null;
let index = emptyIndex();
/** the index, republished on every change (Settings, Storage, packCache read it) */
export const assetCacheIndex = writable(index);
/** which store is in use: 'opfs' | 'cachestorage' | 'none' | '' (not known yet) */
export const assetCacheBackend = writable('');

/** @returns {number} */
function readCapMB() {
	const n = Number(safeStorage.getItem(CAP_KEY));
	return CAP_CHOICES_MB.includes(n) ? n : DEFAULT_CAP_MB;
}
/** the LRU cap in MB (Settings ▸ Storage); LOCAL, persisted */
export const assetCacheCapMB = writable(readCapMB());
let capRead = false;
assetCacheCapMB.subscribe((mb) => {
	if (!capRead) return void (capRead = true); // the value we just read is not a choice
	if (CAP_CHOICES_MB.includes(mb)) safeStorage.setItem(CAP_KEY, String(mb));
	if (backend) void enforceCap();
});

const stats = { hits: 0, misses: 0, writes: 0, evicted: 0, fetches: 0 };

/** Open the store and read the index, once. Resolves whether a store is usable. @returns {Promise<boolean>} */
export function assetCacheReady() {
	if (!backendJob) {
		backendJob = (async () => {
			/** @type {Backend | null} */
			let b = null;
			try {
				b = await opfsBackend();
			} catch {
				b = null;
			}
			if (!b) {
				try {
					b = await cacheBackend();
				} catch {
					b = null;
				}
			}
			if (b) {
				try {
					index = normalizeIndex(await b.readIndex());
				} catch {
					index = emptyIndex();
				}
				// a tab that died between a blob write and its index flush leaves a blob no key
				// names, and one that died mid-eviction a key whose blob is gone: reconcile both
				try {
					const held = new Set(await b.list());
					let dropped = false;
					for (const [k, e] of Object.entries(index.entries)) {
						if (!held.has(e.hash)) {
							delete index.entries[k];
							dropped = true;
						}
					}
					const named = new Set(Object.values(index.entries).map((e) => e.hash));
					for (const h of held) if (!named.has(h)) await b.remove(h);
					if (dropped) scheduleFlush();
				} catch {}
			}
			backend = b;
			assetCacheBackend.set(b ? b.name : 'none');
			publish();
			return b;
		})();
	}
	return backendJob.then((b) => !!b);
}

function publish() {
	assetCacheIndex.set(index);
}

/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
function scheduleFlush() {
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		void flushIndex();
	}, INDEX_FLUSH_MS);
}
/** Write the index now (also on pagehide). */
export async function flushIndex() {
	if (!backend) return;
	try {
		await backend.writeIndex(JSON.stringify(index));
	} catch {}
}
if (typeof addEventListener === 'function') addEventListener('pagehide', () => void flushIndex());

/** SHA-256 hex of the bytes, or null where SubtleCrypto is missing @param {ArrayBuffer} buf */
async function sha256(buf) {
	try {
		const digest = await crypto.subtle.digest('SHA-256', buf);
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	} catch {
		return null;
	}
}

/** Is `key` held (by the index; the bytes may still turn out gone)? @param {string} key */
export function hasCached(key) {
	return !!index.entries[key];
}

/** The index row of `key`, or null @param {string} key */
export function cachedEntry(key) {
	return index.entries[key] ?? null;
}

/**
 * The cached bytes of `key`, or null. A hit stamps the key as just used (LRU).
 * @param {string | null} key @returns {Promise<ArrayBuffer | null>}
 */
export async function readCached(key) {
	if (!key || !(await assetCacheReady()) || !backend) return null;
	const e = index.entries[key];
	if (!e) {
		stats.misses++;
		return null;
	}
	const buf = await backend.read(e.hash);
	if (!buf) {
		// the blob went (another tab cleared, the browser evicted): forget the row
		delete index.entries[key];
		publish();
		scheduleFlush();
		stats.misses++;
		return null;
	}
	e.lastUsed = Date.now();
	scheduleFlush();
	stats.hits++;
	return buf;
}

/**
 * Keep `buffer` under `key`. Best effort: a full quota or a refused store leaves the app as it
 * was (the bytes are already in memory). Resolves the content hash, or null when nothing was kept.
 * @param {string | null} key @param {ArrayBuffer} buffer
 * @param {{kind: string, type?: string, meta?: any}} info
 * @returns {Promise<string | null>}
 */
export async function writeCached(key, buffer, info) {
	if (!key || !buffer || !(await assetCacheReady()) || !backend) return null;
	const hash = await sha256(buffer);
	if (!hash) return null;
	const shared = Object.values(index.entries).some((e) => e.hash === hash);
	try {
		if (!shared) await backend.write(hash, buffer);
	} catch {
		return null;
	}
	const now = Date.now();
	index.entries[key] = {
		hash,
		bytes: buffer.byteLength,
		kind: info.kind,
		...(info.type ? { type: info.type } : {}),
		lastUsed: now,
		at: now,
		...(info.meta !== undefined ? { meta: info.meta } : {})
	};
	stats.writes++;
	await enforceCap([key]);
	publish();
	scheduleFlush();
	maybeOfferPersist();
	return hash;
}

/** Drop the least recently used keys until the cache fits its cap. @param {string[]} [protect] */
async function enforceCap(protect = []) {
	if (!backend) return;
	const plan = planEviction(index, get(assetCacheCapMB) * 1024 * 1024, protect);
	if (!plan.keys.length) return;
	for (const k of plan.keys) delete index.entries[k];
	for (const h of plan.hashes) await backend.remove(h);
	stats.evicted += plan.keys.length;
	publish();
	scheduleFlush();
}

/**
 * The bytes of a network file through the cache: the held copy when there is one (no network
 * at all), else a fetch whose bytes are kept. Throws like fetch does on a failed request.
 * @param {string} url @param {{kind: string, version?: string, init?: RequestInit}} opts
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchCached(url, opts) {
	const key = urlKey(url, opts.version);
	const held = await readCached(key);
	if (held) return held;
	stats.fetches++;
	const res = await fetch(url, opts.init);
	if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
	const buffer = await res.arrayBuffer();
	void writeCached(key, buffer, {
		kind: opts.kind,
		type: res.headers.get('content-type') || undefined
	});
	return buffer;
}

/**
 * Forget `keys`; blobs no other key names are deleted. Resolves the bytes freed.
 * @param {string[]} keys @returns {Promise<number>}
 */
export async function deleteCached(keys) {
	if (!(await assetCacheReady()) || !backend) return 0;
	const orphans = orphanedBy(index, keys);
	let freed = 0;
	for (const h of orphans) {
		const e = Object.values(index.entries).find((x) => x.hash === h);
		freed += e?.bytes ?? 0;
		await backend.remove(h);
	}
	for (const k of keys) delete index.entries[k];
	publish();
	scheduleFlush();
	return freed;
}

/** Settings ▸ Storage ▸ Clear: everything, every kind. Resolves the bytes freed. */
export async function clearAssetCache() {
	if (!(await assetCacheReady()) || !backend) return 0;
	const freed = usageOf(index).bytes;
	try {
		await backend.wipe();
	} catch {}
	index = emptyIndex();
	publish();
	await flushIndex();
	return freed;
}

// ---- persistence: asked once, with the reason ------------------------------------------------

/** 'granted' | 'not-granted' | 'unsupported' | '' (not read yet) */
export const persistState = writable('');

export async function refreshPersistState() {
	const storage = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator.storage : null);
	if (!storage || typeof storage.persisted !== 'function') {
		persistState.set('unsupported');
		return;
	}
	try {
		persistState.set((await storage.persisted()) ? 'granted' : 'not-granted');
	} catch {
		persistState.set('unsupported');
	}
}

/** Was the question put already (on this device)? */
export function persistAsked() {
	return safeStorage.getItem(ASKED_KEY) === '1';
}

/** Ask the browser to keep this origin's storage. The ONE call site of `persist()`. */
export async function requestPersist() {
	safeStorage.setItem(ASKED_KEY, '1');
	const storage = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator.storage : null);
	if (!storage || typeof storage.persist !== 'function') {
		persistState.set('unsupported');
		return false;
	}
	let ok = false;
	try {
		ok = await storage.persist();
	} catch {}
	persistState.set(ok ? 'granted' : 'not-granted');
	return ok;
}

let offered = false;
/** The first time something lands in the cache, say why we want to keep it — once, ever. */
function maybeOfferPersist() {
	if (offered || persistAsked()) return;
	offered = true;
	void (async () => {
		await refreshPersistState();
		if (get(persistState) !== 'not-granted') return; // granted already, or no such API
		safeStorage.setItem(ASKED_KEY, '1');
		const { showToastById } = await import('../stores/appStore.js');
		showToastById(
			'asset-cache-persist',
			'Downloaded packs and skies are kept on this device so scenes load faster and work offline. Keep them even when the browser is short of space?',
			[
				{ label: 'Keep them', action: () => void requestPersist() },
				{ label: 'Not now', action: () => {} }
			]
		);
	})();
}

/** for the suites (`__stores.assetCache`) */
export function assetCacheStats() {
	return {
		...stats,
		backend: backend?.name ?? 'none',
		...usageOf(index),
		capMB: get(assetCacheCapMB)
	};
}
