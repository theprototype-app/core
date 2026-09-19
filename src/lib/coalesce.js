// R29 S2 — A CHANGE SIGNAL THAT CANNOT RUN PER STORE TICK. Imports NOTHING (a leaf,
// vitest-covered).
//
// `api.flow.onChange` / `api.game.onChange` / `api.peerVars.onChange` exist so a module
// toolbox can stop polling. The trap the plan wrote down: a handler that runs on every
// store tick and then reads the graph is NOT cheaper than polling — one bulk edit is
// dozens of flowGraphs writes, and edits ARRIVING from a peer are one message (one
// task) each, thirty of them inside a few milliseconds. So the seam coalesces to ONE
// FRAME: however many ticks land before the next frame, the handler runs once. A
// microtask was tried first and MEASURED insufficient — it folds a local burst but not
// thirty arriving messages (+30 handler calls for 30 edits). And because a frame never
// comes in a background tab, a timer races it: a module's logic must not stall because
// the window lost focus. Outside a browser (the unit tests) it falls back to a microtask.
//
// Svelte's subscribe also calls back SYNCHRONOUSLY with the current value; that is not
// a change, so it is swallowed. And a flush already queued when the subscriber is torn
// down must not run — a disabled module's handler firing once more is exactly the
// "dead code still acting" shape the teardown journal exists to prevent.

/** the timer that stands in for a frame a hidden tab never paints */
export const FRAME_FALLBACK_MS = 100;

/** run `cb` once, on the next frame or after FRAME_FALLBACK_MS, whichever comes first
 * @param {() => void} cb */
export function nextFrame(cb) {
	if (typeof requestAnimationFrame !== 'function') {
		queueMicrotask(cb);
		return;
	}
	let done = false;
	const run = () => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		cb();
	};
	const timer = setTimeout(run, FRAME_FALLBACK_MS);
	requestAnimationFrame(run);
}

/**
 * Subscribe `fn` to every store in `stores`, coalesced: at most one call per burst.
 * @param {{subscribe: (cb: (v: any) => void) => (() => void)}[]} stores
 * @param {() => void} fn
 * @param {(cb: () => void) => void} [schedule] defaults to `nextFrame`
 * @returns {() => void} unsubscribe
 */
export function coalescedSubscribe(stores, fn, schedule) {
	const later = schedule ?? nextFrame;
	let live = true;
	let queued = false;
	let arming = true;
	const flush = () => {
		queued = false;
		if (!live) return;
		try {
			fn();
		} catch (error) {
			// a module's handler must never take a core store write down with it
			console.warn('[module onChange] handler threw', error);
		}
	};
	const poke = () => {
		if (arming || !live || queued) return;
		queued = true;
		later(flush);
	};
	const offs = stores.map((s) => s.subscribe(poke));
	arming = false;
	return () => {
		live = false;
		for (const off of offs) off();
	};
}
