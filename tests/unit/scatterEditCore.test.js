// 51 E4/E5 — the pure half of editing scatter instances (src/lib/scatterEditCore.js) and the
// per-terrain splat resample (terrainPaintCore.resampleSplat).
import { describe, test, expect } from 'vitest';
import {
	indicesInRect,
	rotateEach,
	scaleEach,
	setPoses,
	transformGroup,
	deleteSelected,
	rerollSelected,
	centroid,
	rotateBrush,
	scaleBrush,
	relaxBrush,
	eraseBrush,
	falloff,
	yawOfQuaternion,
	commonSource,
	wrapYaw,
	EDIT_SCALE_MAX
} from '../../src/lib/scatterEditCore.js';
import { rng32 } from '../../src/lib/terrainScatterCore.js';
import { createSplat, paintSplatAt, resampleSplat, layerCoverage } from '../../src/lib/terrainPaintCore.js';

const B = { minX: -10, minZ: -10, sizeX: 20, sizeZ: 20 };
/** @param {number} x @param {number} z @param {number} [yaw] @param {number} [scale] */
const I = (x, z, yaw = 0, scale = 1) => ({ x, z, yaw, scale });
const near = (/** @type {number} */ a, /** @type {number} */ b, eps = 1e-9) => Math.abs(a - b) < eps;

describe('selection ops', () => {
	const list = [I(0, 0), I(1, 0, 1), I(5, 5, 2, 2)];

	test('a box picks by projected point, corners in any order, hidden points never', () => {
		const pts = [
			{ sx: 10, sy: 10, visible: true },
			{ sx: 50, sy: 50, visible: true },
			{ sx: 20, sy: 20, visible: false }
		];
		expect([...indicesInRect(pts, { x0: 60, y0: 60, x1: 0, y1: 0 })]).toEqual([0, 1]);
		expect([...indicesInRect(pts, { x0: 0, y0: 0, x1: 30, y1: 30 })]).toEqual([0]);
	});

	test('rotate / scale touch only the selection and never mutate the input', () => {
		const ids = new Set([1]);
		const r = rotateEach(list, ids, Math.PI);
		expect(r[1].yaw).toBeCloseTo(1 + Math.PI);
		expect(r[0]).toBe(list[0]);
		expect(list[1].yaw).toBe(1);
		const s = scaleEach(list, new Set([2]), 100);
		expect(s[2].scale).toBe(EDIT_SCALE_MAX);
		expect(s[1]).toBe(list[1]);
	});

	test('setPoses writes only finite fields and wraps yaw', () => {
		const out = setPoses(list, new Map([[0, { x: 3, yaw: -Math.PI / 2 }]]));
		expect(out[0]).toEqual({ x: 3, z: 0, yaw: wrapYaw(-Math.PI / 2), scale: 1 });
		expect(out[1]).toBe(list[1]);
	});

	test('a group turn of a quarter about the pivot moves +x to -z (three rotation.y) and turns each yaw', () => {
		const out = transformGroup([I(2, 0), I(0, 0)], new Set([0]), { dx: 0, dz: 0, dyaw: Math.PI / 2, factor: 1, pivot: { x: 0, z: 0 } });
		expect(near(out[0].x, 0, 1e-12)).toBe(true);
		expect(near(out[0].z, -2, 1e-12)).toBe(true);
		expect(out[0].yaw).toBeCloseTo(Math.PI / 2);
		const scaled = transformGroup([I(2, 0)], new Set([0]), { dx: 1, dz: 0, dyaw: 0, factor: 2, pivot: { x: 1, z: 0 } });
		expect(scaled[0]).toEqual({ x: 4, z: 0, yaw: 0, scale: 2 });
	});

	test('delete keeps order and remaps the survivors', () => {
		const { list: kept, remap } = deleteSelected(list, new Set([0]));
		expect(kept).toEqual([list[1], list[2]]);
		expect([...remap]).toEqual([
			[1, 0],
			[2, 1]
		]);
	});

	test('re-roll changes only the selected look; positions and every other instance stay', () => {
		const ids = new Set([0, 2]);
		const a = rerollSelected(list, ids, rng32(7), { scaleMin: 0.5, scaleMax: 1.5, randomRotation: true });
		const b = rerollSelected(list, ids, rng32(7), { scaleMin: 0.5, scaleMax: 1.5, randomRotation: true });
		expect(a).toEqual(b); // the same seed gives the same re-roll (peers agree)
		expect(a[1]).toBe(list[1]);
		for (const i of ids) {
			expect(a[i].x).toBe(list[i].x);
			expect(a[i].z).toBe(list[i].z);
			expect(a[i].scale).toBeGreaterThanOrEqual(0.5);
			expect(a[i].scale).toBeLessThanOrEqual(1.5);
		}
		const keepYaw = rerollSelected(list, ids, rng32(7), { scaleMin: 1, scaleMax: 1, randomRotation: false });
		expect(keepYaw[2].yaw).toBe(2);
	});

	test('centroid is the mean of the selection (null for none)', () => {
		expect(centroid(list, new Set([0, 1]))).toEqual({ x: 0.5, z: 0 });
		expect(centroid(list, new Set())).toBeNull();
	});
});

describe('brushes', () => {
	test('falloff is 1 at the centre and 0 at and past the rim', () => {
		expect(falloff(0, 2)).toBe(1);
		expect(falloff(2, 2)).toBe(0);
		expect(falloff(3, 2)).toBe(0);
		expect(falloff(1, 2)).toBeCloseTo(0.5);
	});

	test('rotate brush turns what is under it, more at the centre, reverse goes back', () => {
		const list = [I(0, 0), I(1, 0), I(9, 9)];
		const { list: out, changed } = rotateBrush(list, 0, 0, 2, 1, 0.1);
		expect(changed).toBe(2);
		expect(out[0].yaw).toBeGreaterThan(out[1].yaw);
		expect(out[2]).toBe(list[2]);
		const back = rotateBrush(out, 0, 0, 2, 1, 0.1, true).list;
		expect(back[0].yaw).toBeCloseTo(0);
	});

	test('scale brush grows and shrinks symmetrically and honours the filter', () => {
		const list = [I(0, 0), I(0.5, 0)];
		const grown = scaleBrush(list, 0, 0, 2, 1, 0.5, false, (i) => i === 0).list;
		expect(grown[0].scale).toBeGreaterThan(1);
		expect(grown[1]).toBe(list[1]);
		const shrunk = scaleBrush(grown, 0, 0, 2, 1, 0.5, true, (i) => i === 0).list;
		expect(shrunk[0].scale).toBeCloseTo(1);
	});

	test('relax spreads a clump, stays inside the brush, and is deterministic', () => {
		const rng = rng32(3);
		const clump = Array.from({ length: 12 }, () => I((rng() - 0.5) * 0.6, (rng() - 0.5) * 0.6));
		const minGap = (/** @type {any[]} */ l) => {
			let m = Infinity;
			for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) m = Math.min(m, Math.hypot(l[i].x - l[j].x, l[i].z - l[j].z));
			return m;
		};
		let a = clump;
		let b = clump;
		for (let k = 0; k < 40; k++) {
			a = relaxBrush(a, 0, 0, 3, 1, 0.05, B).list;
			b = relaxBrush(b, 0, 0, 3, 1, 0.05, B).list;
		}
		expect(a).toEqual(b);
		expect(minGap(a)).toBeGreaterThan(minGap(clump) * 2);
		for (const p of a) expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(3 + 1e-9);
		// two instances on the exact same spot separate (and the same way every time)
		const stacked = relaxBrush([I(0, 0), I(0, 0)], 0, 0, 2, 1, 0.1, B).list;
		expect(Math.hypot(stacked[0].x - stacked[1].x, stacked[0].z - stacked[1].z)).toBeGreaterThan(0);
		expect(relaxBrush([I(0, 0), I(0, 0)], 0, 0, 2, 1, 0.1, B).list).toEqual(stacked);
	});

	test('relax never moves what is outside the brush and needs two to act', () => {
		const list = [I(0, 0), I(0.1, 0), I(2.5, 0)];
		const out = relaxBrush(list, 0, 0, 2, 1, 0.1, B).list;
		expect(out[2]).toBe(list[2]);
		expect(relaxBrush([I(0, 0)], 0, 0, 2, 1, 0.1, B).changed).toBe(0);
	});

	test('erase brush drops what the filter admits inside the circle', () => {
		const list = [I(0, 0), I(0.5, 0), I(5, 0)];
		expect(eraseBrush(list, 0, 0, 1).list).toEqual([list[2]]);
		const only1 = eraseBrush(list, 0, 0, 1, (i) => i === 1);
		expect(only1.list).toEqual([list[0], list[2]]);
		expect(only1.changed).toBe(1);
	});
});

describe('E5 helpers', () => {
	test('yawOfQuaternion reads three rotation.y back', () => {
		for (const yaw of [0, 0.5, 2, -1.2, 3]) {
			const h = yaw / 2;
			expect(yawOfQuaternion({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) })).toBeCloseTo(wrapYaw(yaw));
		}
	});

	test('commonSource needs two copies of ONE convertible source', () => {
		const key = (/** @type {any} */ o) => o.k;
		expect(commonSource([{ k: 'p:Cone' }], key).ok).toBe(false);
		expect(commonSource([{ k: 'p:Cone' }, { k: 'p:Box' }], key).ok).toBe(false);
		expect(commonSource([{ k: 'p:Cone' }, { k: '' }], key).ok).toBe(false);
		expect(commonSource([{ k: 'p:Cone' }, { k: 'p:Cone' }], key)).toEqual({ ok: true, key: 'p:Cone' });
	});
});

describe('splat resample', () => {
	/** @param {Uint8Array} bytes */
	const sums255 = (bytes) => {
		for (let o = 0; o < bytes.length; o += 4) if (bytes[o] + bytes[o + 1] + bytes[o + 2] + bytes[o + 3] !== 255) return false;
		return true;
	};

	test('up and back keeps the weights summing to 255 and the coverage', () => {
		const bytes = createSplat(64);
		for (let k = 0; k < 30; k++) paintSplatAt(bytes, 64, 0.3 + k * 0.01, 0.5, 0.15, 2, 1, 0.1);
		const up = resampleSplat(bytes, 64, 256);
		expect(up.length).toBe(256 * 256 * 4);
		expect(sums255(up)).toBe(true);
		expect(layerCoverage(up, 2)).toBeCloseTo(layerCoverage(bytes, 2), 2);
		const back = resampleSplat(up, 256, 64);
		expect(sums255(back)).toBe(true);
		let worst = 0;
		for (let i = 0; i < bytes.length; i++) worst = Math.max(worst, Math.abs(back[i] - bytes[i]));
		expect(worst).toBeLessThanOrEqual(24); // a box-down of a bilinear-up blurs a hard edge a little
		expect(layerCoverage(back, 2)).toBeCloseTo(layerCoverage(bytes, 2), 2);
	});

	test('the same size is a copy', () => {
		const bytes = createSplat(8);
		const same = resampleSplat(bytes, 8, 8);
		expect(same).toEqual(bytes);
		expect(same).not.toBe(bytes);
	});
});
