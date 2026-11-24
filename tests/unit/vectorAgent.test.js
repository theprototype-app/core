// @ts-nocheck — a fixture test
// 64-vector row 6: create_shape {action: 'vector'} -> create_vector's arguments (vectorAgentCore.js).
import { describe, test, expect } from 'vitest';
import { vectorArgs, AGENT_VECTOR_KINDS } from '../../src/lib/vector/vectorAgentCore.js';
import { cleanVector, vectorDefaults } from '../../src/lib/vector/vectorRecord.js';

describe('create_vector arguments', () => {
	test('every kind the brief names', () => {
		expect(AGENT_VECTOR_KINDS).toEqual(['rect', 'ellipse', 'star', 'polygon', 'path', 'svg']);
	});

	test('a parametric kind: defaults, then the given fields, through the record boundary', () => {
		const r = vectorArgs({ kind: 'star', count: 7, radius: 1.2, corner: 0.05, fill: '#ffcc00', stroke: '#000000', strokeWidth: 0.02 });
		expect(r.params).toEqual(cleanVector({ ...vectorDefaults('star'), kind: 'star', points: 7, radius: 1.2, corner: 0.05, fill: '#ffcc00', stroke: '#000000', strokeWidth: 0.02 }));
		expect(vectorArgs({ kind: 'polygon', sides: 8 }).params.points).toBe(8);
		expect(vectorArgs({ kind: 'rect', width: 3, height: 0.5, fill: '#112233', fill2: '#445566' }).params.fillType).toBe('linear');
	});

	test('a path: 2D vertices, corners by default, smooth on request; closed fills, open is a line', () => {
		const open = vectorArgs({ kind: 'path', vertices: [[0, 0], [1, 0], [1, 1]] }).params;
		expect(open.kind).toBe('path');
		expect(open.paths[0].closed).toBe(false);
		expect(open.paths[0].nodes.every((n) => n.ox === 0 && n.ix === 0)).toBe(true);
		expect(open.fillType).toBe('none');
		expect(open.strokeWidth).toBeGreaterThan(0);
		const closed = vectorArgs({ kind: 'path', vertices: [[0, 0], [1, 0], [1, 1]], closed: true, smooth: true }).params;
		expect(closed.paths[0].closed).toBe(true);
		expect(closed.fillType).toBe('solid');
		expect(closed.paths[0].nodes.some((n) => n.ox !== 0 || n.oy !== 0)).toBe(true);
	});

	test('svg: the text is handed on as is (the untrusted-file gate runs where it is placed)', () => {
		expect(vectorArgs({ kind: 'svg', svg: '<svg></svg>' })).toEqual({ svg: '<svg></svg>' });
	});

	test('one plain error naming the field', () => {
		expect(vectorArgs({ kind: 'blob' }).error).toMatch(/^kind: one of rect/);
		expect(vectorArgs({ kind: 'rect', width: 'wide' }).error).toBe('width: a number');
		expect(vectorArgs({ kind: 'rect', fill: 'red' }).error).toMatch(/^fill: a hex colour/);
		expect(vectorArgs({ kind: 'star', count: 2 }).error).toMatch(/^count: a whole number 3..32/);
		expect(vectorArgs({ kind: 'path', vertices: [[0, 0]] }).error).toMatch(/^vertices: at least two/);
		expect(vectorArgs({ kind: 'path', vertices: [[0, 0], ['a', 1]] }).error).toMatch(/^vertices: each one/);
		expect(vectorArgs({ kind: 'svg' }).error).toMatch(/^svg: /);
		expect(vectorArgs({ kind: 'rect', fillType: 'plaid' }).error).toMatch(/^fillType/);
	});
});
