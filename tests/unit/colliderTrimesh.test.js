// @ts-nocheck — a fixture test: spec/pieces are asserted non-null by the checks themselves
// 36 X2: exact (trimesh) colliders for static bodies. The spec half is pure three;
// the physics half builds the SAME descs physics.js builds (colliderDescsFor) into a
// real rapier world, so "the arch opening is walkable" is proven by a ball rolling
// through it, with the hull as the counterfactual that blocks it.
import { describe, test, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { colliderSpecOf, inferredColliderKind, TRIMESH_MAX_TRIS } from '../../src/lib/colliderSpec.js';
import { colliderDescsFor, trimeshFlags } from '../../src/lib/colliderDescs.js';
import { customGeometryBuilders } from '../../src/lib/customGeometries.js';

beforeAll(async () => {
	await RAPIER.init();
});

/** @param {string} name @param {any} geometry */
function block(name, geometry) {
	const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
	mesh.name = name;
	return mesh;
}

/** A FIXED body for `object`, built the way physics.createBodyFor builds scenery:
 * pieces sit at the object origin, primitives at the AABB centre, body world-aligned.
 * @param {any} world @param {any} object @param {string} kind */
function scenery(world, object, kind) {
	object.updateMatrixWorld(true);
	const spec = colliderSpecOf(object, kind);
	const at = spec.pieces ? object.position : spec.center;
	const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z));
	const descs = colliderDescsFor(RAPIER, spec, {
		origin: object.position.clone().sub(at),
		center: spec.center.clone().sub(at),
		relQuat: object.quaternion.clone()
	});
	descs.forEach((desc) => world.createCollider(desc, body));
	return spec;
}

/** @param {any} world @param {number[]} at @param {number[]} vel @param {number} r */
function ball(world, at, vel, r = 0.2) {
	const body = world.createRigidBody(
		RAPIER.RigidBodyDesc.dynamic().setTranslation(at[0], at[1], at[2]).setLinvel(vel[0], vel[1], vel[2]).setCanSleep(false)
	);
	world.createCollider(RAPIER.ColliderDesc.ball(r).setFriction(0), body);
	return body;
}

/** @param {any} world @param {number} seconds */
function run(world, seconds) {
	for (let i = 0; i < seconds * 60; i++) world.step();
}

describe('X2 spec', () => {
	test('trimesh piece carries every triangle, indexed, origin-relative and scale-baked', () => {
		const arch = block('Arch', customGeometryBuilders.Arch());
		arch.scale.set(2, 1, 1);
		const spec = colliderSpecOf(arch, 'trimesh');
		expect(spec.kind).toBe('trimesh');
		expect(spec.fallback).toBe(false);
		const piece = spec.pieces[0];
		const geometry = arch.geometry;
		const tris = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
		expect(piece.indices.length).toBe(tris * 3);
		// x is scale-baked (the arch is 2 m wide -> 4 m), y is not scaled
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (let i = 0; i < piece.verts.length; i += 3) {
			maxX = Math.max(maxX, piece.verts[i]);
			maxY = Math.max(maxY, piece.verts[i + 1]);
		}
		expect(maxX).toBeCloseTo(2, 5);
		expect(maxY).toBeCloseTo(2, 5);
	});

	test('a Group merges its visible child meshes into the object frame (rotation NOT baked)', () => {
		const group = new THREE.Group();
		const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
		a.position.set(2, 0, 0);
		const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
		b.position.set(-2, 0, 0);
		const hidden = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 9));
		hidden.visible = false;
		group.add(a, b, hidden);
		group.position.set(10, 5, 0);
		group.rotation.y = Math.PI / 2;
		group.scale.setScalar(2);
		const spec = colliderSpecOf(group, 'trimesh');
		expect(spec.kind).toBe('trimesh');
		const piece = spec.pieces[0];
		expect(piece.indices.length).toBe(2 * 12 * 3); // two boxes, the hidden one skipped
		let minX = Infinity;
		let maxX = -Infinity;
		for (let i = 0; i < piece.verts.length; i += 3) {
			minX = Math.min(minX, piece.verts[i]);
			maxX = Math.max(maxX, piece.verts[i]);
		}
		// child at local x=±2 (±2.5 at its far face), times scale 2, rotation stripped
		expect(maxX).toBeCloseTo(5, 5);
		expect(minX).toBeCloseTo(-5, 5);
	});

	test('a dynamic body gets the hull instead (fallback + reason)', () => {
		const arch = block('Arch', customGeometryBuilders.Arch());
		const spec = colliderSpecOf(arch, 'trimesh', { dynamic: true });
		expect(spec.kind).toBe('hull');
		expect(spec.fallback).toBe(true);
		expect(spec.reason).toBe('dynamic');
		expect(spec.pieces[0].indices).toBeUndefined();
	});

	test('over the triangle cap -> box with a reason', () => {
		const big = block('Big', new THREE.SphereGeometry(1, 200, 100));
		const spec = colliderSpecOf(big, 'trimesh');
		expect(TRIMESH_MAX_TRIS).toBe(20000);
		expect(spec.kind).toBe('box');
		expect(spec.fallback).toBe(true);
		expect(spec.reason).toMatch(/triangles/);
	});

	test('inference: concave blocks infer the exact mesh, convex blocks keep the hull', () => {
		const arch = block('Arch', customGeometryBuilders.Arch());
		arch.userData.colliderHint = 'hull'; // a scene saved since 15-A3
		expect(inferredColliderKind(arch)).toBe('trimesh');
		const corner = block('Corner', customGeometryBuilders.Corner());
		expect(inferredColliderKind(corner)).toBe('trimesh'); // legacy, no hint
		const renamed = block('Gate', customGeometryBuilders.Arch());
		renamed.userData.colliderHint = 'trimesh'; // a new arch survives a rename
		expect(inferredColliderKind(renamed)).toBe('trimesh');
		const stairs = block('Stairs', customGeometryBuilders.Stairs());
		stairs.userData.colliderHint = 'hull';
		expect(inferredColliderKind(stairs)).toBe('hull');
		expect(inferredColliderKind(block('Wedge', customGeometryBuilders.Wedge()))).toBe('hull');
	});
});

describe('X2 physics (real rapier)', () => {
	test('a ball rolls THROUGH a static arch opening on a trimesh — and the hull blocks it', () => {
		/** @param {string} kind */
		const through = (kind) => {
			const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
			world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0));
			// a 2 m wide, 2 m tall arch, 0.5 m thick, standing across the z axis at z=0
			scenery(world, block('Arch', customGeometryBuilders.Arch()), kind);
			const b = ball(world, [0, 0.2, -3], [0, 0, 4]);
			run(world, 2);
			return b.translation().z;
		};
		expect(through('trimesh')).toBeGreaterThan(2); // out the other side
		expect(through('hull')).toBeLessThan(0); // the counterfactual: sealed
	});

	test('a ball dropped into a concave bowl settles INSIDE on a trimesh — on the rim plane with a hull', () => {
		// a bowl: a lathe of an open cup profile (concave, the water-tank shape)
		const profile = [
			new THREE.Vector2(0.01, 0),
			new THREE.Vector2(1, 0),
			new THREE.Vector2(1, 1),
			new THREE.Vector2(0.95, 1),
			new THREE.Vector2(0.95, 0.05),
			new THREE.Vector2(0.01, 0.05)
		];
		/** @param {string} kind */
		const restY = (kind) => {
			const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
			const bowl = block('Bowl', new THREE.LatheGeometry(profile, 24));
			scenery(world, bowl, kind);
			const b = ball(world, [0, 2, 0], [0, 0, 0], 0.15);
			run(world, 3);
			return b.translation().y;
		};
		expect(restY('trimesh')).toBeLessThan(0.3); // on the bowl's floor (0.05 + r)
		expect(restY('hull')).toBeGreaterThan(1); // the counterfactual: on the lid
	});

	test('a rotated + offset static trimesh lands where the object is', () => {
		const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
		const arch = block('Arch', customGeometryBuilders.Arch());
		arch.position.set(5, 0, 0);
		arch.rotation.y = Math.PI / 2; // now the opening faces x
		scenery(world, arch, 'trimesh');
		world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0));
		const b = ball(world, [2, 0.2, 0], [4, 0, 0]);
		run(world, 2);
		expect(b.translation().x).toBeGreaterThan(7);
		// and the wall beside the opening still stops a ball (the shape is THERE)
		const world2 = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
		scenery(world2, arch, 'trimesh');
		world2.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0));
		const blocked = ball(world2, [2, 0.2, 0.85], [4, 0, 0]);
		run(world2, 2);
		expect(blocked.translation().x).toBeLessThan(5);
	});

	test('trimesh flags survive awkward meshes (open plane, torus knot, merged group)', () => {
		expect(trimeshFlags(RAPIER)).toBe(RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
		const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
		const group = new THREE.Group();
		group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)), new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
		for (const object of [
			block('Plane', new THREE.PlaneGeometry(4, 4, 8, 8)),
			block('Knot', new THREE.TorusKnotGeometry(1, 0.3, 64, 8)),
			group
		]) {
			const spec = scenery(world, object, 'trimesh');
			expect(spec.kind).toBe('trimesh');
		}
		run(world, 0.1);
	});

	test('a ball rolling over a finely tessellated flat trimesh does not ghost-bump', () => {
		const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
		const floor = block('Floor', new THREE.PlaneGeometry(20, 20, 40, 40));
		floor.rotation.x = -Math.PI / 2;
		scenery(world, floor, 'trimesh');
		const b = ball(world, [-8, 0.2, 0.13], [6, 0, 0]);
		let maxY = 0;
		for (let i = 0; i < 120; i++) {
			world.step();
			maxY = Math.max(maxY, b.translation().y);
		}
		expect(b.translation().x).toBeGreaterThan(0);
		expect(maxY).toBeLessThan(0.23); // no hop off an internal edge
	});
});
