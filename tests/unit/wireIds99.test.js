// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Lane 99-scrub: the edit wire keys its edges by weld id (`edgeIdOf`/`internalEdgeIdsOf`) instead of the string keys
// (`keyAt`/`edgeKey`/`internalEdgeKeysOf`) — ~90 ms of every 67k wire build. The ids are equal exactly when the keys
// are, so the wire must be the SAME: the same corners, in the same order, on every shape (derived and stored
// partitions, n-gon faces, a far-off mesh that takes the weld's string fallback).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { editWireGeometry, pairQuads, readTriangles } from '$lib/faceEdit.js';
import {
	frameOfGeometry,
	keyAt,
	edgeKey,
	internalEdgeKeysOf,
	internalEdgeIdsOf,
	edgeIdOf,
	weld
} from '$lib/triFrame.js';
import { readStoredFaces, storeFaces } from '$lib/meshTopology.js';
import { fixtureSet } from './fixtures/meshOps99Fixtures.js';

/** the v1.78 wire's corner list (string keys), verbatim */
function stringWire(f, faces, partner) {
	const skip = internalEdgeKeysOf(f, faces, partner);
	const seen = new Set();
	const from = [];
	for (let t = 0; t < f.count; t++) {
		const keys = [keyAt(f, t, 0), keyAt(f, t, 1), keyAt(f, t, 2)];
		for (let e = 0; e < 3; e++) {
			const key = edgeKey(keys[e], keys[(e + 1) % 3]);
			if (skip.has(key) || seen.has(key)) continue;
			seen.add(key);
			from.push(t * 3 + e, t * 3 + ((e + 1) % 3));
		}
	}
	return from;
}

function farBox() {
	const g = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2).toNonIndexed();
	g.translate(3e5, 0, 0); // x * 1e4 overflows int32: the weld's string fallback
	return g;
}

/** a plane whose middle 2x2 quads are stored as ONE n-gon face (the dissolve shape) */
function ngonPlane() {
	const g = new THREE.PlaneGeometry(4, 4, 4, 4).toNonIndexed();
	const partner = pairQuads(readTriangles(g));
	const faces = [];
	const done = new Set();
	const big = [];
	for (let t = 0; t < partner.length; t++) {
		if (done.has(t)) continue;
		const p = partner[t];
		const face = p >= 0 ? [t, p] : [t];
		face.forEach((x) => done.add(x));
		const P = g.attributes.position.array;
		const cx = (P[t * 9] + P[t * 9 + 3] + P[t * 9 + 6]) / 3;
		const cy = (P[t * 9 + 1] + P[t * 9 + 4] + P[t * 9 + 7]) / 3;
		if (Math.abs(cx) < 1 && Math.abs(cy) < 1) big.push(...face);
		else faces.push(face);
	}
	faces.push(big.sort((a, b) => a - b));
	storeFaces(g, faces);
	return g;
}

const shapes = [
	...fixtureSet({ big: !!process.env.MESHOPS_BIG }).map((fx) => [fx.name, fx.make]),
	['indexed sphere 32x16', () => new THREE.SphereGeometry(1, 32, 16)],
	['non-indexed torus', () => new THREE.TorusGeometry(1, 0.3, 12, 24).toNonIndexed()],
	['far box (string weld)', farBox],
	['stored n-gon plane', ngonPlane]
];

describe('99-scrub: the edit wire by weld id = the wire by string key', () => {
	for (const [name, make] of shapes)
		it(name, () => {
			const g = make();
			const f = frameOfGeometry(g);
			const faces = readStoredFaces(g);
			const partner = faces ? new Int32Array(0) : pairQuads(readTriangles(g));
			// the skip sets hold the same edges
			const V = weld(f);
			const ids = internalEdgeIdsOf(f, faces, partner);
			const keys = internalEdgeKeysOf(f, faces, partner);
			expect(ids.size).toBe(keys.size);
			// the wire itself: same corners, same order
			const want = stringWire(f, faces, partner);
			const got = Array.from(editWireGeometry(g).userData.fromCorners);
			expect(got.length).toBe(want.length);
			expect(got).toEqual(want);
			expect(want.length).toBeGreaterThan(0);
			// and an id pair is one key pair (spot check every 7th corner edge)
			for (let i = 0; i < want.length; i += 14) {
				const [a, b] = [want[i], want[i + 1]];
				const t = Math.floor(a / 3);
				expect(edgeIdOf(f, V[a], V[b])).toBe(edgeIdOf(f, V[b], V[a]));
				expect(keys.has(edgeKey(keyAt(f, t, a % 3), keyAt(f, Math.floor(b / 3), b % 3)))).toBe(false);
			}
		});
});
