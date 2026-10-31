// 59 T3 — THE BUNDLED SKIES LEAVE THE BUNDLE. The five 1k `.hdr` files (~7.5 MB) used to ship in
// static/hdri/ and so in every deployment and every release zip, while a scene shows at most one.
// They live in the packs repo's `hdri/` folder now (byte-identical, CC0 Poly Haven) and come
// through the same ref-pinned jsDelivr mirror as the packs; the preview CARDS stay bundled, so
// Configure scene looks the same.
//
// TWO SOURCES:
//   - an EXPORTED game reads the copy it carries beside index.html (`hdri/<file>`, the path the
//     export builder writes) — an export must never need the CDN;
//   - the app: the local asset cache (60 Q6, kind `sky`, what Settings ▸ Storage shows and clears)
//     in front of the CDN (`${SKY_BASE}/hdri/<file>`). A sky picked once is not downloaded again,
//     across reloads and offline. Keyed by the full URL, so a new pinned ref is a new entry; the
//     cache's LRU retires the older one. The app BUILD keeps its never-cached rule.
//
// A sky that cannot be fetched is NOT an error: the caller shows the preset's flat colours (what
// an older peer shows anyway) and retries when the browser comes back online. `SkyUnavailable`
// is how it tells the two apart.
import { contentBase } from '../contentBase.js';
import { exportMode, pageUrl } from '../export/exportBoot.js';
import { assetCacheIndex, fetchCached, flushIndex } from '../assetCache';
import { get } from 'svelte/store';

/** the off-bundle base the skies come from: VITE_HDRI_BASE, else the packs override, else the pinned packs ref */
export const SKY_BASE = contentBase(
	import.meta.env.VITE_HDRI_BASE || import.meta.env.VITE_PACKS_BASE,
	'https://cdn.jsdelivr.net/gh/theprototype-app/packs@format-1'
);

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

/**
 * The bytes of a bundled sky. Throws SkyUnavailable when it cannot be reached.
 * @param {string} file the catalog row's `file` @returns {Promise<ArrayBuffer>}
 */
export async function fetchSky(file) {
	const url = skyUrl(file);
	try {
		if (exportMode) {
			const res = await fetch(url);
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return await res.arrayBuffer();
		}
		return await fetchCached(url, { kind: 'sky' });
	} catch (err) {
		throw new SkyUnavailable(
			'could not reach ' + url + ': ' + String(/** @type {any} */ (err)?.message ?? err)
		);
	}
}

/** TEST/EVIDENCE: the sky urls the asset cache holds @returns {Promise<string[]>} */
export async function cachedSkies() {
	await flushIndex();
	return Object.entries(get(assetCacheIndex).entries ?? {})
		.filter(([, e]) => /** @type {any} */ (e).kind === 'sky')
		.map(([k]) => k.replace(/^url:/, ''));
}
