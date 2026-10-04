// 36-export — WHERE A CORNER DECORATION MAY NOT SIT. The "Made with ThePrototype" badge lives in
// the bottom-right corner, which is exactly where a phone game puts its action buttons (36-touch's
// jump / fire / use). Rather than either lane importing the other, the contract is a DOM
// attribute: any element carrying `data-hud-avoid` is a rect the badge lifts itself above. A
// module or a component that draws its own controls opts in with one attribute, and nothing
// here has to know what it is.
//
// A LEAF: no imports — the badge reads it, the touch overlay only writes attributes.

/** the selector every avoid-rect source answers to */
export const HUD_AVOID_SELECTOR = '[data-hud-avoid]';

/**
 * @typedef {{left: number, top: number, right: number, bottom: number}} Box
 */

/**
 * How far above the viewport's bottom edge a box anchored bottom-right must sit so it overlaps
 * none of the obstacles that share its column. PURE (the unit test drives it): returns the
 * bottom offset in px — `base` when nothing is in the way, else the lifted value.
 * @param {Box} box the badge's footprint at its default place (viewport px)
 * @param {Box[]} obstacles
 * @param {number} viewportH
 * @param {number} base the default bottom offset
 * @param {number} [gap] clearance kept above an obstacle
 * @returns {number}
 */
export function liftAbove(box, obstacles, viewportH, base, gap = 8) {
	let bottom = base;
	const height = box.bottom - box.top;
	// re-check after every lift: clearing one button can land the badge on the next one up
	for (let pass = 0; pass < 8; pass++) {
		const top = viewportH - bottom - height;
		const footprint = { left: box.left, right: box.right, top, bottom: viewportH - bottom };
		const hit = obstacles.find(
			(o) => o.right > footprint.left && o.left < footprint.right && o.bottom > footprint.top && o.top < footprint.bottom
		);
		if (!hit) return bottom;
		bottom = Math.max(bottom, viewportH - hit.top + gap);
	}
	return bottom;
}

/**
 * The live obstacles: every visible `[data-hud-avoid]` element's rect.
 * @param {ParentNode} [root]
 * @returns {Box[]}
 */
export function avoidRects(root = typeof document === 'undefined' ? /** @type {any} */ (null) : document) {
	if (!root) return [];
	/** @type {Box[]} */
	const out = [];
	for (const el of root.querySelectorAll(HUD_AVOID_SELECTOR)) {
		const r = /** @type {HTMLElement} */ (el).getBoundingClientRect();
		if (r.width > 0 && r.height > 0) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
	}
	return out;
}
