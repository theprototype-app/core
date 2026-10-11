// 38 R3 — where a mobile bottom Sheet comes to rest (SPEC §2 Sheet, §6 mobile).
//
// A sheet has DETENTS (peek / half / full: heights in px for the current viewport) and is
// dragged by its grab handle. On release it goes to the detent the gesture MEANT, which is
// not always the nearest one: a flick carries it one detent in the flick's direction, and a
// drag (or flick) below the lowest detent dismisses it. Pure, imports nothing:
// tests/unit/sheetSnap.test.js.

/** px/ms past which a release counts as a flick (≈ 500 px/s, the platform feel) */
export const FLICK_VELOCITY = 0.5;
/** below this fraction of the LOWEST detent's height a slow release dismisses */
export const DISMISS_FRACTION = 0.5;
/** 41 G5: how far ahead a flick is PROJECTED (ms of travel at the release speed). A flick whose
 *  projection lands under DISMISS_FRACTION of the lowest rest closes the sheet from ANY height —
 *  the projected-target rule of UISheetPresentationController / BottomSheetBehavior's fling-hide;
 *  a gentler flick still steps one detent (or to the min). */
export const PROJECTION_MS = 200;

/**
 * Detent heights for a viewport.
 * @param {number} viewportH window.innerHeight
 * @param {{peek?: number, topInset?: number}} [opts] peek height in px (default 148), the gap
 *   kept above a FULL sheet (default 48, so the app's top bar stays reachable)
 * @returns {{peek: number, half: number, full: number}}
 */
export function detentHeights(viewportH, opts = {}) {
	const full = Math.max(0, viewportH - (opts.topInset ?? 48));
	const half = Math.min(full, Math.round(viewportH * 0.5));
	const peek = Math.min(half, opts.peek ?? 148);
	return { peek, half, full };
}

/**
 * The detent a released drag settles on.
 * @param {{height: number, velocity: number, heights: Record<string, number>, detents: string[], dismissible?: boolean}} g
 *   height = the sheet's height at release; velocity = px/ms, POSITIVE = moving DOWN (shrinking);
 *   detents = the allowed names (any order); dismissible = may it close (default true)
 * @returns {string} a detent name, or 'closed'
 */
export function snapDetent({ height, velocity, heights, detents, dismissible = true }) {
	const order = detents.filter((d) => Number.isFinite(heights[d])).sort((a, b) => heights[a] - heights[b]);
	if (!order.length) return dismissible ? 'closed' : '';
	const lowest = heights[order[0]];
	if (velocity > FLICK_VELOCITY) {
		// a hard flick projects past the bottom: close from wherever it started
		if (dismissible && height - velocity * PROJECTION_MS < lowest * DISMISS_FRACTION) return 'closed';
		// flick DOWN: the first detent below where the finger let go, else close
		const below = [...order].reverse().find((d) => heights[d] < height - 1);
		return below ?? (dismissible ? 'closed' : order[0]);
	}
	if (velocity < -FLICK_VELOCITY) {
		// flick UP: the first detent above, else the top one
		return order.find((d) => heights[d] > height + 1) ?? order[order.length - 1];
	}
	if (dismissible && height < lowest * DISMISS_FRACTION) return 'closed';
	let best = order[0];
	for (const d of order) if (Math.abs(heights[d] - height) < Math.abs(heights[best] - height)) best = d;
	return best;
}

/**
 * The next detent up (+1) or down (-1) from `current` — the keyboard / handle-tap path.
 * Down from the lowest closes when dismissible; up from the top stays.
 * @param {string} current @param {1|-1} dir @param {string[]} detents @param {Record<string, number>} heights
 * @param {boolean} [dismissible]
 * @returns {string}
 */
export function stepDetent(current, dir, detents, heights, dismissible = true) {
	const order = detents.filter((d) => Number.isFinite(heights[d])).sort((a, b) => heights[a] - heights[b]);
	const i = order.indexOf(current);
	if (i < 0) return order[0] ?? current;
	if (dir > 0) return order[Math.min(order.length - 1, i + 1)];
	if (i === 0) return dismissible ? 'closed' : current;
	return order[i - 1];
}

// ---- 40 F1: FREE-HEIGHT sheets (the phone's drawers) --------------------------------------
// Most phone drawers are not three-detent sheets: the Inspector, the main menu, the Add list,
// the dock rest wherever the finger leaves them (the height is remembered), between a MIN and
// a MAX. What every one of them shares is where a release ENDS:
//   - dragged down "to the end" (under DISMISS_FRACTION of the min) -> closed;
//   - a flick DOWN that starts at or near the min -> closed (the swipe-away gesture);
//     a flick down from higher up -> the min, unless it is hard enough that its PROJECTION
//     (41 G5, PROJECTION_MS) lands past the bottom -> closed;
//   - a flick UP -> the max;
//   - a slow release -> stays where it is, clamped to [min, max], and SNAPS to min / max
//     when it lands within SNAP_PX of either (so "all the way up" is reachable by feel).

/** px within which a slow release snaps onto the min or the max */
export const SNAP_PX = 32;

/**
 * Where a released free-height sheet comes to rest.
 * @param {{height: number, velocity: number, min: number, max: number, dismissible?: boolean}} g
 *   height = the sheet's height at release (px); velocity = px/ms, POSITIVE = moving DOWN
 * @returns {number|'closed'} the resting height, or 'closed'
 */
export function settleSheet({ height, velocity, min, max, dismissible = true }) {
	const lo = Math.max(0, Math.min(min, max));
	const hi = Math.max(lo, max);
	if (velocity > FLICK_VELOCITY) {
		if (dismissible && (height <= lo + SNAP_PX || height - velocity * PROJECTION_MS < lo * DISMISS_FRACTION)) return 'closed';
		return lo;
	}
	if (velocity < -FLICK_VELOCITY) return hi;
	if (dismissible && height < lo * DISMISS_FRACTION) return 'closed';
	const h = Math.min(hi, Math.max(lo, height));
	if (hi - h <= SNAP_PX) return hi;
	if (h - lo <= SNAP_PX) return lo;
	return Math.round(h);
}

/**
 * The room a phone sheet may take: everything between the top bar and the bottom bar, less
 * the selection strip while one rides on top of the sheet (NOTES-38 #32 b) — so a sheet at its
 * max never pushes the strip under the top bar or covers Play (40 F1, cover-play-and-handle).
 * @param {number} viewportH window.innerHeight
 * @param {{barH?: number, topH?: number, stripH?: number}} [o] bottom bar, top bar (logo /
 *   chip / avatar row), and the strip's height + gap (0 = nothing selected)
 */
export function phoneSheetMax(viewportH, o = {}) {
	return Math.max(160, Math.round(viewportH - (o.barH ?? 76) - (o.topH ?? 64) - (o.stripH ?? 0)));
}

// ---- 41 G5: the platform feel (UISheetPresentationController / Material bottom sheets) -------
// Three pure pieces the gesture ($lib/ui/sheetDrag.js) is built from:
//   rubberBand      past a limit the sheet follows the finger with RESISTANCE (iOS's
//                   UIScrollView constant 0.55), and springs back on release;
//   releaseVelocity the flick speed from the last ~100 ms of samples only, so a drag that
//                   paused before letting go is a slow release, not a flick;
//   handoffMode     the NESTED-SCROLL HAND-OFF, decided ONCE per gesture on its first real
//                   move: a list scrolls; at the list's top a downward drag moves the sheet;
//                   a gesture that began as a scroll stays a scroll to its end (no accidental
//                   close when scrolling up and then back down in one gesture).

/** iOS's rubber-band constant */
export const RUBBER_COEFF = 0.55;
/** the window a release velocity is measured over (ms) */
export const VELOCITY_WINDOW_MS = 100;

/**
 * The height shown for a raw finger height, with resistance outside [lo, hi].
 * @param {number} h raw height (start height minus finger travel)
 * @param {number} lo below this the sheet resists (pass 0 for a dismissible sheet: down is the way out)
 * @param {number} hi above this the sheet resists (its max)
 * @param {number} [dim] the dimension the resistance is scaled by (default 600 px)
 */
export function rubberBand(h, lo, hi, dim = 600) {
	const over = (/** @type {number} */ x) => (1 - 1 / ((x * RUBBER_COEFF) / dim + 1)) * dim;
	if (h > hi) return hi + over(h - hi);
	if (h < lo) return Math.max(0, lo - over(lo - h));
	return h;
}

/**
 * Release velocity in px/ms (POSITIVE = finger moving DOWN) from [timeStamp, y] samples,
 * using only those inside the last VELOCITY_WINDOW_MS before `now`.
 * @param {[number, number][]} samples oldest first
 * @param {number} now the release time stamp
 */
export function releaseVelocity(samples, now) {
	if (samples.length < 2) return 0;
	const recent = samples.filter(([t]) => now - t <= VELOCITY_WINDOW_MS);
	// the finger stopped before it lifted: nothing recent moved
	if (recent.length < 2) return 0;
	const [t0, y0] = recent[0];
	const [t1, y1] = recent[recent.length - 1];
	return (y1 - y0) / Math.max(8, t1 - t0);
}

/**
 * Who owns a touch that started inside a sheet's body, decided on its first move past the slop.
 * @param {{dx: number, dy: number, scrollTop: number|null, cancelable?: boolean}} g
 *   dx/dy = travel so far (dy POSITIVE = finger moving down); scrollTop = the vertical scroller
 *   under the finger (null = nothing there scrolls); cancelable = the browser still lets us
 *   take the gesture (false once it has started scrolling)
 * @returns {'sheet'|'scroll'|'ignore'}
 */
export function handoffMode({ dx, dy, scrollTop, cancelable = true }) {
	if (Math.abs(dx) > Math.abs(dy)) return 'ignore'; // a sideways strip / slider owns it
	if (!cancelable) return 'scroll';
	if (scrollTop === null) return 'sheet'; // nothing scrolls: the body IS the sheet
	if (dy > 0 && scrollTop <= 0) return 'sheet'; // pulled down at the top of the list
	return 'scroll';
}
