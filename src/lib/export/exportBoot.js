// 36-export (E1) — THE EXPORT BOOT FLAG. An exported game (the itch.io / static-host zip)
// is this same app build, booted in a play-only mode by one extra file beside index.html:
// `play.js`, a classic script the exporter writes and index.html loads BEFORE the app's
// modules. It sets `window.__TP_EXPORT__ = {...}`; this module reads it ONCE at module
// evaluation, the way playMode reads `?embed=1`, and nothing ever writes it again.
//
// No config (every normal page load) = `exportConfig` null and `exportMode` false: the app
// is byte-for-byte the old one. The config is DATA ONLY — the keys below are copied by
// name and everything else is dropped, so nothing in a hand-edited play.js can reach a
// code path this file does not know about. In particular there is NO key that hides the
// "Made with ThePrototype" badge (the runtime draws it in export mode, full stop): a
// `badge: false`, `hideBadge: true` or anything like it is simply not copied. An exported
// file is still editable by its owner — that is policy, not DRM (see the docs).
//
// A LEAF: imports nothing, so playMode / packs / gltfLoader can all read it without
// widening an import cycle.

/**
 * @typedef {{
 *   version: number,
 *   id: string,
 *   title: string,
 *   scene: string,
 *   packsBase: string,
 *   modules: {id: string, file: string}[],
 *   startFullscreen: boolean,
 *   showFps: boolean,
 *   quality: string,
 *   vrButton: boolean,
 *   preset: string,
 *   builtWith: string
 * }} ExportConfig
 */

/** the quality defaults an export may start at ('auto' = the governor decides) */
export const EXPORT_QUALITIES = ['auto', 'low', 'medium', 'high'];

/** a relative path inside the bundle: no scheme, no leading slash, no `..` */
function relPath(/** @type {unknown} */ v, /** @type {string} */ fallback) {
	const s = typeof v === 'string' ? v.trim() : '';
	if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('/') || s.split('/').includes('..')) return fallback;
	return s;
}

/**
 * Normalise a raw config: known keys only, typed, relative paths only. Exported for the
 * unit test (the "no key hides the badge" rule is asserted on THIS function).
 * @param {any} raw @returns {ExportConfig | null}
 */
export function normalizeExportConfig(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const quality = String(raw.quality ?? 'auto');
	return {
		version: Number(raw.version) || 1,
		id: String(raw.id ?? '').replace(/[^\w-]/g, '').slice(0, 64),
		title: String(raw.title ?? '').slice(0, 120),
		scene: relPath(raw.scene, 'scene.tpscene'),
		packsBase: relPath(raw.packsBase, ''),
		modules: Array.isArray(raw.modules)
			? raw.modules
					.filter((/** @type {any} */ m) => m && typeof m.id === 'string')
					.map((/** @type {any} */ m) => ({ id: String(m.id), file: relPath(m.file, '') }))
					.filter((/** @type {any} */ m) => m.file)
			: [],
		startFullscreen: raw.startFullscreen === true,
		showFps: raw.showFps === true,
		quality: EXPORT_QUALITIES.includes(quality) ? quality : 'auto',
		vrButton: raw.vrButton !== false,
		preset: String(raw.preset ?? 'static').slice(0, 20),
		builtWith: String(raw.builtWith ?? '').slice(0, 40)
	};
}

function readExportBoot() {
	try {
		if (typeof window === 'undefined') return null;
		return normalizeExportConfig(/** @type {any} */ (window).__TP_EXPORT__);
	} catch {
		return null;
	}
}

/** the export's config, or null on every normal page load */
export const exportConfig = readExportBoot();
/** true for the whole life of an exported game's page */
export const exportMode = !!exportConfig;

/**
 * A page-relative path as an absolute URL against the page (index.html's folder), so an app
 * served from a SUBPATH — an export on itch.io lives at `https://html-classic.itch.zone/html/<n>/`
 * — resolves its own files there and never at the host root. At the root of a normal
 * deployment this is exactly the old `/<rel>`.
 * @param {string} rel @returns {string}
 */
export function pageUrl(rel) {
	try {
		return new URL(rel, document.baseURI).href;
	} catch {
		return rel;
	}
}

/** the packs base an export overrides PACKS_BASE with ('' = none: the CDN, or a non-export page) */
export const exportPacksBase = exportConfig?.packsBase ? pageUrl(exportConfig.packsBase).replace(/\/+$/, '') : '';
