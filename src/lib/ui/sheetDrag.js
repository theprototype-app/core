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
//     surfaces?: () => Element[]     41 G5: the sheet's BODY (see below); omit = grab bar only
//   }}
//
// POINTER events (touch arrives as pointerType "touch"), DIRECT listeners (svelte delegates
// `onpointerdown` to the root and panel chrome swallows it on the way up — the repo rule for a
// gesture inside a panel), pointer capture so the finger may leave the bar. A press that starts
// on a control INSIDE the grab zone (a close button, a title field) belongs to that control.
// The grab bar needs `touch-action: none` or the browser scrolls the page instead.
//
// 41 G5 — THE BODY DRAGS TOO (the nested-scroll hand-off of UISheetPresentationController /
// Material's BottomSheetBehavior). With `surfaces`, a TOUCH anywhere on the sheet's body is
// watched, and on its first move past the slop ONE owner is chosen for the whole gesture
// (`handoffMode` in sheetSnap.js):
//   - the list under the finger scrolls normally;
//   - at the list's top (scrollTop 0) a DOWNWARD drag moves the sheet instead (overscroll at
//     the top drags the sheet); a body with nothing to scroll is the sheet in both directions;
//   - a gesture that began as a scroll stays a scroll to its end — scrolling up and then back
//     down in one gesture never pulls the sheet (no accidental close);
//   - while the sheet is being pulled, moving back up past where it started HANDS BACK: the
//     sheet stops at its starting height and the list scrolls by the rest (iOS's behaviour);
//   - a sideways move (a strip, a slider) is left alone, and so is anything that declares it
//     owns vertical touches (`touch-action` without pan-y — a canvas, a DragRow, a node graph,
//     the Explorer's touch pick-up), a range input, `[data-sheet-nodrag]`, and the grab bar
//     itself (it has its own pointer path);
//   - past a limit the sheet follows with RESISTANCE (rubber band) and springs back;
//   - the release settles exactly like a grab-bar release (flick velocity closes, snap points);
//   - the click a dragged touch would end with is swallowed (no row opens under a swipe).
// TOUCH events, not pointer events: once the browser starts a native scroll it cancels the
// pointer stream, while a non-passive `touchmove` we preventDefault on the FIRST move keeps
// the gesture ours. Listeners sit on `window` in the CAPTURE phase so a list that stops
// propagation cannot hide a gesture from its sheet, and the surfaces are asked at touchstart
// (a reused window placed into a frame, a dock panel that changes with the tab).
import { settleSheet, rubberBand, releaseVelocity, handoffMode } from './sheetSnap.js';
import { safeStorage } from '../safeStorage';

/** px of travel before a press becomes a drag */
export const DRAG_SLOP = 6;
/** a click that a drag ends with is not a tap (the click fires after pointerup) */
const CLICK_AFTER_DRAG_MS = 350;
/** keyboard step for ArrowUp / ArrowDown on a free-height sheet */
const KEY_STEP = 64;

const INTERACTIVE = 'input, textarea, select, a[href], [contenteditable=""], [contenteditable="true"], button:not([data-sheet-grip])';
/** never a sheet drag from the body: these own the touch themselves */
const BODY_EXCLUDE = 'input[type=range], textarea, select, [contenteditable=""], [contenteditable="true"], canvas, .svelte-flow, [data-sheet-nodrag], [data-sheet-drag]';

/**
 * @typedef {{height: () => number, min: () => number, max: () => number, dismissible?: boolean, keys?: boolean,
 *   onmove?: (h: number) => void, onsettle?: (h: number) => void, onclose?: () => void, ontap?: () => void,
 *   settle?: (g: {height: number, velocity: number, min: number, max: number, dismissible: boolean}) => number|'closed',
 *   surfaces?: () => (Element|null|undefined)[]}} SheetDragOptions
 */

/** the live height for a finger height: resistance past the max, and below the min when the
 *  sheet may not close (a dismissible sheet goes down freely — that is the way out)
 * @param {SheetDragOptions} o @param {number} raw */
function liveHeight(o, raw) {
	const lo = o.dismissible === false ? o.min() : 0;
	return rubberBand(raw, lo, o.max());
}

/** where a release rests, through the owner's rule @param {SheetDragOptions} o @param {number} height @param {number} velocity */
function releaseSheet(o, height, velocity) {
	const shown = Math.max(0, Math.min(o.max(), height));
	const g = { height: shown, velocity, min: o.min(), max: o.max(), dismissible: o.dismissible !== false };
	const at = (o.settle ?? settleSheet)(g);
	if (at === 'closed') o.onclose?.();
	else o.onsettle?.(at);
}

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
	node.dataset.sheetDrag = '1'; // the body hand-off leaves a grab bar to this path

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
		if (samples.length > 12) samples.shift();
		opts.onmove?.(liveHeight(opts, startH - dy));
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
		samples.push([e.timeStamp, e.clientY]);
		const velocity = e.type === 'pointercancel' ? 0 : releaseVelocity(samples, e.timeStamp);
		samples = [];
		draggedAt = performance.now();
		releaseSheet(opts, startH - (e.clientY - startY), velocity);
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
		if (e.key === 'ArrowUp') releaseSheet(opts, Math.min(opts.max(), h + KEY_STEP), 0);
		else if (h <= opts.min() + 1) releaseSheet(opts, 0, 0); // already at the min: down closes
		else releaseSheet(opts, Math.max(opts.min(), h - KEY_STEP), 0);
	};

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', up);
	node.addEventListener('click', click, true);
	node.addEventListener('keydown', key);
	const body = sheetHandoff(() => opts);
	return {
		/** @param {SheetDragOptions} next */
		update(next) {
			opts = next;
		},
		destroy() {
			delete node.dataset.sheetDrag;
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', up);
			node.removeEventListener('click', click, true);
			node.removeEventListener('keydown', key);
			body();
		}
	};
}

// ---- 41 G5: the body hand-off ------------------------------------------------------------

/** does this element declare it owns vertical touches? @param {Element} el */
function ownsVertical(el) {
	const ta = getComputedStyle(el).touchAction;
	return !!ta && ta !== 'auto' && !/pan-y|pan-down|manipulation/.test(ta);
}

/** the first vertical scroller between `target` and `surface` (inclusive) that can scroll, or
 *  null; 'excluded' when something on the way owns the touch @param {Element} target @param {Element} surface
 * @returns {Element|null|'excluded'} */
export function bodyScroller(target, surface) {
	if (target.closest?.(BODY_EXCLUDE)) return 'excluded';
	/** @type {Element|null} */
	let el = target;
	/** @type {Element|null} */
	let found = null;
	while (el) {
		if (el !== surface && ownsVertical(el)) return 'excluded';
		if (!found && el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 1) {
			const oy = getComputedStyle(el).overflowY;
			if (oy === 'auto' || oy === 'scroll') found = el;
		}
		if (el === surface) break;
		el = el.parentElement;
	}
	return found;
}

/**
 * Watch the BODY of a sheet for the nested-scroll hand-off (see the header). Returns the
 * teardown. Inert until `get().surfaces` names an element the touch started in.
 * @param {() => SheetDragOptions} get
 */
export function sheetHandoff(get) {
	if (typeof window === 'undefined') return () => {};
	/** 'pending' | 'sheet' | 'off' @type {string} */
	let mode = 'off';
	let id = -1;
	let x0 = 0;
	let y0 = 0;
	let originY = 0;
	let startH = 0;
	/** @type {Element|null} */
	let scroller = null;
	let handBack = false;
	let shownH = 0;
	let draggedAt = -Infinity;
	/** [time, height] — the SHEET's travel, so a hand-back to the list is not a flick @type {[number, number][]} */
	let samples = [];

	/** @param {TouchEvent} e */
	const start = (e) => {
		if (e.touches.length !== 1) {
			if (mode === 'sheet') finish(e.timeStamp, true);
			mode = 'off';
			return;
		}
		const o = get();
		const list = o.surfaces?.() ?? [];
		const t = /** @type {Element} */ (e.target);
		const surface = list.find((s) => s && s.isConnected && s.contains(t));
		if (!surface) return;
		const sc = bodyScroller(t, surface);
		if (sc === 'excluded') return;
		const p = e.touches[0];
		mode = 'pending';
		id = p.identifier;
		x0 = p.clientX;
		y0 = p.clientY;
		scroller = sc;
		handBack = false;
		samples = [];
	};
	/** @param {TouchEvent} e */
	const move = (e) => {
		if (mode === 'off') return;
		const p = [...e.changedTouches].find((q) => q.identifier === id);
		if (!p) return;
		const o = get();
		if (mode === 'pending') {
			const dx = p.clientX - x0;
			const dy = p.clientY - y0;
			if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_SLOP) return;
			const who = handoffMode({ dx, dy, scrollTop: scroller ? scroller.scrollTop : null, cancelable: e.cancelable });
			if (who !== 'sheet') {
				mode = 'off';
				return;
			}
			mode = 'sheet';
			// the sheet starts from where the finger IS, so it does not jump by the slop
			originY = p.clientY;
			startH = o.height();
			shownH = startH;
			samples = [[e.timeStamp, startH]];
		}
		e.preventDefault();
		const raw = startH - (p.clientY - originY);
		if (scroller && raw > startH) {
			// pulled back up past the start: the sheet rests at its start and the list takes the rest
			handBack = true;
			shownH = startH;
			scroller.scrollTop = raw - startH;
		} else {
			if (handBack && scroller) scroller.scrollTop = 0;
			handBack = false;
			shownH = liveHeight(o, raw);
		}
		samples.push([e.timeStamp, shownH]);
		if (samples.length > 12) samples.shift();
		o.onmove?.(shownH);
	};
	/** @param {number} at @param {boolean} [cancelled] */
	const finish = (at, cancelled = false) => {
		mode = 'off';
		draggedAt = performance.now();
		const o = get();
		// the height's own velocity, sign flipped to the finger's convention (down = positive)
		const v = cancelled || handBack ? 0 : -releaseVelocity(samples, at);
		samples = [];
		releaseSheet(o, shownH, v);
	};
	/** @param {TouchEvent} e */
	const end = (e) => {
		if (mode === 'off') return;
		if (![...e.changedTouches].some((q) => q.identifier === id)) return;
		if (mode === 'pending') {
			mode = 'off';
			return;
		}
		finish(e.timeStamp, e.type === 'touchcancel');
	};
	/** a dragged touch's click never opens the row under it @param {MouseEvent} e */
	const click = (e) => {
		if (performance.now() - draggedAt < CLICK_AFTER_DRAG_MS) {
			e.stopPropagation();
			e.preventDefault();
		}
	};
	window.addEventListener('touchstart', start, { capture: true, passive: true });
	window.addEventListener('touchmove', move, { capture: true, passive: false });
	window.addEventListener('touchend', end, { capture: true });
	window.addEventListener('touchcancel', end, { capture: true });
	window.addEventListener('click', click, true);
	return () => {
		window.removeEventListener('touchstart', start, true);
		window.removeEventListener('touchmove', move, true);
		window.removeEventListener('touchend', end, true);
		window.removeEventListener('touchcancel', end, true);
		window.removeEventListener('click', click, true);
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
