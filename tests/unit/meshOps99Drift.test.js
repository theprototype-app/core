// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 — THE DRIFT CHECK (claude:9, 2026-11-22): the 67k scan's kernel-vs-soup position difference
// (<= 0.92e-4, the key weld snapping a near-duplicate onto its cell's first point) must not GROW with repeated
// operators. Twenty extrudes of one patch in one session, both paths fed their OWN previous output (each picks
// its face normal off its own geometry, as the editor does), compared after every step:
//   held    = the op mesh kept across ops (the session's path: one op's output is the next one's input)
//   rebuilt = the op mesh re-imported from the committed arrays every step (after an undo / a peer edit)
// MESHOPS_BIG=1 runs it (the 67k fixture); the cube always runs as the exact control.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readTriangles, trisToPositions } from '$lib/faceEdit.js';
import { composeFaces, appendOrigin, appendedQuads } from '$lib/meshTopology.js';
import * as ops from '$lib/meshOps/index.js';
import * as soup from './fixtures/soupOps99.js';
import { cube, scan67k, near, facing } from './fixtures/meshOps99Fixtures.js';
import { EPS, SNAP, editorPartition, opMeshOf, targetFace, maxDiff } from './fixtures/meshOps99Harness.js';

const STEPS = 20;
const DIST = 0.05;

/** a geometry from committed arrays (what the editor applies) */
function geometryOf(out) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(out.positions), 3));
	if (out.uvs) g.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(out.uvs), 2));
	return g;
}

/** @returns {{ perStep: number[], partitionsEqual: boolean }} */
function chain(geometry, region, mode) {
	// the soup path, its own output each step (extrude keeps the cap's triangle indices: walls append)
	let tris = readTriangles(geometry);
	let faces = editorPartition(geometry, tris);
	// the kernel path
	let om = ops.beginOp(opMeshOf(geometry, faces));
	let kernelGeometry = geometry;
	let kernelFaces = faces;
	const perStep = [];
	let partitionsEqual = true;
	for (let k = 0; k < STEPS; k++) {
		const face = targetFace(tris, region);
		const next = soup.extrudeFace(tris, face, DIST);
		faces = composeFaces(faces, appendOrigin(tris.length, next.length), appendedQuads(tris.length, next.length));
		tris = next;
		const kFace = targetFace(readTriangles(kernelGeometry), region);
		ops.extrudeRegion(om, region, [kFace.normal.x, kFace.normal.y, kFace.normal.z], DIST);
		const out = ops.opOutput(om, { order: 'appearance' });
		kernelGeometry = geometryOf(out);
		kernelFaces = out.faces;
		om = mode === 'held' ? ops.beginOp(om) : ops.beginOp(opMeshOf(kernelGeometry, kernelFaces));
		const old = Float32Array.from(trisToPositions(tris));
		expect(out.positions.length).toBe(old.length);
		perStep.push(maxDiff(out.positions, old));
		if (JSON.stringify(out.faces) !== JSON.stringify(faces)) partitionsEqual = false;
	}
	return { perStep, partitionsEqual };
}

const CASES = [
	{ name: 'cube top', make: cube, region: (g) => facing(g, [0, 1, 0]), bound: EPS },
	...(process.env.MESHOPS_BIG ? [{ name: 'scan67k patch', make: scan67k, region: (g) => near(g, [0, 1, 0], 0.25), bound: SNAP }] : [])
];

describe('99 K4: repeated operators do not drift from the old path', () => {
	for (const c of CASES)
		for (const mode of ['held', 'rebuilt'])
			it(`${c.name}: ${STEPS} extrudes, op mesh ${mode}`, () => {
				const g = c.make();
				const { perStep, partitionsEqual } = chain(g, c.region(g), mode);
				const first = perStep[0];
				const max = Math.max(...perStep);
				console.log(`[drift] ${c.name} ${mode}: step1 ${first.toExponential(3)} max ${max.toExponential(3)} last ${perStep.at(-1).toExponential(3)}`);
				expect(partitionsEqual).toBe(true);
				expect(max).toBeLessThanOrEqual(c.bound);
				// not growing: no later step is worse than the first step by more than float noise
				expect(max).toBeLessThanOrEqual(first + 1e-6);
			}, 300000); // the 67k chain runs 20 full ops on both paths
});
