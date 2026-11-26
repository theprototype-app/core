// @ts-nocheck — a fixture test
// 64-vector-edit (D5 row 3): layer order of shapes on one plane — the stack is a deterministic order
// (height, then id), the four moves do what their names say, and the layers that make an order true
// are the fewest and lowest.
import { describe, test, expect } from 'vitest';
import { LAYER_STEP, stackOrder, reorder, layersFor, layerOnTop, heightOf } from '../../src/lib/vector/vectorOrder.js';

const S = LAYER_STEP;
const flat = (ids) => ids.map((id) => ({ id, base: 0, layer: 0 }));

describe('stackOrder', () => {
	test('height first, then the id — never the input order', () => {
		expect(stackOrder([{ id: 'c', base: 0, layer: 0 }, { id: 'a', base: 0, layer: 0 }, { id: 'b', base: 0, layer: 1 }])).toEqual(['a', 'c', 'b']);
		expect(stackOrder([{ id: 'a', base: 0, layer: 0 }, { id: 'c', base: 0, layer: 0 }])).toEqual(stackOrder([{ id: 'c', base: 0, layer: 0 }, { id: 'a', base: 0, layer: 0 }]));
	});
	test('a surface lift counts: 4 mm off the plane is above layer 1', () => {
		expect(stackOrder([{ id: 'lifted', base: 0.004, layer: 0 }, { id: 'one', base: 0, layer: 1 }])).toEqual(['one', 'lifted']);
	});
});

describe('reorder', () => {
	const order = ['a', 'b', 'c', 'd'];
	test('forward / backward trade one place with the next unpicked shape', () => {
		expect(reorder(order, ['b'], 'forward')).toEqual(['a', 'c', 'b', 'd']);
		expect(reorder(order, ['d'], 'forward')).toEqual(order);
		expect(reorder(order, ['c'], 'backward')).toEqual(['a', 'c', 'b', 'd']);
		expect(reorder(order, ['a'], 'backward')).toEqual(order);
	});
	test('a picked set moves together and keeps its own order', () => {
		expect(reorder(order, ['a', 'b'], 'forward')).toEqual(['c', 'a', 'b', 'd']);
		expect(reorder(order, ['a', 'c'], 'front')).toEqual(['b', 'd', 'a', 'c']);
		expect(reorder(order, ['b', 'd'], 'back')).toEqual(['b', 'd', 'a', 'c']);
	});
});

describe('layersFor', () => {
	test('a flat stack of three gets 0, 1, 2', () => {
		const items = flat(['a', 'b', 'c']);
		expect([...layersFor(items, ['c', 'a', 'b'])]).toEqual([['c', 0], ['a', 1], ['b', 2]]);
	});
	test('heights end strictly increasing by a whole step whatever the bases', () => {
		const items = [{ id: 'x', base: 0.004, layer: 0 }, { id: 'y', base: 0, layer: 0 }, { id: 'z', base: 0.0011, layer: 3 }];
		const order = ['x', 'y', 'z'];
		const layers = layersFor(items, order);
		const h = order.map((id) => heightOf({ ...items.find((i) => i.id === id), layer: layers.get(id) }));
		for (let i = 1; i < h.length; i++) expect(h[i] - h[i - 1]).toBeGreaterThanOrEqual(S - 1e-9);
		expect(layers.get('x')).toBe(0);
	});
	test('a stack never creeps: re-running on its own order changes nothing', () => {
		const items = flat(['a', 'b', 'c']);
		const first = layersFor(items, ['a', 'b', 'c']);
		const again = layersFor(items.map((i) => ({ ...i, layer: first.get(i.id) })), ['a', 'b', 'c']);
		expect([...again]).toEqual([...first]);
	});
});

describe('layerOnTop', () => {
	test('one step above the highest member; an empty plane is layer 0', () => {
		expect(layerOnTop([], 0)).toBe(0);
		expect(layerOnTop([{ id: 'a', base: 0, layer: 2 }], 0)).toBe(3);
		expect(layerOnTop([{ id: 'a', base: 0, layer: 0 }], 0.004)).toBe(0); // already above it
	});
});

import { cleanVector, vectorDefaults } from '../../src/lib/vector/vectorRecord.js';
import { buildVectorGeometry } from '../../src/lib/vector/vectorMesh.js';

describe('the record and the builder', () => {
	test('layer is kept only above 0 (an unordered record is byte-identical), clamped, rounded', () => {
		expect('layer' in cleanVector(vectorDefaults('rect'))).toBe(false);
		expect('layer' in cleanVector({ ...vectorDefaults('rect'), layer: 0 })).toBe(false);
		expect(cleanVector({ ...vectorDefaults('rect'), layer: 2.4 }).layer).toBe(2);
		expect(cleanVector({ ...vectorDefaults('rect'), layer: 9999 }).layer).toBe(255);
		expect('layer' in cleanVector({ ...vectorDefaults('rect'), layer: 'x' })).toBe(false);
	});
	test('the builder lifts the whole shape by layer steps and nothing else', () => {
		const flat = buildVectorGeometry(vectorDefaults('rect')).attributes.position.array;
		const up = buildVectorGeometry({ ...vectorDefaults('rect'), layer: 3 }).attributes.position.array;
		expect(up.length).toBe(flat.length);
		for (let i = 0; i < flat.length; i++) expect(up[i]).toBeCloseTo(i % 3 === 2 ? flat[i] + 3 * S : flat[i], 6);
	});
});
