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
//     a flick down from higher up -> the min;
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
		if (dismissible && height <= lo + SNAP_PX) return 'closed';
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
