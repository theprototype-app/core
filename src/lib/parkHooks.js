// 68 — a registry of extra PARKS for flowRuntime.parkAnimatedAtBase (golden rule 10).
//
// Imports nothing, so any runtime can register without reaching into flowRuntime's
// import family (history ← flowRuntime cycles). A hook temporarily puts its objects back
// at their authored base and returns the function that re-applies what it lifted; every
// serializer that already parks therefore saves base poses for the new runtime too. The
// first user is the sequencer's property tracks (propPlayback.js).

/** @type {Set<() => (() => void) | null | void>} */
const hooks = new Set();

/** @param {() => (() => void) | null | void} fn @returns {() => void} unregister */
export function registerParkHook(fn) {
	hooks.add(fn);
	return () => hooks.delete(fn);
}

/** Park every registered runtime; the returned function restores them (idempotent). */
export function runParkHooks() {
	/** @type {(() => void)[]} */
	const undo = [];
	for (const fn of hooks) {
		try {
			const u = fn();
			if (typeof u === 'function') undo.push(u);
		} catch (error) {
			console.warn('park hook:', error);
		}
	}
	let done = false;
	return () => {
		if (done) return;
		done = true;
		for (const u of undo.reverse()) u();
	};
}
