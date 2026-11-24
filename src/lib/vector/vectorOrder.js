// 64-vector-edit (D5 row 3): LAYER ORDER of flat shapes on one plane — the arithmetic. A LEAF.
//
// A shape's record may carry `layer` (an integer, absent = 0); the builder lifts the whole shape by
// layer * LAYER_STEP along its own +Z. Shapes on one plane are a STACK, ordered by their HEIGHT along
// the plane's normal (where the object sits + its lift); equal heights break on the uuid, so the order
// is a fact both peers compute the same way, never an accident of the children list.
// Reordering never moves an object: it only rewrites layers, the fewest it can, so each shape's height
// clears the one below it by a whole step. That also lifts a shape drawn 4 mm off another (a surface
// lift) cleanly above or below it.

/** metres between two layers: more than the stroke's own 1.5 mm lift, so a stroke never pokes through */
export const LAYER_STEP = 0.002;
/** the highest layer a record keeps */
export const MAX_LAYER = 255;

/** @typedef {{id: string, base: number, layer: number}} StackItem base = the object's height along the normal (m) */

/** an item's height @param {StackItem} it @param {number} [step] */
export const heightOf = (it, step = LAYER_STEP) => it.base + it.layer * step;

/** the stack bottom-up @param {StackItem[]} items @param {number} [step] @returns {string[]} ids */
export function stackOrder(items, step = LAYER_STEP) {
	return [...items]
		.sort((a, b) => heightOf(a, step) - heightOf(b, step) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((it) => it.id);
}

/**
 * Move `moving` within a bottom-up order. forward / backward: each moving shape trades places with the
 * next shape that is NOT moving (the selection keeps its own order); front / back: the moving shapes
 * go to the top / bottom, in their own order.
 * @param {string[]} order bottom-up @param {string[]} moving @param {'forward' | 'backward' | 'front' | 'back'} op
 * @returns {string[]}
 */
export function reorder(order, moving, op) {
	const set = new Set(moving);
	const out = [...order];
	if (op === 'front') return [...out.filter((id) => !set.has(id)), ...out.filter((id) => set.has(id))];
	if (op === 'back') return [...out.filter((id) => set.has(id)), ...out.filter((id) => !set.has(id))];
	if (op === 'forward') {
		for (let i = out.length - 2; i >= 0; i--)
			if (set.has(out[i]) && !set.has(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]];
		return out;
	}
	for (let i = 1; i < out.length; i++) if (set.has(out[i]) && !set.has(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]];
	return out;
}

/**
 * The layers that make `order` (bottom-up) true: walking up, each shape takes the LOWEST layer
 * (>= 0) that puts it a whole step above the one below. A shape that already stands high enough
 * keeps a lower layer than it had, so a stack never creeps upwards.
 * @param {StackItem[]} items @param {string[]} order @param {number} [step]
 * @returns {Map<string, number>} id -> layer, for every item
 */
export function layersFor(items, order, step = LAYER_STEP) {
	const byId = new Map(items.map((it) => [it.id, it]));
	/** @type {Map<string, number>} */
	const out = new Map();
	let below = -Infinity;
	for (const id of order) {
		const it = byId.get(id);
		if (!it) continue;
		const need = below === -Infinity ? 0 : Math.ceil((below + step - it.base) / step - 1e-6);
		const layer = Math.min(MAX_LAYER, Math.max(0, need));
		out.set(id, layer);
		below = it.base + layer * step;
	}
	return out;
}

/**
 * The layer a NEW shape takes to sit on top of a stack: one step above its highest member.
 * @param {StackItem[]} items @param {number} base the new shape's height @param {number} [step]
 */
export function layerOnTop(items, base, step = LAYER_STEP) {
	if (!items.length) return 0;
	const top = Math.max(...items.map((it) => heightOf(it, step)));
	return Math.min(MAX_LAYER, Math.max(0, Math.ceil((top + step - base) / step - 1e-6)));
}
