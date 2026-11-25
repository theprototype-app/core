// @ts-nocheck — a fixture test: results are asserted non-null by the checks themselves
// 64-vector-edit (D5): the pure half of editing a drawn path — several points moved at once,
// closing an open path, splitting a path at a point. The outline must not move when a loop is
// opened or a path is cut (the property a user sees), so those checks compare flattened outlines.
import { describe, test, expect } from 'vitest';
import { node, moveNodesBy, closable, closeSubpath, splitSubpathAt, flattenSubpath, insertNodeAt } from '../../src/lib/vector/vectorPath.js';

const tri = () => ({ closed: true, nodes: [node(0, 0), node(1, 0), node(0.5, 1)] });
const zig = () => ({ closed: false, nodes: [node(0, 0), node(1, 0, 0, 0, 0.3, 0.3, true), node(2, 1), node(3, 0)] });
/** total length of a polyline */
const length = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

describe('moveNodesBy', () => {
	test('moves exactly the picked points, handles ride along, a duplicate pick moves once', () => {
		const out = moveNodesBy([zig()], [{ sub: 0, index: 1 }, { sub: 0, index: 3 }, { sub: 0, index: 1 }], 0.5, -0.25);
		expect(out[0].nodes[1]).toMatchObject({ x: 1.5, y: -0.25, ox: 0.3, oy: 0.3 });
		expect(out[0].nodes[3]).toMatchObject({ x: 3.5, y: -0.25 });
		expect(out[0].nodes[0]).toMatchObject({ x: 0, y: 0 });
	});
	test('does not touch its input and ignores a pick that names nothing', () => {
		const src = [zig()];
		const out = moveNodesBy(src, [{ sub: 4, index: 0 }, { sub: 0, index: 9 }], 1, 1);
		expect(out).toEqual(src);
		expect(out).not.toBe(src);
	});
});

describe('close', () => {
	test('an open path of three closes, two straight points do not, two with a curve do', () => {
		expect(closable(zig())).toBe(true);
		expect(closeSubpath(zig()).closed).toBe(true);
		expect(closable({ closed: false, nodes: [node(0, 0), node(1, 0)] })).toBe(false);
		expect(closable({ closed: false, nodes: [node(0, 0, 0, 0, 0, 1), node(1, 0)] })).toBe(true);
		expect(closable(tri())).toBe(false);
	});
});

describe('split', () => {
	test('a closed loop opens at the point: same outline, the point is both ends', () => {
		const loop = insertNodeAt(tri(), 1, 0.5); // a smooth-free mid point on the second edge
		const parts = splitSubpathAt(loop, 2);
		expect(parts).toHaveLength(1);
		const open = parts[0];
		expect(open.closed).toBe(false);
		expect(open.nodes).toHaveLength(loop.nodes.length + 1);
		expect(open.nodes[0]).toMatchObject({ x: loop.nodes[2].x, y: loop.nodes[2].y, ix: 0, iy: 0 });
		const last = open.nodes[open.nodes.length - 1];
		expect([last.x, last.y]).toEqual([loop.nodes[2].x, loop.nodes[2].y]);
		expect(length(flattenSubpath(open))).toBeCloseTo(length([...flattenSubpath(loop), flattenSubpath(loop)[0]]), 6);
	});
	test('a curved loop keeps its curve across the opening', () => {
		const loop = { closed: true, nodes: [node(0, 0, 0, -0.4, 0, 0.4, true), node(1, 1), node(-1, 1)] };
		const open = splitSubpathAt(loop, 0)[0];
		expect(open.nodes[0]).toMatchObject({ ox: 0, oy: 0.4 });
		expect(open.nodes[open.nodes.length - 1]).toMatchObject({ ix: 0, iy: -0.4, ox: 0, oy: 0 });
	});
	test('an open path cuts in two at an interior point, both halves keep it', () => {
		const parts = splitSubpathAt(zig(), 2);
		expect(parts).toHaveLength(2);
		expect(parts[0].nodes.map((n) => n.x)).toEqual([0, 1, 2]);
		expect(parts[1].nodes.map((n) => n.x)).toEqual([2, 3]);
		expect(parts[0].nodes[1]).toMatchObject({ ox: 0.3, oy: 0.3 }); // the curve before the cut survives
		const whole = length(flattenSubpath(zig()));
		expect(length(flattenSubpath(parts[0])) + length(flattenSubpath(parts[1]))).toBeCloseTo(whole, 6);
	});
	test('an end point of an open path has nothing to split', () => {
		expect(splitSubpathAt(zig(), 0)).toBeNull();
		expect(splitSubpathAt(zig(), 3)).toBeNull();
		expect(splitSubpathAt(zig(), 7)).toBeNull();
	});
});
