// 94 SP6 — THE PLAY HUD IS LAID OUT FROM A SAFE AREA. A LEAF (no imports): HudLayer reads it, the
// play chrome only writes an attribute.
//
// The system's own play chrome — the exit ✕ (touch), the "Playing" chip, the game's Menu pill, the
// embed chrome — sits in the top row. A game's HUD is authored on the 9-grid in pixels from the
// viewport edges, so on a narrow phone (N6 folded, 390 px) a top-anchored game HUD lands UNDER that
// row: Sky Run's stage title ran under the Menu pill and the Playing chip hid behind the timer
// (docs img/touch-controls/sky-run-phone.webp).
//
// The rule: every element of the play chrome carries `data-play-chrome`.
// (The bottom band has the mirror rule, hudBottomLift: bottom-anchored HUD lifts above the bottom chrome.) When any TOP-anchored game
// HUD element would overlap a chrome element in the top band, ALL top-anchored HUD elements move
// down together (the author's own arrangement — a band behind a title — stays intact) so the
// highest of them starts below the chrome row. Nothing moves when nothing collides (a desktop
// window is unchanged), and the measurement uses the elements' AUTHORED places, so moving them
// can never feed back into the decision.

/** the selector every play-chrome element answers to */
export const PLAY_CHROME_SELECTOR = '[data-play-chrome]';

/** @typedef {{left: number, top: number, right: number, bottom: number}} Box */

/** @param {Box} a @param {Box} b @param {number} [pad] true when the boxes overlap by more than `pad` px */
export function overlaps(a, b, pad = 0) {
	return a.left < b.right - pad && b.left < a.right - pad && a.top < b.bottom - pad && b.top < a.bottom - pad;
}

/**
 * Where a TOP-anchored HUD element sits by its authored place (`anchor` top-left / top / top-right,
 * `x` / `y` pixel offsets, `w` / `h` size × `scale`); null for any other anchor.
 * @param {{anchor?: string, x?: number, y?: number, w?: number, h?: number}} el
 * @param {number} viewportW
 * @param {number} [scale] the player's HUD text size factor (53 A6) for a text-carrying element
 * @returns {Box | null}
 */
export function topFootprint(el, viewportW, scale = 1) {
	const anchor = String(el.anchor ?? 'top-left');
	if (anchor === 'center') return null;
	const [v, h0] = anchor.split('-');
	if ((v || 'top') !== 'top') return null;
	const h = h0 || 'left';
	const w = (Number(el.w) || 0) * scale;
	const ht = (Number(el.h) || 0) * scale;
	const x = Number(el.x) || 0;
	const top = Number(el.y) || 0;
	const left = h === 'left' ? x : h === 'right' ? viewportW - x - w : viewportW / 2 - w / 2 + x;
	return { left, top, right: left + w, bottom: top + ht };
}

/**
 * How far (px) to move every top-anchored HUD element down so none overlaps the play chrome's top
 * row. PURE (the unit test drives it). 0 when nothing collides.
 * @param {Box[]} slots the top-anchored HUD footprints (authored places, see topFootprint)
 * @param {Box[]} chrome the visible play-chrome rects
 * @param {number} viewportH
 * @param {number} [gap] clearance kept under the chrome row
 * @returns {number}
 */
export function hudTopShift(slots, chrome, viewportH, gap = 6) {
	if (!slots.length || !chrome.length) return 0;
	// the TOP band only: the bottom-left embed chrome and the touch stick are another rule's business
	const row = chrome.filter((c) => c.top < viewportH * 0.25 && c.bottom > c.top && c.right > c.left);
	if (!row.length) return 0;
	const hit = slots.some((s) => s.bottom > s.top && s.right > s.left && row.some((c) => overlaps(s, c, 0.5)));
	if (!hit) return 0;
	const rowBottom = Math.max(...row.map((c) => c.bottom));
	const highest = Math.min(...slots.map((s) => s.top));
	return Math.max(0, Math.ceil(rowBottom + gap - highest));
}

/**
 * Where a BOTTOM-anchored HUD element sits by its authored place; null for any other anchor.
 * @param {{anchor?: string, x?: number, y?: number, w?: number, h?: number}} el
 * @param {number} viewportW @param {number} viewportH
 * @param {number} [scale]
 * @returns {Box | null}
 */
export function bottomFootprint(el, viewportW, viewportH, scale = 1) {
	const anchor = String(el.anchor ?? 'top-left');
	const [v, h0] = anchor.split('-');
	if (v !== 'bottom') return null;
	const h = h0 || 'left';
	const w = (Number(el.w) || 0) * scale;
	const ht = (Number(el.h) || 0) * scale;
	const x = Number(el.x) || 0;
	const bottom = viewportH - (Number(el.y) || 0);
	const left = h === 'left' ? x : h === 'right' ? viewportW - x - w : viewportW / 2 - w / 2 + x;
	return { left, top: bottom - ht, right: left + w, bottom };
}

/**
 * The bottom band's twin of hudTopShift: how far (px) to LIFT every bottom-anchored HUD element so
 * none sits under the play chrome's bottom row (the embed chrome's ⛶ / Open / Remix links on the
 * play entry). 0 when nothing collides. PURE.
 * @param {Box[]} slots the bottom-anchored HUD footprints (bottomFootprint)
 * @param {Box[]} chrome @param {number} viewportH @param {number} [gap]
 * @returns {number}
 */
export function hudBottomLift(slots, chrome, viewportH, gap = 6) {
	if (!slots.length || !chrome.length) return 0;
	const row = chrome.filter((c) => c.bottom > viewportH * 0.75 && c.bottom > c.top && c.right > c.left);
	if (!row.length) return 0;
	const hit = slots.some((s) => s.bottom > s.top && s.right > s.left && row.some((c) => overlaps(s, c, 0.5)));
	if (!hit) return 0;
	const rowTop = Math.min(...row.map((c) => c.top));
	const lowest = Math.max(...slots.map((s) => s.bottom));
	return Math.max(0, Math.ceil(lowest - (rowTop - gap)));
}

/**
 * The live play chrome: every visible `[data-play-chrome]` element's rect.
 * @param {ParentNode} [root] @returns {Box[]}
 */
export function playChromeRects(root = typeof document === 'undefined' ? /** @type {any} */ (null) : document) {
	if (!root) return [];
	/** @type {Box[]} */
	const out = [];
	for (const el of root.querySelectorAll(PLAY_CHROME_SELECTOR)) {
		const r = /** @type {HTMLElement} */ (el).getBoundingClientRect();
		if (r.width > 0 && r.height > 0) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
	}
	return out;
}
