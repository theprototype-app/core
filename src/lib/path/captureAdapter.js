import { writable, get } from 'svelte/store';

// 78 F4 — THE ONE-LINE ADAPTER onto 78-wire's viewport CAPTURE STACK (F5: one push/pop owner for
// spline place, path add, measure, draw, flatten-pick; Esc pops; one banner). Until F5 merges,
// this is a minimal local stand-in with the same shape — `pushCapture({id, label, onExit})`
// returns a pop function, Esc pops the top first — so the Path editor's "Add points" mode is
// written against the stack already. 78-int: replace the body below with a re-export of the F5
// stack's push (the only line that changes); `captureTop` is the banner's store.

/** @typedef {{id: string, label: string, onExit?: () => void}} CaptureEntry */

/** the stack, top last @type {import('svelte/store').Writable<CaptureEntry[]>} */
export const captureTop = writable([]);

/**
 * Push a capture; returns its pop. Pushing an id already on the stack moves it to the top.
 * @param {CaptureEntry} entry @returns {() => void}
 */
export function pushCapture(entry) {
	captureTop.update((list) => [...list.filter((e) => e.id !== entry.id), entry]);
	return () => popCapture(entry.id);
}

/** pop one capture by id (runs its onExit once) @param {string} id */
export function popCapture(id) {
	const list = get(captureTop);
	const entry = list.find((e) => e.id === id);
	if (!entry) return false;
	captureTop.set(list.filter((e) => e.id !== id));
	try {
		entry.onExit?.();
	} catch (error) {
		console.log('capture exit failed', error);
	}
	return true;
}

/** Esc: pop the top capture, if any (true = Esc was used) */
export function popTopCapture() {
	const list = get(captureTop);
	const top = list[list.length - 1];
	return top ? popCapture(top.id) : false;
}

/** is this capture live? @param {string} id */
export function captureActive(id) {
	return get(captureTop).some((e) => e.id === id);
}
