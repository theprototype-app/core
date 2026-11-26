// @ts-check
// 102-boot-diet-3 (claude:9's ruling on QUESTIONS Q3 = b) — THE FIVE DOCK EDITORS ARE PREFETCHED WHEN THE EDITOR IS IDLE.
// They left the boot (lazyPanels.js); a cold first open on a 3G link then paid one round trip + the transfer
// (~1.3-2.1 s measured). This module fetches and evaluates the five bodies' modules in the background, so the first
// open finds them in the module map and only mounts. It is itself a lazy chunk, loaded from Menu.svelte's idle
// callback (the mesh toolbox's); it then waits for the page's `load` event and idle again (a timeout fallback), and
// runs in the editor only (never an embed / play page), so the boot closure keeps its size.
//
// THE RULES:
// - modules only: nothing is mounted (lazyPanels' store is not touched; the window still mounts on its first open);
// - one at a time, so the prefetch never competes with itself for a slow link;
// - not on a metered or slow link: `navigator.connection.saveData`, or an effectiveType of '2g' / 'slow-2g' (checked
//   again before each body, the person may switch it on meanwhile);
// - a failure is SILENT (chunkReload.quietly: no "A new version is ready" notice for a load nobody asked for) and
//   latches nothing: the first open loads the body exactly as without a prefetch (lazyPanels.loadPanel);
// - `localStorage.debugPanelPrefetch = 'off'` skips it (the dock-on-demand suite's cold measurement).
import { LOADERS } from './lazyPanels.js';
import { quietly } from './chunkReload.js';
import { safeStorage } from './safeStorage';
import { get } from 'svelte/store';
import { embedMode } from './playMode.js';

/** the dock editors, in the order they are fetched (the mesh toolbox has its own idle load in Menu.svelte) */
export const PREFETCH_KEYS = Object.freeze(['animation', 'timeline', 'uv', 'shader', 'hud']);

/**
 * May this link take a background download? No on Save-Data or a 2G-class link; yes when the browser does not say.
 * @param {{saveData?: boolean, effectiveType?: string} | null | undefined} conn `navigator.connection`
 */
export function prefetchAllowed(conn) {
	if (!conn) return true;
	if (conn.saveData === true) return false;
	return conn.effectiveType !== '2g' && conn.effectiveType !== 'slow-2g';
}

/** @param {string} what */
function mark(what) {
	try {
		performance.mark('lazy-panel:prefetch:' + what);
	} catch {
		/* no performance API */
	}
}

/** @type {{done: string[], failed: string[], skipped: string | null}} the suites' view */
export const prefetchState = { done: [], failed: [], skipped: null };

/** the page has loaded (every boot fetch done) and the main thread is idle @returns {Promise<void>} */
function settled() {
	return new Promise((resolve) => {
		const idle = () => {
			const ric = /** @type {any} */ (globalThis).requestIdleCallback;
			if (typeof ric === 'function') ric(() => resolve(), { timeout: 10000 });
			else setTimeout(resolve, 3000);
		};
		if (document.readyState === 'complete') idle();
		else globalThis.addEventListener('load', idle, { once: true });
	});
}

/** Fetch the five bodies' modules, one after another, once the editor has settled. Never throws. */
export async function prefetchDockPanels() {
	if (safeStorage.getItem('debugPanelPrefetch') === 'off') {
		prefetchState.skipped = 'off';
		return prefetchState;
	}
	if (get(embedMode)) {
		prefetchState.skipped = 'embed'; // never the play runtime (an embed / play-link page runs this App too)
		return prefetchState;
	}
	await settled();
	mark('start');
	for (const key of PREFETCH_KEYS) {
		if (!prefetchAllowed(/** @type {any} */ (globalThis.navigator)?.connection)) {
			prefetchState.skipped = 'connection';
			break;
		}
		try {
			await quietly(LOADERS[key]);
			prefetchState.done.push(key);
		} catch {
			prefetchState.failed.push(key); // silent: the first open loads it again
		}
	}
	mark('done');
	return prefetchState;
}
