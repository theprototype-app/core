// 59 T3 — THE BUNDLED SKIES LEAVE THE BUNDLE. The five 1k `.hdr` files (~7.5 MB) used to ship in
// static/hdri/ and so in every deployment and every release zip, while a scene shows at most one.
// They live in the packs repo's `hdri/` folder now (byte-identical, CC0 Poly Haven) and come
// through the same ref-pinned jsDelivr mirror as the packs; the preview CARDS stay bundled, so
// Configure scene looks the same.
//
// THREE SOURCES, in order:
//   1. an EXPORTED game reads the copy it carries beside index.html (`hdri/<file>`, the path the
//      export builder writes) — an export must never need the CDN;
//   2. this browser's Cache Storage (`tp-skies-v1`) — a sky picked once is not downloaded again,
//      across reloads and offline. Keyed by the full URL, so a new pinned ref is a new entry; the
//      older entry for the same file is dropped when the new one lands (the cache stays at most
//      the five skies). The app BUILD keeps its never-cached rule: only these files go here;
//   3. the CDN (`${SKY_BASE}/hdri/<file>`), whose answer is put into (2).
//
// A sky that cannot be fetched is NOT an error: the caller shows the preset's flat colours (what
// an older peer shows anyway) and retries when the browser comes back online. `SkyUnavailable`
// is how it tells the two apart.
import { contentBase } from '../contentBase.js';
import { exportMode, pageUrl } from '../export/exportBoot.js';

/** the off-bundle base the skies come from: VITE_HDRI_BASE, else the packs override, else the pinned packs ref */
export const SKY_BASE = contentBase(
	import.meta.env.VITE_HDRI_BASE || import.meta.env.VITE_PACKS_BASE,
	'https://cdn.jsdelivr.net/gh/theprototype-app/packs@format-1'
);

export const SKY_CACHE = 'tp-skies-v1';

/** a bundled sky could not be reached (offline, CDN blocked) — the flat preset shows, no error */
export class SkyUnavailable extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = 'SkyUnavailable';
	}
}

/** Where a bundled sky's bytes come from on this page. @param {string} file e.g. 'hdri/meadow_2_1k.hdr' */
export function skyUrl(file) {
	return exportMode ? pageUrl(file) : SKY_BASE + '/' + String(file).replace(/^\/+/, '');
}

/** @returns {Promise<Cache | null>} null where Cache Storage is missing (http, some webviews) or refused */
async function openCache() {
	try {
		if (typeof caches === 'undefined') return null;
		return await caches.open(SKY_CACHE);
	} catch {
		return null;
	}
}

/**
 * The bytes of a bundled sky. Throws SkyUnavailable when it cannot be reached.
 * @param {string} file the catalog row's `file` @returns {Promise<ArrayBuffer>}
 */
export async function fetchSky(file) {
	const url = skyUrl(file);
	const cache = exportMode ? null : await openCache();
	if (cache) {
		try {
			const hit = await cache.match(url);
			if (hit) return await hit.arrayBuffer();
		} catch {
			/* a broken entry is fetched again below */
		}
	}
	/** @type {Response} */
	let res;
	try {
		res = await fetch(url);
	} catch (err) {
		throw new SkyUnavailable('could not reach ' + url + ': ' + String(/** @type {any} */ (err)?.message ?? err));
	}
	if (!res.ok) throw new SkyUnavailable('HTTP ' + res.status + ' for ' + url);
	const buffer = await res.arrayBuffer();
	if (cache) await keep(cache, url, file, buffer, res.headers.get('content-type'));
	return buffer;
}

/**
 * Store one sky and drop older entries for the same file (another pinned ref or base).
 * @param {Cache} cache @param {string} url @param {string} file @param {ArrayBuffer} buffer @param {string | null} type
 */
async function keep(cache, url, file, buffer, type) {
	try {
		await cache.put(url, new Response(buffer, { headers: { 'content-type': type || 'application/octet-stream' } }));
		const name = '/' + String(file).replace(/^\/+/, '');
		for (const req of await cache.keys()) if (req.url !== url && req.url.endsWith(name)) await cache.delete(req);
	} catch {
		/* quota or a private window: the sky still shows, it is just fetched again next time */
	}
}

/** TEST/EVIDENCE: what the sky cache holds @returns {Promise<string[]>} */
export async function cachedSkies() {
	const cache = await openCache();
	if (!cache) return [];
	try {
		return (await cache.keys()).map((r) => r.url);
	} catch {
		return [];
	}
}
