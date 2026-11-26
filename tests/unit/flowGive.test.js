import { describe, it, expect } from 'vitest';
import { flowCopyFor } from '../../src/lib/flowGive.js';

// 102b-flows row 2: "Give this flow to the selection" — the copy one receiver gets.
describe('flowCopyFor', () => {
	const doc = {
		nodes: [
			{ id: 'c', type: 'onclick', position: { x: 0, y: 0 }, data: {}, __graph: 'A' },
			{ id: 's', type: 'objectselector', position: { x: 200, y: 0 }, data: { selected: 'A' } },
			{ id: 'o', type: 'objectselector', position: { x: 200, y: 100 }, data: { selected: 'LAMP' } },
			{ id: 'v', type: 'visibility', position: { x: 100, y: 0 }, data: { target: 'A', on: false } }
		],
		edges: [
			{ id: 'e-c-v.on', source: 'c', target: 'v', targetHandle: 'on' },
			{ id: 'e-v-s', source: 'v', target: 's' },
			{ id: 'e-x-s', source: 'gone', target: 's' }
		]
	};
	let n = 0;
	const copy = flowCopyFor(doc, 'A', 'B', () => 'n' + n++);
	it('fresh node ids, canonical edge ids, dangling edges dropped', () => {
		expect(copy.nodes.map((/** @type {any} */ x) => x.id)).toEqual(['n0', 'n1', 'n2', 'n3']);
		expect(copy.edges.map((/** @type {any} */ e) => e.id)).toEqual(['e-n0-n3.on', 'e-n3-n1']);
	});
	it('references to the source point at the receiver; others are kept', () => {
		expect(copy.nodes[1].data.selected).toBe('B');
		expect(copy.nodes[2].data.selected).toBe('LAMP');
		expect(copy.nodes[3].data.target).toBe('B');
		expect(copy.nodes[3].data.on).toBe(false);
	});
	it('never shares data objects with the source, drops the graph stamp', () => {
		expect(copy.nodes[1].data).not.toBe(doc.nodes[1].data);
		expect(doc.nodes[1].data.selected).toBe('A');
		expect('__graph' in copy.nodes[0]).toBe(false);
	});
});
