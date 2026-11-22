// phone-polish item 1 — THE BACK STACK, pure half (no DOM, no router: unit-tested).
//
// A phone has no Escape key, and Android Back used to leave the app from every panel, menu and
// modal (the HONOR touch audit, 2026-11-05: ~45 surfaces, every one "leaves"). Play mode already
// solved this for itself (playMode.js W4: ONE shallow history marker while playing, a popstate
// while it is ours spends it on an exit). This generalises that marker to every closable
// surface:
//   - each open surface REGISTERS a close function; the stack is in opening order, top = last;
//   - while the stack is non-empty there is exactly ONE marker entry in the history;
//   - a Back that pops the marker closes the TOP surface only; if more stay open the marker is
//     pushed again, so the next Back closes the next one, and the Back after the last one is
//     the user's own again (it leaves, as it always did);
//   - a surface closed any other way (its ✕, a tap outside, Escape) takes the marker back off
//     once the stack is empty, so no dead entry is left for the user to press through.
// SUSPENDED while playing and on player-only pages (embed / export / /play / the play origin):
// play keeps its own marker and its own Back, exactly as before. Surfaces opened meanwhile are
// still recorded; the marker follows the stack again when the suspension lifts.
//
// The marker is never trusted from a flag alone: `onTop()` reads the CURRENT history entry, so
// play's marker sitting above ours (a surface open when Play was pressed) is handled — a pop
// that lands on our entry is not a Back past it.

/**
 * @typedef {{ id: string, close: () => void, dead?: boolean }} BackEntry
 * @typedef {{ push: () => boolean, back: () => void, onTop: () => boolean, busy?: () => boolean, defer?: (fn: () => void) => void }} BackHost
 * `busy()`: another marker (play's) is the current entry — its own back() may still be on the
 * way, and an entry pushed now would be the one that back() pops
 */

/** @param {BackHost} host */
export function createBackStack(host) {
	/** @type {BackEntry[]} */
	const stack = [];
	/** our marker entry is in the history (on top, or under play's) */
	let marker = false;
	/** we called back() to spend it and its popstate has not arrived yet */
	let spending = false;
	/** suspension reasons ('play', 'player') */
	const held = new Set();
	let queued = false;
	const defer = host.defer ?? ((fn) => queueMicrotask(fn));

	const live = () => stack.filter((e) => !e.dead);

	function sync() {
		queued = false;
		if (held.size || spending) return;
		const open = live().length > 0;
		if (open && !marker) {
			if (host.busy?.()) return; // its popstate re-runs this
			marker = host.push();
		} else if (!open && marker) {
			// only spend it while it is the top entry — another marker above it (play's) is
			// popped first, and that pop lands here again
			if (!host.onTop()) return;
			marker = false;
			spending = true;
			host.back();
		}
	}
	/** batch: a menu item that closes the menu and opens a dialog in one tick never churns */
	function schedule() {
		if (queued) return;
		queued = true;
		defer(sync);
	}

	return {
		/**
		 * an open surface: returns its release (call on close/unmount; idempotent)
		 * @param {() => void} close @param {string} [id]
		 */
		register(close, id = '') {
			/** @type {BackEntry} */
			const e = { id, close };
			stack.push(e);
			schedule();
			return () => {
				const i = stack.indexOf(e);
				if (i < 0) return;
				stack.splice(i, 1);
				schedule();
			};
		},
		/** the router saw a popstate (any entry) */
		popstate() {
			if (spending) {
				// the pop we caused ourselves
				spending = false;
				schedule();
				return;
			}
			if (held.size) return;
			const top = host.onTop();
			if (marker && !top) {
				// a Back past our marker: close the top surface, and only it
				marker = false;
				this.closeTop();
				schedule();
			} else if (!marker && top && !live().length) {
				// Forward onto a spent marker of ours: give it back at once
				spending = true;
				host.back();
			} else schedule();
		},
		/** close the top surface. It leaves the stack at once, so a surface that refuses to
		 *  close (a permanent dialog) can never trap the user's Back inside the app */
		closeTop() {
			const all = live();
			const e = all[all.length - 1];
			if (!e) return false;
			e.dead = true;
			const i = stack.indexOf(e);
			if (i >= 0) stack.splice(i, 1);
			try {
				e.close();
			} catch {
				/* a closer that throws still leaves the stack */
			}
			return true;
		},
		/** @param {string} reason @param {boolean} on */
		suspend(reason, on) {
			if (on) held.add(reason);
			else if (held.delete(reason)) schedule();
		},
		/** the host's push was refused after it said yes (an async router): no marker after all */
		pushFailed() {
			if (marker && !spending) marker = false;
		},
		/** test/debug view */
		state() {
			return { open: live().map((e) => e.id), marker, spending, suspended: [...held] };
		}
	};
}
