// @ts-nocheck — plain fixtures; the code under test is typed
// 36-fb F24: flow paths, headless — a river steers a stream along a bend, a recycling river is
// a closed loop that never runs dry against the lifetime cap, a pipe moves water from its
// intake to its outlet, and a floater's pose is a pure function of (path, start, time).
import { describe, it, expect } from 'vitest';
import { FluidSolver } from '../../src/lib/sim/fluidCore.js';
import { normalizeFlowPath, compileFlow, applyFlows, arcLengths, pointAt, floatAt, arcLengthOf, FLOW_PATH_DEFAULTS } from '../../src/lib/sim/flowPathCore.js';

const G = { gravity: [0, -9.81, 0], viscosity: 0.05, surfaceTension: 0.5 };

function openSolver(n = 600, half = [2, 1, 2], floor = true) {
	const s = new FluidSolver({ min: half.map((v) => -v), max: half, capacity: n, spacing: 0.05 });
	s.setWalls([false, false, floor, false, false, false]);
	return s;
}

describe('normalizeFlowPath', () => {
	it('types, clamps, drops duplicate points; fewer than two points = the default path', () => {
		const f = normalizeFlowPath({ kind: 'lava', points: [[0, 0, 0], [0, 0, 0], [1, 'x', 0], [2, 0, 0]], width: 99, speed: -3 });
		expect(f.kind).toBe('river');
		expect(f.points).toEqual([[0, 0, 0], [2, 0, 0]]);
		expect(f.width).toBe(10);
		expect(f.speed).toBe(0);
		expect(normalizeFlowPath({ points: [[1, 1, 1]] }).points).toEqual(FLOW_PATH_DEFAULTS.points.map((p) => [...p]));
		expect(normalizeFlowPath({ kind: 'pipe' }).kind).toBe('pipe');
	});
	it('arc lengths and pointAt', () => {
		const pts = [[0, 0, 0], [3, 0, 0], [3, 0, 4]];
		const { cum, total } = arcLengths(pts);
		expect(total).toBe(7);
		const a = pointAt(pts, cum, 5);
		expect(a.p).toEqual([3, 0, 2]);
		expect(a.t).toEqual([0, 0, 1]);
		expect(arcLengthOf(pts, [3.2, 0.1, 1])).toBeCloseTo(4, 5);
	});
});

describe('river', () => {
	/** a stream released at the start of a right-angle chute: where does it go? */
	function bend(withFlow) {
		const s = openSolver(800, [2, 1, 2]);
		const spec = normalizeFlowPath({ points: [[-1.5, -0.9, 0], [0.5, -0.9, 0], [0.5, -0.9, 1.6]], width: 0.5, depth: 0.3, speed: 1.5, strength: 6 });
		const flows = [compileFlow(spec, spec.points)];
		for (let f = 0; f < 240; f++) {
			if (f < 120) for (let k = 0; k < 4; k++) s.spawn([-1.5 + (k % 2) * 0.05, -0.85, (k >> 1) * 0.05], [0.5, 0, 0]);
			s.step(1 / 60, { ...G, walls: s.walls });
			if (withFlow) applyFlows(s, flows, 1 / 60);
		}
		let turned = 0;
		for (let i = 0; i < s.count; i++) if (s.x[i * 3 + 2] > 0.8 && Math.abs(s.x[i * 3] - 0.5) < 0.35) turned++;
		return { turned, n: s.count };
	}
	it('steers a stream round a bend — counterfactual: without the flow it does not turn', () => {
		const on = bend(true);
		const off = bend(false);
		expect(on.turned).toBeGreaterThan(on.n * 0.3);
		expect(off.turned).toBeLessThan(on.turned / 4);
	});
	it('a recycling river is a closed loop: the same particles go round, never aging out', () => {
		const s = openSolver(300, [2, 1, 2]);
		const spec = normalizeFlowPath({ points: [[-1.5, -0.9, 0], [1.5, -0.9, 0]], width: 0.6, depth: 0.4, speed: 2, strength: 8, recycle: true });
		const flows = [compileFlow(spec, spec.points)];
		for (let k = 0; k < 200; k++) s.spawn([-1.4 + (k % 20) * 0.05, -0.9 + Math.floor(k / 20) * 0.02, 0], [2, 0, 0]);
		let recycled = 0;
		for (let f = 0; f < 600; f++) {
			s.step(1 / 60, { ...G, walls: s.walls, lifetime: 3 });
			recycled += applyFlows(s, flows, 1 / 60).recycled;
		}
		// 10 s with a 3 s lifetime: without the loop every particle would be gone
		expect(s.count).toBeGreaterThan(150);
		expect(recycled).toBeGreaterThan(200);
		for (let i = 0; i < s.count; i++) expect(s.x[i * 3]).toBeLessThan(1.6 + 0.2);
	});
	it('outside the tube nothing is touched', () => {
		const s = openSolver(10);
		s.spawn([0, 0.5, 1.5], [0, 0, 0]);
		const spec = normalizeFlowPath({ points: [[-1, 0, 0], [1, 0, 0]], width: 0.4, depth: 0.2, speed: 3, strength: 40 });
		const st = applyFlows(s, [compileFlow(spec, spec.points)], 1 / 60);
		expect(st.steered).toBe(0);
		expect(s.v[0]).toBe(0);
	});
});

describe('pipe', () => {
	it('swallows at the intake and pours from the outlet along its last segment', () => {
		const s = openSolver(50);
		for (let k = 0; k < 10; k++) s.spawn([-1 + k * 0.01, -0.5, 0], [0, 0, 0]);
		const spec = normalizeFlowPath({ kind: 'pipe', points: [[-1, -0.5, 0], [-1, 0.8, 0], [0.5, 0.8, 0]], width: 0.4, speed: 2 });
		const st = applyFlows(s, [compileFlow(spec, spec.points)], 1 / 60);
		expect(st.piped).toBe(10);
		for (let i = 0; i < 10; i++) {
			expect(s.x[i * 3]).toBeCloseTo(0.5, 0);
			expect(s.x[i * 3 + 1]).toBeGreaterThan(0.7);
			expect(s.v[i * 3]).toBeCloseTo(2, 5);
			expect(s.age[i]).toBe(0);
		}
	});
});

describe('floaters', () => {
	it('a pose is a pure function of (path, start, time) and wraps at the end', () => {
		const pts = [[0, 0, 0], [4, 0, 0]];
		const a = floatAt(pts, 1, 0.5, 2);
		const b = floatAt(pts, 1, 0.5, 2);
		expect(a).toEqual(b);
		expect(a.p[0]).toBeCloseTo(2, 6);
		expect(floatAt(pts, 1, 0.5, 8).p[0]).toBeCloseTo(1, 6); // 1 + 4 = 5 → wraps to 1
	});
});
