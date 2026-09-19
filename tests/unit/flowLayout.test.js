import { describe, it, expect } from 'vitest';
import { freeRegion, NODE_W, NODE_H, GAP_X, GAP_Y, MARGIN } from '../../src/lib/flowLayout.js';

// R29 S1. The one "where does a built block of nodes land" rule — api.flow.freeRegion and
// the HUD editor's bindings both call it, so it is pinned here with no browser.

/** does a w x h block at p overlap any NODE_W x NODE_H card?
 * @param {any[]} nodes @param {{x: number, y: number}} p @param {number} w @param {number} h */
const overlaps = (nodes, p, w, h) =>
	nodes.some((/** @type {any} */ n) => {
		const x = n.position.x, y = n.position.y;
		return p.x < x + NODE_W && x < p.x + w && p.y < y + NODE_H && y < p.y + h;
	});
/** @param {number} x @param {number} y */
const at = (x, y) => ({ position: { x, y } });

describe('freeRegion', () => {
	it('an empty graph gets the margin', () => {
		expect(freeRegion([], { w: 300, h: 200 })).toEqual({ x: MARGIN, y: MARGIN, w: 300, h: 200 });
	});
	it('below: left-aligned, one gap under the lowest card', () => {
		const nodes = [at(60, 40), at(280, 400), at(-20, 120)];
		const p = freeRegion(nodes);
		expect(p.x).toBe(-20);
		expect(p.y).toBe(400 + NODE_H + GAP_Y);
	});
	it('a measured height is honoured over the estimate', () => {
		const p = freeRegion([{ position: { x: 0, y: 0 }, measured: { height: 400 } }]);
		expect(p.y).toBe(400 + GAP_Y);
	});
	it('accepts flat {x, y} snapshots (what api.flow.nodes returns)', () => {
		expect(freeRegion([{ x: 10, y: 20 }]).y).toBe(20 + NODE_H + GAP_Y);
	});
	it('two blocks placed in a row never overlap each other or the graph', () => {
		const graph = [at(60, 40), at(280, 40)];
		const first = freeRegion(graph, { w: 370, h: 150 });
		expect(overlaps(graph, first, 370, 150)).toBe(false);
		graph.push(at(first.x, first.y), at(first.x + 220, first.y));
		const second = freeRegion(graph, { w: 370, h: 150 });
		expect(overlaps(graph, second, 370, 150)).toBe(false);
		expect(second.y).toBeGreaterThan(first.y);
	});
	it("right: the HUD bindings' rule, byte-identical to what hudActions always computed", () => {
		const nodes = [at(100, 50), at(640, 90)];
		const legacy = nodes.reduce((max, n) => Math.max(max, n.position.x), 0) + 220;
		expect(freeRegion(nodes, { side: 'right' }).x).toBe(legacy);
		expect(NODE_W + GAP_X).toBe(220);
		// the empty graph was a phantom card at 0, so the first binding sits at 220
		expect(freeRegion([], { side: 'right' }).x).toBe(220);
	});
	it('garbage in is ignored, not thrown', () => {
		expect(freeRegion(/** @type {any} */ (null)).x).toBe(MARGIN);
		expect(freeRegion([null, at(0, 0)]).y).toBe(NODE_H + GAP_Y);
	});
});
