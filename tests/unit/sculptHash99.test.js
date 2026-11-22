// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K6 — THE SCULPT PARITY GATE: the brush on the kernel's SpatialHash (src/lib/terrainSculpt.js) against
// the pre-K6 linear-scan brush frozen in tests/unit/fixtures/sculptSoup99.js. Same strokes, same positions and
// normals (asserted within 1e-6; the measured difference is 0 — the hash only chooses WHICH vertices are visited,
// in the same ascending order, and every distance / falloff / displacement is the same expression). Every rebuild
// policy, the pre-load linear fallback ('scan'), and a remote/undo geometry swap mid-stroke.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as THREE from 'three';

vi.mock('$lib/objectActions', () => ({ selectObject: () => {}, deselectObject: () => {}, moveObjectToGroup: () => {}, duplicateObject: () => null }));
vi.mock('$lib/physics', () => ({ setPhysicsFor: () => {}, physicsShapeChanged: () => {} }));

const { objectsGroup } = await import('../../src/stores/sceneStore');
const ops = await import('../../src/lib/meshOps/index.js');
const soupOps = await import('./fixtures/soupOps99b.js');
const { readTriangles } = await import('../../src/lib/faceEdit.js');
const { editorPartition, opMeshOf } = await import('./fixtures/meshOps99bHarness.js');
const ts = await import('../../src/lib/terrainSculpt.js');
const old = await import('./fixtures/sculptSoup99.js');

const EPS = 1e-6;

/** mulberry32 */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** a bumpy terrain plane, non-indexed the way enterSculpt leaves it */
export function terrainPlane(segments = 48, size = 24) {
	const g = new THREE.PlaneGeometry(size, size, segments, segments);
	g.rotateX(-Math.PI / 2);
	const p = g.attributes.position;
	for (let i = 0; i < p.count; i++) p.setY(i, 0.4 * Math.sin(p.getX(i) * 0.7) * Math.cos(p.getZ(i) * 0.5));
	const n = g.toNonIndexed();
	n.computeVertexNormals();
	return n;
}

/** a sphere, non-indexed (SphereGeometry(1, 260, 130) = 67k triangles) */
export function sphere(w = 32, h = 16) {
	const n = new THREE.SphereGeometry(1, w, h).toNonIndexed();
	n.computeVertexNormals();
	return n;
}

/** a reproducible list of strokes over a geometry: each = op, radius, strength, dt, dabs (points near the surface) */
export function strokesFor(geometry, seed, mode, count = 6, dabs = 12) {
	const rand = rng(seed);
	const p = geometry.attributes.position;
	const ops = ['raise', 'lower', 'smooth', 'flatten'];
	const box = new THREE.Box3().setFromBufferAttribute(p);
	const span = box.getSize(new THREE.Vector3()).length();
	const out = [];
	for (let s = 0; s < count; s++) {
		const op = ops[s % 4];
		const radius = span * (0.04 + rand() * 0.12);
		const strength = 0.2 + rand() * 0.8;
		const dt = [0.016, 0.033, 0.05][s % 3];
		const at = Math.floor(rand() * p.count);
		const c = new THREE.Vector3(p.getX(at), p.getY(at), p.getZ(at));
		const step = new THREE.Vector3(rand() - 0.5, mode === 'terrain' ? 0 : rand() - 0.5, rand() - 0.5).multiplyScalar(radius * 0.3);
		const list = [];
		for (let d = 0; d < dabs; d++) list.push(c.clone().addScaledVector(step, d));
		out.push({ op, radius, strength, dt, dabs: list });
	}
	return out;
}

/** two meshes from one geometry: the new brush's (in objectsGroup) and the frozen brush's */
function pair(geometry) {
	const a = new THREE.Mesh(geometry.clone());
	const b = new THREE.Mesh(geometry.clone());
	const group = new THREE.Group();
	group.add(a);
	objectsGroup.set(group);
	old.setObjectResolver((uuid) => (uuid === b.uuid ? b : null));
	return { a, b };
}

function dab(api, mesh, mode, s, c) {
	return mode === 'mesh'
		? api.applyMeshBrushAt(mesh.uuid, c.x, c.y, c.z, s.op, s.radius, s.strength, s.dt)
		: api.applyBrushAt(mesh.uuid, c.x, c.z, s.op, s.radius, s.strength, s.dt);
}

function maxDiff(x, y) {
	expect(x.length).toBe(y.length);
	let m = 0;
	for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]));
	return m;
}

/** run `strokes` both ways; returns the worst position + normal difference and the touched agreement */
function run(geometry, mode, strokes, opts = {}) {
	const { a, b } = pair(geometry);
	let worst = 0;
	let dabsMoved = 0;
	for (let si = 0; si < strokes.length; si++) {
		const s = strokes[si];
		ts.beginStroke(a.uuid);
		for (let d = 0; d < s.dabs.length; d++) {
			if (opts.swapAt && opts.swapAt(si, d)) {
				// a remote stroke / undo: applyMeshGeo replaces the position ATTRIBUTE (same values here, moved by a
				// shift so a stale cache would show) on both, then runs the rebuild hook
				for (const m of [a, b]) {
					const arr = m.geometry.attributes.position.array.slice();
					for (let i = 1; i < arr.length; i += 3) arr[i] += 0.05;
					m.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
					m.geometry.computeVertexNormals();
				}
				if (opts.hook) ts.rebuildSculptCaches(a);
			}
			const tn = dab(ts, a, mode, s, s.dabs[d]);
			const to = dab(old, b, mode, s, s.dabs[d]);
			expect(tn).toBe(to);
			if (to) dabsMoved++;
		}
		ts.endStroke();
		worst = Math.max(worst, maxDiff(a.geometry.attributes.position.array, b.geometry.attributes.position.array));
		worst = Math.max(worst, maxDiff(a.geometry.attributes.normal.array, b.geometry.attributes.normal.array));
	}
	return { worst, dabsMoved };
}

beforeAll(async () => {
	expect(await ts.sculptHashReady()).toBe(true);
});

const CASES = [
	{ name: 'terrain plane 48', make: () => terrainPlane(48), mode: 'terrain', strokes: 8 },
	{ name: 'terrain plane 120', make: () => terrainPlane(120, 40), mode: 'terrain', strokes: 4 },
	{ name: 'sphere, terrain mode', make: () => sphere(32, 16), mode: 'terrain', strokes: 4 },
	{ name: 'terrain plane, mesh mode', make: () => terrainPlane(48), mode: 'mesh', strokes: 8 },
	{ name: 'sphere 32x16', make: () => sphere(32, 16), mode: 'mesh', strokes: 8 },
	{ name: 'sphere 67k', make: () => sphere(260, 130), mode: 'mesh', strokes: 4, dabs: 6 }
];

describe('99 K6: the sculpt brush on the spatial hash = the linear-scan brush', () => {
	for (const c of CASES) {
		const g = c.make();
		for (const policy of ['adaptive', 'stroke', 'dab', 'scan']) {
			if (c.name === 'sphere 67k' && policy !== 'adaptive' && policy !== 'stroke') continue;
			it(`${c.name} (${c.mode} mode, ${policy})`, () => {
				ts.sculptHashDebug(policy);
				const before = ts.sculptHashDebug();
				const r = run(g, c.mode, strokesFor(g, 7, c.mode, c.strokes, c.dabs ?? 12));
				const after = ts.sculptHashDebug();
				expect(r.worst).toBeLessThanOrEqual(EPS);
				expect(r.dabsMoved).toBeGreaterThan(0);
				if (policy === 'scan') expect(after.hashed).toBe(before.hashed);
				else expect(after.scanned).toBe(before.scanned);
				ts.sculptHashDebug('adaptive');
			}, 120000);
		}
	}

	it('big strokes (the drift outgrows the cell): every policy still matches', () => {
		const g = sphere(48, 24);
		const strokes = strokesFor(g, 11, 'mesh', 4, 20).map((s) => ({ ...s, strength: 1, dt: 0.05 }));
		for (const policy of ['adaptive', 'stroke', 'dab']) {
			ts.sculptHashDebug(policy);
			expect(run(g, 'mesh', strokes).worst).toBeLessThanOrEqual(EPS);
		}
		ts.sculptHashDebug('adaptive');
	});

	it('the radius changes mid-stroke (the hash re-cells)', () => {
		const g = sphere(48, 24);
		const strokes = strokesFor(g, 5, 'mesh', 4, 12).map((s) => ({ ...s, dabs: s.dabs }));
		const { a, b } = pair(g);
		for (const s of strokes) {
			ts.beginStroke(a.uuid);
			s.dabs.forEach((c, i) => {
				const t = { ...s, radius: s.radius * (i % 3 === 0 ? 3 : i % 3 === 1 ? 0.2 : 1) };
				expect(dab(ts, a, 'mesh', t, c)).toBe(dab(old, b, 'mesh', t, c));
			});
			ts.endStroke();
		}
		expect(maxDiff(a.geometry.attributes.position.array, b.geometry.attributes.position.array)).toBeLessThanOrEqual(EPS);
	});

	for (const mode of ['mesh', 'terrain']) {
		for (const hook of [true, false]) {
			it(`a remote/undo geometry swap mid-stroke (${mode} mode, ${hook ? 'the applyMeshGeo hook' : 'the attribute-identity guard alone'})`, () => {
				const g = mode === 'mesh' ? sphere(48, 24) : terrainPlane(48);
				ts.sculptMode.set(mode); // rebuildSculptCaches picks the map by the session's mode
				const r = run(g, mode, strokesFor(g, 3, mode, 4, 10), { swapAt: (si, d) => d === 5 || (si === 2 && d === 0), hook });
				expect(r.worst).toBeLessThanOrEqual(EPS);
			});
		}
	}
});

describe('99 K6: endStroke compare (typed arrays, the JSON.stringify semantics)', () => {
	const json = (a, b) => JSON.stringify(Array.from(a)) !== JSON.stringify(Array.from(b));
	const cases = [
		[[1, 2, 3], [1, 2, 3]],
		[[1, 2, 3], [1, 2, 3.0000001]],
		[[1, 2], [1, 2, 3]],
		[[0], [-0]],
		[[NaN], [NaN]],
		[[NaN], [Infinity]],
		[[Infinity], [-Infinity]],
		[[NaN], [0]],
		[[], []]
	];
	for (const [x, y] of cases)
		it(`${JSON.stringify(x)} vs ${JSON.stringify(y)} (as written: ${String(x)} / ${String(y)})`, () => {
			expect(ts.positionsDiffer(new Float32Array(x), new Float32Array(y))).toBe(json(new Float32Array(x), new Float32Array(y)));
			expect(ts.positionsDiffer(x, y)).toBe(json(x, y));
		});
});

describe('99 K6: mergeByDistance clusters through neighbouring cells', () => {
	/** a geometry of loose triangles (flat x,y,z lists) */
	const soupOf = (...tris) => {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
		return g;
	};
	const run = (g, threshold) => {
		const tris = readTriangles(g);
		const partition = editorPartition(g, tris);
		const om = ops.beginOp(opMeshOf(g, partition));
		const k = ops.mergeByDistance(om, threshold);
		return { k, soup: soupOps.mergeByDistanceSoup(tris, partition, threshold), out: k.error ? null : ops.opOutput(om, { order: 'appearance' }) };
	};
	const xsOf = (positions) => [...new Set(Array.from({ length: positions.length / 3 }, (_, i) => positions[i * 3]))].sort((a, b) => a - b);

	it('two copies 1e-6 apart straddling a cell wall merge (the grid never merged them)', () => {
		// threshold 3e-4: the old grid's wall at x = 1.5e-4 (round(x / 3e-4) = 0 | 1) is also a wall of the op mesh's
		// 1e-4 import weld (round(x * 1e4) = 1 | 2), so the two copies arrive as two vertices
		const xa = Math.fround(1.5e-4 - 5e-7);
		const xb = Math.fround(1.5e-4 + 5e-7);
		const g = soupOf([xa, 0, 0, 0, 1, 0, -1, 0, 0], [xb, 0, 0, 1, 0, 0, 0, 1, 0]);
		const { k, soup, out } = run(g, 3e-4);
		expect(soup.error).toBe('No vertices closer than 0.0003 to merge'); // the old rule: two cells, nothing to do
		expect(k.error).toBeUndefined();
		expect(k.moved).toBe(2);
		expect(k.dropped).toBe(0);
		// both corners went to their mean, so the seam is one vertex now
		const xs = xsOf(out.positions);
		expect(xs.length).toBe(4); // -1, 0, the merged copy, 1
		expect(xs[2]).toBeCloseTo((xa + xb) / 2, 9);
	});

	it('greedy, not transitive: a claims b (within the threshold), c beyond a stays (a strip never collapses end to end)', () => {
		const e = 0.01;
		// three corners on a line 0.8 * e apart: a-c is 1.6 * e
		const g = soupOf([0, 0, 0, 0, 1, 0, -1, 0, 0], [0.008, 0, 0, 0, -1, 0, 1, 0, 0], [0.016, 0, 0, 1, 1, 0, 0.5, 2, 0]);
		const { k, out } = run(g, e);
		expect(k.error).toBeUndefined();
		expect(k.moved).toBe(2); // a and b move to their mean 0.004; c keeps its place
		const p = out.positions;
		const merged = [...new Set(Array.from({ length: p.length / 3 }, (_, i) => i).filter((i) => p[i * 3 + 1] === 0 && Math.abs(p[i * 3]) < 0.1).map((i) => p[i * 3]))].sort((x, y) => x - y);
		expect(merged.length).toBe(2);
		expect(merged[0]).toBeCloseTo(0.004, 6);
		expect(merged[1]).toBeCloseTo(0.016, 6);
	});

	it('exactly the threshold apart merges (inclusive); just beyond it does not', () => {
		const e = 0.01;
		const at = (dx) => soupOf([0, 0, 0, 0, 1, 0, -1, 0, 0], [dx, 0, 0, 1, 0, 0, 0.5, -1, 0]);
		expect(run(at(Math.fround(0.009999)), e).k.error).toBeUndefined();
		expect(run(at(0.0101), e).k.error).toBe('No vertices closer than 0.01 to merge');
	});
});
