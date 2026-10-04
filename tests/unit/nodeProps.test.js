// @ts-nocheck — partial fixtures (rows/graphs with only the fields under test)
// 36 (flow-revamp 200-202): the per-node property schema (src/lib/nodeProps.js, a leaf).
import { describe, test, expect } from 'vitest';
import { propertyRows, coerceProp, propPatch, inferKind } from '../../src/lib/nodeProps.js';

const bounceSpec = {
	type: 'bounce',
	defaults: { amplitude: 0.5, speed: 2 },
	params: [
		{ key: 'amplitude', kind: 'range', min: 0, max: 3, step: 0.05 },
		{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1, group: 'Timing', doc: 'cycles per second' }
	]
};

describe('propertyRows', () => {
	test('spec params come first, with authored ranges, groups and docs', () => {
		const rows = propertyRows({ id: 'n', type: 'bounce', data: { amplitude: 1 } }, bounceSpec, []);
		expect(rows.map((r) => r.key)).toEqual(['amplitude', 'speed']);
		expect(rows[0]).toMatchObject({ kind: 'range', value: 1, min: 0, max: 3, wired: false, source: 'spec' });
		expect(rows[1]).toMatchObject({ value: 2, group: 'Timing', doc: 'cycles per second' });
	});
	test('a wire into a key marks the row wired (the wire overrides the property)', () => {
		const rows = propertyRows({ id: 'n', type: 'bounce', data: {} }, bounceSpec, [
			{ source: 's', target: 'n', targetHandle: 'speed' },
			{ source: 's', target: 'other', targetHandle: 'amplitude' }
		]);
		expect(rows.find((r) => r.key === 'speed').wired).toBe(true);
		expect(rows.find((r) => r.key === 'amplitude').wired).toBe(false);
	});
	test('defaults the params did not name become rows, kind inferred; bookkeeping never does', () => {
		const spec = { type: 'math', defaults: { op: 'add', a: 0, b: 0, label: 'x', code: '' } };
		const rows = propertyRows({ id: 'm', type: 'math', data: { a: 3 } }, spec, []);
		expect(rows.map((r) => [r.key, r.kind, r.value])).toEqual([
			['op', 'text', 'add'],
			['a', 'number', 3],
			['b', 'number', 0]
		]);
	});
	test("a script's unwired declared inputs are its properties (object inputs are wires only)", () => {
		const node = {
			id: 's',
			type: 'script',
			data: { inputs: [{ name: 'power', type: 'number', value: 7 }, { name: 'on', type: 'boolean' }, { name: 'ball', type: 'object' }] }
		};
		const rows = propertyRows(node, { defaults: { code: '' } }, []);
		expect(rows.map((r) => [r.key, r.kind, r.value, r.source])).toEqual([
			['power', 'number', 7, 'input'],
			['on', 'toggle', undefined, 'input']
		]);
		expect(propPatch(node, rows[0], 9)).toEqual({
			inputs: [{ name: 'power', type: 'number', value: 9 }, { name: 'on', type: 'boolean' }, { name: 'ball', type: 'object' }]
		});
	});
	test("a behaviour's literal params are rows; their patch is not a data patch (the source literal is)", () => {
		const behaviour = { params: [{ key: 'power', type: 'number', value: 7, min: 1, max: 12, range: [10, 11] }, { key: 'fn', type: 'opaque', range: null }] };
		const rows = propertyRows({ id: 'b', type: 'behaviour', data: { code: '' } }, null, [], { behaviour });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ key: 'power', kind: 'range', value: 7, source: 'behaviour' });
		expect(propPatch({}, rows[0], 8)).toBeNull();
	});
	test('a node with no spec and no data has no rows', () => {
		expect(propertyRows({ id: 'x', type: 'mystery', data: {} }, null, [])).toEqual([]);
		expect(propertyRows(null, null, [])).toEqual([]);
	});
});

describe('coerceProp', () => {
	test('numbers: a half-typed value writes nothing; ranges clamp', () => {
		expect(coerceProp({ kind: 'number' }, 'abc')).toBeUndefined();
		expect(coerceProp({ kind: 'number' }, '2.5')).toBe(2.5);
		expect(coerceProp({ kind: 'range', min: 0, max: 3 }, 9)).toBe(3);
	});
	test('vector3, color, select, text', () => {
		expect(coerceProp({ kind: 'vector3' }, '1, 2 3')).toEqual([1, 2, 3]);
		expect(coerceProp({ kind: 'vector3' }, '1, x, 3')).toBeUndefined();
		expect(coerceProp({ kind: 'color' }, '#00ff00')).toBe('#00ff00');
		expect(coerceProp({ kind: 'color' }, 'green')).toBeUndefined();
		expect(coerceProp({ kind: 'select', options: ['a', 'b'] }, 'c')).toBeUndefined();
		expect(coerceProp({ kind: 'text', maxLength: 3 }, 'abcdef')).toBe('abc');
	});
	test('inferKind', () => {
		expect(inferKind(true)).toBe('toggle');
		expect(inferKind('#ff4000')).toBe('color');
		expect(inferKind([0, 1, 2])).toBe('vector3');
		expect(inferKind({})).toBeNull();
	});
});
