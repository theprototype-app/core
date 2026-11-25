// 105-slots: the pure half of material slots — ids, the duplicate-id rule, group remapping, slot references.
// Imports only slotIds.js (the boot half, itself import-free); slotDraw.js and materialSlots.js build on them.
import { slotIdsOf } from './slotIds.js';
export { slotIdOf, slotIdsOf, slotOffOf, slotLinkOf, newLinkId } from './slotIds.js';

/** @typedef {{start: number, count: number, materialIndex: number}} Group */

/**
 * Remap every group's slot index (`map[old]` = new index, or -1 = drop the group), then sort by start and merge
 * adjacent groups that now point at one slot.
 * @param {Group[]} groups @param {number[]} map @returns {Group[]}
 */
export function remapGroups(groups, map) {
	/** @type {Group[]} */
	const out = [];
	const sorted = groups
		.map((g) => ({
			start: g.start,
			count: g.count,
			materialIndex: map[g.materialIndex || 0] ?? -1
		}))
		.filter((g) => g.materialIndex >= 0 && g.count > 0)
		.sort((a, b) => a.start - b.start);
	for (const g of sorted) {
		const last = out[out.length - 1];
		if (last && last.materialIndex === g.materialIndex && last.start + last.count === g.start)
			last.count += g.count;
		else out.push(g);
	}
	return out;
}

/** Triangles per slot index. @param {Group[]} groups @param {number} slots @returns {number[]} */
export function facesPerSlot(groups, slots) {
	const out = new Array(Math.max(0, slots)).fill(0);
	for (const g of groups) {
		const i = g.materialIndex || 0;
		if (i < slots) out[i] += Math.floor(g.count / 3);
	}
	return out;
}

/**
 * A slot reference -> its index: an index, an id (as `slotIdsOf` answers it, `id~n` included) or a name.
 * @param {any[]} materials @param {number | string} ref @returns {number} -1 when nothing matches
 */
export function slotIndexOf(materials, ref) {
	if (typeof ref === 'number')
		return Number.isInteger(ref) && ref >= 0 && ref < materials.length ? ref : -1;
	if (typeof ref !== 'string' || !ref) return -1;
	const byId = slotIdsOf(materials).indexOf(ref);
	if (byId >= 0) return byId;
	return materials.findIndex((m) => (m?.name ?? '') === ref);
}

/** The index map for removing slot `index` with its faces going to `target`. @param {number} n @param {number} index @param {number} target */
export function removalMap(n, index, target) {
	/** @type {number[]} */
	const map = [];
	let next = 0;
	for (let i = 0; i < n; i++) map[i] = i === index ? -1 : next++;
	map[index] = map[target];
	return map;
}

/** The index map for swapping slots `a` and `b`. @param {number} n @param {number} a @param {number} b */
export function swapMap(n, a, b) {
	return Array.from({ length: n }, (_, i) => (i === a ? b : i === b ? a : i));
}

/** The index map for inserting a new slot right after `index`. @param {number} n @param {number} index */
export function insertAfterMap(n, index) {
	return Array.from({ length: n }, (_, i) => (i <= index ? i : i + 1));
}
