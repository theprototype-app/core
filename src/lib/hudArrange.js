// 21-F1 — HUD ARRANGE: the pure geometry behind align / distribute / equalize.
//
// Imports NOTHING, deliberately (the `hudKinds` / `meshTopology` rule): it is a table of
// operations plus one pure function over absolute rectangles, so it is testable with no
// DOM, no store and no document — and the editor stays the only place that knows about
// anchors, gestures and history.
//
// THE ONE THING THAT MATTERS HERE IS THE COORDINATE SPACE. A HUD element is positioned as
// a 9-GRID ANCHOR plus a PIXEL OFFSET, so "align left" cannot be done on the authored
// numbers: a `top-right` element's x counts leftwards from the right edge, so setting two
// elements' x equal puts them in two different places whenever their anchors differ. Every
// op therefore works on ABSOLUTE rects in the artboard's frame, and the caller converts
// back through each element's OWN anchor (`offsetsInFrame`). That single rule is what makes
// an align correct across a mixed-anchor selection.
//
// The list is DATA so the topbar and the context menu render from one source (the
// `buildObjectMenuItems` / `hudKinds` precedent) and cannot drift apart.

/** @typedef {{left: number, top: number, w: number, h: number}} HudRect */
/** @typedef {{id: string, rect: HudRect}} HudMember */
/** @typedef {{key: string, label: string, hint: string, group: string, min: number}} HudArrangeOp */

/**
 * Every arrange operation, in display order. `min` is how many selected elements the op
 * NEEDS: aligning one thing to itself is a no-op, and distributing needs a middle to move.
 * @type {HudArrangeOp[]}
 */
export const HUD_ARRANGE_OPS = [
	{ key: 'align-left', label: 'Align left', hint: 'Left edges meet the leftmost one', group: 'Align', min: 2 },
	{ key: 'align-hcenter', label: 'Align centres horizontally', hint: 'Centres meet the middle of the selection', group: 'Align', min: 2 },
	{ key: 'align-right', label: 'Align right', hint: 'Right edges meet the rightmost one', group: 'Align', min: 2 },
	{ key: 'align-top', label: 'Align top', hint: 'Top edges meet the topmost one', group: 'Align', min: 2 },
	{ key: 'align-vcenter', label: 'Align centres vertically', hint: 'Centres meet the middle of the selection', group: 'Align', min: 2 },
	{ key: 'align-bottom', label: 'Align bottom', hint: 'Bottom edges meet the lowest one', group: 'Align', min: 2 },
	{
		key: 'distribute-h',
		label: 'Distribute horizontally',
		// EQUAL GAPS, not equal centres: the outer two stay exactly where they are, which is
		// both what a layout tool means by it and an invariant worth asserting
		hint: 'Equal gaps left to right; the outer two stay put',
		group: 'Arrange',
		min: 3
	},
	{ key: 'distribute-v', label: 'Distribute vertically', hint: 'Equal gaps top to bottom; the outer two stay put', group: 'Arrange', min: 3 },
	{
		key: 'equalize',
		label: 'Equalize size',
		// the FIRST member is the reference — deterministic, and it is the one the user
		// picked first, which is the same rule every "match this" command in a DCC uses
		hint: 'Every selected element takes the FIRST one\'s width and height',
		group: 'Arrange',
		min: 2
	}
];

/** The groups, in display order, with no duplicates. @type {string[]} */
export const HUD_ARRANGE_GROUPS = HUD_ARRANGE_OPS.reduce(
	(/** @type {string[]} */ acc, op) => (acc.includes(op.group) ? acc : [...acc, op.group]),
	[]
);

/** @param {string} key @returns {HudArrangeOp|null} */
export function arrangeOp(key) {
	return HUD_ARRANGE_OPS.find((op) => op.key === key) ?? null;
}

/** @param {number} n */
const r0 = (n) => Math.round(n);

/**
 * Apply an arrange op to a set of ABSOLUTE rects.
 *
 * Returns ONLY the members whose rect actually changes, so the caller writes nothing for an
 * element that was already in place — which is what makes "align left moved exactly these
 * two" a readable assertion and keeps a second press a genuine no-op.
 *
 * @param {string} opKey
 * @param {HudMember[]} members in SELECTION order (the first is `equalize`'s reference)
 * @returns {Record<string, HudRect>}
 */
export function arrangeRects(opKey, members) {
	const op = arrangeOp(opKey);
	/** @type {Record<string, HudRect>} */
	const out = {};
	if (!op || !Array.isArray(members) || members.length < op.min) return out;

	const rects = members.map((m) => m.rect);
	const minLeft = Math.min(...rects.map((r) => r.left));
	const maxRight = Math.max(...rects.map((r) => r.left + r.w));
	const minTop = Math.min(...rects.map((r) => r.top));
	const maxBottom = Math.max(...rects.map((r) => r.top + r.h));

	/** @param {HudMember} m @param {Partial<HudRect>} patch */
	function put(m, patch) {
		const next = { ...m.rect, ...patch };
		if (
			r0(next.left) === r0(m.rect.left) &&
			r0(next.top) === r0(m.rect.top) &&
			r0(next.w) === r0(m.rect.w) &&
			r0(next.h) === r0(m.rect.h)
		)
			return; // already there — do not write, do not report
		out[m.id] = { left: r0(next.left), top: r0(next.top), w: r0(next.w), h: r0(next.h) };
	}

	switch (op.key) {
		case 'align-left':
			for (const m of members) put(m, { left: minLeft });
			break;
		case 'align-hcenter': {
			const cx = (minLeft + maxRight) / 2;
			for (const m of members) put(m, { left: cx - m.rect.w / 2 });
			break;
		}
		case 'align-right':
			for (const m of members) put(m, { left: maxRight - m.rect.w });
			break;
		case 'align-top':
			for (const m of members) put(m, { top: minTop });
			break;
		case 'align-vcenter': {
			const cy = (minTop + maxBottom) / 2;
			for (const m of members) put(m, { top: cy - m.rect.h / 2 });
			break;
		}
		case 'align-bottom':
			for (const m of members) put(m, { top: maxBottom - m.rect.h });
			break;
		case 'distribute-h': {
			// sorted by left, id as the tie-break so two elements at the same x cannot make
			// the result depend on the selection order
			const order = [...members].sort((a, b) => a.rect.left - b.rect.left || (a.id < b.id ? -1 : 1));
			const sumW = order.reduce((n, m) => n + m.rect.w, 0);
			const gap = (maxRight - minLeft - sumW) / (order.length - 1);
			let cursor = minLeft;
			for (const m of order) {
				put(m, { left: cursor });
				cursor += m.rect.w + gap;
			}
			break;
		}
		case 'distribute-v': {
			const order = [...members].sort((a, b) => a.rect.top - b.rect.top || (a.id < b.id ? -1 : 1));
			const sumH = order.reduce((n, m) => n + m.rect.h, 0);
			const gap = (maxBottom - minTop - sumH) / (order.length - 1);
			let cursor = minTop;
			for (const m of order) {
				put(m, { top: cursor });
				cursor += m.rect.h + gap;
			}
			break;
		}
		case 'equalize': {
			const ref = members[0].rect;
			// the top-left stays put and only the size changes — resizing about the centre
			// would move every element as well, which is two edits reported as one
			for (const m of members) put(m, { w: ref.w, h: ref.h });
			break;
		}
	}
	return out;
}

/**
 * Does a rect touch a marquee box? INTERSECTION, not containment: dragging a box that
 * clips an element is how every layout tool selects it, and containment makes a large
 * panel unselectable without enclosing the whole board.
 * @param {HudRect} rect @param {{x0: number, y0: number, x1: number, y1: number}} box
 */
export function rectHitsBox(rect, box) {
	const x0 = Math.min(box.x0, box.x1);
	const x1 = Math.max(box.x0, box.x1);
	const y0 = Math.min(box.y0, box.y1);
	const y1 = Math.max(box.y0, box.y1);
	return rect.left < x1 && rect.left + rect.w > x0 && rect.top < y1 && rect.top + rect.h > y0;
}
