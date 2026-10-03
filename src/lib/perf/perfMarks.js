// 34 PF/R1 — THE MARKER SEAM. "What was happening" when a frame stalled is only knowable
// at the places that DO things: a teleport lands in vr/locomotion, a grab starts in
// vr/grip or playInteract, the pause menu opens in gameShell, a scene load begins in
// sceneLoader. Those modules sit inside the history/vrControls import families, and the
// recorder reads stores, the scene budget and IndexedDB — so they must never import it.
//
// A DELIBERATE LEAF that imports NOTHING: a caller writes `perfMark('teleport')` and the
// recorder (or nobody) hears it. Context the recorder cannot import (the open scene's
// name lives in levels.js, the loaded modules in the SDK registries) is REGISTERED here
// as a provider by the module that owns it, the registerMetricSource shape.

/** @type {Set<(kind: string, detail?: any) => void>} */
const sinks = new Set();

/** @type {Map<string, () => any>} */
const context = new Map();

/**
 * A moment worth a marker on the timeline. Cheap when nobody listens; a throwing sink is
 * isolated (one bad listener must never take the caller's action down with it).
 * @param {string} kind one of tpprof EVENT_KINDS, or any short string
 * @param {any} [detail] small plain JSON
 */
export function perfMark(kind, detail) {
	for (const fn of sinks) {
		try {
			fn(kind, detail);
		} catch {
			/* isolated */
		}
	}
}

/** Hear every marker. @param {(kind: string, detail?: any) => void} fn @returns {() => void} */
export function onPerfMark(fn) {
	sinks.add(fn);
	return () => sinks.delete(fn);
}

/**
 * Contribute a piece of recording context without the recorder importing you.
 * Known keys: `scene` (string|null), `modules` ({id: version}).
 * @param {string} key @param {() => any} read @returns {() => void}
 */
export function registerPerfContext(key, read) {
	context.set(key, read);
	return () => context.delete(key);
}

/** One context value, or null when nobody provides it / the provider throws. @param {string} key */
export function perfContext(key) {
	const read = context.get(key);
	if (!read) return null;
	try {
		return read() ?? null;
	} catch {
		return null;
	}
}
