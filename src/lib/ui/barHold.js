// 42 I5 — HOLD AND DRAG, for the phone bar and the More sheet's items. A press held HOLD_MS
// without travelling HOLD_SLOP asks the owner what the hold means (`onhold` → 'drag' picks the
// item up, 'menu' means the hold opened something, null = nothing); a picked-up item then follows
// the finger (`onmove`) until it is released (`ondrop`) or the gesture is lost (`oncancel`).
// A press that travels first is a scroll or a swipe and is left to the page.
//
// The touch traps this handles (the placeDrag / touchHold precedents):
//   - touch-action is decided at touchstart, before the hold made this a drag, so the browser
//     would take the moving finger as a PAN and end the pointer stream with a pointercancel: a
//     non-passive window `touchmove` is preventDefaulted while an item is held;
//   - the sheet the item sits in pulls on a downward swipe (sheetDrag's body hand-off): the
//     `tp-place-dragging` class tells it a hold claimed this touch;
//   - the browser's own long-press `contextmenu` (Android) belongs to the hold — swallowed in the
//     capture phase so the item's delegated `oncontextmenu` (a mouse right-click / a test's
//     synthetic event: More, Play's menu) never sees it twice;
//   - the click a held press ends with is not a tap — swallowed for a moment after the release.
//
//   use:barHold={{ onhold: (x, y) => 'drag' | 'menu' | null, onmove?, ondrop?, oncancel? }}
import { uiHaptic } from '../uiHaptics';

export const HOLD_MS = 400;
export const HOLD_SLOP = 10;
/** a contextmenu this soon after a touch press belongs to that press */
const TOUCH_WINDOW_MS = 1500;
/** the click a hold ends with arrives right after the release */
const CLICK_AFTER_MS = 450;

/**
 * @typedef {{onhold: (x: number, y: number) => 'drag' | 'menu' | null, onmove?: (x: number, y: number) => void,
 *   ondrop?: (x: number, y: number) => void, oncancel?: () => void}} BarHoldOptions
 */

let swallowUntil = 0;
/** @param {MouseEvent} e */
function swallowClick(e) {
	if (performance.now() < swallowUntil) {
		e.stopPropagation();
		e.preventDefault();
	}
}
let clickGuards = 0;

/** @param {HTMLElement} node @param {BarHoldOptions} options */
export function barHold(node, options) {
	let opts = options;
	let timer = 0;
	let pointerId = -1;
	let x0 = 0;
	let y0 = 0;
	let touchAt = -Infinity;
	/** 'idle' | 'pressing' | 'dragging' */
	let state = 'idle';
	node.style.setProperty('-webkit-touch-callout', 'none');
	node.style.setProperty('-webkit-user-select', 'none');
	node.style.setProperty('user-select', 'none');
	if (clickGuards++ === 0) window.addEventListener('click', swallowClick, true);

	const clearTimer = () => {
		clearTimeout(timer);
		timer = 0;
	};
	const reset = () => {
		clearTimer();
		state = 'idle';
		pointerId = -1;
		window.removeEventListener('pointermove', onMove, true);
		window.removeEventListener('pointerup', onUp, true);
		window.removeEventListener('pointercancel', onCancel, true);
		window.removeEventListener('touchmove', onTouchMove, true);
		document.documentElement.classList.remove('tp-place-dragging');
	};

	/** @param {PointerEvent} e */
	const onDown = (e) => {
		if (state !== 'idle' || (e.pointerType === 'mouse' && e.button !== 0)) return;
		if (e.pointerType !== 'mouse') touchAt = performance.now();
		state = 'pressing';
		pointerId = e.pointerId;
		x0 = e.clientX;
		y0 = e.clientY;
		window.addEventListener('pointermove', onMove, true);
		window.addEventListener('pointerup', onUp, true);
		window.addEventListener('pointercancel', onCancel, true);
		timer = window.setTimeout(onHold, HOLD_MS);
	};
	const onHold = () => {
		timer = 0;
		if (state !== 'pressing') return;
		const meant = opts.onhold(x0, y0);
		if (meant) uiHaptic('select', { kind: 'gestures', touch: true });
		if (meant === 'drag') {
			state = 'dragging';
			window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
			document.documentElement.classList.add('tp-place-dragging');
			opts.onmove?.(x0, y0);
			return;
		}
		// a menu (or nothing): the release that follows is not a tap
		if (meant === 'menu') swallowUntil = Infinity;
		reset();
		if (meant === 'menu') {
			const release = () => {
				swallowUntil = performance.now() + CLICK_AFTER_MS;
				window.removeEventListener('pointerup', release, true);
				window.removeEventListener('pointercancel', release, true);
			};
			window.addEventListener('pointerup', release, true);
			window.addEventListener('pointercancel', release, true);
		}
	};
	/** @param {PointerEvent} e */
	const onMove = (e) => {
		if (e.pointerId !== pointerId) return;
		if (state === 'pressing') {
			if (Math.abs(e.clientX - x0) > HOLD_SLOP || Math.abs(e.clientY - y0) > HOLD_SLOP) reset();
			return;
		}
		if (state === 'dragging') {
			e.preventDefault();
			opts.onmove?.(e.clientX, e.clientY);
		}
	};
	/** @param {PointerEvent} e */
	const onUp = (e) => {
		if (e.pointerId !== pointerId) return;
		const was = state;
		reset();
		if (was !== 'dragging') return;
		e.preventDefault();
		e.stopPropagation();
		swallowUntil = performance.now() + CLICK_AFTER_MS;
		opts.ondrop?.(e.clientX, e.clientY);
	};
	/** @param {PointerEvent} e */
	const onCancel = (e) => {
		if (e.pointerId !== pointerId) return;
		const was = state;
		reset();
		if (was === 'dragging') opts.oncancel?.();
	};
	/** @param {TouchEvent} e */
	const onTouchMove = (e) => {
		if (state === 'dragging' && e.cancelable) e.preventDefault();
	};
	/** @param {Event} e */
	const onContext = (e) => {
		if (performance.now() - touchAt > TOUCH_WINDOW_MS) return; // a mouse right-click / a synthetic one
		e.preventDefault();
		e.stopPropagation();
	};
	/** @param {DragEvent} e */
	const onNativeDrag = (e) => {
		if (performance.now() - touchAt < TOUCH_WINDOW_MS) e.preventDefault();
	};

	node.addEventListener('pointerdown', onDown);
	node.addEventListener('contextmenu', onContext, true);
	node.addEventListener('dragstart', onNativeDrag, true);
	return {
		/** @param {BarHoldOptions} next */
		update(next) {
			opts = next;
		},
		destroy() {
			const was = state;
			reset();
			if (was === 'dragging') opts.oncancel?.();
			node.removeEventListener('pointerdown', onDown);
			node.removeEventListener('contextmenu', onContext, true);
			node.removeEventListener('dragstart', onNativeDrag, true);
			if (--clickGuards === 0) window.removeEventListener('click', swallowClick, true);
		}
	};
}
