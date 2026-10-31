// @ts-nocheck — plain fixtures; the module under test is typed
// 52 V1: the VR measure tool's arithmetic — the laser's snap cone, grid rounding, the angular point pick-up,
// the double-tap keep and the distance-scaled label.
import { describe, it, expect } from 'vitest';
import {
	VR_SNAP_CONE_DEG,
	VR_SNAP_RADIUS_PX,
	VR_DOUBLE_TAP_MS,
	VR_LABEL_ANGLE,
	rayCameraFov,
	snapToGrid,
	angularPick,
	isDoubleTap,
	labelWorldHeight,
	labelPxMetrics,
	coneBias
} from '../../src/lib/vrMeasureCore.js';

describe('rayCameraFov', () => {
	it('puts the engine radius exactly on the cone, at any view height', () => {
		for (const h of [480, 720, 1080]) {
			const fov = rayCameraFov(h);
			// the px at which a direction `cone` off-centre projects, in that camera
			const px = (Math.tan((VR_SNAP_CONE_DEG * Math.PI) / 180) / Math.tan((fov * Math.PI) / 360)) * (h / 2);
			expect(px).toBeCloseTo(VR_SNAP_RADIUS_PX, 6);
		}
	});
	it('a missing view height falls back instead of dividing by zero', () => {
		expect(Number.isFinite(rayCameraFov(0))).toBe(true);
	});
});

describe('snapToGrid', () => {
	it('a raw surface point lands on the grid in x and z and keeps its height', () => {
		expect(snapToGrid([1.26, 0.83, -0.74], 0.5, '')).toEqual({ point: [1.5, 0.83, -0.5], snap: 'grid' });
	});
	it('a ground point rounds y too', () => {
		expect(snapToGrid([0.2, 0.01, 0.9], 0.25, 'ground')).toEqual({ point: [0.25, 0, 1], snap: 'grid' });
	});
	it('no grid = the point and its snap kind unchanged', () => {
		expect(snapToGrid([1.26, 0.83, -0.74], 0, 'ground')).toEqual({ point: [1.26, 0.83, -0.74], snap: 'ground' });
	});
});

describe('angularPick', () => {
	const o = [0, 1.5, 0];
	const d = [0, 0, -1];
	it('picks the point nearest the laser by angle, near or far', () => {
		// 1° off at 10 m beats 2° off at 1 m
		const far = [Math.tan((1 * Math.PI) / 180) * 10, 1.5, -10];
		const near = [Math.tan((2 * Math.PI) / 180) * 1, 1.5, -1];
		expect(angularPick(o, d, [near, far])).toBe(1);
	});
	it('nothing inside the cone = -1, and a point behind the hand never counts', () => {
		expect(angularPick(o, d, [[1, 1.5, -1]])).toBe(-1);
		expect(angularPick(o, d, [[0, 1.5, 2]])).toBe(-1);
	});
});

describe('isDoubleTap', () => {
	it('a second press soon after, on the same spot, keeps the chain', () => {
		expect(isDoubleTap({ at: 1000, point: [1, 0, 0] }, 1000 + VR_DOUBLE_TAP_MS - 1, [1.01, 0, 0], 2)).toBe(true);
	});
	it('too late, too far, or no previous point is a new point', () => {
		expect(isDoubleTap({ at: 1000, point: [1, 0, 0] }, 1000 + VR_DOUBLE_TAP_MS + 1, [1, 0, 0], 2)).toBe(false);
		expect(isDoubleTap({ at: 1000, point: [1, 0, 0] }, 1100, [1.2, 0, 0], 2)).toBe(false);
		expect(isDoubleTap({ at: 0, point: null }, 10, [1, 0, 0], 2)).toBe(false);
	});
	it('the tolerance grows with distance (2 %), never below 3 cm', () => {
		expect(isDoubleTap({ at: 0, point: [0, 0, 0] }, 10, [0.15, 0, 0], 10)).toBe(true);
		expect(isDoubleTap({ at: 0, point: [0, 0, 0] }, 10, [0.029, 0, 0], 0.5)).toBe(true);
	});
});

describe('labels', () => {
	it('a label is the same ANGLE tall near and far (between the clamps)', () => {
		expect(labelWorldHeight(1) / 1).toBeCloseTo(VR_LABEL_ANGLE, 9);
		expect(labelWorldHeight(8) / 8).toBeCloseTo(VR_LABEL_ANGLE, 9);
		expect(labelWorldHeight(0.01)).toBeGreaterThan(0);
		expect(labelWorldHeight(1000)).toBeLessThanOrEqual(1.5);
	});
	it('the layout metrics are a whole line tall in the virtual view, wider than tall per two chars', () => {
		const m = labelPxMetrics(1000, 90);
		expect(m.h).toBeGreaterThan((VR_LABEL_ANGLE / (Math.PI / 2)) * 1000);
		expect(m.charW * 2).toBeCloseTo(m.h, 6);
	});
});

describe('coneBias', () => {
	it('scales the desktop pull with the reach: the same RELATIVE pull inside the cone', () => {
		const b = coneBias({ vertex: -16, edge: -6, face: -2 }, 18);
		expect(b.vertex / VR_SNAP_RADIUS_PX).toBeCloseTo(-16 / 18, 9);
		expect(b.edge / VR_SNAP_RADIUS_PX).toBeCloseTo(-6 / 18, 9);
	});
	it('a corner 0.4 of the cone off beats an edge seen almost edge-on (0.04 of it off — the IWER case: a laser grazing a box top foreshortens the edge), as under the mouse', () => {
		const b = coneBias({ vertex: -16, edge: -6 }, 18);
		const vertex = 0.4 * VR_SNAP_RADIUS_PX + b.vertex;
		const edge = 0.04 * VR_SNAP_RADIUS_PX + b.edge;
		expect(vertex).toBeLessThan(edge);
		// unscaled, the edge won — the bug this exists for
		expect(0.4 * VR_SNAP_RADIUS_PX - 16).toBeGreaterThan(0.04 * VR_SNAP_RADIUS_PX - 6);
	});
});
