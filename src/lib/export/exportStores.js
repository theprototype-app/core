// 36-export — the Publish / Export modal's state, and the export defaults. A LEAF (svelte/store
// + safeStorage), so the sidebar row, the modal, the settings section and the cloud plugin's
// seams can all reach it without an import cycle.
import { writable, get } from 'svelte/store';
import { safeStorage } from '../safeStorage';

/** the modal is open @type {import('svelte/store').Writable<boolean>} */
export const publishExportOpen = writable(false);
/** its tab: 'publish' | 'export' | 'settings' @type {import('svelte/store').Writable<string>} */
export const publishExportTab = writable('export');

/**
 * Open the modal on a tab. With a cloud plugin the burger row lands on Publish (the plugin's
 * flow); the OSS app has no Publish of its own and lands on Export.
 * @param {string} [tab]
 */
export function openPublishExport(tab) {
	publishExportTab.set(tab || (get(publishSlot) ? 'publish' : 'export'));
	publishExportOpen.set(true);
}

/**
 * cloudApi `mountPublish(fn)`: the plugin's Publish tab body — a `(el) => cleanup` mount fn
 * (the CloudSlot shape). Null = no plugin = the tab explains where publishing lives.
 * @type {import('svelte/store').Writable<any>}
 */
export const publishSlot = writable(null);

/**
 * cloudApi `setPublishedLink(info)`: what the plugin last published from this scene —
 * `{id, title, playUrl, pageUrl}` — so the Export tab's Embed preset can point its iframe at the
 * play link. Null until something is published (the Embed preset then asks for a URL).
 * @type {import('svelte/store').Writable<{id: string, title: string, playUrl: string, pageUrl: string} | null>}
 */
export const publishedLink = writable(null);

/* ---------------------------------------------------------------- the defaults ---- */

const PREFS_KEY = 'export:prefs';

/** @typedef {{preset: string, startFullscreen: boolean, showFps: boolean, quality: string,
 *   vrButton: boolean, useCdnForPacks: boolean, thumbnail: boolean, viewportW: number,
 *   viewportH: number, embedUrl: string}} ExportPrefs */

/** @type {ExportPrefs} */
export const DEFAULT_EXPORT_PREFS = Object.freeze({
	preset: 'itch',
	startFullscreen: false,
	showFps: false,
	quality: 'auto',
	vrButton: true,
	useCdnForPacks: false,
	thumbnail: true,
	viewportW: 960,
	viewportH: 600,
	embedUrl: ''
});

const QUALITIES = ['auto', 'low', 'medium', 'high'];
const PRESETS = ['itch', 'static', 'embed'];

/** Typed, clamped prefs from whatever was stored (unknown keys dropped). PURE. @param {any} raw @returns {ExportPrefs} */
export function coerceExportPrefs(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = DEFAULT_EXPORT_PREFS;
	/** @param {any} v @param {number} lo @param {number} hi @param {number} def */
	const int = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : def);
	/** @param {any} v @param {boolean} def */
	const bool = (v, def) => (typeof v === 'boolean' ? v : def);
	return {
		preset: PRESETS.includes(r.preset) ? r.preset : d.preset,
		startFullscreen: bool(r.startFullscreen, d.startFullscreen),
		showFps: bool(r.showFps, d.showFps),
		quality: QUALITIES.includes(r.quality) ? r.quality : d.quality,
		vrButton: bool(r.vrButton, d.vrButton),
		useCdnForPacks: bool(r.useCdnForPacks, d.useCdnForPacks),
		thumbnail: bool(r.thumbnail, d.thumbnail),
		viewportW: int(r.viewportW, 200, 4096, d.viewportW),
		viewportH: int(r.viewportH, 200, 4096, d.viewportH),
		embedUrl: typeof r.embedUrl === 'string' ? r.embedUrl.slice(0, 500) : d.embedUrl
	};
}

function readPrefs() {
	try {
		return coerceExportPrefs(JSON.parse(safeStorage.getItem(PREFS_KEY) || 'null'));
	} catch {
		return coerceExportPrefs(null);
	}
}

/** the export defaults, persisted per device @type {import('svelte/store').Writable<ExportPrefs>} */
export const exportPrefs = writable(readPrefs());

/** @param {Partial<ExportPrefs>} patch */
export function setExportPrefs(patch) {
	const next = coerceExportPrefs({ ...get(exportPrefs), ...patch });
	exportPrefs.set(next);
	safeStorage.setItem(PREFS_KEY, JSON.stringify(next));
}
