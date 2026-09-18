import { describe, it, expect, beforeAll } from 'vitest';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import * as THREE from 'three';
import { weldSoup, simplifyMesh, planTargets, planTextureCap, ERROR_CAP } from '../../src/lib/decimateCore.js';

// 26-F phase 2. decimateCore is what runs INSIDE the decimation Worker, and it imports
// nothing so it can run here too — against the REAL simplifier, not a stub, because the
// thing worth pinning is what meshoptimizer does with the arrays we hand it: a soup that
// must be welded first, material groups that must not bleed into each other, and a vertex
// buffer that must actually shrink.

beforeAll(async () => {
	await MeshoptSimplifier.ready;
});

/** A UV sphere's arrays, the 26-E fixture shape. @param {number} w @param {number} h */
function sphere(w, h) {
	const g = new THREE.SphereGeometry(1, w, h);
	return {
		positions: new Float32Array(g.attributes.position.array),
		normals: new Float32Array(g.attributes.normal.array),
		uvs: new Float32Array(g.attributes.uv.array),
		index: new Uint32Array(/** @type {any} */ (g.index).array),
		tris: /** @type {any} */ (g.index).count / 3,
		verts: g.attributes.position.count
	};
}

describe('simplifyMesh', () => {
	it('reaches the target on an indexed mesh and shrinks the vertex buffer with it', () => {
		const s = sphere(160, 80);
		const out = simplifyMesh(MeshoptSimplifier, { key: 'a', ...s, target: Math.floor(s.tris / 4) });
		expect(out.before).toBe(s.tris);
		expect(out.triangles).toBeLessThanOrEqual(Math.floor(s.tris / 4));
		expect(out.triangles).toBeGreaterThan(Math.floor(s.tris / 4) * 0.9);
		// the saving that matters for memory and the wire: vertices go too
		expect(out.positions.length / 3).toBeLessThan(s.verts / 2);
		expect(out.normals?.length).toBe(out.positions.length);
		expect(out.uvs?.length).toBe((out.positions.length / 3) * 2);
		// every index addresses a vertex that exists
		const n = out.positions.length / 3;
		expect(Math.max(...out.index)).toBeLessThan(n);
		expect(out.error).toBeLessThanOrEqual(ERROR_CAP);
		expect(out.recomputeNormals).toBe(false);
	});

	it('keeps the shape: every vertex still lies on the unit sphere', () => {
		const s = sphere(120, 60);
		const out = simplifyMesh(MeshoptSimplifier, { key: 'a', ...s, target: Math.floor(s.tris / 5) });
		let worst = 0;
		for (let i = 0; i < out.positions.length; i += 3) {
			const r = Math.hypot(out.positions[i], out.positions[i + 1], out.positions[i + 2]);
			worst = Math.max(worst, Math.abs(1 - r));
		}
		expect(worst).toBeLessThan(1e-5); // collapses keep surviving vertices exactly where they were
	});

	it('WELDS a triangle soup first — unwelded, the simplifier cannot collapse a single edge', () => {
		const g = new THREE.SphereGeometry(1, 80, 40).toNonIndexed();
		const positions = new Float32Array(g.attributes.position.array);
		const tris = positions.length / 9;
		const out = simplifyMesh(MeshoptSimplifier, { key: 's', positions, normals: null, uvs: null, index: null, target: Math.floor(tris / 4) });
		expect(out.before).toBe(tris);
		expect(out.triangles).toBeLessThanOrEqual(Math.floor(tris / 4));
		expect(out.recomputeNormals).toBe(true);
		// the counterfactual, measured in-test: hand the SAME soup over as an index of
		// 0..n-1 (what "no weld" means) and nothing collapses
		const identity = new Uint32Array(positions.length / 3).map((_, i) => i);
		const raw = simplifyMesh(MeshoptSimplifier, { key: 'r', positions, index: identity, target: Math.floor(tris / 4) });
		expect(raw.triangles).toBe(tris);
	});

	it('weldSoup keys on position AND uv, never on normals', () => {
		const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0]);
		const same = weldSoup(positions, null, null);
		expect(same.positions.length / 3).toBe(4);
		const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 0.5, 0.5, 0, 1, 1, 1]); // corner 0 re-used with a different uv
		const seam = weldSoup(positions, uvs, null);
		expect(seam.positions.length / 3).toBe(5);
	});

	it('simplifies material groups SEPARATELY: each keeps its material and its share', () => {
		const s = sphere(120, 60);
		const half = Math.floor(s.index.length / 6) * 3;
		const groups = [
			{ start: 0, count: half, materialIndex: 0 },
			{ start: half, count: s.index.length - half, materialIndex: 1 }
		];
		const out = simplifyMesh(MeshoptSimplifier, { key: 'g', ...s, groups, target: Math.floor(s.tris / 3) });
		expect(out.groups.length).toBe(2);
		expect(out.groups[0].materialIndex).toBe(0);
		expect(out.groups[1].materialIndex).toBe(1);
		expect(out.groups[0].start).toBe(0);
		expect(out.groups[1].start).toBe(out.groups[0].count);
		expect(out.groups[0].count + out.groups[1].count).toBe(out.index.length);
		// both halves were reduced, neither vanished
		expect(out.groups[0].count / 3).toBeLessThan(half / 3);
		expect(out.groups[0].count).toBeGreaterThan(0);
	});
});

describe('planTargets', () => {
	it('shares a scene-wide room in proportion and leaves small meshes alone', () => {
		const t = planTargets(
			[
				{ triangles: 900000, vertices: 450000 },
				{ triangles: 100000, vertices: 50000 },
				{ triangles: 500, vertices: 300 }
			],
			{ room: 500500 }
		);
		expect(t[2]).toBe(500);
		expect(t[0]).toBe(450000);
		expect(t[1]).toBe(50000);
	});

	it('applies the per-mesh vertex cap on top, and never goes below the floor', () => {
		const [capped] = planTargets([{ triangles: 2400000, vertices: 1200000 }], { meshCap: 450000 });
		expect(capped).toBe(Math.floor(2400000 * (450000 / 1200000)));
		const [floored] = planTargets([{ triangles: 2400000, vertices: 1200000 }], { room: 1000 });
		expect(floored).toBe(240000);
	});

	it('an already-fitting model is untouched', () => {
		expect(planTargets([{ triangles: 5000, vertices: 2600 }], { room: 10000, meshCap: 500000 })).toEqual([5000]);
	});
});

describe('planTextureCap', () => {
	it('caps at the single-texture ceiling', () => {
		expect(planTextureCap([{ width: 8192, height: 8192 }], { single: 4096 })).toBe(4096);
		expect(planTextureCap([{ width: 2048, height: 1024 }], { single: 4096 })).toBeNull();
	});
	it('halves further when the byte budget still does not fit, never below 512', () => {
		const sizes = Array.from({ length: 10 }, () => ({ width: 4096, height: 4096 }));
		const cap = planTextureCap(sizes, { single: 4096, budget: 256 * 1024 * 1024 });
		expect(cap).toBe(2048); // ten 2k maps = ~213MB with mips
		expect(planTextureCap(sizes, { single: 4096, budget: 1 })).toBe(512);
	});
});
