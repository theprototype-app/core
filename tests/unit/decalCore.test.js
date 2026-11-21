// @ts-nocheck - fixture-heavy test (checkJs covers tests/unit)
import { describe, it, expect } from 'vitest';
import {
	DECAL_DEFAULTS,
	DECAL_VERSION,
	normalizeDecal,
	isNewerDecalRecord,
	clipPolygon,
	projectDecal,
	targetRefusal,
	admitStamp,
	expireStamps,
	stampFade,
	stampCap,
	stampLifetime,
	decalPoseMatrix,
	mul4,
	STAMP_CAP_MAX
} from '../../src/lib/decalCore.js';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** column-major translate+scale */
const TS = (tx, ty, tz, sx = 1, sy = 1, sz = 1) => [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, tx, ty, tz, 1];

/** a quad in the XY plane facing +Z, half-size h, at z */
function quad(h, z = 0) {
	return {
		positions: new Float32Array([-h, -h, z, h, -h, z, h, h, z, -h, h, z]),
		index: new Uint32Array([0, 1, 2, 0, 2, 3]),
		meshToWorld: I
	};
}

describe('decal record', () => {
	it('defaults and clamps', () => {
		const r = normalizeDecal({ opacity: 4, tint: 'red', roughness: -1, angle: 120, image: 'ABCDEF0123456789' });
		expect(r.opacity).toBe(1);
		expect(r.tint).toBe(DECAL_DEFAULTS.tint);
		expect(r.roughness).toBe(0);
		expect(r.angle).toBe(89);
		expect(r.image).toBe('abcdef0123456789');
		expect(normalizeDecal(null)).toMatchObject({ v: DECAL_VERSION, image: '', opacity: 1 });
	});
	it('refuses a non-hash image (no URLs, no data)', () => {
		expect(normalizeDecal({ image: 'https://x.test/a.png' }).image).toBe('');
		expect(normalizeDecal({ image: 'data:image/png;base64,AAAA' }).image).toBe('');
	});
	it('keeps a newer record whole and says so', () => {
		const raw = { v: 2, glow: 3, opacity: 0.5 };
		expect(isNewerDecalRecord(raw)).toBe(true);
		const r = normalizeDecal(raw);
		expect(r.v).toBe(2);
		expect(r.glow).toBe(3);
		expect(r.opacity).toBe(0.5);
		expect(isNewerDecalRecord({ v: 1 })).toBe(false);
	});
});

describe('projection box maths', () => {
	it('clips a polygon to one plane and interpolates attributes', () => {
		const poly = [
			[0, 0, 0, 0],
			[1, 0, 0, 10],
			[1, 1, 0, 10],
			[0, 1, 0, 0]
		];
		const out = clipPolygon(poly, 0, 1);
		expect(out.length).toBe(4);
		for (const v of out) expect(v[0]).toBeLessThanOrEqual(0.5 + 1e-9);
		const cut = out.find((v) => Math.abs(v[0] - 0.5) < 1e-9);
		expect(cut?.[3]).toBeCloseTo(5);
	});
	it('a quad bigger than the box is cut to the box, uv 0..1', () => {
		const r = projectDecal([quad(2)], I, I);
		expect(r.tris).toBeGreaterThan(0);
		let minU = 1, maxU = 0;
		for (let i = 0; i < r.position.length; i += 3) {
			expect(Math.abs(r.position[i])).toBeLessThanOrEqual(0.5 + 1e-6);
			expect(Math.abs(r.position[i + 1])).toBeLessThanOrEqual(0.5 + 1e-6);
		}
		for (let i = 0; i < r.uv.length; i += 2) {
			minU = Math.min(minU, r.uv[i]);
			maxU = Math.max(maxU, r.uv[i]);
		}
		expect(minU).toBeCloseTo(0);
		expect(maxU).toBeCloseTo(1);
		// area of the kept surface = the box face (1 x 1)
		let area = 0;
		for (let i = 0; i < r.position.length; i += 9) {
			const ax = r.position[i + 3] - r.position[i], ay = r.position[i + 4] - r.position[i + 1];
			const bx = r.position[i + 6] - r.position[i], by = r.position[i + 7] - r.position[i + 1];
			area += Math.abs(ax * by - ay * bx) / 2;
		}
		expect(area).toBeCloseTo(1, 5);
	});
	it('depth limits what it wraps: a surface outside the box depth is not touched', () => {
		expect(projectDecal([quad(2, 0.6)], I, I).tris).toBe(0);
		expect(projectDecal([quad(2, 0.4)], I, I).tris).toBeGreaterThan(0);
	});
	it('back faces and grazing faces stay bare', () => {
		const back = quad(2);
		back.index = new Uint32Array([0, 2, 1, 0, 3, 2]);
		expect(projectDecal([back], I, I).tris).toBe(0);
		// a wall along the projector (normal +X) is beyond any angle
		const wall = {
			positions: new Float32Array([0, -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1]),
			index: new Uint32Array([0, 1, 2, 0, 2, 3]),
			meshToWorld: I
		};
		expect(projectDecal([wall], I, I).tris).toBe(0);
	});
	it('works in box space: a scaled, moved box clips in world units', () => {
		// box 2 x 4 x 1 centred at (5, 0, 0): its inverse maps world into the unit box
		const boxToWorld = TS(5, 0, 0, 2, 4, 1);
		const worldToBox = TS(-2.5, 0, 0, 0.5, 0.25, 1);
		expect(mul4(worldToBox, boxToWorld).map((v) => Math.round(v * 1e9) / 1e9)).toEqual(I);
		const src = quad(10);
		const r = projectDecal([src], worldToBox, boxToWorld);
		expect(r.tris).toBeGreaterThan(0);
		for (let i = 0; i < r.position.length; i += 3) expect(Math.abs(r.position[i])).toBeLessThanOrEqual(0.5 + 1e-6);
		// normals given as M^T n: for a +Z face under scale sz = 1 that stays +Z
		expect(r.normal[2]).toBeCloseTo(1);
	});
	it('pushes off the surface along +Z and carries the bake uv', () => {
		const src = { ...quad(2), uv2: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) };
		const r = projectDecal([src], I, I, { push: 0.01 });
		expect(r.position[2]).toBeCloseTo(0.01);
		expect(r.uv2).not.toBeNull();
		// a corner of the box (x=-0.5,y=-0.5) sits a quarter-way along the source quad's uv2
		for (let i = 0; i < r.position.length / 3; i++)
			if (Math.abs(r.position[i * 3] + 0.5) < 1e-6 && Math.abs(r.position[i * 3 + 1] + 0.5) < 1e-6) {
				expect(r.uv2?.[i * 2]).toBeCloseTo(0.375);
				expect(r.uv2?.[i * 2 + 1]).toBeCloseTo(0.375);
			}
	});
	it('caps the triangles it keeps', () => {
		const r = projectDecal([quad(2)], I, I, { maxTris: 1 });
		expect(r.tris).toBe(1);
		expect(r.capped).toBe(true);
	});
	it('the pose matrix puts +Z along the normal and keeps a wall decal upright', () => {
		const m = decalPoseMatrix([1, 2, 3], [1, 0, 0], [2, 1, 0.5]);
		expect([m[8], m[9], m[10]]).toEqual([0.5, 0, 0]);
		// local +Y (up) along world +Y on a wall
		expect(m[5]).toBeCloseTo(1);
		expect([m[12], m[13], m[14]]).toEqual([1, 2, 3]);
		const floor = decalPoseMatrix([0, 0, 0], [0, 1, 0], [1, 1, 1]);
		expect(floor[9]).toBeCloseTo(1);
	});
});

describe('targets refused in this version', () => {
	it('names the reason', () => {
		expect(targetRefusal({})).toBeNull();
		expect(targetRefusal({ skinned: true })).toMatch(/skinned/);
		expect(targetRefusal({ scattered: true })).toMatch(/scattered/);
		expect(targetRefusal({ instanced: true })).toMatch(/scattered/);
		expect(targetRefusal({ decal: true })).toMatch(/another decal/);
		expect(targetRefusal({ tris: 1e7 })).toMatch(/too detailed/);
	});
});

describe('stamp pool', () => {
	const s = (id, at, life = 0) => ({ id, at, life });
	it('evicts the oldest past the cap', () => {
		let list = [];
		for (let i = 0; i < 5; i++) list = admitStamp(list, s('a' + i, i * 10), 3).list;
		expect(list.map((x) => x.id)).toEqual(['a2', 'a3', 'a4']);
		const r = admitStamp(list, s('late', 100), 3);
		expect(r.evicted.map((x) => x.id)).toEqual(['a2']);
		expect(r.added).toBe(true);
	});
	it('an arrival older than everything at the cap is not added', () => {
		const list = [s('a', 10), s('b', 20)];
		const r = admitStamp(list, s('old', 1), 2);
		expect(r.added).toBe(false);
		expect(r.list.map((x) => x.id)).toEqual(['a', 'b']);
	});
	it('a resent stamp is ignored', () => {
		const list = [s('a', 10)];
		expect(admitStamp(list, s('a', 10)).added).toBe(false);
	});
	it('the same stamps in any order end in the same pool (every peer agrees)', () => {
		const all = [s('x', 5), s('y', 5), s('z', 1), s('w', 9)];
		let a = [];
		for (const t of all) a = admitStamp(a, t, 3).list;
		let b = [];
		for (const t of [...all].reverse()) b = admitStamp(b, t, 3).list;
		expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
	});
	it('expires and fades by lifetime', () => {
		const list = [s('a', 0, 2), s('b', 0, 0), s('c', 1500, 2)];
		const r = expireStamps(list, 2000);
		expect(r.expired.map((x) => x.id)).toEqual(['a']);
		expect(r.list.map((x) => x.id)).toEqual(['b', 'c']);
		expect(stampFade(s('c', 1500, 2), 3000)).toBeCloseTo(0.5);
		expect(stampFade(s('b', 0, 0), 99999)).toBe(1);
	});
	it('clamps the authored cap and lifetime', () => {
		expect(stampCap(500)).toBe(STAMP_CAP_MAX);
		expect(stampCap('x')).toBe(64);
		expect(stampCap(0)).toBe(1);
		expect(stampLifetime(-3)).toBe(0);
		expect(stampLifetime(1e9)).toBe(600);
	});
});
