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

// 53 A1: a px token may read back as calc(Npx * var(--ui-scale, 1)) (the a11y-css transform).
// Resolved here, the simple form uiScale's cssPx reads, so this module keeps NO imports: it is
// DOM-free and loads straight into node (window-size-clamp).
/** @param {CSSStyleDeclaration} cs @param {string} name */
function tokenPx(cs, name) {
	const s = cs.getPropertyValue(name).trim();
	const calc = /^calc\(\s*(-?[\d.]+)px\s*\*\s*(?:(-?[\d.]+)|var\(--ui-scale(?:,\s*[\d.]+)?\))\s*\)$/.exec(s);
	if (calc) return Number(calc[1]) * (calc[2] != null ? Number(calc[2]) : parseFloat(cs.getPropertyValue('--ui-scale')) || 1);
	return parseFloat(s);
}

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

/**
 * 24-B3: bottom chrome a window's HEADER may not sit under. Three things cover the
 * bottom of the layout viewport and none of them was accounted for — a toolbox
 * dragged low slid its header under the Controls pill and was lost:
 *  - `--controls-inset`: the band the Controls pill / play FAB and HUD buttons own on
 *    coarse-pointer or narrow viewports (76px / 68px, ui.css), on `--z-hud` ABOVE windows;
 *  - `--viewport-inset`: the bottom dock's height WHEN it pushes the viewport (the
 *    `dockPushesViewport` pref; bottomDock.js publishes it gated, unlike
 *    `--bottom-inset` which is the raw dock height);
 *  - `visualViewport`: browser chrome drawn OVER the layout viewport (SteamOS's
 *    gaming-mode browser, mobile URL bars) — `innerHeight` lies there, the visual
 *    viewport does not.
 * The centred Controls pill on a wide desktop is a RECT, not a band; dragWindow tests it
 * per window so a window can still be parked in the bottom corners beside it.
 * `{dock: false}` (41 G7): a window's POSITION ignores the dock — windows sit above the
 * dock's tier, so one parked over it keeps a reachable header (like the Objects window).
 * 42 I6: its SIZE ignores the dock too (`viewportCap`, `clampResize`) — "should be possible
 * to resize even when it is covering docked window drawer, now it stuck and disallow to resize
 * height past this docker window". A window above the dock's tier that may sit over the dock
 * may also GROW over it; the corner still stops above the Controls band and the browser's own
 * overlay, which are drawn above windows. Nothing passes `{dock: true}` any more; the default
 * stays for a caller that asks what the dock takes from the viewport.
 * @param {{dock?: boolean}} [options]
 */
export function bottomReserve({ dock: withDock = true } = {}) {
	if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
	let inset = 0;
	let dock = 0;
	try {
		const cs = getComputedStyle(document.documentElement);
		inset = tokenPx(cs, '--controls-inset') || 0;
		dock = tokenPx(cs, '--viewport-inset') || 0;
	} catch {}
	const vv = window.visualViewport;
	const overlay =
		vv && typeof vv.height === 'number' ? Math.max(0, window.innerHeight - (vv.height + (vv.offsetTop || 0))) : 0;
	return Math.max(inset, withDock ? dock : 0) + overlay;
}

/** The largest a window may be right now, given it will be placed below the top
 * chrome and above the bottom chrome (24-B3). @param {number} [margin] */
export function viewportCap(margin = WIN_MARGIN) {
	if (typeof window === 'undefined') return { w: Infinity, h: Infinity };
	return {
		w: Math.max(120, window.innerWidth - margin),
		h: Math.max(120, window.innerHeight - margin - topInset() - bottomReserve({ dock: false }))
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
	// 24-B3: the corner also stops above the bottom chrome, so a resize cannot put the
	// grip under the Controls band either (42 I6: but NOT above the dock — windows sit over it)
	const maxH = Math.max(120, (typeof window === 'undefined' ? Infinity : window.innerHeight - margin - bottomReserve({ dock: false })) - Math.max(0, top || 0));
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

// 44 M3 — "Reset size" in a window's header menu: each window that owns a size it can reset registers
// how, against its NODE (dragWindow's `resizable` grip, the object list's own). A window absent from
// here sizes itself from its content or a store of its own, and the menu says so.
/** @type {WeakMap<object, () => void>} */
const sizeResets = new WeakMap();
/** @param {object} node @param {() => void} fn @returns {() => void} unregister */
export function registerSizeReset(node, fn) {
	sizeResets.set(node, fn);
	return () => {
		if (sizeResets.get(node) === fn) sizeResets.delete(node);
	};
}
/** @param {object} node @returns {(() => void) | null} */
export function sizeResetOf(node) {
	return sizeResets.get(node) ?? null;
}

/** 54i (N6 unfolded): the TOP chrome no window header may sit under. It is drawn above the window
 * tier (--z-chrome-top), so a header there is covered and cannot be grabbed: the Connect pill (the
 * full-width bar when docked), the notes / notifications / people cluster and the profile circle.
 * 76 FW-AI cleared the profile circle for the AI window alone; a docked Connect bar on a tablet-wide
 * screen pushes the whole cluster down, so every window that opens at the top right (the AI window,
 * the Debugger, module toolboxes) slid its header under the bell row. */
export const TOP_CHROME = ['.connect-pill', '#hud-tr', '#avatar-trigger'];

/** The lowest top a window `left..left+width` may take: just under every chrome rect it overlaps
 * horizontally (an empty rect — hidden chrome — never counts). 0 when it overlaps none.
 * @param {number} left @param {number} width
 * @param {Array<{left: number, right: number, bottom: number, width: number, height: number} | null>} rects
 * @param {number} [gap] */
export function topChromeFloor(left, width, rects, gap = 4) {
	let floor = 0;
	for (const r of rects) {
		if (!r || !(r.width > 0) || !(r.height > 0)) continue;
		if (left < r.right && left + width > r.left) floor = Math.max(floor, Math.round(r.bottom) + gap);
	}
	return floor;
}
