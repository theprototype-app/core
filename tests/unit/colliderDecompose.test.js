// @ts-nocheck — a fixture test against the vendored V-HACD + real rapier
// 36 X3: convex decomposition for CUSTOM colliders. The core is run against the same
// vendored vhacd-js the worker loads; the result is fed through colliderSpecOf's custom
// path and colliderDescsFor into a real rapier world. The proof that matters is the one
// X2 could not give: a DYNAMIC arch (static-only trimesh is out) keeps its opening —
// a ball rolls through the decomposed arch, and the hull (the counterfactual) stops it.
import { describe, test, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ConvexMeshDecomposition } from '../../src/lib/vendor/vhacd/vhacd.js';
import {
	weldMesh,
	packPieces,
	vertexBudget,
	clampPieces,
	decomposeMesh,
	decomposeOptions,
	DECOMPOSE_MAX_FLOATS
} from '../../src/lib/colliderDecomposeCore.js';
import { colliderSpecOf, CUSTOM_MAX_FLOATS } from '../../src/lib/colliderSpec.js';
import { colliderDescsFor } from '../../src/lib/colliderDescs.js';
import { customGeometryBuilders } from '../../src/lib/customGeometries.js';

let decomposer;
beforeAll(async () => {
	await RAPIER.init();
	decomposer = await ConvexMeshDecomposition.create();
}, 30000);

/** the app's decomposeCollider minus the store/worker plumbing @param {any} object @param {number} n */
function decomposeObject(object, n) {
	const spec = colliderSpecOf(object, 'trimesh');
	const piece = spec.pieces[0];
	const s = object.scale;
	const unscaled = Float64Array.from(piece.verts, (v, i) => v / [s.x, s.y, s.z][i % 3]);
	return packPieces(decomposeMesh(decomposer, weldMesh(unscaled, piece.indices), n));
}

describe('X3 core', () => {
	test('budget keeps any piece count under the replicated cap', () => {
		expect(DECOMPOSE_MAX_FLOATS).toBe(CUSTOM_MAX_FLOATS);
		for (let n = 2; n <= 16; n++) expect(clampPieces(n) * vertexBudget(n) * 3).toBeLessThanOrEqual(1200);
		expect(clampPieces(99)).toBe(16);
		expect(clampPieces(0)).toBe(2);
		expect(decomposeOptions(8)).toMatchObject({ maxHulls: 8, maxVerticesPerHull: 32 });
	});

	test('weldMesh merges a non-indexed extrusion into shared vertices', () => {
		const g = customGeometryBuilders.Arch(); // ExtrudeGeometry: a triangle soup
		const welded = weldMesh(g.attributes.position.array, g.index ? g.index.array : null);
		expect(welded.positions.length / 3).toBeLessThan(g.attributes.position.count / 2);
		expect(welded.indices.length % 3).toBe(0);
		expect(Math.max(...welded.indices)).toBeLessThan(welded.positions.length / 3);
	});

	test('packPieces drops whole pieces past the cap, never half of one', () => {
		const big = new Float64Array(3 * 300); // 900 floats
		const packed = packPieces([big, big, new Float64Array(12)]);
		expect(packed.colliderPieces).toEqual([[0, 900], [900, 12]]);
		expect(packed.dropped).toBe(1);
	});

	test('an Arch decomposes into several pieces that fit the cap, deterministically', () => {
		const arch = new THREE.Mesh(customGeometryBuilders.Arch());
		const a = decomposeObject(arch, 8);
		const b = decomposeObject(arch, 8);
		expect(a.colliderPieces.length).toBeGreaterThanOrEqual(3);
		expect(a.colliderVerts.length).toBeLessThanOrEqual(1200);
		expect(a.dropped).toBe(0);
		expect(b.colliderVerts).toEqual(a.colliderVerts); // same input, same output
	}, 30000);
});

describe('X3 physics (real rapier) — the dynamic arch keeps its opening', () => {
	/** a DYNAMIC heavy arch body built like physics.createBodyFor builds a custom/hull body
	 * @param {any} world @param {any} object @param {string} kind */
	function dynamicArch(world, object, kind) {
		const spec = colliderSpecOf(object, kind, { dynamic: true });
		const body = world.createRigidBody(
			RAPIER.RigidBodyDesc.dynamic().setTranslation(object.position.x, object.position.y, object.position.z).setCanSleep(false)
		);
		const descs = colliderDescsFor(RAPIER, spec, {
			origin: new THREE.Vector3(),
			center: spec.center.clone().sub(object.position),
			relQuat: object.quaternion.clone()
		});
		descs.forEach((d) => world.createCollider(d.setMass(500 / descs.length), body));
		return spec;
	}

	/** @param {any} arch */
	function rollThrough(arch, kind) {
		const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
		world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0));
		const spec = dynamicArch(world, arch, kind);
		const ball = world.createRigidBody(
			RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.2, -3).setLinvel(0, 0, 4).setCanSleep(false)
		);
		world.createCollider(RAPIER.ColliderDesc.ball(0.15).setFriction(0).setMass(0.2), ball);
		for (let i = 0; i < 150; i++) world.step();
		return { z: ball.translation().z, kind: spec.kind, pieces: spec.pieces?.length ?? 0 };
	}

	test('decomposed (custom): the ball passes; hull: it is stopped', () => {
		const arch = new THREE.Mesh(customGeometryBuilders.Arch());
		arch.userData.physics = { mode: 'dynamic', mass: 500, collider: 'custom', ...decomposeObject(arch, 8) };
		const custom = rollThrough(arch, 'custom');
		expect(custom.kind).toBe('custom');
		expect(custom.pieces).toBeGreaterThanOrEqual(3);
		expect(custom.z).toBeGreaterThan(1.5);

		const hull = rollThrough(arch, 'hull');
		expect(hull.kind).toBe('hull');
		expect(hull.z).toBeLessThan(0); // the counterfactual: sealed
	}, 30000);

	test('a SCALED arch decomposes in unscaled object space and scales back exactly', () => {
		const arch = new THREE.Mesh(customGeometryBuilders.Arch());
		arch.scale.set(2, 1.5, 1);
		const packed = decomposeObject(arch, 6);
		arch.userData.physics = { collider: 'custom', ...packed };
		const spec = colliderSpecOf(arch, 'custom');
		let maxX = 0;
		for (const p of spec.pieces) for (let i = 0; i < p.verts.length; i += 3) maxX = Math.max(maxX, p.verts[i]);
		expect(maxX).toBeGreaterThan(1.8); // the 2 m arch, scaled x2, reaches ~2 m from its centre
		expect(maxX).toBeLessThan(2.1);
	}, 30000);
});
