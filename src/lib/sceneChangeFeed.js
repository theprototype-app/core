// CL-5 continuity (roadmap 37 / R13, lane 37-continuity) — the "the scene changed" feed a cloud
// plugin's room keeper autosaves from (cloudApi `sceneRevision()` / `onSceneChange(fn)`).
//
// ZERO-IMPORT LEAF on purpose: it is handed autosave's `dirtyPulse` (a bare counter bumped on EVERY
// dirty mark — objects, graphs, animation, looks, sky, physics, transport, patch, HUD, game state,
// local or replicated) by cloudPlugin's primed dynamic import, so it carries no edge into the history
// family, and the unit layer can drive it with a stub store.
//
// Two rules:
//   · the subscription is made only when a plugin asks (`onChange`), and dropped by the `off` it
//     returns — with no plugin nothing subscribes, so the OSS build behaves byte-identically;
//   · a listener hears CHANGES, never the store's synchronous first call on subscribe (that call is the
//     current value, not a change), and a throwing listener never breaks the others or the store.

/**
 * @param {() => ({subscribe: (fn: (n: number) => void) => () => void} | null)} source the counter store,
 *   or null before it is primed (then the revision reads 0 and listeners wait for nothing)
 */
export function sceneChangeFeed(source) {
	return {
		/** the current change counter — compare two reads to know whether anything changed between them
		 *  @returns {number} */
		revision() {
			const store = source();
			if (!store) return 0;
			let n = 0;
			store.subscribe((v) => (n = Number(v) || 0))();
			return n;
		},
		/** `fn(revision)` on every change from now on; returns `off`
		 *  @param {(revision: number) => void} fn @returns {() => void} */
		onChange(fn) {
			const store = source();
			if (!store || typeof fn !== 'function') return () => {};
			let first = true;
			const unsub = store.subscribe((v) => {
				if (first) {
					first = false;
					return;
				}
				try {
					fn(Number(v) || 0);
				} catch (e) {
					console.warn('onSceneChange listener threw', e);
				}
			});
			let live = true;
			return () => {
				if (!live) return;
				live = false;
				unsub();
			};
		}
	};
}
