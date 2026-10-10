// 40 F1 — THE ONE SHEET GESTURE. Every phone drawer (the shell's framed sheets, ui/Sheet, the
// Inspector / Configure Scene, the main menu, the profile menu, the Add list, the notes sheet,
// the toolboxes, the dock) is dragged by its grab bar through THIS action, so they all resize
// the same way and all close the same way: swipe down to the end (or flick down from the min).
// Where a release rests is the pure rule in sheetSnap.js (`settleSheet` for a free-height
// sheet; a detent sheet passes its own `settle`).
//
//   use:sheetDrag={{
//     height: () => number,          the sheet's height NOW (read at the press)
//     min: () => number, max: () => number,
//     dismissible?: boolean,         default true
//     onmove: (h) => void,           live height while the finger drags
//     onsettle: (h) => void,         the resting height after a release / key
//     onclose: () => void,           a release that dismisses
//     ontap?: () => void,            a press that did not travel (the grip's own click)
//     settle?: (g) => number|'closed' replaces settleSheet (detent sheets)
//     keys?: boolean                 false = the owner handles ArrowUp/ArrowDown itself
//   }}
//
// POINTER events (touch arrives as pointerType "touch"), DIRECT listeners (svelte delegates
// `onpointerdown` to the root and panel chrome swallows it on the way up — the repo rule for a
// gesture inside a panel), pointer capture so the finger may leave the bar. A press that starts
// on a control INSIDE the grab zone (a close button, a title field) belongs to that control.
// The grab bar needs `touch-action: none` or the browser scrolls the page instead.
import { settleSheet } from './sheetSnap.js';
import { safeStorage } from '../safeStorage';

/** px of travel before a press becomes a drag */
export const DRAG_SLOP = 6;
/** a click that a drag ends with is not a tap (the click fires after pointerup) */
const CLICK_AFTER_DRAG_MS = 350;
/** keyboard step for ArrowUp / ArrowDown on a free-height sheet */
const KEY_STEP = 64;

const INTERACTIVE = 'input, textarea, select, a[href], [contenteditable=""], [contenteditable="true"], button:not([data-sheet-grip])';

/**
 * @typedef {{height: () => number, min: () => number, max: () => number, dismissible?: boolean, keys?: boolean,
 *   onmove?: (h: number) => void, onsettle?: (h: number) => void, onclose?: () => void, ontap?: () => void,
 *   settle?: (g: {height: number, velocity: number, min: number, max: number, dismissible: boolean}) => number|'closed'}} SheetDragOptions
 */

/** @param {HTMLElement} node @param {SheetDragOptions} options */
export function sheetDrag(node, options) {
	let opts = options;
	let startY = 0;
	let startH = 0;
	let moved = false;
	let draggedAt = -Infinity;
	let pointerId = -1;
	/** recent [time, y] samples for the release velocity @type {[number, number][]} */
	let samples = [];

	const clampLive = (/** @type {number} */ h) => Math.max(0, Math.min(opts.max(), h));
	/** @param {number} height @param {number} velocity */
	function release(height, velocity) {
		const g = { height, velocity, min: opts.min(), max: opts.max(), dismissible: opts.dismissible !== false };
		const at = (opts.settle ?? settleSheet)(g);
		if (at === 'closed') opts.onclose?.();
		else opts.onsettle?.(at);
	}

	/** @param {PointerEvent} e */
	const down = (e) => {
		if (e.button !== 0 || pointerId !== -1) return;
		const t = /** @type {HTMLElement} */ (e.target);
		if (t !== node && t.closest?.(INTERACTIVE) && node.contains(t.closest(INTERACTIVE))) return;
		pointerId = e.pointerId;
		startY = e.clientY;
		startH = opts.height();
		moved = false;
		samples = [[e.timeStamp, e.clientY]];
		try {
			node.setPointerCapture?.(e.pointerId);
		} catch {}
	};
	/** @param {PointerEvent} e */
	const move = (e) => {
		if (e.pointerId !== pointerId) return;
		const dy = e.clientY - startY;
		if (!moved && Math.abs(dy) < DRAG_SLOP) return;
		moved = true;
		samples.push([e.timeStamp, e.clientY]);
		if (samples.length > 6) samples.shift();
		opts.onmove?.(clampLive(startH - dy));
		e.preventDefault();
	};
	/** @param {PointerEvent} e */
	const up = (e) => {
		if (e.pointerId !== pointerId) return;
		pointerId = -1;
		try {
			node.releasePointerCapture?.(e.pointerId);
		} catch {}
		if (!moved) return; // a tap: the grip's own click handles it
		const first = samples[0];
		samples = [];
		const velocity = e.type === 'pointercancel' ? 0 : (e.clientY - first[1]) / Math.max(1, e.timeStamp - first[0]);
		draggedAt = performance.now();
		release(clampLive(startH - (e.clientY - startY)), velocity);
	};
	/** @param {MouseEvent} e */
	const click = (e) => {
		if (performance.now() - draggedAt < CLICK_AFTER_DRAG_MS) {
			e.stopPropagation();
			e.preventDefault();
			return;
		}
		const t = /** @type {HTMLElement} */ (e.target);
		if (t !== node && t.closest?.(INTERACTIVE) && node.contains(t.closest(INTERACTIVE)) && !t.closest('[data-sheet-grip]')) return;
		opts.ontap?.();
	};
	/** @param {KeyboardEvent} e */
	const key = (e) => {
		if (opts.keys === false || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
		const t = /** @type {HTMLElement} */ (e.target);
		if (t !== node && !t.closest?.('[data-sheet-grip]')) return;
		e.preventDefault();
		const h = opts.height();
		if (e.key === 'ArrowUp') release(Math.min(opts.max(), h + KEY_STEP), 0);
		else if (h <= opts.min() + 1) release(0, 0); // already at the min: down closes
		else release(Math.max(opts.min(), h - KEY_STEP), 0);
	};

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', up);
	node.addEventListener('click', click, true);
	node.addEventListener('keydown', key);
	return {
		/** @param {SheetDragOptions} next */
		update(next) {
			opts = next;
		},
		destroy() {
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', up);
			node.removeEventListener('click', click, true);
			node.removeEventListener('keydown', key);
		}
	};
}

// ---- remembered heights -------------------------------------------------------------------
// Each sheet keeps the storage key it always had (inspectorSheetH, notesSheetH, tbxSheetH:<key>,
// flowDockHeight …: the behaviour lock), so this only centralises the read/clamp/write.

/** @param {string} key @param {number} fallback @returns {number} */
export function readSheetH(key, fallback) {
	try {
		const v = parseInt(safeStorage.getItem(key) || '');
		return Number.isFinite(v) && v > 0 ? v : fallback;
	} catch {
		return fallback;
	}
}
/** @param {string} key @param {number} h */
export function saveSheetH(key, h) {
	try {
		safeStorage.setItem(key, String(Math.round(h)));
	} catch {
		// private mode: remembered for this session only
	}
}
