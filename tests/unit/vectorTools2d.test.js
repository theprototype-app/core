// @ts-nocheck
// 64-vector-edit: the vector rows of 64-2d's 2D toolbar follow its contract (src/lib/sprite2d/tools2d.js header):
// a default array of {id, label, icon, order, run, active?, disarm?}, pen at 20 and shapes at 30.
import { describe, test, expect } from 'vitest';
import { get } from 'svelte/store';
import tools from '../../src/lib/vector/tools2d.js';
import { vectorTool } from '../../src/lib/vector/vectorGate.js';

describe('vector tools2d', () => {
	test('pen 20, shapes 30, each a complete row', () => {
		expect(tools.map((t) => [t.id, t.order])).toEqual([['pen', 20], ['shapes', 30]]);
		for (const t of tools) {
			expect(typeof t.label).toBe('string');
			expect(typeof t.icon).toBe('string');
			expect(typeof t.run).toBe('function');
			expect(typeof t.disarm).toBe('function');
		}
	});
	test('a row lights while its tool is armed', () => {
		const [pen, shapes] = tools;
		vectorTool.set('pen');
		expect([get(pen.active), get(shapes.active)]).toEqual([true, false]);
		vectorTool.set('star');
		expect([get(pen.active), get(shapes.active)]).toEqual([false, true]);
		vectorTool.set(null);
		expect([get(pen.active), get(shapes.active)]).toEqual([false, false]);
	});
});
