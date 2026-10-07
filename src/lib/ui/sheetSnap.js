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
