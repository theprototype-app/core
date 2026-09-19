// R29 S1 — WHERE A BUILT GRAPH LANDS. Imports NOTHING (a leaf, vitest-covered).
//
// Anything that authors nodes on the user's behalf — a module recipe through
// `api.flow.freeRegion`, the HUD editor's action bindings — has to ask one question:
// "where can I put a block of nodes without landing on top of what is already there?"
// `gameRecipes` answered it once (below everything), `hudActions` answered it again
// (right of everything), and every module would have written a third copy. The rule
// lives HERE now and nowhere else.
//
// It is deliberately DETERMINISTIC and cheap: a pure function of the node positions,
// which are replicated, so two peers asking about the same graph get the same point.
// Node SIZE is an estimate — a serialized node does not reliably carry its measured
// box — and every card in the editor is `w-[150px]`, so width is known and height is
// the one guess (measured when the node happens to carry it).

/** every flow card is `w-[150px]` */
export const NODE_W = 150;
/** a typical card's height when the node carries no measured box */
export const NODE_H = 150;
/** clearance between the existing graph and the new block */
export const GAP_Y = 40;
export const GAP_X = 70;
/** where the first block of an EMPTY graph goes */
export const MARGIN = 40;

/** @param {any} n */
function heightOf(n) {
	const h = Number(n?.measured?.height ?? n?.height);
	return Number.isFinite(h) && h > 0 ? h : NODE_H;
}

/**
 * A top-left point for a `w` x `h` block that overlaps nothing in `nodes`.
 *
 * `side: 'below'` (the default, the recipe rule): left-aligned with the graph's
 * leftmost node, one gap under its lowest card. `side: 'right'` (the HUD bindings
 * rule): one gap past the rightmost card, level with the top — with the empty graph
 * read as a phantom card at x 0, which is what `hudActions` always did.
 *
 * Nothing is REJECTED: below/right of everything always has room, so `w`/`h` never
 * change the answer today — they are part of the contract so a smarter packer can
 * honour them without changing a caller.
 * @param {any[]} nodes `{position: {x, y}}` (or `{x, y}`) records
 * @param {{w?: number, h?: number, side?: 'below'|'right'}} [opts]
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function freeRegion(nodes, opts = {}) {
	const w = Math.max(0, Number(opts.w) || 0);
	const h = Math.max(0, Number(opts.h) || 0);
	const list = (Array.isArray(nodes) ? nodes : []).filter(Boolean);
	const xOf = (/** @type {any} */ n) => Number(n.position?.x ?? n.x) || 0;
	const yOf = (/** @type {any} */ n) => Number(n.position?.y ?? n.y) || 0;
	if (opts.side === 'right') {
		const right = list.reduce((max, n) => Math.max(max, xOf(n)), 0) + NODE_W + GAP_X;
		const top = list.length ? Math.min(...list.map(yOf)) : MARGIN;
		return { x: right, y: top, w, h };
	}
	if (!list.length) return { x: MARGIN, y: MARGIN, w, h };
	const left = Math.min(...list.map(xOf));
	const bottom = Math.max(...list.map((n) => yOf(n) + heightOf(n)));
	return { x: left, y: bottom + GAP_Y, w, h };
}
