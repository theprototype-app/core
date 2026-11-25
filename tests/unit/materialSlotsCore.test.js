import { describe, it, expect } from 'vitest';
import {
	slotIdOf,
	slotIdsOf,
	slotOffOf,
	remapGroups,
	facesPerSlot,
	slotIndexOf,
	removalMap,
	swapMap,
	insertAfterMap,
	slotLinkOf,
	newLinkId
} from '../../src/lib/materialSlotsCore.js';

// 105-slots: the pure half of material slots — the id rules every peer must agree on and the group remapping
// every list operation commits.

/** @param {string} uuid @param {any} [slot] @param {string} [name] */
const mat = (uuid, slot, name = '') => ({ uuid, name, userData: slot ? { slot } : {} });

describe('slot ids', () => {
	it('an explicit id wins, else the material uuid', () => {
		expect(slotIdOf(mat('u1'))).toBe('u1');
		expect(slotIdOf(mat('u1', { id: 'lid' }))).toBe('lid');
		expect(slotIdOf(mat('u1', { id: '' }))).toBe('u1');
		expect(slotIdOf(mat('u1', { id: 7 }))).toBe('u1');
		expect(slotIdOf(null)).toBe('');
	});
	it('two slots with one id: the LATER answers id~index (an older peer cloned the last slot)', () => {
		const list = [
			mat('a', { id: 's1' }),
			mat('b', { id: 's2', off: true }),
			mat('c', { id: 's2', off: true })
		];
		expect(slotIdsOf(list)).toEqual(['s1', 's2', 's2~2']);
		// the same rule on every peer: order is the only input
		expect(slotIdsOf(list.slice())).toEqual(slotIdsOf(list));
	});
	it('a uuid that collides with an explicit id is also disambiguated', () => {
		expect(slotIdsOf([mat('x'), mat('y', { id: 'x' })])).toEqual(['x', 'x~1']);
	});
	it('off is only a literal true', () => {
		expect(slotOffOf(mat('a', { off: true }))).toBe(true);
		expect(slotOffOf(mat('a', { off: 'yes' }))).toBe(false);
		expect(slotOffOf(mat('a'))).toBe(false);
	});
});

describe('slot references', () => {
	const list = [
		mat('a', null, 'Body'),
		mat('b', { id: 'glass' }, 'Glass'),
		mat('c', { id: 'glass' }, 'Trim')
	];
	it('index, id, the disambiguated id, then name', () => {
		expect(slotIndexOf(list, 1)).toBe(1);
		expect(slotIndexOf(list, 3)).toBe(-1);
		expect(slotIndexOf(list, 1.5)).toBe(-1);
		expect(slotIndexOf(list, 'a')).toBe(0);
		expect(slotIndexOf(list, 'glass')).toBe(1);
		expect(slotIndexOf(list, 'glass~2')).toBe(2);
		expect(slotIndexOf(list, 'Trim')).toBe(2);
		expect(slotIndexOf(list, 'nope')).toBe(-1);
		expect(slotIndexOf(list, '')).toBe(-1);
	});
});

describe('group remapping', () => {
	// a box with three slots: faces 0-3 slot 0, 4-7 slot 1, 8-11 slot 2 (indices: 3 per triangle)
	const box = [
		{ start: 0, count: 12, materialIndex: 0 },
		{ start: 12, count: 12, materialIndex: 1 },
		{ start: 24, count: 12, materialIndex: 2 }
	];
	it('remove the middle slot, its faces to slot 0: adjacent groups of one slot merge', () => {
		const map = removalMap(3, 1, 0);
		expect(map).toEqual([0, 0, 1]);
		expect(remapGroups(box, map)).toEqual([
			{ start: 0, count: 24, materialIndex: 0 },
			{ start: 24, count: 12, materialIndex: 1 }
		]);
	});
	it('remove the first slot, its faces to the last one', () => {
		const map = removalMap(3, 0, 2);
		expect(map).toEqual([1, 0, 1]);
		expect(remapGroups(box, map)).toEqual([
			{ start: 0, count: 12, materialIndex: 1 },
			{ start: 12, count: 12, materialIndex: 0 },
			{ start: 24, count: 12, materialIndex: 1 }
		]);
	});
	it('every face is still covered after a removal (nothing drawn by a missing slot)', () => {
		for (let index = 0; index < 3; index++)
			for (let target = 0; target < 3; target++) {
				if (target === index) continue;
				const out = remapGroups(box, removalMap(3, index, target));
				expect(out.reduce((n, g) => n + g.count, 0)).toBe(36);
				expect(out.every((g) => g.materialIndex >= 0 && g.materialIndex < 2)).toBe(true);
			}
	});
	it('swap keeps the picture: each face keeps its material', () => {
		const materials = ['A', 'B', 'C'];
		const map = swapMap(3, 0, 1);
		const next = [materials[1], materials[0], materials[2]];
		const out = remapGroups(box, map);
		for (const g of box) {
			const moved = out.find((o) => o.start === g.start);
			expect(next[moved?.materialIndex ?? -1]).toBe(materials[g.materialIndex]);
		}
	});
	it('insert after: later slots shift up, the new slot has no faces', () => {
		const map = insertAfterMap(3, 0);
		expect(map).toEqual([0, 2, 3]);
		const out = remapGroups(box, map);
		expect(facesPerSlot(out, 4)).toEqual([4, 0, 4, 4]);
	});
	it('unsorted and touching groups are sorted and merged; empty ones dropped', () => {
		const groups = [
			{ start: 6, count: 3, materialIndex: 1 },
			{ start: 0, count: 6, materialIndex: 1 },
			{ start: 9, count: 0, materialIndex: 0 },
			{ start: 12, count: 3, materialIndex: 1 }
		];
		expect(remapGroups(groups, [0, 1])).toEqual([
			{ start: 0, count: 9, materialIndex: 1 },
			{ start: 12, count: 3, materialIndex: 1 }
		]);
	});
	it('faces per slot ignores out-of-range slots', () => {
		expect(
			facesPerSlot(
				[
					{ start: 0, count: 9, materialIndex: 5 },
					{ start: 9, count: 6, materialIndex: 0 }
				],
				2
			)
		).toEqual([2, 0]);
	});
});

describe('links (105-slots phase 3)', () => {
	it('a link id rides userData.slot.link; anything else is no link', () => {
		expect(slotLinkOf(mat('a', { link: 'lnk1' }))).toBe('lnk1');
		expect(slotLinkOf(mat('a', { link: '' }))).toBe('');
		expect(slotLinkOf(mat('a', { link: 3 }))).toBe('');
		expect(slotLinkOf(mat('a'))).toBe('');
	});
	it('new link ids are unique and short', () => {
		const ids = new Set(Array.from({ length: 200 }, () => newLinkId()));
		expect(ids.size).toBe(200);
		for (const id of ids) expect(id.length).toBeLessThanOrEqual(24);
	});
	it('a link does not change the slot id rules', () => {
		expect(slotIdsOf([mat('a', { link: 'L' }), mat('b', { link: 'L' })])).toEqual(['a', 'b']);
	});
});
