// 98 P1 — the bake cores: BVH + tracing, the UV2 auto-unwrap / overlap / AO-only fallback, the
// atlas planner, the kernel (AO + one bounce), the encode, the record + stale + tier budget.
import { describe, it, expect } from 'vitest';
import { buildBvh, traceFirst, occluded, hit } from '../../src/lib/bake/bakeTraceCore.js';
import {
	triangleList,
	buildCharts,
	autoUnwrap,
	layoutFromUv,
	overlapOf,
	chooseUnwrap,
	rebuildLayout,
	rasterTriangles
} from '../../src/lib/bake/bakeUnwrapCore.js';
import { planAtlas, imageWidth, halves, GUTTER } from '../../src/lib/bake/bakeAtlasCore.js';
import { hemisphereDirs, traceSamples, resolveTexels, encodeAtlas, downscaleAtlas, lightScaleOf } from '../../src/lib/bake/bakeKernelCore.js';
import { planBake, bakeUvFor, worldScaleOf } from '../../src/lib/bake/bakePlanCore.js';
import {
	normalizeBakeRecord,
	objectSig,
	staleOf,
	mapChoice,
	bakeBudget,
	bakeTierOf,
	lightsSig,
	BAKE_TIERS
} from '../../src/lib/bake/bakeRecordCore.js';

// ---- geometry the way three builds it -------------------------------------------------------

/** three's BoxGeometry layout: 6 faces x 4 own vertices, indexed, uv0 per face 0..1 */
function box(w = 1, h = 1, d = 1) {
	const pos = [], uv = [], nor = [], idx = [];
	const face = (/** @type {number[][]} */ corners, /** @type {number[]} */ n) => {
		const base = pos.length / 3;
		for (const [i, c] of corners.entries()) {
			pos.push(c[0] * w / 2, c[1] * h / 2, c[2] * d / 2);
			nor.push(...n);
			uv.push(i % 2, i < 2 ? 1 : 0);
		}
		idx.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
	};
	face([[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1]], [1, 0, 0]);
	face([[-1, 1, -1], [-1, 1, 1], [-1, -1, -1], [-1, -1, 1]], [-1, 0, 0]);
	face([[-1, 1, -1], [1, 1, -1], [-1, 1, 1], [1, 1, 1]], [0, 1, 0]);
	face([[-1, -1, 1], [1, -1, 1], [-1, -1, -1], [1, -1, -1]], [0, -1, 0]);
	face([[-1, 1, 1], [1, 1, 1], [-1, -1, 1], [1, -1, 1]], [0, 0, 1]);
	face([[1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1]], [0, 0, -1]);
	return { pos: Float32Array.from(pos), uv0: Float32Array.from(uv), normal: Float32Array.from(nor), index: Uint32Array.from(idx) };
}

/** three's SphereGeometry: a seamed grid, indexed, uv0 a valid layout */
function sphere(r = 1, ws = 16, hs = 8) {
	const pos = [], uv = [], nor = [], idx = [];
	const grid = [];
	for (let iy = 0; iy <= hs; iy++) {
		const row = [];
		const v = iy / hs;
		for (let ix = 0; ix <= ws; ix++) {
			const u = ix / ws;
			const x = -r * Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
			const y = r * Math.cos(v * Math.PI);
			const z = r * Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
			pos.push(x, y, z);
			nor.push(x / r, y / r, z / r);
			uv.push(u, 1 - v);
			row.push(pos.length / 3 - 1);
		}
		grid.push(row);
	}
	for (let iy = 0; iy < hs; iy++) {
		for (let ix = 0; ix < ws; ix++) {
			const a = grid[iy][ix + 1], b = grid[iy][ix], c = grid[iy + 1][ix], d = grid[iy + 1][ix + 1];
			if (iy !== 0) idx.push(a, b, d);
			if (iy !== hs - 1) idx.push(b, c, d);
		}
	}
	return { pos: Float32Array.from(pos), uv0: Float32Array.from(uv), normal: Float32Array.from(nor), index: Uint32Array.from(idx) };
}

/** a flat ground quad (y up) of size s */
function plane(s = 10) {
	return {
		pos: Float32Array.from([-s / 2, 0, -s / 2, s / 2, 0, -s / 2, -s / 2, 0, s / 2, s / 2, 0, s / 2]),
		normal: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
		uv0: Float32Array.from([0, 1, 1, 1, 0, 0, 1, 0]),
		index: Uint32Array.from([0, 2, 1, 2, 3, 1])
	};
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** @param {number} x @param {number} y @param {number} z */
const at = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** a non-indexed copy (every triangle its own three vertices) @param {any} g */
function nonIndexed(g) {
	const pos = [], uv = [], nor = [];
	for (const v of g.index) {
		pos.push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]);
		nor.push(g.normal[v * 3], g.normal[v * 3 + 1], g.normal[v * 3 + 2]);
		uv.push(g.uv0[v * 2], g.uv0[v * 2 + 1]);
	}
	return { pos: Float32Array.from(pos), uv0: Float32Array.from(uv), normal: Float32Array.from(nor), index: null };
}

// ---- tracer --------------------------------------------------------------------------------

describe('bake tracer', () => {
	const ground = Float32Array.from([-5, 0, -5, -5, 0, 5, 5, 0, -5, 5, 0, -5, -5, 0, 5, 5, 0, 5]);
	it('hits the nearest triangle and reports distance and index', () => {
		const bvh = buildBvh(ground);
		expect(traceFirst(bvh, 0, 2, 0, 0, -1, 0, 100)).toBe(true);
		expect(hit.t).toBeCloseTo(2, 5);
		expect(hit.tri === 0 || hit.tri === 1).toBe(true);
		expect(traceFirst(bvh, 0, 2, 0, 0, 1, 0, 100)).toBe(false);
		expect(traceFirst(bvh, 0, 2, 0, 0, -1, 0, 1.5)).toBe(false); // tMax honoured
	});
	it('agrees with brute force on a scene of many boxes', () => {
		/** @type {number[]} */
		const soup = [];
		const b = box(0.5, 0.5, 0.5);
		for (let i = 0; i < 40; i++) {
			const ox = (i % 8) - 4, oz = Math.floor(i / 8) - 2, oy = (i * 7) % 3;
			for (const v of b.index) soup.push(b.pos[v * 3] + ox, b.pos[v * 3 + 1] + oy, b.pos[v * 3 + 2] + oz);
		}
		const tris = Float32Array.from(soup);
		const bvh = buildBvh(tris);
		const one = buildBvh(tris.slice(0)); // same build twice: deterministic
		expect(Array.from(one.order)).toEqual(Array.from(bvh.order));
		const brute = (/** @type {number[]} */ o, /** @type {number[]} */ d) => {
			let best = Infinity;
			for (let t = 0; t < tris.length / 9; t++) {
				const single = buildBvh(tris.slice(t * 9, t * 9 + 9));
				if (traceFirst(single, o[0], o[1], o[2], d[0], d[1], d[2], 1e9) && hit.t < best) best = hit.t;
			}
			return best;
		};
		let checked = 0;
		for (let r = 0; r < 25; r++) {
			const o = [Math.sin(r) * 6, 5, Math.cos(r * 1.3) * 4];
			const d = [Math.sin(r * 0.7) * 0.3, -1, Math.cos(r * 0.4) * 0.3];
			const l = Math.hypot(...d);
			const dir = d.map((x) => x / l);
			const want = brute(o, dir);
			const got = traceFirst(bvh, o[0], o[1], o[2], dir[0], dir[1], dir[2], 1e9) ? hit.t : Infinity;
			if (want === Infinity) expect(got).toBe(Infinity);
			else expect(got).toBeCloseTo(want, 4);
			checked++;
		}
		expect(checked).toBe(25);
	});
	it('occluded() is an any-hit test', () => {
		const bvh = buildBvh(ground);
		expect(occluded(bvh, 0, -1, 0, 0, 1, 0, 5)).toBe(true);
		expect(occluded(bvh, 0, -1, 0, 0, 1, 0, 0.5)).toBe(false);
	});
});

// ---- unwrap --------------------------------------------------------------------------------

describe('bake UV2 auto-unwrap', () => {
	it('a box unwraps into 6 flat charts with no overlap', () => {
		const b = box(1, 2, 3);
		const tris = triangleList(b.index, b.pos.length / 3);
		const layout = autoUnwrap(b.pos, tris, b.uv0, 0.05);
		expect(layout.ok).toBe(true);
		if (!layout.ok) return;
		expect(layout.charts).toBe(6);
		expect(overlapOf(layout, tris, 64).ratio).toBeLessThanOrEqual(0.01);
		// object units: total chart area ~ the box's surface area (2*(2+3+6) = 22)
		expect(layout.area).toBeCloseTo(22, 3);
	});
	it('a NON-indexed box merges its triangle pairs back into 6 charts', () => {
		const b = nonIndexed(box());
		const tris = triangleList(null, b.pos.length / 3);
		const built = buildCharts(b.pos, tris, b.uv0);
		expect('charts' in built && built.charts.length).toBe(6);
	});
	it('a sphere (curved, shared vertices) is parameterised by its own uv0 and stays clean', () => {
		const s = sphere();
		const tris = triangleList(s.index, s.pos.length / 3);
		const layout = autoUnwrap(s.pos, tris, s.uv0, 0.02);
		expect(layout.ok).toBe(true);
		if (layout.ok) expect(overlapOf(layout, tris, 32).ratio).toBeLessThanOrEqual(0.01);
	});
	it('a curved mesh with no UVs cannot auto-unwrap (reason given)', () => {
		const s = sphere();
		const tris = triangleList(s.index, s.pos.length / 3);
		const layout = autoUnwrap(s.pos, tris, null, 0.02);
		expect(layout.ok).toBe(false);
		if (!layout.ok) expect(layout.reason).toMatch(/curved/);
	});
	it('chooseUnwrap: clean auto → full; uv1 preferred when it is clean', () => {
		const b = box();
		const got = chooseUnwrap({ pos: b.pos, index: b.index, uv0: b.uv0 }, 0.05, 32);
		expect('error' in got).toBe(false);
		if ('error' in got) return;
		expect(got.src).toBe('auto');
		expect(got.mode).toBe('full');
		// a clean uv1 (the auto layout itself, normalised) wins over the auto-unwrap
		const uv1 = Float32Array.from(got.layout.uv, (v) => v / Math.max(got.layout.w, got.layout.h));
		const again = chooseUnwrap({ pos: b.pos, index: b.index, uv0: b.uv0, uv1 }, 0.05, 32);
		expect('error' in again ? '' : again.src).toBe('uv1');
	});
	it('overlap check: stacked UVs read as overlapping → AO-only fallback with a reason', () => {
		// a curved mesh (no flat charts) whose uv0 maps two halves onto the same square
		const s = sphere(1, 8, 6);
		const uv = Float32Array.from(s.uv0, (v, i) => (i % 2 === 0 ? (v * 2) % 1 : v)); // u wraps twice
		const tris = triangleList(s.index, s.pos.length / 3);
		expect(overlapOf(/** @type {any} */ (layoutFromUv(s.pos, tris, uv)), tris, 32).ratio).toBeGreaterThan(0.2);
		const got = chooseUnwrap({ pos: s.pos, index: s.index, uv0: uv }, 0.05, 32);
		expect('error' in got).toBe(false);
		if ('error' in got) return;
		expect(got.mode).toBe('ao');
		expect(got.reason).toMatch(/overlapping/);
	});
	it('no triangles / no usable UVs is an error, never a throw', () => {
		expect('error' in chooseUnwrap({ pos: new Float32Array(0), index: null }, 0.1, 10)).toBe(true);
		const s = sphere();
		const got = chooseUnwrap({ pos: s.pos, index: s.index, uv0: null }, 0.1, 10);
		expect('error' in got).toBe(true);
	});
	it('rebuildLayout is deterministic (the apply side gets the bake side\'s exact UVs)', () => {
		const b = nonIndexed(box(2, 1, 1));
		const tris = triangleList(null, b.pos.length / 3);
		const first = autoUnwrap(b.pos, tris, b.uv0, 0.031);
		const again = rebuildLayout({ pos: Float32Array.from(b.pos), index: null, uv0: Float32Array.from(b.uv0) }, 'auto', 0.031);
		expect(first.ok && again.ok).toBe(true);
		if (first.ok && again.ok) expect(Array.from(again.uv)).toEqual(Array.from(first.uv));
	});
	it('rasterTriangles visits each covered texel of a clean layout once', () => {
		const uv = Float32Array.from([0, 0, 4, 0, 0, 4, 4, 4]);
		const seen = new Map();
		rasterTriangles(uv, Uint32Array.from([0, 1, 2, 1, 3, 2]), 4, 4, (t) => seen.set(t, (seen.get(t) ?? 0) + 1));
		expect(seen.size).toBe(16);
		expect([...seen.values()].every((n) => n === 1)).toBe(true);
	});
});

// ---- atlas ---------------------------------------------------------------------------------

describe('bake atlas', () => {
	it('places items without overlap, keeps texel (0,0) free, and fills the side', () => {
		const items = [3, 1, 2, 1, 1].map((size, i) => ({
			key: 'o' + i,
			ws: 1,
			area: size * size,
			layoutFor: () => /** @type {const} */ ({ ok: true, w: size, h: size })
		}));
		const plan = planAtlas(items, 256, 2, 1000);
		expect('error' in plan).toBe(false);
		if ('error' in plan) return;
		const rects = plan.placements.map((p, i) => ({ x: p.x * 256, y: p.y * 256, w: items[i].area ** 0.5 * plan.density, h: items[i].area ** 0.5 * plan.density }));
		for (const r of rects) {
			expect(r.x).toBeGreaterThanOrEqual(1);
			expect(r.y).toBeGreaterThanOrEqual(1);
			expect(r.x + r.w).toBeLessThanOrEqual(256);
			expect(r.y + r.h).toBeLessThanOrEqual(256);
		}
		for (let a = 0; a < rects.length; a++)
			for (let b = a + 1; b < rects.length; b++) {
				const A = rects[a], B = rects[b];
				const apart = A.x + A.w <= B.x || B.x + B.w <= A.x || A.y + A.h <= B.y || B.y + B.h <= A.y;
				expect(apart).toBe(true);
			}
		expect(plan.used).toBeGreaterThan(0.5);
	});
	it('maxDensity caps a small scene', () => {
		const plan = planAtlas([{ key: 'a', ws: 1, area: 1, layoutFor: () => ({ ok: true, w: 1, h: 1 }) }], 1024, 2, 16);
		expect('error' in plan ? 0 : plan.density).toBe(16);
	});
	it('the image layout: [light | white gutter | AO] with offsets for the two textures', () => {
		expect(imageWidth(512)).toBe(1024 + GUTTER);
		const h = halves(512);
		expect(h.light.offset).toBe(0);
		expect(h.ao.offset).toBeCloseTo((512 + GUTTER) / (1024 + GUTTER));
		expect(h.light.repeat).toBeCloseTo(512 / (1024 + GUTTER));
	});
});

// ---- plan + kernel --------------------------------------------------------------------------

/** the template scene: a ground, a box on it, a wall beside it */
function scene() {
	const g = plane(8), b = box(1, 1, 1), w = box(0.2, 3, 4);
	return [
		{ key: 'ground', receive: true, ...g, uv1: null, world: IDENTITY, albedo: [0.8, 0.8, 0.8] },
		{ key: 'crate', receive: true, ...b, uv1: null, world: at(0, 0.5, 0), albedo: [0.9, 0.2, 0.2] },
		{ key: 'wall', receive: true, ...w, uv1: null, world: at(2, 1.5, 0), albedo: [0.2, 0.9, 0.2] }
	];
}

describe('bake plan + kernel', () => {
	const budget = { atlas: 128, pad: 2, maxDensity: 64 };
	it('plans every receiver into the atlas with one sample per covered texel', () => {
		const plan = planBake(scene(), budget);
		expect('error' in plan).toBe(false);
		if ('error' in plan) return;
		expect(plan.objects.map((o) => o.key).sort()).toEqual(['crate', 'ground', 'wall']);
		expect(plan.samples.length / 6).toBe(plan.texelOf.length);
		expect(plan.texelOf.length).toBeGreaterThan(1000);
		expect([...plan.texelOf].every((t) => t !== 0)).toBe(true); // the neutral texel is never baked
		expect(plan.tris.length / 9).toBe(2 + 12 + 12);
	});
	it('the apply side rebuilds the exact UVs the plan used', () => {
		const meshes = scene();
		const plan = planBake(meshes, budget);
		if ('error' in plan) throw new Error(plan.error);
		for (const o of plan.objects) {
			const m = meshes.find((x) => x.key === o.key);
			const uv = bakeUvFor({ pos: m.pos, index: m.index, uv0: m.uv0 }, /** @type {any} */ (o));
			expect(uv).not.toBeNull();
			if (!uv) continue;
			for (let i = 0; i < uv.length; i++) {
				expect(uv[i]).toBeGreaterThanOrEqual(0);
				expect(uv[i]).toBeLessThanOrEqual(1);
			}
		}
	});
	it('AO darkens the ground next to the crate and leaves open ground open; the wall bounces green', () => {
		const plan = planBake(scene(), budget);
		if ('error' in plan) throw new Error(plan.error);
		const bvh = buildBvh(plan.tris);
		const count = plan.texelOf.length;
		const ao = new Float32Array(count);
		const light = new Float32Array(count * 3);
		const sun = { type: /** @type {const} */ ('dir'), dx: -0.4, dy: 0.9, dz: 0.2, r: 3, g: 3, b: 3 };
		const l = Math.hypot(sun.dx, sun.dy, sun.dz);
		sun.dx /= l;
		sun.dy /= l;
		sun.dz /= l;
		const done = traceSamples(
			{ bvh, albedo: plan.albedo, lights: [sun], dirs: hemisphereDirs(32), aoDistance: plan.aoDistance, bias: plan.bias, far: plan.far, bounce: true, aoOnly: plan.aoOnly },
			plan.samples, ao, light, 0, count, Infinity, () => 0
		);
		expect(done).toBe(count);
		// ground samples: by distance from the crate
		let nearAo = 0, nearN = 0, farAo = 0, farN = 0, wallSideG = 0, wallSideR = 0, wallN = 0;
		for (let i = 0; i < count; i++) {
			const x = plan.samples[i * 6], y = plan.samples[i * 6 + 1], z = plan.samples[i * 6 + 2], ny = plan.samples[i * 6 + 4];
			if (Math.abs(y) > 1e-3 || ny < 0.9) continue; // ground top only
			const dCrate = Math.max(Math.abs(x), Math.abs(z));
			if (dCrate > 0.5 && dCrate < 0.65) {
				nearAo += ao[i];
				nearN++;
			}
			if (x < -3 && Math.abs(z) > 3) {
				farAo += ao[i];
				farN++;
			}
			if (x > 1.3 && x < 1.85 && Math.abs(z) < 1) {
				wallSideG += light[i * 3 + 1];
				wallSideR += light[i * 3];
				wallN++;
			}
		}
		expect(nearN).toBeGreaterThan(5);
		expect(farN).toBeGreaterThan(5);
		expect(nearAo / nearN).toBeLessThan(0.85);
		expect(farAo / farN).toBeGreaterThan(0.95);
		expect(wallN).toBeGreaterThan(3);
		expect(wallSideG / wallN).toBeGreaterThan(wallSideR / wallN); // green wall, green fill
	});
	it('a deadline stops tracing early and says how far it got (time cap + Cancel)', () => {
		const plan = planBake(scene(), budget);
		if ('error' in plan) throw new Error(plan.error);
		const bvh = buildBvh(plan.tris);
		let clock = 0;
		const done = traceSamples(
			{ bvh, albedo: plan.albedo, lights: [], dirs: hemisphereDirs(8), aoDistance: 1, bias: 1e-3, far: 10, bounce: false },
			plan.samples, new Float32Array(plan.texelOf.length), new Float32Array(plan.texelOf.length * 3), 0, plan.texelOf.length, 5, () => clock++
		);
		expect(done).toBeLessThan(plan.texelOf.length);
		expect(done).toBeGreaterThan(0);
	});
	it('an AO-only mesh gets AO and no light', () => {
		const meshes = scene();
		const plan = planBake(meshes, budget);
		if ('error' in plan) throw new Error(plan.error);
		plan.aoOnly.fill(1);
		const count = plan.texelOf.length;
		const light = new Float32Array(count * 3);
		traceSamples(
			{ bvh: buildBvh(plan.tris), albedo: plan.albedo, lights: [{ type: 'dir', dx: 0, dy: 1, dz: 0, r: 5, g: 5, b: 5 }], dirs: hemisphereDirs(8), aoDistance: plan.aoDistance, bias: plan.bias, far: plan.far, bounce: true, aoOnly: plan.aoOnly },
			plan.samples, new Float32Array(count), light, 0, count, Infinity, () => 0
		);
		expect(light.every((v) => v === 0)).toBe(true);
	});
	it('a scene with nothing static says so', () => {
		const got = planBake([{ ...scene()[0], receive: false }], budget);
		expect('error' in got && got.error).toMatch(/nothing to bake/);
	});
	it('worldScaleOf reads uniform scale', () => {
		expect(worldScaleOf([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 5, 5, 1])).toBeCloseTo(2);
	});
});

describe('bake resolve + encode', () => {
	it('dilates into empty texels, keeps the neutral corners and the white gutter', () => {
		const side = 8;
		const texelOf = Uint32Array.from([3 * side + 3, 3 * side + 4]);
		const r = resolveTexels(texelOf, Float32Array.from([0.5, 0.5]), Float32Array.from([1, 0, 0, 1, 0, 0]), 2, side);
		expect(r.covered[3 * side + 3]).toBe(1);
		expect(r.ao[3 * side + 5]).toBeCloseTo(0.5); // dilated neighbour
		const scale = lightScaleOf(r.light, r.covered);
		expect(scale).toBeCloseTo(1);
		const rgba = encodeAtlas(r.ao, r.light, side, scale, GUTTER);
		const w = imageWidth(side);
		expect(rgba.length).toBe(w * side * 4);
		expect([rgba[0], rgba[1], rgba[2]]).toEqual([0, 0, 0]); // neutral light texel
		const aoCorner = (side + GUTTER) * 4;
		expect(rgba[aoCorner]).toBe(255); // neutral AO texel
		expect(rgba[side * 4]).toBe(255); // gutter
		const lit = (3 * w + 3) * 4;
		expect(rgba[lit]).toBe(255); // red at full scale
		expect(rgba[(3 * w + side + GUTTER + 3) * 4]).toBe(128); // AO 0.5
		const small = downscaleAtlas(rgba, side, 2, GUTTER);
		expect(small.side).toBe(4);
		expect(small.rgba.length).toBe(imageWidth(4) * 4 * 4);
		expect(small.rgba[0]).toBe(0);
		expect(small.rgba[(4 + GUTTER) * 4]).toBe(255);
	});
});

// ---- record ---------------------------------------------------------------------------------

describe('bake record', () => {
	const good = {
		full: { hash: 'abc123', side: 1024, bytes: 900000 },
		lite: { hash: 'def456', side: 512, bytes: 300000 },
		lightScale: 2.5,
		objects: [{ uuid: 'u1', src: 'auto', mode: 'full', pad: 0.01, x: 0.1, y: 0.1, s: 0.02, sig: 'aa', ch: 2 }],
		changedAt: 5,
		future: 'kept'
	};
	it('normalizes, clamps and keeps unknown fields', () => {
		const r = normalizeBakeRecord({ ...good, intensity: { light: 99, ao: -1 }, objects: [...good.objects, { uuid: '' }, { uuid: 'u2', src: 'evil', mode: 'x', x: 9 }] });
		expect(r.objects.length).toBe(2);
		expect(r.objects[1].src).toBe('auto');
		expect(r.objects[1].mode).toBe('full');
		expect(r.objects[1].x).toBe(1);
		expect(r.intensity).toEqual({ light: 10, ao: 0 });
		expect(r.future).toBe('kept');
	});
	it('rejects what is not a bake', () => {
		expect(normalizeBakeRecord(null)).toBeNull();
		expect(normalizeBakeRecord({ ...good, full: { hash: '../x y' } })).toBeNull();
		expect(normalizeBakeRecord({ ...good, objects: [] })).toBeNull();
	});
	it('stale: moved, deleted, lights changed', () => {
		const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
		const sig = objectSig(m, 24);
		const rec = normalizeBakeRecord({ ...good, objects: [{ ...good.objects[0], sig }], lightsSig: lightsSig([{ type: 'dir', r: 1 }]) });
		expect(staleOf(rec, new Map([['u1', sig]]), lightsSig([{ type: 'dir', r: 1 }])).stale).toBe(false);
		const moved = objectSig([...m.slice(0, 12), 0.01, 0, 0, 1], 24);
		expect(moved).not.toBe(sig);
		expect(staleOf(rec, new Map([['u1', moved]])).moved).toEqual(['u1']);
		expect(staleOf(rec, new Map()).missing).toEqual(['u1']);
		expect(staleOf(rec, new Map([['u1', sig]]), lightsSig([{ type: 'dir', r: 2 }])).lights).toBe(true);
		// a sub-millimetre jitter is not a move
		expect(objectSig([...m.slice(0, 12), 0.0001, 0, 0, 1], 24)).toBe(sig);
	});
	it('tier budgets: phones and Quest take the small copy, or nothing when even that is over budget', () => {
		const rec = normalizeBakeRecord(good);
		expect(mapChoice(rec, 'pc')).toBe('full');
		expect(mapChoice(rec, 'phone')).toBe('full'); // 1024 + 0.9 MB fit a phone
		expect(mapChoice(rec, 'quest')).toBe('lite'); // Quest caps at 512
		const big = normalizeBakeRecord({ ...good, full: { hash: 'f', side: 2048, bytes: 9e6 }, lite: { hash: 'l', side: 512, bytes: 3e6 } });
		expect(mapChoice(big, 'phone')).toBeNull();
		expect(mapChoice(big, 'pc')).toBe('full');
	});
	it('bakeBudget per tier and quality', () => {
		expect(bakeTierOf({ quest: true, phone: true })).toBe('quest');
		expect(bakeTierOf({ phone: true })).toBe('phone');
		expect(bakeTierOf({})).toBe('pc');
		const pc = bakeBudget('pc', 'normal', 8);
		expect(pc.atlas).toBe(BAKE_TIERS.pc.atlas);
		expect(pc.workers).toBe(4);
		expect(bakeBudget('pc', 'high', 8).atlas).toBe(2048);
		expect(bakeBudget('quest', 'high', 8).atlas).toBe(512);
		expect(bakeBudget('phone', 'draft', 2).workers).toBe(1);
		expect(bakeBudget('pc', 'bogus').quality).toBe('normal');
		expect(pc.pad).toBeGreaterThanOrEqual(4); // 1024 → the 512 copy keeps >= 2 texels
	});
});
