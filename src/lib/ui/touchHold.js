// 40 F3 — A LONG PRESS ON AN EXPLORER ITEM OPENS ITS MENU (the phone action sheet: every
// ContextMenu is a bottom sheet on the phone), and never the browser's own long-press
// behaviour. On Android a long press on a `draggable` card started a NATIVE drag (the ghost
// with the file name the user screenshotted: long-press-explorer-file), and on an <img> the
// browser offers its image callout. So, for TOUCH only (a mouse keeps right-click and HTML5
// drag exactly as they were):
//   - a hold of HOLD_MS that has not travelled HOLD_SLOP calls `onhold(x, y)`;
//   - the browser's own `contextmenu` for that touch is swallowed (the hold already opened ours,
//     and it would open it twice) — a DIRECT capture listener, so the item's delegated
//     `oncontextmenu` never sees it;
//   - a native `dragstart` from a touch is cancelled (the Explorer's own touch pick-up is the
//     drag on a phone);
//   - `-webkit-touch-callout: none` is set on the node (scoped to Explorer items, not the app).
//
//   use:touchHold={{ onhold?: (x, y) => void }}   (no onhold = only the suppression)

export const HOLD_MS = 450;
export const HOLD_SLOP = 10;
/** a contextmenu/dragstart this soon after a touch press belongs to that press */
const TOUCH_WINDOW_MS = 1500;

/** @param {HTMLElement} node @param {{onhold?: (x: number, y: number) => void}} [options] */
export function touchHold(node, options = {}) {
	let opts = options;
	let timer = 0;
	let x0 = 0;
	let y0 = 0;
	let touchAt = -Infinity;
	node.dataset.touchHold = '1'; // the marker (Chromium drops -webkit-touch-callout; iOS honours it)
	node.style.setProperty('-webkit-touch-callout', 'none');
	node.style.setProperty('-webkit-user-select', 'none');
	node.style.setProperty('user-select', 'none');

	const cancel = () => {
		clearTimeout(timer);
		timer = 0;
	};
	/** @param {PointerEvent} e */
	const down = (e) => {
		if (e.pointerType === 'mouse') return;
		touchAt = performance.now();
		x0 = e.clientX;
		y0 = e.clientY;
		cancel();
		if (!opts.onhold) return;
		timer = window.setTimeout(() => {
			timer = 0;
			try {
				navigator.vibrate?.(12);
			} catch {}
			opts.onhold?.(x0, y0);
		}, HOLD_MS);
	};
	/** @param {PointerEvent} e */
	const move = (e) => {
		if (timer && (Math.abs(e.clientX - x0) > HOLD_SLOP || Math.abs(e.clientY - y0) > HOLD_SLOP)) cancel();
	};
	const fromTouch = () => performance.now() - touchAt < TOUCH_WINDOW_MS;
	/** @param {Event} e */
	const swallow = (e) => {
		if (!fromTouch()) return;
		e.preventDefault();
		e.stopPropagation();
	};
	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', cancel);
	node.addEventListener('pointercancel', cancel);
	node.addEventListener('contextmenu', swallow, true);
	node.addEventListener('dragstart', swallow, true);
	return {
		/** @param {{onhold?: (x: number, y: number) => void}} [next] */
		update(next = {}) {
			opts = next;
		},
		destroy() {
			cancel();
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', cancel);
			node.removeEventListener('pointercancel', cancel);
			node.removeEventListener('contextmenu', swallow, true);
			node.removeEventListener('dragstart', swallow, true);
		}
	};
}

/** a synthetic event for a menu opener that reads clientX/Y and calls preventDefault/stopPropagation */
export function holdEvent(/** @type {number} */ x, /** @type {number} */ y) {
	return /** @type {any} */ ({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {}, target: null, currentTarget: null });
}
