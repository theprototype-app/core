// 18-B: one sizing rule for every floating window.
//
// The bug this exists for: a window could be resized (or restored from a saved
// size) LARGER than the screen. The bottom-right grip then sits off-screen, and
// since that grip is the only way to resize, the window can never be brought
// back — the user is stuck with a window they cannot shrink.
//
// Two different clamps, because they answer different questions:
//  - `clampWinSize`  — "does this size fit the screen at all?"  Used on LOAD and
//    whenever the viewport shrinks. Deliberately position-independent: squashing
//    a window merely because it sits near the right edge would be surprising.
//  - `clampResize`   — "can the corner go there?"  Used WHILE dragging the grip,
//    where the answer is the OS window rule: the corner stops at the screen edge.
//    That is what keeps the grip reachable, so the trap cannot re-form.
//
// In both, the viewport cap WINS over the minimum size: a 360px minimum on a
// 320px-wide screen would otherwise reinstate the very thing being prevented.

/** px of breathing room kept between a window edge and the viewport edge */
export const WIN_MARGIN = 8;

/**
 * Top chrome a window may not sit under. dragWindow's position clamp already
 * refuses to park a window behind the Connect bar, so that strip is not usable
 * HEIGHT either: ignoring it produced a window that fitted the viewport on
 * paper, got pinned below the bar, and hung its resize grip off the bottom.
 */
function topInset() {
	if (typeof document === 'undefined') return 0;
	const pill = document.querySelector('.connect-pill');
	if (!pill) return 0;
	const r = pill.getBoundingClientRect();
	return Math.max(0, Math.round(r.bottom) + 4);
}

/** The largest a window may be right now, given it will be placed below the top
 * chrome. @param {number} [margin] */
export function viewportCap(margin = WIN_MARGIN) {
	if (typeof window === 'undefined') return { w: Infinity, h: Infinity };
	return {
		w: Math.max(120, window.innerWidth - margin),
		h: Math.max(120, window.innerHeight - margin - topInset())
	};
}

/**
 * Fit a size to the viewport, ignoring where the window sits.
 * @param {number} w @param {number} h
 * @param {{minW?: number, minH?: number, margin?: number}} [options]
 */
export function clampWinSize(w, h, { minW = 260, minH = 180, margin = WIN_MARGIN } = {}) {
	const cap = viewportCap(margin);
	return {
		w: Math.min(Math.max(Math.min(minW, cap.w), w || 0), cap.w),
		h: Math.min(Math.max(Math.min(minH, cap.h), h || 0), cap.h)
	};
}

/**
 * Fit a size being dragged from a top-left anchor: the bottom-right corner may
 * not leave the viewport, so the resize grip always stays grabbable. A window
 * shoved partly off the LEFT/TOP is allowed to use the space it has (a negative
 * anchor does not inflate the cap).
 * @param {number} w @param {number} h
 * @param {number} left @param {number} top window position in viewport px
 * @param {{minW?: number, minH?: number, margin?: number}} [options]
 */
export function clampResize(w, h, left, top, { minW = 260, minH = 180, margin = WIN_MARGIN } = {}) {
	// the RAW viewport here, not `viewportCap`: the anchor already accounts for
	// wherever the top chrome pushed this window, so subtracting the inset again
	// would shrink it twice
	const maxW = Math.max(120, (typeof window === 'undefined' ? Infinity : window.innerWidth - margin) - Math.max(0, left || 0));
	const maxH = Math.max(120, (typeof window === 'undefined' ? Infinity : window.innerHeight - margin) - Math.max(0, top || 0));
	return {
		w: Math.min(Math.max(Math.min(minW, maxW), w || 0), maxW),
		h: Math.min(Math.max(Math.min(minH, maxH), h || 0), maxH)
	};
}

/**
 * Where a window currently sits, for `clampResize`. Reads the live rect so it is
 * correct whether the position came from dragWindow's inline styles, a tab group
 * or the CSS default.
 * @param {any} node @returns {{left: number, top: number}}
 */
export function anchorOf(node) {
	const r = node?.getBoundingClientRect?.();
	return { left: r?.left ?? 0, top: r?.top ?? 0 };
}
