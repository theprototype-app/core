// @ts-nocheck — a fixture test: hand-built geometry helpers, results asserted non-null by the checks themselves
import { describe, it, expect } from 'vitest';
import {
	buildSurface,
	placeOnSurface,
	generateSurfaceSlots,
	maskOf,
	passesMask,
	slopeDeg,
	splatWeightAt,
	surfaceDab,
	triangleIndex,
	eraseInSphere,
	encodeSurfaceRecords,
	decodeSurfaceRecords,
	boxOf,
	boxFrom,
	fillBudget,
	SURFACE_RECORD,
	ATTEMPTS_PER_INSTANCE
} from '../../src/lib/scatterSurfaceCore.js';

// ---- fixtures: geometry built by hand (this layer imports no three.js) -----------------------

/** mulberry32 */
function rng32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** the per-slot stream shape 51-sources' slotDraws uses: slot k is its OWN stream (seed, k) */
function slotSeed(seed, k) {
	let h = ((seed >>> 0) ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return (h ^ (h >>> 16)) >>> 0;
}
const drawsFor = (seed) => (k) => {
	const r = rng32(slotSeed(seed, k));
	return { u: r(), v: r(), yaw: r(), scale: r(), pick: r(), tint: r() };
};

/** a UV sphere: indexed positions + smooth normals (what three's SphereGeometry hands over) */
function sphere(radius, ws, hs) {
	const pos = [];
	const nrm = [];
	for (let y = 0; y <= hs; y++) {
		const v = y / hs;
		for (let x = 0; x <= ws; x++) {
			const u = x / ws;
			const px = -Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
			const py = Math.cos(v * Math.PI);
			const pz = Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
			pos.push(px * radius, py * radius, pz * radius);
			nrm.push(px, py, pz);
		}
	}
	const index = [];
	for (let y = 0; y < hs; y++)
		for (let x = 0; x < ws; x++) {
			const a = y * (ws + 1) + x + 1;
			const b = y * (ws + 1) + x;
			const c = (y + 1) * (ws + 1) + x;
			const d = (y + 1) * (ws + 1) + x + 1;
			if (y !== 0) index.push(a, b, d);
			if (y !== hs - 1) index.push(b, c, d);
		}
	return { pos: new Float32Array(pos), index: new Uint32Array(index), nrm: new Float32Array(nrm) };
}

/** a unit cube as a triangle soup (12 triangles, area 6), outward winding */
function cubeSoup(s = 1) {
	const h = s / 2;
	const quads = [
		// +y, -y, +x, -x, +z, -z (counter-clockwise seen from outside)
		[[-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h]],
		[[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]],
		[[h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h]],
		[[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]],
		[[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]],
		[[-h, -h, -h], [-h, h, -h], [h, h, -h], [h, -h, -h]]
	];
	const pos = [];
	for (const [a, b, c, d] of quads) pos.push(...a, ...b, ...c, ...a, ...c, ...d);
	return new Float32Array(pos);
}

/** a flat square in xz, n x n cells, y = 0 */
function plane(size, n) {
	const pos = [];
	const step = size / n;
	for (let i = 0; i < n; i++)
		for (let j = 0; j < n; j++) {
			const x0 = -size / 2 + i * step;
			const z0 = -size / 2 + j * step;
			const x1 = x0 + step;
			const z1 = z0 + step;
			pos.push(x0, 0, z0, x0, 0, z1, x1, 0, z1, x0, 0, z0, x1, 0, z1, x1, 0, z0);
		}
	return new Float32Array(pos);
}

const GEN = { scaleMin: 0.8, scaleMax: 1.2, rot: true };

// ---- the surface ------------------------------------------------------------------------------

describe('buildSurface', () => {
	it('measures the area and the bounds of a soup', () => {
		const S = buildSurface(cubeSoup(2));
		expect(S).not.toBeNull();
		expect(S.tris).toBe(12);
		expect(S.area).toBeCloseTo(24, 6);
		expect(S.min).toEqual([-1, -1, -1]);
		expect(S.max).toEqual([1, 1, 1]);
	});

	it('reads an indexed mesh and refuses one with no area', () => {
		const sp = sphere(1, 16, 12);
		const S = buildSurface(sp.pos, sp.index, sp.nrm);
		expect(S.tris).toBe(sp.index.length / 3);
		expect(S.area).toBeGreaterThan(12); // 4 pi = 12.57, a coarse sphere is a little less
		expect(S.area).toBeLessThan(4 * Math.PI);
		expect(buildSurface(new Float32Array(9))).toBeNull();
		expect(buildSurface(new Float32Array(0))).toBeNull();
	});
});

describe('placeOnSurface', () => {
	it('is uniform BY AREA: a triangle three times bigger gets three times the points', () => {
		// two triangles in one soup, areas 0.5 and 1.5
		const S = buildSurface(new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 5, 0, 0, 5, 0, 1, 8, 0, 0]));
		const r = rng32(7);
		let big = 0;
		const N = 20000;
		for (let k = 0; k < N; k++) if (placeOnSurface(S, r(), r()).x >= 5) big++;
		expect(big / N).toBeGreaterThan(0.72);
		expect(big / N).toBeLessThan(0.78);
	});

	it('puts every point on the surface with the interpolated normal', () => {
		const sp = sphere(2, 32, 24);
		const S = buildSurface(sp.pos, sp.index, sp.nrm);
		const r = rng32(3);
		for (let k = 0; k < 500; k++) {
			const p = placeOnSurface(S, r(), r());
			const len = Math.hypot(p.x, p.y, p.z);
			expect(len).toBeGreaterThan(1.97); // a chord sits a hair inside the true sphere
			expect(len).toBeLessThan(2.0001);
			// smooth normal ~ the radial direction
			expect((p.x * p.nx + p.y * p.ny + p.z * p.nz) / len).toBeGreaterThan(0.995);
		}
	});

	it('gives a soup its face normals (outward on a cube)', () => {
		const S = buildSurface(cubeSoup(1));
		const r = rng32(11);
		for (let k = 0; k < 200; k++) {
			const p = placeOnSurface(S, r(), r());
			expect(p.x * p.nx + p.y * p.ny + p.z * p.nz).toBeCloseTo(0.5, 5);
		}
	});
});

// ---- masks ------------------------------------------------------------------------------------

describe('masks', () => {
	it('drops a mask that lets everything through, so a default set writes none', () => {
		expect(maskOf({})).toEqual({});
		expect(maskOf({ slope: [0, 180] })).toEqual({});
		expect(maskOf({ slope: [40, 10] }).slope).toEqual([10, 40]);
		expect(maskOf({ slope: [0, 999] })).toEqual({});
		expect(maskOf({ height: [1, 'x'] })).toEqual({});
		expect(maskOf({ layer: { i: 7 } })).toEqual({});
		expect(maskOf({ layer: { i: 2 } }).layer).toEqual({ i: 2, min: 0.5 });
	});

	it('measures slope against local up', () => {
		expect(slopeDeg(1)).toBeCloseTo(0, 9);
		expect(slopeDeg(0)).toBeCloseTo(90, 9);
		expect(slopeDeg(-1)).toBeCloseTo(180, 9);
		const m = maskOf({ slope: [0, 30], height: [0, 5] });
		expect(passesMask(m, { y: 1, ny: Math.cos((20 * Math.PI) / 180) })).toBe(true);
		expect(passesMask(m, { y: 1, ny: Math.cos((40 * Math.PI) / 180) })).toBe(false);
		expect(passesMask(m, { y: 6, ny: 1 })).toBe(false);
	});

	it('a layer mask rejects everything on a host with no paint', () => {
		const m = maskOf({ layer: { i: 1, min: 0.3 } });
		expect(passesMask(m, { y: 0, ny: 1 }, null)).toBe(false);
		expect(passesMask(m, { y: 0, ny: 1 }, (i) => (i === 1 ? 0.4 : 0))).toBe(true);
	});

	it('reads a splat layer weight bilinearly, normalized like the shader', () => {
		const res = 8;
		const bytes = new Uint8Array(res * res * 4);
		for (let z = 0; z < res; z++)
			for (let x = 0; x < res; x++) {
				const o = (z * res + x) * 4;
				if (x < res / 2) bytes[o] = 255;
				else bytes[o + 2] = 255;
			}
		const b = { minX: 0, minZ: 0, sizeX: 8, sizeZ: 8 };
		expect(splatWeightAt(bytes, res, b, 1, 4, 0)).toBeCloseTo(1, 6);
		expect(splatWeightAt(bytes, res, b, 7, 4, 2)).toBeCloseTo(1, 6);
		expect(splatWeightAt(bytes, res, b, 4, 4, 2)).toBeCloseTo(0.5, 6);
	});
});

// ---- fill -------------------------------------------------------------------------------------

describe('generateSurfaceSlots (FILL)', () => {
	const sp = sphere(3, 48, 32);
	const S = buildSurface(sp.pos, sp.index, sp.nrm);

	it('COUNT mode places exactly the count, even through a mask', () => {
		expect(generateSurfaceSlots({ ...GEN, count: 300 }, S, { draws: drawsFor(1) })).toHaveLength(300);
		const top = generateSurfaceSlots({ ...GEN, count: 300, slope: [0, 45] }, S, { draws: drawsFor(1) });
		expect(top).toHaveLength(300);
		for (const p of top) expect(slopeDeg(p.ny)).toBeLessThanOrEqual(45 + 1e-6);
	});

	it('COUNT mode gives up after ATTEMPTS_PER_INSTANCE x count when the mask leaves no room', () => {
		const none = generateSurfaceSlots({ ...GEN, count: 50, height: [100, 200] }, S, { draws: drawsFor(1) });
		expect(none).toHaveLength(0);
		expect(fillBudget({ count: 50 }, 10).attempts).toBe(50 * ATTEMPTS_PER_INSTANCE);
	});

	it('DENSITY mode draws density x area slots, so a mask keeps the density where it passes', () => {
		const Sp = buildSurface(plane(10, 10)); // 100 m²
		const all = generateSurfaceSlots({ ...GEN, density: 2 }, Sp, { draws: drawsFor(9) });
		expect(all).toHaveLength(200);
		const half = generateSurfaceSlots({ ...GEN, density: 2, height: [-1, 1] }, Sp, {
			draws: drawsFor(9),
			accept: (p) => p.x < 0
		});
		expect(half.length).toBeGreaterThan(80);
		expect(half.length).toBeLessThan(120);
	});

	it('a height range keeps instances inside it (local Y)', () => {
		const band = generateSurfaceSlots({ ...GEN, count: 200, height: [-1, 1] }, S, { draws: drawsFor(4) });
		expect(band).toHaveLength(200);
		for (const p of band) {
			expect(p.y).toBeGreaterThanOrEqual(-1);
			expect(p.y).toBeLessThanOrEqual(1);
		}
	});

	it('a painted-layer mask follows the paint', () => {
		const Sp = buildSurface(plane(8, 8));
		const res = 16;
		const bytes = new Uint8Array(res * res * 4);
		for (let z = 0; z < res; z++)
			for (let x = 0; x < res; x++) bytes[(z * res + x) * 4 + (z < res / 2 ? 0 : 2)] = 255;
		const b = { minX: -4, minZ: -4, sizeX: 8, sizeZ: 8 };
		const list = generateSurfaceSlots({ ...GEN, count: 150, layer: { i: 2, min: 0.9 } }, Sp, {
			draws: drawsFor(5),
			layerWeight: (p, i) => splatWeightAt(bytes, res, b, p.x, p.z, i)
		});
		expect(list).toHaveLength(150);
		for (const p of list) expect(p.z).toBeGreaterThan(-0.3);
	});

	it('MINIMUM SPACING: no two instances closer than the spacing (3D), Poisson-disk', () => {
		// sphere r 3 = 113 m²; random packing at 0.6 m saturates near ~210, so 150 must all fit
		const list = generateSurfaceSlots({ ...GEN, count: 150, spacing: 0.6 }, S, { draws: drawsFor(2) });
		expect(list.length).toBe(150);
		let minD = Infinity;
		for (let i = 0; i < list.length; i++)
			for (let j = i + 1; j < list.length; j++)
				minD = Math.min(minD, Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y, list[i].z - list[j].z));
		expect(minD).toBeGreaterThanOrEqual(0.6);
		// the counterfactual: without spacing the same draws do crowd
		const loose = generateSurfaceSlots({ ...GEN, count: 150 }, S, { draws: drawsFor(2) });
		let looseMin = Infinity;
		for (let i = 0; i < loose.length; i++)
			for (let j = i + 1; j < loose.length; j++)
				looseMin = Math.min(looseMin, Math.hypot(loose[i].x - loose[j].x, loose[i].y - loose[j].y, loose[i].z - loose[j].z));
		expect(looseMin).toBeLessThan(0.6);
	});

	it('past saturation COUNT mode places what fits and stops (it never overlaps to reach the number)', () => {
		const full = generateSurfaceSlots({ ...GEN, count: 600, spacing: 0.6 }, S, { draws: drawsFor(2) });
		expect(full.length).toBeGreaterThan(150);
		expect(full.length).toBeLessThan(600);
	});

	it('raising the count ADDS instances and moves none (slot ids are stable)', () => {
		const a = generateSurfaceSlots({ ...GEN, count: 100, spacing: 0.3 }, S, { draws: drawsFor(8) });
		const b = generateSurfaceSlots({ ...GEN, count: 160, spacing: 0.3 }, S, { draws: drawsFor(8) });
		expect(b.slice(0, 100)).toEqual(a);
	});

	it('DETERMINISM: one seed, two runs, two peers (each rebuilding the surface from its own copy)', () => {
		const gen = { ...GEN, count: 400, spacing: 0.25, slope: [0, 120], height: [-2.5, 2.8] };
		const run1 = generateSurfaceSlots(gen, S, { draws: drawsFor(0xc0ffee) });
		const run2 = generateSurfaceSlots(gen, S, { draws: drawsFor(0xc0ffee) });
		expect(run2).toEqual(run1);
		// peer B: the same geometry after a wire / save round trip (float32 values through JSON)
		const copy = JSON.parse(JSON.stringify({ pos: [...sp.pos], index: [...sp.index], nrm: [...sp.nrm] }));
		const SB = buildSurface(new Float32Array(copy.pos), new Uint32Array(copy.index), new Float32Array(copy.nrm));
		const peerB = generateSurfaceSlots(JSON.parse(JSON.stringify(gen)), SB, { draws: drawsFor(0xc0ffee) });
		expect(peerB).toEqual(run1);
		// and a different seed is a different layout
		const other = generateSurfaceSlots(gen, S, { draws: drawsFor(0xc0ffef) });
		expect(other[0]).not.toEqual(run1[0]);
	});

	it('honours the room left on the host', () => {
		expect(generateSurfaceSlots({ ...GEN, count: 300 }, S, { draws: drawsFor(1), room: 40 })).toHaveLength(40);
	});
});

// ---- the brush --------------------------------------------------------------------------------

describe('surfaceDab (the brush on a mesh)', () => {
	it('fills the sphere up to the density, inside the radius, and a second dab adds nothing', () => {
		const S = buildSurface(plane(20, 20));
		const index = triangleIndex(S);
		const o = { cx: 0, cy: 0, cz: 0, radius: 2, density: 1, scaleMin: 1, scaleMax: 1, randomRotation: true, rng: rng32(1) };
		const first = surfaceDab([], S, index, o);
		expect(first.length).toBe(Math.floor(Math.PI * 4));
		for (const p of first) expect(Math.hypot(p.x, p.y, p.z)).toBeLessThanOrEqual(2 + 1e-6);
		expect(surfaceDab(first, S, index, { ...o, rng: rng32(2) })).toHaveLength(0);
	});

	it('paints on a curved surface (a sphere), every instance ON it', () => {
		const sp = sphere(5, 64, 48);
		const S = buildSurface(sp.pos, sp.index, sp.nrm);
		const index = triangleIndex(S);
		const added = surfaceDab([], S, index, {
			cx: 5,
			cy: 0,
			cz: 0,
			radius: 1.5,
			density: 2,
			scaleMin: 1,
			scaleMax: 1,
			randomRotation: false,
			rng: rng32(4)
		});
		expect(added.length).toBeGreaterThan(8);
		for (const p of added) {
			expect(Math.hypot(p.x, p.y, p.z)).toBeGreaterThan(4.98);
			expect(Math.hypot(p.x - 5, p.y, p.z)).toBeLessThanOrEqual(1.5 + 1e-6);
			expect(p.nx).toBeGreaterThan(0.85);
		}
	});

	it('erases inside a sphere', () => {
		const list = [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }];
		expect(eraseInSphere(list, 0, 0, 0, 1)).toEqual([{ x: 3, y: 0, z: 0 }]);
	});
});

// ---- records ----------------------------------------------------------------------------------

describe('16-byte surface records', () => {
	it('round-trips position, normal, yaw and scale within quantization', () => {
		const sp = sphere(4, 24, 16);
		const S = buildSurface(sp.pos, sp.index, sp.nrm);
		const list = generateSurfaceSlots({ ...GEN, count: 200 }, S, { draws: drawsFor(3) });
		const box = boxOf(list, S);
		const bytes = encodeSurfaceRecords(list, box);
		expect(bytes.length).toBe(200 * SURFACE_RECORD);
		const back = decodeSurfaceRecords(bytes, box);
		back.forEach((p, k) => {
			const q = list[k];
			expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)).toBeLessThan(0.001);
			expect(p.nx * q.nx + p.ny * q.ny + p.nz * q.nz).toBeGreaterThan(0.9999);
			expect(Math.abs(p.yaw - q.yaw)).toBeLessThan(0.001);
			expect(Math.abs(p.scale - q.scale)).toBeLessThanOrEqual(0.0005);
		});
	});

	it('keeps a flat axis (a plane) from dividing by zero, and validates a stored box', () => {
		const box = boxOf([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 2 }]);
		expect(box[4]).toBeGreaterThan(0);
		expect(boxFrom(box)).toEqual(box);
		expect(boxFrom([0, 0, 0, 1, 0, 1])).toBeNull();
		expect(boxFrom('x')).toBeNull();
	});
});

// ---- the perf number the brief asks for -------------------------------------------------------

describe('perf: 5,000 instances on a 100k-triangle mesh', () => {
	it('builds the surface and fills it in well under a frame budget per step', () => {
		const sp = sphere(10, 224, 224); // 2 x 224 x 223 = 99,904 triangles
		const t0 = performance.now();
		const S = buildSurface(sp.pos, sp.index, sp.nrm);
		const t1 = performance.now();
		const plain = generateSurfaceSlots({ ...GEN, count: 5000 }, S, { draws: drawsFor(42) });
		const t2 = performance.now();
		const spaced = generateSurfaceSlots({ ...GEN, count: 5000, spacing: 0.3, slope: [0, 150] }, S, { draws: drawsFor(42) });
		const t3 = performance.now();
		expect(S.tris).toBeGreaterThan(99000);
		expect(plain).toHaveLength(5000);
		expect(spaced).toHaveLength(5000);
		console.log(
			`[perf] ${S.tris} tris: buildSurface ${(t1 - t0).toFixed(1)} ms · fill 5000 ${(t2 - t1).toFixed(1)} ms · ` +
				`fill 5000 + spacing 0.3 + slope mask ${(t3 - t2).toFixed(1)} ms`
		);
		// generous ceilings (a loaded CI box): the measured numbers are in the log line above
		expect(t1 - t0).toBeLessThan(1500);
		expect(t3 - t1).toBeLessThan(1500);
	});
});

// ---- a mesh host's SET in the 51 format ---------------------------------------------------------

import { surfaceInstancesOf, surfaceRecords } from '../../src/lib/scatterSurfaceCore.js';
import { normalizeScatter, withOverrides } from '../../src/lib/terrainScatterCore.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

describe('host: mesh sets (format + instances + edits)', () => {
	const sp = sphere(2, 32, 24);
	const S = buildSurface(sp.pos, sp.index, sp.nrm);
	const CONE = { kind: 'primitive', type: 'Cone' };

	it('normalize keeps a 16-byte painted set with its box, and refuses one without a box', () => {
		const list = generateSurfaceSlots({ ...GEN, count: 12 }, S, { draws: drawsFor(1) });
		const enc = surfaceRecords.encode(list);
		const ok = normalizeScatter({ sets: [{ source: CONE, host: 'mesh', data: b64(enc.bytes), box: enc.box }] }, unb64);
		expect(ok.v).toBe(2);
		expect(ok.sets[0]).toMatchObject({ host: 'mesh', count: 12, box: enc.box });
		const noBox = normalizeScatter({ sets: [{ source: CONE, host: 'mesh', data: b64(enc.bytes) }] }, unb64);
		expect(noBox.sets).toHaveLength(0);
		// a terrain set never grows a host field (a 1.38 scene stays byte-identical)
		const t = normalizeScatter({ sets: [{ source: CONE, data: b64(new Uint8Array(8)) }] }, unb64);
		expect('host' in t.sets[0]).toBe(false);
		expect(t.v).toBe(1);
	});

	it('generated + painted instances, with stable ids, on two peers', () => {
		const painted = surfaceRecords.encode(generateSurfaceSlots({ ...GEN, count: 5 }, S, { draws: drawsFor(77) }));
		const raw = { sets: [{ id: 'm', source: CONE, host: 'mesh', seed: 99, gen: { ...GEN, count: 40, spacing: 0.2 }, data: b64(painted.bytes), box: painted.box }] };
		const set = normalizeScatter(raw, unb64).sets[0];
		const a = surfaceInstancesOf(set, S, unb64);
		const b = surfaceInstancesOf(normalizeScatter(JSON.parse(JSON.stringify(raw)), unb64).sets[0], buildSurface(new Float32Array([...sp.pos]), new Uint32Array([...sp.index]), new Float32Array([...sp.nrm])), unb64);
		expect(a).toHaveLength(45);
		expect(b).toEqual(a);
		expect(a.slice(0, 40).every((p) => p.id.startsWith('g'))).toBe(true);
		expect(a.slice(40).map((p) => p.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
		for (const p of a) expect(Math.hypot(p.x, p.y, p.z)).toBeGreaterThan(1.95);
	});

	it('hand edits: a generated slot moves (with y) or goes; a painted record is rewritten through the 16-byte codec', () => {
		const painted = surfaceRecords.encode(generateSurfaceSlots({ ...GEN, count: 3 }, S, { draws: drawsFor(5) }));
		const set = normalizeScatter({ sets: [{ id: 'm', source: CONE, host: 'mesh', seed: 3, gen: { ...GEN, count: 10 }, data: b64(painted.bytes), box: painted.box }] }, unb64).sets[0];
		const io = { bounds: { minX: -2, minZ: -2, sizeX: 4, sizeZ: 4 }, decode: unb64, encode: b64, records: surfaceRecords };
		const next = withOverrides(set, { g2: { x: 0, y: 2, z: 0 }, g3: { del: true }, p1: { del: true } }, io);
		const list = surfaceInstancesOf(normalizeScatter({ sets: [next] }, unb64).sets[0], S, unb64);
		expect(list.find((p) => p.id === 'g2')).toMatchObject({ x: 0, y: 2, z: 0 });
		expect(list.find((p) => p.id === 'g3')).toBeUndefined();
		expect(next.count).toBe(2);
		expect(list.filter((p) => p.id.startsWith('p'))).toHaveLength(2);
	});
});
