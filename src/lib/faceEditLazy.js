// 102-boot-diet-2 (phase 2): faceEdit.js on demand. The face / edge editor (~30 KB gz) left both boots;
// the boot keeps faceEditState.js (stores, prefs, registries) and meshGeoApply.js (the peer / undo swap).
//
// THE CONTRACT, unchanged for every caller outside the boot: faceEdit.js itself is the same module
// with the same exports — the `faceEdit` debug hook, agent tools and e2e import it exactly as before.
// Boot code reaches it here:
//   withFaceEdit(fn)  runs fn(module) SYNCHRONOUSLY when it is loaded (the same tick as before) and
//                     after the load otherwise -- the entry points (enter a face / vertex session,
//                     a sculpt stroke's commit) go through it, so after the prefetch nothing changes;
//   faceEditNow()     the module or null, for per-frame and handler code that only matters inside a
//                     session (a session implies the module is loaded: enterFaceEdit lives in it);
//   prefetchFaceEdit() starts the load when the machine is idle (the editor after its first frame,
//                     any page entering VR), so the first double-click / radial press is not a fetch.
// A load failure is reported once and retried on the next use (the stale-chunk rule: a deploy that
// replaced the chunk is handled by vite's import retry; a real failure must not latch).

import { isVRMode } from '../stores/sceneStore';

/** @type {typeof import('./faceEdit') | null} */
let mod = null;

/** faceEdit.js calls this at the END of its own evaluation with its namespace, so EVERY way in -- this
 * loader, the debug hook's import, an agent tool's `await import('$lib/faceEdit')` -- leaves the
 * accessor answering (an agent can open a session the viewport's handlers must then see)
 * @param {typeof import('./faceEdit')} m */
export function adoptFaceEdit(m) {
	mod = m;
}
/** @type {Promise<typeof import('./faceEdit')> | null} */
let pending = null;

/** @returns {Promise<typeof import('./faceEdit')>} */
export function loadFaceEdit() {
	if (mod) return Promise.resolve(mod);
	pending ??= import('./faceEdit').then(
		(m) => (mod = m),
		(err) => {
			pending = null;
			console.warn('[faceEdit] could not load the mesh editor', err);
			throw err;
		}
	);
	return pending;
}

/** the loaded module, or null */
export function faceEditNow() {
	return mod;
}

/**
 * Run `fn` with faceEdit: synchronously when it is loaded, else once it is.
 * @template T
 * @param {(fe: typeof import('./faceEdit')) => T} fn
 * @returns {T | Promise<T>}
 */
export function withFaceEdit(fn) {
	if (mod) return fn(mod);
	return loadFaceEdit().then(fn);
}

/** start loading when the browser is idle (never before the first frame) */
export function prefetchFaceEdit() {
	if (mod || pending || typeof window === 'undefined') return;
	const go = () => void loadFaceEdit().catch(() => {});
	const ric = /** @type {any} */ (window).requestIdleCallback;
	if (typeof ric === 'function') ric(go, { timeout: 4000 });
	else setTimeout(go, 1500);
}

// a headset is where the radial menu enters a session with no double-click to wait for: fetch on entry
if (typeof window !== 'undefined') isVRMode.subscribe((on) => on && prefetchFaceEdit());
