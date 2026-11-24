// 102b-papercuts: a rounded box is a Box setting (two numbers in the file), a baked one is recognised
// (never converted by itself), and equal shapes are saved once.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { RoundedBox, matchRoundedBox, bakedRoundedBox, restoreRoundedBoxes, roundedBoxVertexCount } from '../../src/lib/roundedBox.js';
import { boxGeometryFor, loadRoundedBox, roundedBoxModule } from '../../src/lib/roundedBoxGate.js';
import { shareGeometries, inflateSharedGeometries } from '../../src/lib/sharedGeometryWrite.js';
import { geometrySpec } from '../../src/lib/geometryParams.js';

describe('rounded box: before its chunk', () => {
	it('a radius builds the square box for that moment', () => {
		expect(roundedBoxModule()).toBeNull();
		const g = boxGeometryFor({ width: 2, height: 1, depth: 1, radius: 0.2 });
		expect(g).not.toBeInstanceOf(RoundedBox);
		expect(g.attributes.position.count).toBe(24);
	});
});

describe('rounded box', () => {
	beforeAll(async () => {
		await loadRoundedBox();
	});

	it('radius 0 or absent is exactly the old BoxGeometry', () => {
		const g = boxGeometryFor({ width: 2, height: 1, depth: 1, widthSegments: 1, heightSegments: 1, depthSegments: 1 });
		expect(g).toBeInstanceOf(THREE.BoxGeometry);
		expect(g).not.toBeInstanceOf(RoundedBox);
		const { uuid: _a, ...mine } = /** @type {any} */ (g.toJSON());
		const { uuid: _b, ...stock } = /** @type {any} */ (new THREE.BoxGeometry(2, 1, 1, 1, 1, 1).toJSON());
		expect(mine).toEqual(stock);
		expect(Object.keys(g.parameters)).not.toContain('radius');
		expect(boxGeometryFor({ width: 1, height: 1, depth: 1, radius: 0 })).not.toBeInstanceOf(RoundedBox);
	});

	it('saves as a Box with two numbers and loads back rounded', () => {
		const g = boxGeometryFor({ width: 2, height: 1, depth: 3, radius: 0.2, radiusSegments: 3 });
		const json = g.toJSON();
		expect(json.type).toBe('BoxGeometry');
		expect(json.data).toBeUndefined();
		expect(json).toMatchObject({ width: 2, height: 1, depth: 3, radius: 0.2, radiusSegments: 3 });
		expect(JSON.stringify(json).length).toBeLessThan(300);
		const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
		const back = /** @type {any} */ (new THREE.ObjectLoader().parse(mesh.toJSON()));
		expect(back.geometry).toBeInstanceOf(RoundedBox);
		expect(back.geometry.attributes.position.count).toBe(roundedBoxVertexCount(3));
	});

	it('an older reader (stock BoxGeometry.fromJSON) gets a plain box of the same size', () => {
		const json = /** @type {any} */ (boxGeometryFor({ width: 2, height: 1, depth: 3, radius: 0.2 }).toJSON());
		const stock = new THREE.BoxGeometry(json.width, json.height, json.depth, json.widthSegments, json.heightSegments, json.depthSegments);
		stock.computeBoundingBox();
		expect(stock.boundingBox?.max.toArray()).toEqual([1, 0.5, 1.5]);
	});

	it('recognises a baked rounded box and nothing else', () => {
		const baked = bakedRoundedBox({ width: 1.2, height: 0.8, depth: 0.6, radius: 0.08, radiusSegments: 2 });
		expect(/** @type {any} */ (baked).parameters).toBeUndefined();
		expect(matchRoundedBox(baked)).toEqual({ width: 1.2, height: 0.8, depth: 0.6, radius: 0.08, radiusSegments: 2 });
		// a moved one, an edited one, a sphere and a typed box are not offered
		const moved = baked.clone().translate(0.5, 0, 0);
		expect(matchRoundedBox(moved)).toBeNull();
		const dented = baked.clone();
		dented.attributes.position.array[4] += 0.05;
		expect(matchRoundedBox(dented)).toBeNull();
		expect(matchRoundedBox(new THREE.SphereGeometry(1).toNonIndexed())).toBeNull();
		expect(matchRoundedBox(new THREE.BoxGeometry())).toBeNull();
	});

	it('a box an older build wrote back square is rounded again from its userData', () => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), new THREE.MeshStandardMaterial());
		mesh.userData.geometryParams = { gtype: 'Box', params: { width: 2, height: 1, depth: 1, radius: 0.1, radiusSegments: 2 } };
		expect(restoreRoundedBoxes(mesh)).toBe(1);
		expect(mesh.geometry).toBeInstanceOf(RoundedBox);
		// a sculpted one keeps its mesh
		const edited = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
		edited.userData = { faceEdited: true, geometryParams: { gtype: 'Box', params: { width: 2, height: 1, depth: 1, radius: 0.1 } } };
		expect(restoreRoundedBoxes(edited)).toBe(0);
	});

	it('the Box spec stores the radius rows only once used', () => {
		const spec = /** @type {any} */ (geometrySpec('Box'));
		const optional = spec.params.filter((/** @type {any} */ p) => p.optional).map((/** @type {any} */ p) => p.key);
		expect(optional).toEqual(['radius', 'radiusSegments']);
		expect(spec.params.find((/** @type {any} */ p) => p.key === 'radiusSegments').show({ radius: 0 })).toBe(false);
	});
});

describe('equal shapes saved once', () => {
	/** @param {string} name @param {THREE.BufferGeometry} g */
	const el = (name, g) => {
		const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
		m.name = name;
		return m.toJSON();
	};

	it('a payload without repeats is returned unchanged (same object)', () => {
		const payload = { objects: [el('a', new THREE.SphereGeometry(1).toNonIndexed()), el('b', new THREE.BoxGeometry())] };
		expect(shareGeometries(payload)).toBe(payload);
	});

	it('repeats go into one table entry and come back where they were used', () => {
		const crate = bakedRoundedBox({ width: 1, height: 1, depth: 1, radius: 0.1, radiusSegments: 3 });
		const objects = [el('c1', crate.clone()), el('c2', crate.clone()), el('c3', crate.clone()), el('ball', new THREE.SphereGeometry(1, 8, 6).toNonIndexed())];
		const payload = { objects };
		const before = JSON.stringify(payload);
		const shared = shareGeometries(payload);
		expect(JSON.stringify(payload)).toBe(before); // the live payload is untouched
		expect(shared.sharedGeometries).toHaveLength(1);
		const stub = shared.objects[1].geometries[0];
		expect(stub).toMatchObject({ type: 'BoxGeometry', width: 1, height: 1, depth: 1, sharedGeometry: 0 });
		expect(shared.objects[3]).toBe(objects[3]); // the one-off sphere is written as before
		expect(JSON.stringify(shared).length).toBeLessThan(before.length / 2);
		const back = inflateSharedGeometries(JSON.parse(JSON.stringify(shared)));
		expect(back.sharedGeometries).toBeUndefined();
		expect(JSON.stringify(back) === before).toBe(true);
		// each mesh owns its copy
		expect(back.objects[0].geometries[0].data).not.toBe(back.objects[1].geometries[0].data);
	});

	it('an older reader parses the stub as a plain box of the mesh size', () => {
		const crate = bakedRoundedBox({ width: 2, height: 1, depth: 1, radius: 0.1, radiusSegments: 1 });
		const shared = shareGeometries({ objects: [el('a', crate.clone()), el('b', crate.clone())] });
		const stub = shared.objects[0].geometries[0];
		const old = new THREE.BoxGeometry(stub.width, stub.height, stub.depth);
		old.computeBoundingBox();
		expect(old.boundingBox?.max.x).toBeCloseTo(1, 4);
	});
});
