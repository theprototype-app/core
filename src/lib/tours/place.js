// 36 I5 — where the 2D tour card goes. Pure geometry (imports nothing), so the unit layer
// checks every placement against the viewports the app is used at (phones folded/unfolded too).

/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

export const CARD_MARGIN = 12;
export const SPOT_PAD = 6;

/**
 * A `data-tour` id, or a CSS selector when it starts with one of `[.#`.
 * @param {string} target @param {Record<string, string>} [fallbacks] built-in id → selector
 * @returns {string[]} selectors to try in order
 */
export function targetSelectors(target, fallbacks = {}) {
	if (!target) return [];
	if (/^[[.#]/.test(target)) return [target];
	const list = [`[data-tour="${target.replace(/["\\]/g, '')}"]`];
	if (fallbacks[target]) list.push(fallbacks[target]);
	return list;
}

/**
 * Place a card of size (w, h) next to a target rect, inside the viewport (vw, vh).
 * Tries the preferred side, then below, above, right, left; when nothing fits (or there is no
 * target) the card centres. On a narrow screen (< 520 px) it is a bottom sheet — unless the
 * target sits in the bottom half, then a top sheet — so it never covers what it points at.
 * @param {Rect | null} target @param {{w: number, h: number}} card @param {number} vw @param {number} vh
 * @param {string} [prefer] 'auto' | 'top' | 'bottom' | 'left' | 'right' | 'center'
 * @returns {{x: number, y: number, side: string, w: number}}
 */
export function placeCard(target, card, vw, vh, prefer = 'auto') {
	const m = CARD_MARGIN;
	if (vw < 520) {
		const w = vw - 2 * m;
		const below = !target || target.y + target.h / 2 < vh / 2;
		return { x: m, y: below ? Math.max(m, vh - card.h - m) : m, side: below ? 'sheet-bottom' : 'sheet-top', w };
	}
	const w = card.w;
	const centre = { x: Math.round((vw - w) / 2), y: Math.round((vh - card.h) / 2), side: 'center', w };
	if (!target || prefer === 'center') return centre;
	const gap = SPOT_PAD + 10;
	const clampX = (/** @type {number} */ x) => Math.min(Math.max(m, x), vw - w - m);
	const clampY = (/** @type {number} */ y) => Math.min(Math.max(m, y), vh - card.h - m);
	const cx = target.x + target.w / 2;
	const cy = target.y + target.h / 2;
	/** @type {Record<string, () => ({x: number, y: number} | null)>} */
	const sides = {
		bottom: () => (target.y + target.h + gap + card.h <= vh - m ? { x: clampX(cx - w / 2), y: target.y + target.h + gap } : null),
		top: () => (target.y - gap - card.h >= m ? { x: clampX(cx - w / 2), y: target.y - gap - card.h } : null),
		right: () => (target.x + target.w + gap + w <= vw - m ? { x: target.x + target.w + gap, y: clampY(cy - card.h / 2) } : null),
		left: () => (target.x - gap - w >= m ? { x: target.x - gap - w, y: clampY(cy - card.h / 2) } : null)
	};
	const order = ['bottom', 'top', 'right', 'left'];
	if (prefer && sides[prefer]) order.unshift(prefer);
	for (const side of order) {
		const at = sides[side]();
		if (at) return { ...at, side, w };
	}
	return centre;
}

/**
 * Do two rects overlap? (the suite's "the card never covers its target")
 * @param {Rect} a @param {Rect} b
 */
export function overlaps(a, b) {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
