// panel-gestures item 7 (owner, N6 unfolded): "dragging across many sidebar tabs tears a tab off as a
// floating window instead of scrolling; on docked panels a vertical drag moves the tabs like a menu".
//
// ONE TOUCH MODEL FOR EVERY TAB STRIP (sidebar columns, floating groups, the dock), touch and pen only —
// a mouse keeps each strip's own press-drag exactly as it was:
//
//   - the tab says `touch-action: pan-x`, so a sideways swipe is the browser's own scroll (momentum,
//     overscroll) and never a drag;
//   - the first AXIS_PX of travel decide (the axis lock): sideways = the strip scrolls and we stand down;
//     up / down = nothing (pan-x leaves the browser no vertical pan, and we start no drag);
//   - a STILL press of LIFT_MS LIFTS the tab (a haptic tick where the device has one, the `tab-lifted`
//     class): only now does travel move it — `onmove` / `ondrop` with the real pointer events, so each
//     strip keeps its own drop model. After the lift our non-passive `touchmove` cancels the browser's
//     pan, so the tab follows the finger instead of the strip scrolling under it;
//   - lifted and still at MENU_MS, or let go after the lift without moving = the tab's menu (`onmenu`);
//   - TEAR_PX: a strip tears a tab off only when it is dropped that far outside the strip (`outsideBy`).
//
// The slop is re-checked WHEN THE TIMER FIRES, not only on move (98-int's fieldMenu trap: a long-press
// that fired after the finger had already travelled): the gesture keeps the last position it saw.
//
// `createTabGesture` is the pure state machine (unit-tested); `tabTouch` is the Svelte action that wires
// it to a tab:   use:tabTouch={{ onlift?, onmove, ondrop, oncancel?, onmenu }}

export const AXIS_PX = 8;
export const LIFT_MS = 350;
export const MENU_MS = 650;
export const TEAR_PX = 48;
/** a contextmenu / dragstart / click this soon after a touch press belongs to that press */
const TOUCH_WINDOW_MS = 1500;

/** @typedef {'idle'|'pending'|'scroll'|'vertical'|'lifted'|'dragging'|'menu'} TabGesturePhase */

/** Which axis a travel has locked to, or null while it is under the lock distance
 * @param {number} dx @param {number} dy @param {number} [px] @returns {'x'|'y'|null} */
export function axisOf(dx, dy, px = AXIS_PX) {
	if (Math.hypot(dx, dy) < px) return null;
	return Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
}

/** Is a point at least `px` outside a rect (the tear-off distance)?
 * @param {{left: number, top: number, right: number, bottom: number}} rect @param {number} x @param {number} y @param {number} [px] */
export function outsideBy(rect, x, y, px = TEAR_PX) {
	return x < rect.left - px || x > rect.right + px || y < rect.top - px || y > rect.bottom + px;
}

/** the pure gesture: the action feeds it pointer facts and the two timers, it answers what they mean
 * @param {{axisPx?: number}} [opts] */
export function createTabGesture(opts = {}) {
	const axisPx = opts.axisPx ?? AXIS_PX;
	/** @type {TabGesturePhase} */
	let phase = 'idle';
	let id = -1;
	let x0 = 0;
	let y0 = 0;
	let x = 0;
	let y = 0;
	const reset = () => {
		phase = 'idle';
		id = -1;
	};
	return {
		get phase() {
			return phase;
		},
		get origin() {
			return { x: x0, y: y0 };
		},
		/** a touch / pen press on the tab @param {number} pid @param {number} px @param {number} py */
		down(pid, px, py) {
			phase = 'pending';
			id = pid;
			x0 = x = px;
			y0 = y = py;
		},
		/** @param {number} pid @param {number} px @param {number} py
		 * @returns {'ignore'|'wait'|'scroll'|'vertical'|'hold'|'drag-start'|'drag'} */
		move(pid, px, py) {
			if (pid !== id || phase === 'idle') return 'ignore';
			x = px;
			y = py;
			if (phase === 'pending') {
				const axis = axisOf(x - x0, y - y0, axisPx);
				if (!axis) return 'wait';
				phase = axis === 'x' ? 'scroll' : 'vertical';
				return phase;
			}
			if (phase === 'lifted') {
				if (!axisOf(x - x0, y - y0, axisPx)) return 'hold';
				phase = 'dragging';
				return 'drag-start';
			}
			if (phase === 'dragging') return 'drag';
			return 'ignore';
		},
		/** the lift timer fired: lift only a press that is still pending AND still inside the slop */
		lift() {
			if (phase !== 'pending' || axisOf(x - x0, y - y0, axisPx)) return false;
			phase = 'lifted';
			return true;
		},
		/** the menu timer fired: a lifted tab that has not moved opens its menu */
		menuDue() {
			if (phase !== 'lifted') return false;
			phase = 'menu';
			return true;
		},
		/** @param {number} pid @returns {'ignore'|'tap'|'drop'|'menu'|'none'} */
		up(pid) {
			if (pid !== id || phase === 'idle') return 'ignore';
			const was = phase;
			reset();
			if (was === 'pending') return 'tap';
			if (was === 'dragging') return 'drop';
			if (was === 'lifted') return 'menu'; // let go after the lift without moving = the menu
			return 'none';
		},
		/** the browser took the gesture: true when a lifted / dragged tab must put things back */
		cancel() {
			const was = phase;
			reset();
			return was === 'lifted' || was === 'dragging';
		},
		/** does a touchmove now belong to us (cancel the browser's pan)? */
		owns() {
			return phase === 'lifted' || phase === 'dragging' || phase === 'menu';
		}
	};
}

/**
 * @typedef {object} TabTouchOptions
 * @property {(x: number, y: number, e: PointerEvent | null) => void} [onlift] the tab lifted (still, LIFT_MS)
 * @property {(e: PointerEvent) => void} [onmove] a lifted tab moved (every move from the lock on)
 * @property {(e: PointerEvent) => void} [ondrop] a dragged tab was let go
 * @property {() => void} [oncancel] the browser took a lifted / dragged gesture
 * @property {(x: number, y: number) => void} [onmenu] the long-press menu
 * @property {boolean} [disabled]
 */

/** @param {HTMLElement} node @param {TabTouchOptions} [options] */
export function tabTouch(node, options = {}) {
	let opts = options;
	const g = createTabGesture();
	/** @type {ReturnType<typeof setTimeout> | 0} */ let liftTimer = 0;
	/** @type {ReturnType<typeof setTimeout> | 0} */ let menuTimer = 0;
	let touchAt = -Infinity;
	let swallowClick = false;
	node.dataset.tabTouch = '1';
	node.style.setProperty('touch-action', 'pan-x');
	node.style.setProperty('-webkit-touch-callout', 'none');

	const clearTimers = () => {
		if (liftTimer) clearTimeout(liftTimer);
		if (menuTimer) clearTimeout(menuTimer);
		liftTimer = menuTimer = 0;
	};
	const unlift = () => node.classList.remove('tab-lifted');
	const menu = () => {
		const o = g.origin;
		swallowClick = true;
		unlift();
		opts.onmenu?.(o.x, o.y);
	};

	/** @param {PointerEvent} e */
	const down = (e) => {
		if (opts.disabled || e.pointerType === 'mouse' || !e.isPrimary) return;
		touchAt = performance.now();
		swallowClick = false;
		clearTimers();
		g.down(e.pointerId, e.clientX, e.clientY);
		const pid = e.pointerId;
		liftTimer = setTimeout(() => {
			liftTimer = 0;
			if (!g.lift()) return;
			try {
				navigator.vibrate?.(10);
			} catch {}
			try {
				node.setPointerCapture?.(pid);
			} catch {}
			node.classList.add('tab-lifted');
			const o = g.origin;
			opts.onlift?.(o.x, o.y, null);
			menuTimer = setTimeout(() => {
				menuTimer = 0;
				if (g.menuDue()) menu();
			}, Math.max(0, MENU_MS - LIFT_MS));
		}, LIFT_MS);
	};
	/** @param {PointerEvent} e */
	const move = (e) => {
		const r = g.move(e.pointerId, e.clientX, e.clientY);
		if (r === 'scroll' || r === 'vertical') clearTimers();
		else if (r === 'drag-start' || r === 'drag') {
			clearTimers();
			opts.onmove?.(e);
		}
	};
	/** @param {PointerEvent} e */
	const up = (e) => {
		const r = g.up(e.pointerId);
		if (r === 'ignore') return;
		clearTimers();
		unlift();
		if (r === 'drop') {
			swallowClick = true;
			opts.ondrop?.(e);
		} else if (r === 'menu') menu();
		else if (r === 'none') swallowClick = true; // the menu already opened at MENU_MS
	};
	const cancel = () => {
		clearTimers();
		unlift();
		if (g.cancel()) opts.oncancel?.();
	};
	/** @param {TouchEvent} e */
	const touchmove = (e) => {
		if (g.owns() && e.cancelable) e.preventDefault(); // the lifted tab, not the strip, follows the finger
	};
	const fromTouch = () => performance.now() - touchAt < TOUCH_WINDOW_MS;
	/** Android's own long-press `contextmenu` (and a native drag) — ours is the timer @param {Event} e */
	const swallow = (e) => {
		if (!fromTouch()) return;
		e.preventDefault();
		e.stopPropagation();
	};
	/** @param {MouseEvent} e */
	const click = (e) => {
		if (!swallowClick) return;
		swallowClick = false;
		e.preventDefault();
		e.stopImmediatePropagation();
	};

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', cancel);
	node.addEventListener('touchmove', touchmove, { passive: false });
	node.addEventListener('contextmenu', swallow, true);
	node.addEventListener('dragstart', swallow, true);
	node.addEventListener('click', click, true);
	return {
		/** @param {TabTouchOptions} [next] */
		update(next = {}) {
			opts = next;
		},
		destroy() {
			clearTimers();
			if (g.cancel()) opts.oncancel?.();
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', cancel);
			node.removeEventListener('touchmove', touchmove);
			node.removeEventListener('contextmenu', swallow, true);
			node.removeEventListener('dragstart', swallow, true);
			node.removeEventListener('click', click, true);
		}
	};
}
