// @ts-check
// 102-boot-diet-3 — EDITOR PANELS THAT LOAD ON FIRST OPEN. The bottom-dock windows (Animation, UV editor, Shader
// editor, HUD editor, Timeline: ~120 KB gz together) and the mesh toolbox left the editor's boot; App.svelte /
// Menu.svelte mount each through this registry (components/editors/LazyDockWindow.svelte for the dock windows).
//
// THE RULES:
// - a body loads the first time its panel opens (or, for the mesh toolbox, at idle / on the first edit session) and
//   then STAYS MOUNTED, closed or open, exactly as the static import kept it: its close-time duties (the UV checker
//   going off, the Timeline giving the view back, auto-key disarming on a selection change) and its view state (zoom,
//   picks) behave as before once it has been opened. Duties that must hold before any open live in lib starters
//   (the active-sequence fallback: sequencePlayer.js; the slot list warm-up: Inspector.svelte).
// - the cache is per page: a remount (a pop-out coming back) is synchronous.
// - a failed load does not latch: the next open retries (the stale-chunk rule; vite's import retry covers a deploy).
// - test pages (the `debugStores` hook) load every body before the hook publishes, so suites that open a panel and
//   act at once see it mounted (debugHooks.js); tests/e2e/dock-on-demand runs the real path on plain pages.
// - play never reaches this module's loaders: every caller sits in the editor's `!$isLocked && !$embedMode` block.
import { writable, get } from 'svelte/store';

/** key -> the body's loader. The dock keys are the bottomDock / panelRegistry keys. (panelPrefetch.js reads it) */
export const LOADERS = /** @type {Record<string, () => Promise<any>>} */ ({
	animation: () => import('../components/editors/AnimationWindow.svelte'),
	uv: () => import('../components/editors/UvEditor.svelte'),
	shader: () => import('../components/editors/ShaderEditor.svelte'),
	hud: () => import('../components/editors/HudEditor.svelte'),
	timeline: () => import('../components/editors/TimelineEditor.svelte'),
	meshToolbox: () => import('../components/menu/MeshEditPopup.svelte')
});

/** key -> the loaded component (absent until it has loaded) @type {import('svelte/store').Writable<Record<string, any>>} */
export const lazyPanels = writable({});

/** @type {Map<string, Promise<any>>} */
const pending = new Map();

/**
 * Load a panel's body once (again after a failure). Resolves with the component.
 * @param {string} key @returns {Promise<any>}
 */
export function loadPanel(key) {
	const have = get(lazyPanels)[key];
	if (have) return Promise.resolve(have);
	let p = pending.get(key);
	if (!p) {
		const load = LOADERS[key];
		if (!load) return Promise.reject(new Error('no lazy panel ' + key));
		mark(key, 'start'); // the first-open timing, readable by the dock-on-demand suite and a profiler
		p = load().then(
			(m) => {
				mark(key, 'loaded');
				pending.delete(key);
				lazyPanels.update((s) => ({ ...s, [key]: m.default }));
				return m.default;
			},
			(err) => {
				pending.delete(key);
				console.warn('[panels] could not load ' + key, err);
				throw err;
			}
		);
		pending.set(key, p);
	}
	return p;
}

/** @param {string} key @param {string} what */
export function mark(key, what) {
	try {
		performance.mark('lazy-panel:' + key + ':' + what);
	} catch {
		/* no performance API */
	}
}

/** test pages: every body, before the debug hook publishes @returns {Promise<void>} */
export function loadAllPanels() {
	return Promise.all(Object.keys(LOADERS).map((k) => loadPanel(k).catch(() => {}))).then(() => {});
}

/** the keys this registry loads (the dock-on-demand suite reads it) */
export const LAZY_PANEL_KEYS = Object.freeze(Object.keys(LOADERS));
