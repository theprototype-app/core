// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 family 5 (lane 99-ops-b) — THE PARITY GATE for merge / dissolve / delete: every ported operator
// against the pre-port soup code (tests/unit/fixtures/soupOps99b.js, frozen) on the fixture set. Same positions
// (<= eps), the same face partition in the same stored order, the same uvs and material groups, the same refusals
// and the same counts the toasts print.
import { describe, it, expect } from 'vitest';
import { readTriangles } from '$lib/faceEdit.js';
import { composeFaces } from '$lib/meshTopology.js';
import { storedPartition } from '$lib/meshKernel/index.js';
import * as ops from '$lib/meshOps/index.js';
import * as soup from './fixtures/soupOps99b.js';
import * as fx from './fixtures/meshOps99bFixtures.js';
import { snappedCorners, editorPartition, partnerOf, opMeshOf, stateOf, expectSame } from './fixtures/meshOps99bHarness.js';

const BIG = !!process.env.MESHOPS_BIG;

/** corners in a weld (1e-4 key) cell that holds two different points */
function weldCellCorners(tris) {
	const cells = new Map();
	for (const t of tris)
		for (const v of t) {
			const key = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
			const c = cells.get(key) ?? { n: 0, pts: new Set() };
			c.n++;
			c.pts.add(`${v.x},${v.y},${v.z}`);
			cells.set(key, c);
		}
	let n = 0;
	for (const c of cells.values()) if (c.pts.size > 1) n += c.n;
	return n;
}

/** run one family-5 op both ways */
export function both5(geometry, op, arg, opts = {}) {
	const tris = readTriangles(geometry);
	const partition = editorPartition(geometry, tris);
	const om = ops.beginOp(opMeshOf(geometry, partition));
	let r;
	let k;
	let order = 'appearance';
	if (op === 'merge') {
		r = soup.mergeByDistanceSoup(tris, partition, arg);
		k = ops.mergeByDistance(om, arg);
		if (!r.error) {
			// the toast's corner count: two points the 1e-4 weld already made one vertex count as moved corners in the
			// soup (both go to their mean) and not here — bounded by the corners in such weld cells
			expect(Math.abs(k.moved - r.moved)).toBeLessThanOrEqual(weldCellCorners(tris));
			expect(k.dropped).toBe(r.dropped);
		}
	} else if (op === 'dissolveEdges') {
		r = soup.dissolveEdgesSoup(tris, partition, partnerOf(partition, tris.length), arg);
		k = ops.dissolveEdges(om, ops.edgesOfKeys(om, arg), partnerOf(partition, tris.length));
		if (!r.error) {
			expect(k.dissolved).toBe(r.dissolved);
			expect(k.skipped).toBe(r.skipped);
		}
	} else if (op === 'dissolveVertices') {
		r = soup.dissolveVerticesCore(tris, partition, arg);
		k = ops.dissolveVertices(om, ops.verticesOfKeys(om, arg));
		expect(k.done).toBe(r.done);
		expect(k.skipped).toBe(r.skipped);
		if (!r.done) return { refused: true };
		order = 'stored';
	} else if (op === 'deleteEdges') {
		r = soup.deleteEdgesSoup(tris, partition, arg);
		const drop = ops.trianglesOnSides(om, ops.edgesOfKeys(om, arg));
		if (r.error) return { error: r.error, kernelDrop: drop.length, all: tris.length };
		expect(drop.length).toBe(r.dropped);
		k = ops.deleteTriangles(om, drop);
	} else if (op === 'deleteVertices') {
		// the vertex-mode delete composes onto the STORED partition; with none stored the soup made every survivor
		// its own face, and so does the commit (faceEdit deleteVertices) — compared that way below
		r = soup.deleteVerticesSoup(tris, storedPartition(geometry), arg);
		if (!storedPartition(geometry)) order = 'singletons';
		const drop = ops.trianglesTouching(om, ops.verticesOfKeys(om, arg));
		if (r.error) return { error: r.error, kernelDrop: drop.length, all: tris.length };
		expect(drop.length).toBe(r.dropped);
		k = ops.deleteTriangles(om, drop);
	} else if (op === 'deleteFaces') {
		const kept = soup.deleteFaceTris(tris, { triIndices: arg });
		const drop = new Set(arg);
		r = { tris: kept, faces: composeFaces(partition, soup.survivorOrigin(tris.length, drop), []) };
		k = ops.deleteTriangles(om, arg);
	}
	if (r.error) return { error: r.error, kernelError: k?.error ?? null };
	const neu = ops.opOutput(om, { order: order === 'singletons' ? 'appearance' : order });
	if (order === 'singletons') neu.faces = Array.from({ length: neu.positions.length / 9 }, (_, t) => [t]);
	return { old: stateOf(r.tris, r.faces), neu, r, k, snapped: snappedCorners(tris) };
}

function cases() {
	const out = [];
	const add = (name, make, list) => out.push({ name, make, list });
	// MERGE
	add('cracked grid (0.001)', fx.crackedGrid, () => [{ op: 'merge', arg: 0.001 }]);
	add('cracked grid (1e-5 floor: refusal)', fx.crackedGrid, () => [{ op: 'merge', arg: 0 }]);
	add('sliver cube (an edge collapses)', fx.sliverCube, () => [{ op: 'merge', arg: 0.001 }]);
	add('grid collapsed by a big threshold', () => fx.grid(4), () => [{ op: 'merge', arg: 0.8 }]);
	add('cube: nothing to merge (refusal)', fx.cube, () => [{ op: 'merge', arg: 0.001 }]);
	add('split-normals uv seams: nothing moves (refusal)', fx.splitNormalsUv, () => [{ op: 'merge', arg: 0.001 }]);
	add('two prisms pushed together', () => fx.merged(fx.ngonPrism(), fx.ngonPrism(), [0, 1.0004, 0]), () => [{ op: 'merge', arg: 0.001 }]);
	// DISSOLVE EDGES
	const dissolveEdges = (g) => {
		const keys = fx.interiorEdgeKeys(g);
		return [
			{ op: 'dissolveEdges', arg: [keys[0]] },
			{ op: 'dissolveEdges', arg: keys.slice(0, 3) },
			{ op: 'dissolveEdges', arg: keys }
		];
	};
	add('grid 3x3', () => fx.grid(3), dissolveEdges);
	add('split-normals uv box', fx.splitNormalsUv, dissolveEdges);
	add('skinned box', fx.skinned, dissolveEdges);
	add('cube (corners: refusal)', fx.cube, dissolveEdges);
	add('open box', fx.openBox, dissolveEdges);
	// DISSOLVE VERTICES
	const dissolveVerts = (g) => {
		const keys = fx.vertexKeys(g);
		return [
			{ op: 'dissolveVertices', arg: [keys[0]] },
			{ op: 'dissolveVertices', arg: [keys[4]] },
			{ op: 'dissolveVertices', arg: keys.slice(2, 5) },
			{ op: 'dissolveVertices', arg: [keys[1], keys[1]] },
			{ op: 'dissolveVertices', arg: ['9,9,9'] }
		];
	};
	add('grid 3x3', () => fx.grid(3), (g) => [
		...dissolveVerts(g),
		// an interior vertex (four quads -> one octagon) and two at once
		{ op: 'dissolveVertices', arg: ['-3333,3333,0'] },
		{ op: 'dissolveVertices', arg: ['-3333,3333,0', '3333,-3333,0'] }
	]);
	add('cube', fx.cube, dissolveVerts);
	add('ngon prism', fx.ngonPrism, dissolveVerts);
	add('split-normals uv box', fx.splitNormalsUv, dissolveVerts);
	add('skinned box', fx.skinned, dissolveVerts);
	add('open box', fx.openBox, dissolveVerts);
	add('L hole', fx.lHole, dissolveVerts);
	// DELETE
	const deletes = (g) => {
		const edges = [...fx.interiorEdgeKeys(g), ...fx.borderKeys(g)];
		const verts = fx.vertexKeys(g);
		const tris = readTriangles(g);
		return [
			{ op: 'deleteEdges', arg: [edges[0]] },
			{ op: 'deleteEdges', arg: edges.slice(1, 4) },
			{ op: 'deleteEdges', arg: edges },
			{ op: 'deleteVertices', arg: [verts[0]] },
			{ op: 'deleteVertices', arg: verts.slice(1, 3) },
			{ op: 'deleteVertices', arg: verts },
			{ op: 'deleteFaces', arg: [0, 1] },
			{ op: 'deleteFaces', arg: [1] },
			{ op: 'deleteFaces', arg: tris.map((_, i) => i).filter((i) => i % 3 === 0) }
		];
	};
	add('cube', fx.cube, deletes);
	add('ngon prism', fx.ngonPrism, deletes);
	add('split-normals uv box', fx.splitNormalsUv, deletes);
	add('skinned box', fx.skinned, deletes);
	add('grid 3x3', () => fx.grid(3), deletes);
	add('ngon prism: half the cap n-gon', fx.ngonPrism, (g) => [{ op: 'deleteFaces', arg: fx.facing(g, [0, 1, 0]).slice(0, 3) }]);
	if (BIG) {
		add('scan67k: merge 0.004', fx.scan67k, () => [{ op: 'merge', arg: 0.004 }]);
		add('scan67k: dissolve 40 edges', fx.scan67k, (g) => [{ op: 'dissolveEdges', arg: fx.interiorEdgeKeys(g).filter((_, i) => i % 997 === 0).slice(0, 40) }]);
		add('scan67k: dissolve 20 vertices', fx.scan67k, (g) => [{ op: 'dissolveVertices', arg: fx.vertexKeys(g).filter((_, i) => i % 1601 === 0).slice(0, 20) }]);
		add('scan67k: delete a patch by vertices', fx.scan67k, (g) => [{ op: 'deleteVertices', arg: fx.vertexKeys(g).slice(5000, 5400) }]);
		add('scan67k: delete faces', fx.scan67k, (g) => [{ op: 'deleteFaces', arg: fx.near(g, [0, 1, 0], 0.3) }]);
	}
	return out;
}

describe('99 K4 family 5: merge / dissolve / delete on the kernel = the soup operators', () => {
	for (const { name, make, list } of cases()) {
		const g = make();
		list(g).forEach((c, i) => {
			it(`${name} / ${c.op} #${i}`, () => {
				const run = both5(g, c.op, c.arg, c.opts);
				// the 67k cases are there to do work, not to agree on a refusal
				if (name.startsWith('scan67k')) expect(!!(run.refused || run.error)).toBe(false);
				if (run.refused) return;
				if (run.error) {
					if ('kernelError' in run) expect(run.kernelError).toBe(run.error);
					// a delete's refusals are the caller's (nothing picked / everything picked): same counts
					else expect(run.kernelDrop === 0 || run.kernelDrop >= run.all).toBe(true);
					return;
				}
				expect(run.k.error).toBeUndefined();
				expectSame(run);
			}, 120000);
		});
	}
});
