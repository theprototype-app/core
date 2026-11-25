// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Lane 99-scrub: the loop-cut SCRUB PREVIEW draws where the cut will land. The preview's segments come from
// `loopCutRails` + `loopCutStops` (the same quad walk and the same fractions `loopCutRegion` cuts with); every
// preview end point must be a vertex of the real cut at those params, one segment per walked quad per cut, and
// reading the rails must leave the op mesh untouched (the scrub copies the adjust's base op mesh).
import { describe, it, expect } from 'vitest';
import { readTriangles, pairQuads } from '$lib/faceEdit.js';
import { storedPartition } from '$lib/meshKernel/index.js';
import * as ops from '$lib/meshOps/index.js';
import { fixtureSet } from './fixtures/meshOps99Fixtures.js';
import { editorPartition, opMeshOf, ringOf } from './fixtures/meshOps99Harness.js';

/** the session's quad pairing (meshOps99Cut.test.js partnerOf, not imported: a test file import re-runs its suites) */
function partnerOf(geometry, tris) {
	const stored = storedPartition(geometry);
	if (!stored) return pairQuads(tris);
	const partner = new Int32Array(tris.length).fill(-1);
	for (const f of stored)
		if (f.length === 2) {
			partner[f[0]] = f[1];
			partner[f[1]] = f[0];
		}
	return partner;
}

const CUTS = [
	{ cuts: 1, position: 0.5 },
	{ cuts: 1, position: 0.2 },
	{ cuts: 3 },
	{ cuts: 1, position: 0.995 } // clamped
];

/** the preview's segment end points for these params (faceEdit drawLoopCutPreview's arithmetic) */
function previewPoints(rails, options) {
	const stops = ops.loopCutStops(options.cuts ?? 1, options.position ?? 0.5);
	const out = [];
	for (let o = 0; o < rails.length; o += 12)
		for (const t of stops)
			for (const [from, to] of [
				[o, o + 9],
				[o + 3, o + 6]
			])
				out.push([0, 1, 2].map((c) => rails[from + c] + (rails[to + c] - rails[from + c]) * t));
	return out;
}

function nearestDistance(p, positions) {
	let best = Infinity;
	for (let i = 0; i < positions.length; i += 3) {
		const d = Math.hypot(positions[i] - p[0], positions[i + 1] - p[1], positions[i + 2] - p[2]);
		if (d < best) best = d;
	}
	return best;
}

describe('99-scrub: the loop-cut preview line sits on the cut', () => {
	let compared = 0;
	for (const fx of fixtureSet({ big: false })) {
		const geometry = fx.make();
		const tris = readTriangles(geometry);
		const partition = editorPartition(geometry, tris);
		const partner = partnerOf(geometry, tris);
		for (const [region, regionTris] of Object.entries(fx.regions(geometry))) {
			const start = regionTris.find((t) => (partner[t] ?? -1) >= 0);
			if (start === undefined) continue;
			for (const axis of [0, 1]) {
				const ring = ringOf(tris, partner, start, axis);
				if (!ring.length) continue;
				for (const options of CUTS)
					it(`${fx.name} / ${region} / tri ${start} axis ${axis} / ${JSON.stringify(options)}`, () => {
						const base = opMeshOf(geometry, partition);
						const before = ops.opOutput(ops.beginOp(ops.cloneOpMesh(base)), {
							order: 'appearance'
						});
						const rails = ops.loopCutRails(base, ring, partner);
						// read-only: the base still outputs the same bytes
						const after = ops.opOutput(ops.beginOp(ops.cloneOpMesh(base)), { order: 'appearance' });
						expect(Array.from(after.positions)).toEqual(Array.from(before.positions));
						expect(rails.length % 12).toBe(0);
						expect(rails.length / 12).toBeLessThanOrEqual(ring.length);
						const om = ops.beginOp(ops.cloneOpMesh(base));
						ops.loopCutRegion(om, ring, partner, options);
						const cut = ops.opOutput(om, { order: 'appearance' });
						const points = previewPoints(rails, options);
						expect(points.length).toBe((rails.length / 12) * (options.cuts ?? 1) * 2);
						// every preview end point is a vertex of the cut (the weld may snap it by up to a key cell)
						for (const p of points) expect(nearestDistance(p, cut.positions)).toBeLessThan(1e-4);
						compared++;
					});
			}
		}
	}
	it('compared something (the fixtures have rings)', () => {
		expect(compared).toBeGreaterThan(0);
	});
});
