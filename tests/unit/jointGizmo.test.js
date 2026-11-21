// @ts-nocheck - a fixture test (checkJs covers tests/unit)
import { describe, it, expect } from 'vitest';
import { jointGizmoSegments, rotate, perpendicular, GIZMO_COLORS } from '../../src/lib/jointGizmo.js';

// 102b row 2: what the joint gizmo draws for each kind
const I = [0, 0, 0, 1];
const run = (def, a = [0, 0, 0], b = [0, 0, 0], q = I) => {
	const pos = [];
	const col = [];
	jointGizmoSegments(def, a, b, q, pos, col);
	const segs = [];
	for (let i = 0; i < pos.length; i += 6) segs.push({ p: pos.slice(i, i + 3), r: pos.slice(i + 3, i + 6), c: col.slice(i, i + 3) });
	return segs;
};
const near = (u, v) => u.every((x, i) => Math.abs(x - v[i]) < 1e-6);

describe('102b joint gizmo', () => {
	it('rotates the axis of a into the world', () => {
		const q90z = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
		expect(near(rotate(q90z, [1, 0, 0]), [0, 1, 0])).toBe(true);
		const p = perpendicular([0, 1, 0]);
		expect(Math.abs(p[1])).toBeLessThan(1e-9);
	});
	it('a slider with limits draws its travel and two end ticks along a\'s axis', () => {
		const segs = run({ kind: 'prismatic', axisA: [1, 0, 0], limits: [-1, 2] });
		const travel = segs.find((s) => near(s.p, [-1, 0, 0]) && near(s.r, [2, 0, 0]));
		expect(near(travel.c, GIZMO_COLORS.limit)).toBe(true);
		expect(segs.filter((s) => near(s.c, GIZMO_COLORS.limit)).length).toBe(3);
	});
	it('a hinge without limits draws only its axis; with limits an arc too', () => {
		const plain = run({ kind: 'revolute', axisA: [0, 1, 0] });
		expect(plain.filter((s) => near(s.c, GIZMO_COLORS.axis)).length).toBe(1);
		const limited = run({ kind: 'revolute', axisA: [0, 1, 0], limits: [0, Math.PI / 2] });
		expect(limited.filter((s) => near(s.c, GIZMO_COLORS.limit)).length).toBe(16 + 2);
	});
	it('a rope is slack or taut by colour, with a tick where it goes taut', () => {
		const slack = run({ kind: 'rope', length: 3 }, [0, 0, 0], [0, -1, 0]);
		expect(slack.some((s) => near(s.c, GIZMO_COLORS.ropeSlack))).toBe(true);
		const tick = slack.find((s) => near(s.c, GIZMO_COLORS.limit));
		expect(Math.abs((tick.p[1] + tick.r[1]) / 2 + 3)).toBeLessThan(1e-6);
		const taut = run({ kind: 'rope', length: 1 }, [0, 0, 0], [0, -1, 0]);
		expect(taut.some((s) => near(s.c, GIZMO_COLORS.ropeTaut))).toBe(true);
		expect(taut.some((s) => near(s.c, GIZMO_COLORS.limit))).toBe(false);
	});
	it('a spring zigzags from one anchor to the other', () => {
		const segs = run({ kind: 'spring', rest: 2 }, [0, 0, 0], [0, 2, 0]).filter((s) => near(s.c, GIZMO_COLORS.spring));
		expect(segs.length).toBe(11);
		expect(near(segs[0].p, [0, 0, 0]) && near(segs[10].r, [0, 2, 0])).toBe(true);
	});
	it('a ball draws three rings; weld and an unknown kind draw only anchors (+ the weld line)', () => {
		expect(run({ kind: 'spherical' }).filter((s) => near(s.c, GIZMO_COLORS.axis)).length).toBe(36);
		expect(run({ kind: 'weld' }).length).toBe(4);
		expect(run({ kind: 'future' }).length).toBe(3);
	});
});
