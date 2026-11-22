// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 family 1 — THE PARITY GATE: every ported operator against the pre-port soup code
// (tests/unit/fixtures/soupOps99.js, frozen) on the fixture set. Same positions (<= eps), same face
// partition (and the same stored order), same uvs and material groups.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readTriangles, trisToPositions, trisToGroups, trisToUVs } from '$lib/faceEdit.js';
import { composeFaces, appendOrigin, appendedQuads } from '$lib/meshTopology.js';
import * as ops from '$lib/meshOps/index.js';
import * as soup from './fixtures/soupOps99.js';
import { fixtureSet } from './fixtures/meshOps99Fixtures.js';
import { EPS, SNAP, snappedCorners, editorPartition, opMeshOf, targetFace, maxDiff } from './fixtures/meshOps99Harness.js';
export { EPS, SNAP, snappedCorners, editorPartition, opMeshOf, targetFace, maxDiff };

/** run one op both ways @returns {{ old: any, neu: any }} */
export function both(geometry, region, op, arg) {
	const tris = readTriangles(geometry);
	const partition = editorPartition(geometry, tris);
	const face = targetFace(tris, region);
	let next;
	let faces;
	if (op === 'extrude') next = soup.extrudeFace(tris, face, arg);
	else if (op === 'inset') next = soup.insetFace(tris, face, arg);
	else if (op === 'move') next = soup.moveFaceAlongNormal(tris, face, arg);
	else if (op === 'extrudeIndividual') next = soup.extrudeFacesIndividual(tris, face, arg);
	else if (op === 'insetEx') next = soup.insetFaceEx(tris, face, arg);
	faces = op === 'move' ? partition : composeFaces(partition, appendOrigin(tris.length, next.length), appendedQuads(tris.length, next.length));
	const old = {
		positions: Float32Array.from(trisToPositions(next)),
		uvs: trisToUVs(next) ? Float32Array.from(trisToUVs(next)) : null,
		groups: trisToGroups(next),
		faces
	};
	const om = ops.beginOp(opMeshOf(geometry, partition));
	const n = [face.normal.x, face.normal.y, face.normal.z];
	if (op === 'extrude') ops.extrudeRegion(om, region, n, arg);
	else if (op === 'inset') ops.insetRegion(om, region, arg);
	else if (op === 'move') ops.moveRegion(om, region, n, arg);
	else if (op === 'extrudeIndividual') ops.extrudeIndividual(om, region, arg);
	else if (op === 'insetEx') ops.insetExtended(om, region, arg);
	const neu = ops.opOutput(om, { order: op === 'move' ? 'stored' : 'appearance' });
	return { old, neu, om };
}


const OPS = [
	['extrude', 0.3],
	['extrude', -0.2],
	['inset', 0.3],
	['move', 0.25],
	['extrudeIndividual', 0.4],
	['insetEx', { amount: 0.25, depth: 0.15 }],
	['insetEx', { amount: 0.2, individual: true }]
];

describe('99 K4 family 1: kernel operators = the soup operators', () => {
	for (const fx of fixtureSet({ big: !!process.env.MESHOPS_BIG })) {
		const geometry = fx.make();
		const regions = fx.regions(geometry);
		for (const [region, tris] of Object.entries(regions)) {
			if (!tris.length) continue;
			for (const [op, arg] of OPS) {
				it(`${fx.name} / ${region} / ${op} ${JSON.stringify(arg)}`, () => {
					const { old, neu } = both(geometry, tris, op, arg);
					expect(neu.positions.length).toBe(old.positions.length);
					// exact except where the weld snaps a near-duplicate onto its key cell's first point
					const snapped = snappedCorners(readTriangles(geometry));
					const d = maxDiff(neu.positions, old.positions);
					expect(d).toBeLessThanOrEqual(snapped.size ? SNAP : EPS);
					expect(neu.faces).toEqual(old.faces);
					expect(!!neu.uvs).toBe(!!old.uvs);
					// a wall's uv step divides by the base edge's length, so a snapped corner moves it too (scan67k:
					// <= 1.4e-4 in uv on 2.4e-2 edges); exact everywhere else
					if (old.uvs) expect(maxDiff(neu.uvs, old.uvs)).toBeLessThanOrEqual(snapped.size ? 1e-3 : EPS);
					expect(neu.groups).toEqual(old.groups);
				});
			}
		}
	}
});

// the soup-shaped exports (VR, the bevel core and the e2e suites call them) are adapters over the same
// kernel operators: same triangles, same mi / uv tags as the frozen soup code
describe('99 K4 family 1: the soup exports = the soup operators', async () => {
	const fe = await import('$lib/faceEdit.js');
	await fe.loadKernelOps();
	const tagsOf = (out) => out.map((t) => [t.mi || 0, t.uv ? t.uv.flat() : null]);
	const near6 = (a, b) => a.every((x, i) => Math.abs(x - b[i]) <= 1e-6);
	for (const fx of fixtureSet({ big: false })) {
		const geometry = fx.make();
		for (const [region, tris] of Object.entries(fx.regions(geometry))) {
			if (!tris.length) continue;
			for (const [op, arg] of OPS) {
				it(`${fx.name} / ${region} / ${op} ${JSON.stringify(arg)}`, () => {
					const src = readTriangles(geometry);
					const face = targetFace(src, tris);
					const name = { extrude: 'extrudeFace', inset: 'insetFace', move: 'moveFaceAlongNormal', extrudeIndividual: 'extrudeFacesIndividual', insetEx: 'insetFaceEx' }[op];
					const old = soup[name](src, face, arg);
					const neu = fe[name](src, face, arg);
					expect(neu.length).toBe(old.length);
					expect(near6(trisToPositions(neu), trisToPositions(old))).toBe(true);
					const a = tagsOf(neu);
					const b = tagsOf(old);
					a.forEach(([mi, uv], i) => {
						expect(mi).toBe(b[i][0]);
						expect(!!uv).toBe(!!b[i][1]);
						if (uv) expect(near6(uv, b[i][1])).toBe(true);
					});
				});
			}
		}
	}
});
