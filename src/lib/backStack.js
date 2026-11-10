// phone-polish item 1 — the Back stack, wired to the browser (the rules are backStackCore.js).
//
// The marker is a SvelteKit SHALLOW entry, for the reason playMode.js W4 gives: the router
// patches a raw history.pushState with a warning, and its popstate handler treats a shallow
// entry's Back as a state change, never a navigation. Its state object is `{ tpBack: true }`
// (play's marker is `{ tpPlay: true }`); shallowHistory.js pushes both and reads the current
// entry in SvelteKit 3's shape (sk3: the push is async there — back() waits for it).
//
// Surfaces join through:
//   - WindowChrome — every window, panel and modal with a close button (one line covers ~25);
//   - `use:backClose={fn}` — any other surface (menus, popovers, the sidebar, the palette):
//     the element exists only while the surface is open, so mount = open and destroy = closed.
// Suspended by playMode (playing, and player-only pages — they keep play's own Back).
import { afterShallowPush, currentShallowState, pushShallow } from './shallowHistory.js';
import { createBackStack } from './backStackCore.js';

export const backStack = createBackStack({
	push() {
		if (typeof history === 'undefined') return false;
		// optimistic: the entry lands a few microtasks later; a refusal (before the router has
		// started, a sandboxed frame) hands the marker back, and the surface simply keeps its
		// other ways out
		pushShallow({ tpBack: true }).then((ok) => {
			if (!ok) backStack.pushFailed();
		});
		return true;
	},
	back() {
		afterShallowPush((ok) => {
			if (!ok) return;
			try {
				history.back();
			} catch {
				/* nothing to go back to */
			}
		});
	},
	onTop: () => !!currentShallowState()?.tpBack,
	busy: () => !!currentShallowState()?.tpPlay
});

if (typeof window !== 'undefined') {
	window.addEventListener('popstate', () => backStack.popstate());
}

/**
 * Register an open surface with the Back stack. Returns the release.
 * @param {() => void} close @param {string} [id]
 */
export function registerBack(close, id) {
	return backStack.register(close, id);
}

/** @param {HTMLElement} node */
const backId = (node) => (node.id || node.getAttribute('aria-label') || node.tagName.toLowerCase()).slice(0, 40);

/**
 * Svelte action: `<div use:backClose={() => (open = false)}>` on an element that exists only
 * while its surface is open. A null/undefined param registers nothing.
 * @param {HTMLElement} node @param {(() => void) | null | undefined} close
 */
export function backClose(node, close) {
	let fn = close;
	/** @type {(() => void) | null} */
	let release = fn ? registerBack(() => fn?.(), backId(node)) : null;
	return {
		/** @param {(() => void) | null | undefined} next */
		update(next) {
			// a new closer is a new page of the surface (the welcome card's sub-views): it
			// re-joins the stack, because Back may have spent the previous entry
			if (next === fn) return;
			fn = next;
			release?.();
			release = fn ? registerBack(() => fn?.(), backId(node)) : null;
		},
		destroy() {
			release?.();
			release = null;
		}
	};
}

/** suspend the stack while `reason` holds (playMode: 'play', 'player') @param {string} reason @param {boolean} on */
export function suspendBack(reason, on) {
	backStack.suspend(reason, on);
}

/** test/debug view: {open, marker, spending, suspended} + whether the marker is the top entry */
export function backStackState() {
	return { ...backStack.state(), onTop: !!currentShallowState()?.tpBack };
}
