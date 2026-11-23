// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 family 6 (lane 99-ops-b) — THE PARITY GATE for subdivide / symmetrize: every ported operator
// against the pre-port soup code (tests/unit/fixtures/soupOps99b.js, frozen) on the fixture set. Same positions
// (<= eps), the same face partition in the same stored order, the same uvs and material groups, the same refusals,
// the same new-triangle selection and the same counts the toasts print.
import { describe, it, expect } from 'vitest';
import { readTriangles } from '$lib/faceEdit.js';
import { composeFaces } from '$lib/meshTopology.js';
import * as ops from '$lib/meshOps/index.js';
import * as soup from './fixtures/soupOps99b.js';
import * as fx from './fixtures/meshOps99bFixtures.js';
import { snappedCorners, editorPartition, partnerOf, opMeshOf, stateOf, expectSame } from './fixtures/meshOps99bHarness.js';

const BIG = !!process.env.MESHOPS_BIG;

/** faceEdit mirrorTolerance: 0.1% of the bounding diagonal */
function toleranceOf(tris) {
	const lo = [Infinity, Infinity, Infinity];
	const hi = [-Infinity, -Infinity, -Infinity];
	for (const t of tris)
		for (const v of t)
			[v.x, v.y, v.z].forEach((c, i) => {
				lo[i] = Math.min(lo[i], c);
				hi[i] = Math.max(hi[i], c);
			});
	return Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.001, 1e-5);
}

/** run one family-6 op both ways */
function both6(geometry, op, arg) {
	const tris = readTriangles(geometry);
	const partition = editorPartition(geometry, tris);
	const partner = partnerOf(partition, tris.length);
	const om = ops.beginOp(opMeshOf(geometry, partition));
	let r;
	let k;
	let faces = null;
	if (op === 'subdivide' || op === 'levels') {
		const split =
			op === 'subdivide'
				? soup.subdivideFaceUnits(tris, arg.tris, partner)
				: soup.subdivideLevels(tris, arg.tris, partner, arg.levels);
		r = { tris: split.tris, faces: composeFaces(partition, split.origin, split.authored) };
		k = op === 'subdivide' ? ops.subdivideUnits(om, arg.tris, partner) : ops.subdivideLevels(om, arg.tris, partner, arg.levels);
		expect(k.newTris).toEqual(split.newIndices);
	} else if (op === 'esub') {
		r = soup.subdivideEdgesSoup(tris, partition, arg);
		k = ops.subdivideEdges(om, ops.edgesOfKeys(om, arg));
		if (r.error) return { error: r.error, kernelError: k.error ?? null };
		expect(k.split).toBe(r.split);
		expect(k.midpoints.length).toBe(r.edges);
		const halves = k.midpoints.flatMap((h) => [fx.edgeKey(h.ka, h.km), fx.edgeKey(h.km, h.kb)]);
		expect(halves).toEqual(r.halves);
	} else if (op === 'mirror') {
		const tol = toleranceOf(tris);
		const prior = arg.prior === false ? null : partition;
		r = soup.mirrorTrisCore(tris, prior, arg.axis, arg.keep, tol);
		k = ops.symmetrize(om, arg.axis, arg.keep, tol);
		if (!r) {
			expect(k).toBeNull();
			return { refused: true };
		}
		expect(k).not.toBeNull();
		expect([...k.kept]).toEqual([...r.kept]);
		expect({ pairs: k.pairs, clipped: k.clipped, dropped: k.dropped }).toEqual({ pairs: r.pairs, clipped: r.clipped, dropped: r.dropped });
		// with no partition to carry the soup made every triangle its own face, and so does the commit
		if (!prior) faces = 'singletons';
	}
	// the operators write their view directly: it must be the one buildView derives from the kernel
	const view = ops.buildView(om.mesh);
	expect(om.view.count).toBe(view.count);
	expect(Array.from(om.view.tFace)).toEqual(Array.from(view.tFace));
	expect(Array.from(om.view.tLoc)).toEqual(Array.from(view.tLoc));
	const neu = ops.opOutput(om, { order: 'appearance' });
	if (faces === 'singletons') neu.faces = Array.from({ length: neu.positions.length / 9 }, (_, t) => [t]);
	return { old: stateOf(r.tris, r.faces), neu, snapped: snappedCorners(tris) };
}

const allTris = (g) => readTriangles(g).map((_, i) => i);

function cases() {
	const out = [];
	const add = (name, make, list) => out.push({ name, make, list });
	// SUBDIVIDE FACES (quads + triangles, one face, a patch, half a quad, everything)
	const subdivides = (g) => {
		const all = allTris(g);
		const top = fx.facing(g, [0, 1, 0]);
		return [
			{ op: 'subdivide', arg: { tris: top } },
			{ op: 'subdivide', arg: { tris: top.slice(0, 1) } },
			{ op: 'subdivide', arg: { tris: all.filter((i) => i % 3 === 0) } },
			{ op: 'subdivide', arg: { tris: all } },
			{ op: 'levels', arg: { tris: top, levels: 2 } },
			{ op: 'levels', arg: { tris: all, levels: 3 } }
		];
	};
	add('cube', fx.cube, subdivides);
	add('ngon prism', fx.ngonPrism, subdivides);
	add('split-normals uv box', fx.splitNormalsUv, subdivides);
	add('skinned box', fx.skinned, subdivides);
	add('grid 3x3', () => fx.grid(3), (g) => [...subdivides(g), { op: 'subdivide', arg: { tris: [] } }]);
	add('open box', fx.openBox, subdivides);
	// SUBDIVIDE EDGES
	const esubs = (g) => {
		const edges = [...fx.interiorEdgeKeys(g), ...fx.borderKeys(g)];
		return [
			{ op: 'esub', arg: [edges[0]] },
			{ op: 'esub', arg: edges.slice(1, 4) },
			{ op: 'esub', arg: edges.filter((_, i) => i % 2 === 0) },
			{ op: 'esub', arg: edges },
			{ op: 'esub', arg: ['9,9,9|8,8,8'] }
		];
	};
	add('cube', fx.cube, esubs);
	add('ngon prism', fx.ngonPrism, esubs);
	add('split-normals uv box', fx.splitNormalsUv, esubs);
	add('skinned box', fx.skinned, esubs);
	add('grid 3x3', () => fx.grid(3), esubs);
	add('open box', fx.openBox, esubs);
	// SYMMETRIZE (every axis, both sides, straddling faces clipped, a refusal, no partition)
	const mirrors = () => [
		{ op: 'mirror', arg: { axis: 'x', keep: 1 } },
		{ op: 'mirror', arg: { axis: 'x', keep: -1 } },
		{ op: 'mirror', arg: { axis: 'y', keep: 1 } },
		{ op: 'mirror', arg: { axis: 'z', keep: -1 } },
		{ op: 'mirror', arg: { axis: 'x', keep: 1, prior: false } }
	];
	add('cube', fx.cube, mirrors);
	add('ngon prism', fx.ngonPrism, mirrors);
	add('split-normals uv box', fx.splitNormalsUv, mirrors);
	add('skinned box', fx.skinned, mirrors);
	add('grid 3x3', () => fx.grid(3), mirrors);
	add('open box', fx.openBox, mirrors);
	add('L hole', fx.lHole, mirrors);
	add('two cubes (one off the plane)', fx.twoCubes, mirrors);
	add('cube pushed to +x (refusal on -x)', () => fx.merged(fx.cube(), fx.cube(), [3, 0, 0]).translate(2, 0, 0), () => [
		{ op: 'mirror', arg: { axis: 'x', keep: -1 } },
		{ op: 'mirror', arg: { axis: 'x', keep: 1 } }
	]);
	if (BIG) {
		add('scan67k: subdivide a patch', fx.scan67k, (g) => [{ op: 'subdivide', arg: { tris: fx.near(g, [0, 1, 0], 0.3) } }]);
		add('scan67k: subdivide 2 levels', fx.scan67k, (g) => [{ op: 'levels', arg: { tris: fx.near(g, [1, 0, 0], 0.2), levels: 2 } }]);
		add('scan67k: subdivide 300 edges', fx.scan67k, (g) => [{ op: 'esub', arg: fx.interiorEdgeKeys(g).slice(0, 300) }]);
		add('scan67k: symmetrize x', fx.scan67k, () => [{ op: 'mirror', arg: { axis: 'x', keep: 1 } }]);
		add('scan67k: symmetrize z, keep -z', fx.scan67k, () => [{ op: 'mirror', arg: { axis: 'z', keep: -1 } }]);
	}
	return out;
}

describe('99 K4 family 6: subdivide / symmetrize on the kernel = the soup operators', () => {
	for (const { name, make, list } of cases()) {
		const g = make();
		list(g).forEach((c, i) => {
			it(`${name} / ${c.op} #${i}`, () => {
				const run = both6(g, c.op, c.arg);
				// the 67k cases are there to do work, not to agree on a refusal
				if (name.startsWith('scan67k')) expect(!!(run.refused || run.error)).toBe(false);
				if (run.refused) return;
				if (run.error) {
					expect(run.kernelError).toBe(run.error);
					return;
				}
				expectSame(run);
			}, 120000);
		});
	}
});
