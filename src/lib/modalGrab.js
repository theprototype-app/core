/**
 * The confirm/cancel half of a drag, shared by the editors that transform a SET of
 * 2D things you selected (the animation timeline's keys; the UV editor's vertices).
 *
 * The animation timeline arrived at this shape the hard way, and every rule in it is
 * paid for:
 *
 *  * SNAPSHOT the selection at gesture start and write ABSOLUTE state from it on
 *    every move. An incremental "add this frame's delta" drifts over a long drag,
 *    and where the mutator compounds (uvEditor's `transformUvCluster` reads the
 *    CURRENT uv values) it multiplies instead of tracking the pointer.
 *  * Anything DERIVED from what the gesture writes must be frozen for its duration
 *    — a rotate pivot read from the moving selection's bounds spirals; the
 *    timeline's pan read a derived span and widened the view as it went.
 *  * A gesture ends exactly once, either kept or REVERTED, and the undo/broadcast
 *    session is opened and closed in the same place, so a cancel cannot leave a
 *    half-written entry behind.
 *
 * A MODAL grab is the same gesture with no button held: the selection follows the
 * pointer until a click or Enter commits it and Escape puts it back. Its listeners
 * are on `window` in CAPTURE phase, because the committing click must not also
 * start the next gesture.
 *
 * The engine owns: the origin, the snapshot, the listeners, and the
 * commit-or-revert contract. The consumer owns all of the MATHS — the hooks get a
 * context and decide what a pointer offset means.
 */

/**
 * @typedef {{
 *   origin: {x: number, y: number},
 *   snapshot: any,
 *   pivot: any,
 *   modal: boolean,
 *   keyboard: boolean,
 *   data: any,
 *   dx: number,
 *   dy: number,
 *   event: any,
 *   touching?: boolean
 * }} GestureContext
 */

/**
 * @param {{
 *   snapshot: () => any,
 *   start?: (ctx: GestureContext) => boolean|void,
 *   apply: (ctx: GestureContext) => void,
 *   revert?: (ctx: GestureContext) => void,
 *   end?: (ctx: GestureContext, kept: boolean) => void,
 *   onActive?: (active: boolean, modal: boolean) => void,
 *   touchDrag?: boolean,
 *   rebase?: (ctx: GestureContext) => void,
 *   passDown?: (e: PointerEvent) => boolean,
 *   key?: (ctx: GestureContext, e: KeyboardEvent) => boolean,
 *   rightCancels?: boolean
 * }} hooks
 *   `snapshot` returns whatever the consumer needs to re-derive absolute state
 *   (falsy, or an empty array, refuses the gesture). `start` opens the undo session
 *   and may set `ctx.pivot` — returning `false` ABORTS (uvEditor's `beginUvDrag`
 *   can legitimately refuse). `apply` writes absolute state from `ctx.snapshot` and
 *   `ctx.dx/dy` (pointer pixels). `revert` puts the snapshot back. `end` closes the
 *   session and drops any frozen view state, kept or not.
 *   44 M4 — `touchDrag`: in a MODAL gesture a touch / pen press grabs (the gesture follows the finger
 *   and commits on the lift) instead of committing; `rebase` folds what is applied so far into
 *   `ctx.snapshot` first, so the drag continues from there. `passDown(e)` true lets a press through
 *   untouched (a Cancel button drawn for the armed gesture).
 *   103 H4 — `key(ctx, e)`: a MODAL gesture's own keys (axis locks, a typed number), offered every
 *   keydown AND keyup before Enter / Escape; true = consumed (the engine stops it). `rightCancels`:
 *   a right-button press cancels instead of committing (Blender's rule), and the browser's trailing
 *   context menu is swallowed.
 */
export function createGesture(hooks) {
	/** @type {GestureContext|null} */
	let ctx = null;

	function attach() {
		if (!ctx || ctx.keyboard) return;
		window.addEventListener('pointermove', onMove);
		if (ctx.modal) {
			// capture, so the click that COMMITS cannot also start a fresh gesture
			window.addEventListener('pointerdown', onModalDown, true);
			window.addEventListener('keydown', onModalKey, true);
			window.addEventListener('keyup', onModalKey, true);
		} else {
			window.addEventListener('pointerup', onUp);
		}
	}
	function detach() {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		window.removeEventListener('pointerdown', onModalDown, true);
		window.removeEventListener('keydown', onModalKey, true);
		window.removeEventListener('keyup', onModalKey, true);
		window.removeEventListener('pointerup', onTouchUp, true);
		window.removeEventListener('pointercancel', onTouchUp, true);
	}

	function onMove(/** @type {PointerEvent} */ e) {
		move(e);
	}
	function onUp() {
		finish(true);
	}
	function onModalDown(/** @type {PointerEvent} */ e) {
		if (!ctx?.modal) return;
		// a control the consumer draws for the armed gesture itself (a touch Cancel) keeps its press
		if (hooks.passDown?.(e)) return;
		e.preventDefault();
		e.stopPropagation();
		// 103 H4: right-click cancels; its trailing contextmenu (on the press on Linux, the release
		// elsewhere) must not open the viewport menu over the object that just went back
		if (hooks.rightCancels && e.button === 2) {
			swallowContextMenu();
			finish(false);
			return;
		}
		// 44 M4: a FINGER has no hover, so "follow the pointer, click to commit" committed on the very
		// first touch, wherever the thing was. With `touchDrag` a touch / pen press GRABS instead: the
		// gesture re-bases on what has been applied so far, follows the finger, and commits on the lift.
		if (hooks.touchDrag && e.pointerType && e.pointerType !== 'mouse') {
			if (ctx.touching) return;
			hooks.rebase?.(ctx);
			ctx.origin = { x: e.clientX, y: e.clientY };
			ctx.dx = 0;
			ctx.dy = 0;
			ctx.touching = true;
			window.addEventListener('pointerup', onTouchUp, true);
			window.addEventListener('pointercancel', onTouchUp, true);
			return;
		}
		finish(true);
	}
	function onTouchUp() {
		// a pointercancel (the browser took the touch) keeps what the finger did so far, like a lift
		finish(true);
	}
	function onModalKey(/** @type {KeyboardEvent} */ e) {
		if (!ctx?.modal) return;
		if (hooks.key?.(ctx, e)) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (e.type !== 'keydown') return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			finish(false);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			finish(true);
		}
	}

	function swallowContextMenu() {
		const swallow = (/** @type {Event} */ ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			window.removeEventListener('contextmenu', swallow, true);
		};
		window.addEventListener('contextmenu', swallow, true);
		setTimeout(() => window.removeEventListener('contextmenu', swallow, true), 1000);
	}

	/**
	 * Open a gesture. `e` may be null for a KEYBOARD gesture (no listeners, the
	 * caller applies once and finishes) — how a nudge becomes one undo entry
	 * through the same path as a drag.
	 * @param {PointerEvent|MouseEvent|null} e
	 * @param {{modal?: boolean, keyboard?: boolean, pivot?: any, data?: any}} [opts]
	 * @returns {boolean} did it open
	 */
	function begin(e, opts = {}) {
		if (ctx) return false;
		const snapshot = hooks.snapshot();
		if (!snapshot || (Array.isArray(snapshot) && !snapshot.length)) return false;
		/** @type {GestureContext} */
		const next = {
			origin: { x: e?.clientX ?? 0, y: e?.clientY ?? 0 },
			snapshot,
			pivot: opts.pivot ?? null,
			modal: !!opts.modal,
			keyboard: !!opts.keyboard || !e,
			data: opts.data ?? null,
			dx: 0,
			dy: 0,
			event: e ?? null
		};
		ctx = next;
		if (hooks.start?.(next) === false) {
			ctx = null;
			return false;
		}
		attach();
		hooks.onActive?.(true, next.modal);
		return true;
	}

	/** the pointer moved: re-apply the TOTAL offset from the snapshot
	 * @param {PointerEvent|MouseEvent} e */
	function move(e) {
		if (!ctx) return;
		ctx.dx = e.clientX - ctx.origin.x;
		ctx.dy = e.clientY - ctx.origin.y;
		ctx.event = e;
		hooks.apply(ctx);
	}

	/** re-apply the same offset — for a mode change mid-gesture (1/2/3 while a
	 *  modal grab is running), which has to re-derive from the snapshot */
	function refresh() {
		if (ctx) hooks.apply(ctx);
	}

	/** @param {boolean} keep commit, or put the snapshot back */
	function finish(keep) {
		const open = ctx;
		if (!open) return false;
		ctx = null;
		detach();
		if (!keep) hooks.revert?.(open);
		hooks.end?.(open, !!keep);
		hooks.onActive?.(false, open.modal);
		return true;
	}

	return {
		begin,
		move,
		refresh,
		finish,
		cancel: () => finish(false),
		active: () => !!ctx,
		isModal: () => !!ctx?.modal,
		ctx: () => ctx
	};
}
