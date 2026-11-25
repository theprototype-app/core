// 64-extrude (D7): the kernel solid builder (vectorSolid.js) and its use in buildVectorGeometry.
import { describe, test, expect } from 'vitest';
import {
	buildSolidKernel,
	buildSolidArrays,
	bridgePieces,
	cleanRing,
	profileLevels,
	safeInset,
	ringMiters
} from '../../src/lib/vector/vectorSolid.js';
import {
	ringsToPolygons,
	flattenSubpath,
	starPath,
	rectPath
} from '../../src/lib/vector/vectorPath.js';
import {
	buildVectorGeometry,
	vectorMeshDebug,
	resetSolidCache
} from '../../src/lib/vector/vectorMesh.js';
import { cleanVector, vectorDefaults } from '../../src/lib/vector/vectorRecord.js';
import { readStoredFaces } from '../../src/lib/meshTopology.js';
import { fromBufferGeometry } from '../../src/lib/meshKernel/geometry.js';

/** @param {number} n @param {number} r @param {number} [cx] @param {number} [cy] @param {boolean} [ccw] */
const ring = (n, r, cx = 0, cy = 0, ccw = true) =>
	Array.from({ length: n }, (_, i) => {
		const a = ((ccw ? 1 : -1) * i * 2 * Math.PI) / n;
		return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
	});
/** @param {number[][]} r */
const area = (r) => {
	let a = 0;
	for (let i = 0, j = r.length - 1; i < r.length; j = i++)
		a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
	return a / 2;
};
/** the summed signed area of the triangles lying on z = `z` (xy projection) @param {ArrayLike<number>} p @param {number} z */
function areaAt(p, z) {
	let s = 0;
	for (let t = 0; t < p.length; t += 9) {
		if (![p[t + 2], p[t + 5], p[t + 8]].every((v) => Math.abs(v - z) < 1e-6)) continue;
		s +=
			((p[t + 3] - p[t]) * (p[t + 7] - p[t + 1]) - (p[t + 4] - p[t + 1]) * (p[t + 6] - p[t])) / 2;
	}
	return s;
}
const star5 = () => ringsToPolygons([flattenSubpath(starPath(5, 1, 0.45, 0)[0], 0.01)]);
const wavy = (n = 2000) =>
	Array.from({ length: n }, (_, i) => {
		const a = (i / n) * 2 * Math.PI;
		const r = 3 + 0.3 * Math.sin(a * 37);
		return [r * Math.cos(a), r * Math.sin(a)];
	});

describe('rings', () => {
	test('cleanRing drops repeats, the closing duplicate and points on a straight run', () => {
		const r = cleanRing([
			[0, 0],
			[0.5, 0],
			[1, 0],
			[1, 0],
			[1, 1],
			[0, 1],
			[0, 0]
		]);
		expect(r).toEqual([
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1]
		]);
	});
	test('safeInset never lets a side flip: a thin bar caps the bevel at half its thickness', () => {
		const bar = [
			[0, 0],
			[2, 0],
			[2, 0.1],
			[0, 0.1]
		];
		const d = safeInset([bar], [ringMiters(bar)], 0.5);
		expect(d).toBeGreaterThan(0.04);
		expect(d).toBeLessThan(0.05);
	});
	test('profileLevels: no bevel = two levels; a round bevel = quarter circles meeting the side', () => {
		expect(profileLevels(0, 1, 0, 0, 2, 0)).toEqual([
			[0, 0],
			[0, 1]
		]);
		const lv = profileLevels(0, 1, 0.1, 0.1, 2, 0);
		expect(lv.length).toBe(6);
		expect(lv[0][0]).toBeCloseTo(-0.1, 9); // the cap is inset by the width
		expect(lv[0][1]).toBeCloseTo(0, 9);
		expect(lv[2]).toEqual([0, expect.closeTo(0.1, 9)]); // the side starts a width up
		expect(lv[5][1]).toBeCloseTo(1, 9);
		// a bevel that takes the whole depth shares its middle level
		expect(profileLevels(0, 0.2, 0.1, 0.1, 2, 0).length).toBe(5);
	});
});

describe('caps with holes', () => {
	test('one hole = two simple pieces whose areas add up to the region', () => {
		const rings = [ring(32, 1), ring(16, 0.5, 0, 0, false)];
		const { pieces, failures } = bridgePieces(rings);
		expect(failures).toBe(0);
		expect(pieces.length).toBe(2);
		const sum = pieces.reduce((s, piece) => s + area(piece.map(([r, i]) => rings[r][i])), 0);
		expect(sum).toBeCloseTo(area(rings[0]) + area(rings[1]), 9);
		for (const piece of pieces)
			expect(new Set(piece.map((ref) => ref.join(','))).size).toBe(piece.length);
	});
	test('two holes side by side cut into three pieces', () => {
		const rings = [ring(48, 2), ring(12, 0.4, -0.8, 0, false), ring(12, 0.4, 0.8, 0, false)];
		const { pieces, failures } = bridgePieces(rings);
		expect(failures).toBe(0);
		expect(pieces.length).toBe(3);
	});
});

describe('the solid', () => {
	const cases = {
		square: [
			[
				[
					[0, 0],
					[1, 0],
					[1, 1],
					[0, 1]
				]
			]
		],
		annulus: [[ring(32, 1), ring(16, 0.5, 0, 0, false)]],
		twoHoles: [[ring(48, 2), ring(12, 0.4, -0.8, 0, false), ring(12, 0.4, 0.8, 0, false)]],
		star5: star5(),
		roundedRect: ringsToPolygons([flattenSubpath(rectPath(2, 1, 0.3)[0], 0.005)]),
		wavyHole: ringsToPolygons([wavy(), ring(400, 1)])
	};
	for (const [name, polys] of Object.entries(cases))
		for (const width of [0, 0.05])
			test(`${name}, bevel ${width}: closed, manifold, consistently wound, valid`, () => {
				const { mesh, info } = buildSolidKernel(polys, { depth: 0.4, width, segments: 2 });
				const rep = mesh.topologyReport();
				expect(mesh.validate()).toEqual([]);
				expect(rep.closed).toBe(true);
				expect(rep.manifold).toBe(true);
				expect(rep.windingConflicts).toBe(0);
				expect(info.bridgeFailures).toBe(0);
				const out = buildSolidArrays(polys, { depth: 0.4, width, segments: 2 });
				// the caps cover the region exactly (no bevel) / the inset region (bevel), front up, back down
				const front = areaAt(out.positions, 0.4);
				const back = areaAt(out.positions, 0);
				expect(front).toBeCloseTo(-back, 4);
				const region = polys.reduce((s, poly) => s + poly.reduce((t, r) => t + area(r), 0), 0);
				if (width === 0) expect(front).toBeCloseTo(region, 4);
				else expect(front).toBeLessThan(region);
				// the face partition covers every triangle once
				const seen = new Set(out.faces.flat());
				expect(seen.size).toBe(out.positions.length / 9);
			});
	test('a star: one n-gon per cap, quads everywhere else', () => {
		const { mesh } = buildSolidKernel(star5(), { depth: 0.3, width: 0 });
		const sizes = mesh.faceIds().map((f) => mesh.faceSize(f));
		expect(sizes.filter((n) => n === 10).length).toBe(2);
		expect(sizes.filter((n) => n === 4).length).toBe(10);
	});
	test('budget: a 2 000-point path with a hole builds in well under 300 ms', () => {
		const { info } = buildSolidKernel(ringsToPolygons([wavy(), ring(400, 1)]), {
			depth: 0.5,
			width: 0.05,
			segments: 2
		});
		expect(info.ms).toBeLessThan(300);
	});
	test('normals: caps point along z, a smooth side has no crease along a curve', () => {
		const out = buildSolidArrays([[ring(64, 1)]], { depth: 0.5, width: 0 });
		const p = out.positions;
		const n = /** @type {Float32Array} */ (out.normals);
		for (let i = 0; i < p.length; i += 3) {
			const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
			expect(len).toBeCloseTo(1, 5);
			const onCap = Math.abs(p[i + 2] - 0.5) < 1e-6 || Math.abs(p[i + 2]) < 1e-6;
			const side = Math.abs(n[i + 2]) < 1e-6;
			// a side corner's normal is radial (smooth), a cap corner's is +-z
			if (side) expect(Math.abs(n[i] * p[i] + n[i + 1] * p[i + 1])).toBeCloseTo(1, 3);
			else expect(onCap).toBe(true);
		}
	});
});

describe('buildVectorGeometry on the kernel', () => {
	const star = (patch = {}) => cleanVector({ ...vectorDefaults('star'), ...patch });
	test('an extruded star stores its kernel faces; flat stays as it was (no partition)', () => {
		const flat = buildVectorGeometry(star());
		expect(flat.userData.__topo).toBeUndefined();
		const solid = buildVectorGeometry(star({ depth: 0.3, bevel: 0.03 }));
		const faces = readStoredFaces(solid);
		expect(faces).not.toBeNull();
		expect(Math.max(...(faces ?? []).map((f) => f.length))).toBeGreaterThan(2); // an n-gon cap
		solid.computeBoundingBox();
		expect(solid.boundingBox?.min.z).toBeCloseTo(0, 6);
		expect(solid.boundingBox?.max.z).toBeCloseTo(0.3, 6);
	});
	test('the editor reads it back as the same clean mesh (n-gons kept, closed)', () => {
		const solid = buildVectorGeometry(star({ depth: 0.3, bevel: 0.03, bevelSegments: 3 }));
		const { mesh, report } = fromBufferGeometry(solid, { weld: 1e-4 });
		expect(report.partition).toBe('used');
		expect(report.fallbackFaces).toBe(0);
		const rep = mesh.topologyReport();
		expect(rep.closed).toBe(true);
		expect(rep.manifold).toBe(true);
	});
	test('a stroked solid: the partition still covers every triangle (stroke triangles are their own faces)', () => {
		const g = buildVectorGeometry(star({ depth: 0.2, strokeWidth: 0.02 }));
		expect(readStoredFaces(g)).not.toBeNull();
	});
	test('bevelSegments is additive: absent = 2, clamped 1..8', () => {
		expect(cleanVector({ kind: 'star' }).bevelSegments).toBe(2);
		expect(cleanVector({ kind: 'star', bevelSegments: 99 }).bevelSegments).toBe(8);
		expect(cleanVector({ kind: 'star', bevelSegments: 0 }).bevelSegments).toBe(1);
	});
	test('a depth-only change takes the fast path and matches a full build', () => {
		resetSolidCache();
		const base = star({ depth: 0.3, bevel: 0.03, strokeWidth: 0.01 });
		buildVectorGeometry(base);
		const before = vectorMeshDebug().fastBuilds;
		const fast = buildVectorGeometry({ ...base, depth: 0.7 });
		expect(vectorMeshDebug().fastBuilds).toBe(before + 1);
		resetSolidCache();
		const full = buildVectorGeometry({ ...base, depth: 0.7 });
		const a = fast.attributes.position.array;
		const b = full.attributes.position.array;
		expect(a.length).toBe(b.length);
		let worst = 0;
		for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
		expect(worst).toBeLessThan(1e-5);
		expect(fast.userData.__topo).toEqual(full.userData.__topo);
		// a bevel that no longer fits inside the depth builds in full
		const n = vectorMeshDebug().fastBuilds;
		buildVectorGeometry({ ...base, depth: 0.05 });
		expect(vectorMeshDebug().fastBuilds).toBe(n);
	});
	test('64-int: a layered solid (64-vector-edit layer + 64-extrude depth drag) takes the fast path and matches a full build', () => {
		resetSolidCache();
		// a thin solid: the 8 mm lift is more than half its depth, so the halves must part ABOVE the lift
		const base = star({ depth: 0.01, bevel: 0, layer: 4 });
		const first = buildVectorGeometry(base);
		first.computeBoundingBox();
		expect(first.boundingBox?.min.z).toBeCloseTo(0.008, 5); // 4 layer steps of 2 mm
		const before = vectorMeshDebug().fastBuilds;
		const fast = buildVectorGeometry({ ...base, depth: 0.05 });
		expect(vectorMeshDebug().fastBuilds).toBe(before + 1);
		resetSolidCache();
		const full = buildVectorGeometry({ ...base, depth: 0.05 });
		const a = fast.attributes.position.array;
		const b = full.attributes.position.array;
		expect(a.length).toBe(b.length);
		let worst = 0;
		for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
		expect(worst).toBeLessThan(1e-5);
	});
});

describe('the 2D toolbar contract (64-2d Q9)', () => {
	test('src/lib/extrude/tools2d.js: one Extrude tool at order 50 with a Lucide icon the Icon map knows', async () => {
		const tools = (await import('../../src/lib/extrude/tools2d.js')).default;
		expect(tools.map((t) => [t.id, t.order, t.icon])).toEqual([['extrude', 50, 'box']]);
		expect(typeof tools[0].run).toBe('function');
		const fs = await import('fs');
		expect(fs.readFileSync('src/components/ui/Icon.svelte', 'utf8')).toMatch(/\n\t\tbox: Box,/);
	});
});

describe('64-int: the corner limit (text keeps three\'s sqrt(2))', () => {
	// a sharp apex: 20 degrees at (0, 1), counter-clockwise
	const tri = [[-0.18, 0], [0.18, 0], [0, 1]];
	const len = (m, i) => Math.hypot(m[i * 2], m[i * 2 + 1]);
	test('ringMiters caps the apex at the given limit; the default (shapes) lets it reach 6', () => {
		expect(len(ringMiters(tri), 2)).toBeGreaterThan(5);
		expect(len(ringMiters(tri, Math.SQRT2), 2)).toBeCloseTo(Math.SQRT2, 6);
	});
	test('buildSolidArrays({miterMax: sqrt 2}) keeps a bevelled apex within sqrt(2) x the outset of the outline', () => {
		const polys = [[tri]];
		const opts = { zBack: 0, zFront: 0.2, width: 0.03, thickness: 0.03, outset: 0.03, segments: 3, clamp: false };
		const top = (o) => {
			let y = -Infinity;
			const p = buildSolidArrays(polys, o).positions;
			for (let i = 1; i < p.length; i += 3) y = Math.max(y, p[i]);
			return y;
		};
		expect(top({ ...opts, miterMax: Math.SQRT2 }) - 1).toBeLessThanOrEqual(0.03 * Math.SQRT2 + 1e-6);
		expect(top(opts) - 1).toBeGreaterThan(0.03 * 3);
	});
});
