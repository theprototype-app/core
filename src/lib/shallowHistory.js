// sk3 — THE SHALLOW HISTORY MARKERS, in one place (play's `{ tpPlay: true }` and the Back stack's
// `{ tpBack: true }`; playMode.js W4 and backStack.js say why they are router SHALLOW entries and not
// raw history.pushState).
//
// SvelteKit 3 changed both things the two callers leaned on:
//   1. `pushState` is deprecated for `goto(url, { shallow: true, state })`, and both are ASYNC — the
//      entry lands after the router resolves the route (a few microtasks), where 2.x pushed it
//      synchronously. A `history.back()` sent before it lands pops the user's REAL previous entry
//      (enter play and leave it in one tick), so every back() here waits for the push in flight.
//   2. The entry's state moved from `history.state['sveltekit:states']` (a plain object) to
//      `history.state['sveltekit:metadata'].state` (a devalue string). `page.state` is the public
//      read, but the router sets it AFTER an await inside its own popstate handler, so a popstate
//      listener reading it sees the entry it just left. The current entry is read here instead,
//      in both shapes.
import { goto } from '$app/navigation';
import { parse } from 'devalue';

/** @type {Promise<boolean> | null} */
let inflight = null;
/** @type {Record<string, any> | null} the state of the push in flight (it is the top entry-to-be) */
let inflightState = null;

/**
 * Push a shallow entry on the CURRENT url ('' resolves to it: no navigation, nothing to load).
 * Serialised behind any push still in flight. Resolves false when the router refused (not started,
 * a sandboxed frame).
 * @param {Record<string, any>} state @returns {Promise<boolean>}
 */
export function pushShallow(state) {
	const prev = inflight ?? Promise.resolve(true);
	const p = prev.then(() =>
		goto('', { shallow: true, state }).then(
			() => true,
			() => false
		)
	);
	inflight = p;
	inflightState = state;
	p.then(() => {
		if (inflight === p) {
			inflight = null;
			inflightState = null;
		}
	});
	return p;
}

/**
 * Run `fn(ok)` once the push in flight (if any) has landed — `ok` false when it was refused, so the
 * caller does not pop an entry that was never pushed. Synchronous when nothing is in flight.
 * @param {(ok: boolean) => void} fn
 */
export function afterShallowPush(fn) {
	if (inflight) inflight.then(fn);
	else fn(true);
}

/** @param {any} st @returns {Record<string, any> | null} */
export function entryState(st) {
	try {
		const meta = st?.['sveltekit:metadata'];
		if (meta && typeof meta.state === 'string') return parse(meta.state) ?? null;
		return st?.['sveltekit:states'] ?? null; // SvelteKit 2
	} catch {
		return null;
	}
}

/**
 * The state object of the CURRENT history entry — or of the push in flight, which is about to be it.
 * @returns {Record<string, any> | null}
 */
export function currentShallowState() {
	if (inflightState) return inflightState;
	try {
		return typeof history === 'undefined' ? null : entryState(history.state);
	} catch {
		return null;
	}
}
