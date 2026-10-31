// 47-cc0 — the network half: the two sources' JSON through a LOCAL response cache, and byte
// downloads with progress.
//
// THE CACHE (the user's ruling: "responses cached LOCAL"): every JSON answer is kept in the app's
// one IndexedDB store under `cc0:<url>` with the time it arrived. A fresh entry answers with no
// network at all; an expired one is refetched, and when that refetch FAILS (offline, the site
// down, the relay down) the old answer is served with `stale: true`, so the browser keeps working
// on what it saw last and says so. Downloads become Library items (content-hashed and deduped by
// the import entry); 60 Q6 also keeps their BYTES in the local asset cache (`fetchBytes`).
import { idbGet, idbPut } from '../idb';
import { safeStorage } from '../safeStorage';
import { PH_API, ACG_PAGE, DEFAULT_CC0_PROXY, classifyError } from './cc0Core.js';
import { readCached, writeCached } from '../assetCache';
import { urlKey } from '../assetCacheCore.js';

const HOUR = 3600_000;
/** how long an answer is fresh, per endpoint family */
export const CC0_TTL = { list: 24 * HOUR, categories: 7 * 24 * HOUR, files: 24 * HOUR, page: 6 * HOUR };

/** the relay base — a build env, else a LOCAL override (a staging Worker), else production */
export function cc0Proxy() {
	const env = /** @type {any} */ (import.meta).env?.VITE_CC0_PROXY;
	return String(safeStorage.getItem('cc0Proxy') || env || DEFAULT_CC0_PROXY).replace(/\/+$/, '');
}

/** in-memory memo over the idb cache (one session re-reads nothing) @type {Map<string, {at: number, data: any}>} */
const memo = new Map();

/** @param {string} url */
async function readCache(url) {
	const hit = memo.get(url);
	if (hit) return hit;
	try {
		const row = await idbGet('cc0:' + url);
		if (row && Number.isFinite(row.at)) {
			memo.set(url, row);
			return row;
		}
	} catch {}
	return null;
}

/** @param {string} url @param {any} data */
async function writeCache(url, data) {
	const row = { at: Date.now(), data };
	memo.set(url, row);
	try {
		await idbPut('cc0:' + url, row);
	} catch {}
}

const online = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

/**
 * GET a JSON document through the cache.
 * @param {string} url @param {number} ttl @param {{proxy?: boolean, fresh?: boolean}} [opts]
 * @returns {Promise<{data: any, stale: boolean, at: number, error?: {code: string, message: string}}>}
 */
export async function cachedJson(url, ttl, opts = {}) {
	const cached = await readCache(url);
	if (cached && !opts.fresh && Date.now() - cached.at < ttl) return { data: cached.data, stale: false, at: cached.at };
	try {
		const res = await fetch(url, { credentials: 'omit' });
		if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), opts.proxy ? { code: 'proxy', status: res.status } : { status: res.status });
		const data = await res.json();
		await writeCache(url, data);
		return { data, stale: false, at: Date.now() };
	} catch (err) {
		const error = classifyError(err, online());
		if (cached) return { data: cached.data, stale: true, at: cached.at, error };
		throw Object.assign(new Error(error.message), { cc0: error });
	}
}

/** Poly Haven: the whole list of one type (`fresh` = a Refresh press: ask even when cached)
 * @param {string} phType @param {boolean} [fresh] */
export const phList = (phType, fresh = false) => cachedJson(PH_API + '/assets?t=' + encodeURIComponent(phType), CC0_TTL.list, { fresh });
/** @param {string} phType @param {boolean} [fresh] */
export const phCategories = (phType, fresh = false) => cachedJson(PH_API + '/categories/' + encodeURIComponent(phType), CC0_TTL.categories, { fresh });
/** @param {string} id */
export const phFiles = (id) => cachedJson(PH_API + '/files/' + encodeURIComponent(id), CC0_TTL.files);

/**
 * ambientCG: one page of materials (through the relay — ambientCG sends no CORS header).
 * @param {{query?: string, category?: string, offset?: number, fresh?: boolean}} q
 */
export function acgPage(q) {
	const p = new URLSearchParams({ type: 'material', sort: 'popular', limit: String(ACG_PAGE), offset: String(q.offset ?? 0), include: 'title,tags,thumbnails,downloads' });
	if (q.query) p.set('q', q.query);
	if (q.category) p.set('category', q.category);
	return cachedJson(cc0Proxy() + '/acg/assets?' + p.toString(), CC0_TTL.page, { proxy: true, fresh: !!q.fresh });
}
/** @param {boolean} [fresh] */
export const acgCategories = (fresh = false) => cachedJson(cc0Proxy() + '/acg/categories', CC0_TTL.categories, { proxy: true, fresh });

/**
 * Where an ambientCG zip really lives: the relay follows `ambientcg.com/get?file=` (a redirect with
 * no CORS) and answers `{url}` on the CDN, which the browser then fetches itself.
 * @param {string} file e.g. Wood096_1K-JPG.zip
 */
export async function acgResolve(file) {
	const r = await cachedJson(cc0Proxy() + '/acg/resolve?file=' + encodeURIComponent(file), CC0_TTL.files, { proxy: true });
	const url = r.data?.url;
	if (typeof url !== 'string' || !/^https:\/\/[\w.-]+\.struffelproductions\.com\//.test(url))
		throw Object.assign(new Error('bad relay answer'), { cc0: { code: 'proxy', message: 'The ambientCG relay gave no download address. Try again in a minute.' } });
	return url;
}

/**
 * Download bytes with progress. `onProgress(done, total)` — total is 0 when the server did not say.
 * @param {string} url @param {(done: number, total: number) => void} [onProgress] @param {AbortSignal} [signal]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchBytes(url, onProgress, signal) {
	// 60 Q6: a download is kept in the local asset cache (kind `import`), so importing the same
	// file again — after deleting it from the library, or into another project — costs no network
	const key = urlKey(url);
	const held = await readCached(key);
	if (held) {
		onProgress?.(held.byteLength, held.byteLength);
		return new Uint8Array(held);
	}
	const bytes = await downloadBytes(url, onProgress, signal);
	void writeCached(key, /** @type {ArrayBuffer} */ (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), { kind: 'import' });
	return bytes;
}

/** @param {string} url @param {(done: number, total: number) => void} [onProgress] @param {AbortSignal} [signal] @returns {Promise<Uint8Array>} */
async function downloadBytes(url, onProgress, signal) {
	let res;
	try {
		res = await fetch(url, { credentials: 'omit', signal });
	} catch (err) {
		throw Object.assign(new Error('fetch failed'), { cc0: classifyError(err, online()) });
	}
	if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { cc0: classifyError({ status: res.status }, online()) });
	const total = Number(res.headers.get('content-length')) || 0;
	if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
	const reader = res.body.getReader();
	/** @type {Uint8Array[]} */
	const parts = [];
	let done = 0;
	for (;;) {
		const { value, done: end } = await reader.read();
		if (end) break;
		parts.push(value);
		done += value.byteLength;
		onProgress(done, total);
	}
	const out = new Uint8Array(done);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.byteLength;
	}
	return out;
}

/** drop the memo (tests; a "Refresh" press) */
export function forgetCc0Memo() {
	memo.clear();
}
