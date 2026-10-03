// 34 PF — THE PROFILER'S OUTSIDE SEAMS. A leaf (stores only) so anything can hand the
// Profiler tab something to show without importing the panel: the headset lane's LIVE stream
// (34-profiler-xr), a beacon report someone opened, a moment that was just saved.
//
// THE LIVE SOURCE CONTRACT (for 34-profiler-xr). A producer calls
//   const live = registerLiveSource({ id: 'xr:<peerId>', label: 'Quest (live)' });
//   live.update(doc);   // a whole T1 document, as often as it likes (the panel redraws ≤ 4/s)
//   live.end();         // the stream stopped: the source stays listed (greyed) until removed
//   live.remove();      // gone from the list
// `doc` is any valid T1 document (light or detailed; captures welcome). The panel lists live
// sources above the saved recordings, never writes them to storage on its own, and offers
// "Save a copy" (recorder.saveDocument). Nothing here replicates.
import { writable, get } from 'svelte/store';
import { profilerClose } from '../../stores/appStore';

/**
 * @typedef {{id: string, label: string, doc: import('./tpprof.js').Tpprof | null, live: boolean, updatedAt: number}} LiveSource
 */

/** @type {import('svelte/store').Writable<LiveSource[]>} */
export const liveSources = writable([]);

/**
 * What the panel should show next: a saved recording id, a live source id, or an unsaved
 * document. Write-once (the panel clears it as it acts), the dockModeArm shape.
 * @type {import('svelte/store').Writable<null | {recording?: string, live?: string, doc?: import('./tpprof.js').Tpprof, label?: string}>}
 */
export const profilerRequest = writable(null);

/** @param {{id: string, label?: string}} opts */
export function registerLiveSource(opts) {
	const id = String(opts.id);
	const label = String(opts.label || id).slice(0, 80);
	liveSources.update((list) => [
		...list.filter((s) => s.id !== id),
		{ id, label, doc: null, live: true, updatedAt: Date.now() }
	]);
	const patch = (/** @type {Partial<LiveSource>} */ p) =>
		liveSources.update((list) =>
			list.map((s) => (s.id === id ? { ...s, ...p, updatedAt: Date.now() } : s))
		);
	return {
		id,
		/** @param {import('./tpprof.js').Tpprof} doc */
		update: (doc) => patch({ doc, live: true }),
		end: () => patch({ live: false }),
		remove: () => liveSources.update((list) => list.filter((s) => s.id !== id))
	};
}

/**
 * Open the Profiler tab (docked or floating, whichever it was last) and show something.
 * @param {{recording?: string, live?: string, doc?: import('./tpprof.js').Tpprof, label?: string}} [what]
 */
export async function openProfiler(what) {
	if (what) profilerRequest.set(what);
	const { togglePanel } = await import('../panelToggles');
	if (get(profilerClose)) togglePanel('profiler');
	else {
		const dock = await import('../bottomDock');
		if (get(dock.dockOccupants).profiler?.present) dock.activateDock('profiler');
	}
}
