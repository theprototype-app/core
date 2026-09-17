import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { disposeTree, keepSet, removeAndDispose } from '../../src/lib/disposeTree.js';

// 27-G (audit H6). Freeing GPU memory is easy; freeing memory that something ELSE still
// draws with is the bug, and it does not throw — the other object just renders black,
// later, with nothing to connect it to the delete that caused it. So these tests are
// mostly about SHARING, and they need no renderer: a geometry, a material and a texture
// are ordinary objects with a dispose() method and a disposal event.

/** a mesh with its own geometry, material and texture
 * @param {string} name */
const mesh = (name) => {
	const g = new THREE.BoxGeometry(1, 1, 1);
	const t = new THREE.Texture();
	const m = new THREE.MeshStandardMaterial({ map: t });
	const o = new THREE.Mesh(g, m);
	o.name = name;
	return o;
};

/** record what actually got disposed, by listening for three's own event
 * @param {...any} resources */
const watch = (...resources) => {
	const gone = new Set();
	for (const r of resources) r.addEventListener('dispose', () => gone.add(r));
	return gone;
};

describe('it frees what only the doomed object was using', () => {
	it('disposes geometry, material and texture, and says so', () => {
		const scene = new THREE.Scene();
		const a = mesh('a');
		scene.add(a);
		const gone = watch(a.geometry, a.material, a.material.map);

		const freed = removeAndDispose(scene, a);

		expect(freed).toEqual({ geometries: 1, materials: 1, textures: 1 });
		expect(gone.size).toBe(3);
		expect(a.parent).toBe(null);
	});

	it('walks the whole subtree, not just the root', () => {
		const scene = new THREE.Scene();
		const parent = new THREE.Group();
		const child = mesh('child');
		parent.add(child);
		scene.add(parent);

		const freed = removeAndDispose(scene, parent);
		expect(freed.geometries).toBe(1);
		expect(freed.textures).toBe(1);
	});

	it('counts a material referenced twice only once', () => {
		const scene = new THREE.Scene();
		const shared = new THREE.MeshStandardMaterial();
		const o = new THREE.Mesh(new THREE.BoxGeometry(), [shared, shared]);
		scene.add(o);

		const freed = removeAndDispose(scene, o);
		expect(freed.materials).toBe(1);
	});
});

describe('it refuses to free what the scene still holds', () => {
	it('keeps a MATERIAL two objects share', () => {
		const scene = new THREE.Scene();
		const shared = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
		const a = new THREE.Mesh(new THREE.BoxGeometry(), shared);
		const b = new THREE.Mesh(new THREE.BoxGeometry(), shared);
		scene.add(a, b);
		const gone = watch(shared, shared.map);

		const freed = removeAndDispose(scene, a);

		expect(freed.geometries).toBe(1); // its own geometry goes
		expect(freed.materials).toBe(0); // the shared material does NOT
		expect(freed.textures).toBe(0); // nor the texture hanging off it
		expect(gone.size).toBe(0);
	});

	it('keeps a GEOMETRY a clone shares — the clone() rule this repo already lives by', () => {
		const scene = new THREE.Scene();
		const a = mesh('a');
		const ghost = a.clone(); // shares geometry AND material
		scene.add(a, ghost);
		const gone = watch(a.geometry, a.material);

		const freed = removeAndDispose(scene, a);
		expect(freed.geometries).toBe(0);
		expect(freed.materials).toBe(0);
		expect(gone.size).toBe(0);
	});

	it('keeps a TEXTURE shared by two different materials', () => {
		const scene = new THREE.Scene();
		const tex = new THREE.Texture();
		const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: tex }));
		const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: tex }));
		scene.add(a, b);
		const gone = watch(tex);

		const freed = removeAndDispose(scene, a);
		expect(freed.materials).toBe(1); // a's own material is not shared
		expect(freed.textures).toBe(0); // the texture is
		expect(gone.size).toBe(0);
	});

	it('THE COUNTERFACTUAL: with no keep set, the shared texture IS destroyed', () => {
		// this is the bug the keep set exists to prevent, written down so the guard
		// cannot quietly stop working
		const tex = new THREE.Texture();
		const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: tex }));
		const gone = watch(tex);

		disposeTree(a); // no keep set
		expect(gone.has(tex)).toBe(true);
	});
});

describe('it finds textures it was never told about', () => {
	it('disposes any map-like slot, not a hardcoded list', () => {
		// three grows new map slots release to release; a hardcoded list silently stops
		// covering the newest one, and a leak that covers 90% looks like no leak
		const scene = new THREE.Scene();
		const m = new THREE.MeshStandardMaterial();
		m.map = new THREE.Texture();
		m.normalMap = new THREE.Texture();
		m.roughnessMap = new THREE.Texture();
		m.emissiveMap = new THREE.Texture();
		const o = new THREE.Mesh(new THREE.BoxGeometry(), m);
		scene.add(o);

		const freed = removeAndDispose(scene, o);
		expect(freed.textures).toBe(4);
	});
});

describe('keepSet', () => {
	it('excludes the doomed subtree, so its own resources are not protected from it', () => {
		const scene = new THREE.Scene();
		const a = mesh('a');
		scene.add(a);
		const keep = keepSet(scene, a);
		expect(keep.has(a.geometry)).toBe(false);
	});

	it('takes an ARRAY of doomed roots, which is what clear-scene needs', () => {
		const scene = new THREE.Scene();
		const a = mesh('a');
		const b = mesh('b');
		scene.add(a, b);
		const keep = keepSet(scene, [a, b]);
		expect(keep.has(a.geometry)).toBe(false);
		expect(keep.has(b.geometry)).toBe(false);
	});

	it('survives a null scene and a null target rather than throwing mid-delete', () => {
		expect(() => keepSet(null, null)).not.toThrow();
		expect(disposeTree(null)).toEqual({ geometries: 0, materials: 0, textures: 0 });
	});
});
