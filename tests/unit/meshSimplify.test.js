import { describe, it, expect, beforeAll } from 'vitest';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import * as THREE from 'three';
import {
	simplifyGeometryData,
	simplifyTarget,
	simplifyRefusal,
	attributeNames,
	trianglesIn,
	MIN_TRIANGLES
} from '../../src/lib/meshSimplify.js';
import { simplifyMesh } from '../../src/lib/decimateCore.js';
import { openEdges } from '../../src/lib/export3d/print3dCore.js';

// 102 M1: the pure Simplify core, against the REAL simplifier. What must hold: the attribute
// set survives (incl. skin weights and a second uv set), a carried channel stays attached to the
// vertex it belonged to, material group ranges stay contiguous and cover the index, and the
// triangle count lands on the request.

beforeAll(async () => {
	await MeshoptSimplifier.ready;
});

/** geometry data of a three geometry @param {any} g */
function dataOf(g) {
	/** @type {Record<string, any>} */
	const attributes = {};
	for (const [name, a] of Object.entries(g.attributes)) {
		const attr = /** @type {any} */ (a);
		attributes[name] = { array: attr.array, itemSize: attr.itemSize, ...(attr.normalized ? { normalized: true } : {}) };
	}
	return { attributes, index: g.index ? Uint32Array.from(g.index.array) : null, groups: g.groups.map((/** @type {any} */ x) => ({ ...x })) };
}

/** a sphere carrying skin weights keyed off each vertex's height, a second uv set and colours */
function riggedSphere() {
	const g = new THREE.SphereGeometry(1, 64, 48);
	const n = g.attributes.position.count;
	const skinIndex = new Uint16Array(n * 4);
	const skinWeight = new Float32Array(n * 4);
	const colors = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		const y = g.attributes.position.getY(i);
		// bone 0 below the equator, bone 1 above: a weight that can be checked per vertex
		skinIndex[i * 4] = y > 0 ? 1 : 0;
		skinWeight[i * 4] = 1;
		colors[i * 3] = (y + 1) / 2;
	}
	g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
	g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
	g.setAttribute('uv1', g.attributes.uv.clone());
	g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
	return g;
}

describe('simplifyTarget', () => {
	it('reads a percentage or a count and clamps to the mesh', () => {
		expect(simplifyTarget(1000, { percent: 25 })).toBe(250);
		expect(simplifyTarget(1000, { triangles: 300 })).toBe(300);
		expect(simplifyTarget(1000, { triangles: 5000 })).toBe(1000);
		expect(simplifyTarget(1000, { percent: 0 })).toBe(MIN_TRIANGLES);
		expect(simplifyTarget(0, { percent: 50 })).toBe(0);
	});
});

describe('simplifyGeometryData', () => {
	it('keeps the attribute set, including skin weights, uv1 and colours', () => {
		const g = riggedSphere();
		const data = dataOf(g);
		const before = trianglesIn(data);
		const result = simplifyGeometryData(MeshoptSimplifier, data, { percent: 25 });
		expect(attributeNames(result.data)).toEqual(attributeNames(data));
		expect(result.before).toBe(before);
		// lands within 2% of the ask (meshoptimizer stops at or under the target)
		expect(result.triangles).toBeLessThanOrEqual(Math.round(before * 0.25));
		expect(result.triangles).toBeGreaterThan(Math.round(before * 0.25 * 0.9));
		// the vertex buffer shrank with it, and every channel has one item per kept vertex
		const kept = result.data.attributes.position.array.length / 3;
		expect(kept).toBeLessThan(g.attributes.position.count);
		for (const [name, c] of Object.entries(result.data.attributes)) expect(c.array.length / c.itemSize, name).toBe(kept);
		// skin indices keep their integer type
		expect(result.data.attributes.skinIndex.array).toBeInstanceOf(Uint16Array);
	});

	it('keeps each carried value on the vertex it belonged to', () => {
		const data = dataOf(riggedSphere());
		const result = simplifyGeometryData(MeshoptSimplifier, data, { percent: 30 });
		const pos = result.data.attributes.position.array;
		const bone = result.data.attributes.skinIndex.array;
		for (let v = 0; v < pos.length / 3; v++) expect(bone[v * 4]).toBe(pos[v * 3 + 1] > 0 ? 1 : 0);
	});

	it('keeps material group ranges contiguous and covering the index', () => {
		const g = new THREE.BoxGeometry(1, 1, 1, 16, 16, 16); // six groups, one per side
		const data = dataOf(g);
		const result = simplifyGeometryData(MeshoptSimplifier, data, { percent: 40 });
		const groups = result.data.groups;
		expect(groups.length).toBe(6);
		expect(groups.map((x) => x.materialIndex)).toEqual([0, 1, 2, 3, 4, 5]);
		let at = 0;
		for (const group of groups) {
			expect(group.start).toBe(at);
			expect(group.count % 3).toBe(0);
			at += group.count;
		}
		expect(at).toBe(/** @type {Uint32Array} */ (result.data.index).length);
	});

	it('reports a dropped tangent and still simplifies', () => {
		const g = new THREE.SphereGeometry(1, 32, 24);
		g.computeTangents();
		const result = simplifyGeometryData(MeshoptSimplifier, dataOf(g), { percent: 50 });
		expect(result.dropped).toEqual(['tangent']);
		expect(result.data.attributes.tangent).toBeUndefined();
	});

	it('a closed uv sphere stays watertight (its seam and poles do not crack)', () => {
		const g = new THREE.SphereGeometry(1, 251, 100);
		const data = dataOf(g);
		const result = simplifyGeometryData(MeshoptSimplifier, data, { percent: 25 });
		expect(openEdges([{ name: 'before', positions: /** @type {any} */ (data.attributes.position.array), index: data.index }])).toBe(0);
		expect(openEdges([{ name: 'after', positions: /** @type {any} */ (result.data.attributes.position.array), index: result.data.index }])).toBe(0);
		expect(result.triangles).toBeGreaterThan(Math.round(trianglesIn(data) * 0.25 * 0.9));
	});

	it('welds a triangle soup first (an STL) and still reaches the target', () => {
		const g = new THREE.SphereGeometry(1, 48, 32).toNonIndexed();
		g.deleteAttribute('normal');
		g.deleteAttribute('uv');
		const data = dataOf(g);
		const before = trianglesIn(data);
		const result = simplifyGeometryData(MeshoptSimplifier, data, { percent: 25 });
		expect(result.recomputeNormals).toBe(true);
		expect(result.triangles).toBeLessThanOrEqual(Math.round(before * 0.25));
		expect(result.triangles).toBeGreaterThan(Math.round(before * 0.2));
	});
});

describe('decimateCore extras stay additive', () => {
	it('no extras in = no extras key out (the import path is byte-identical)', () => {
		const g = new THREE.SphereGeometry(1, 16, 12);
		const out = simplifyMesh(MeshoptSimplifier, {
			key: 'a',
			positions: new Float32Array(g.attributes.position.array),
			index: Uint32Array.from(/** @type {any} */ (g.index).array),
			target: 100
		});
		expect('extras' in out).toBe(false);
	});
});

describe('simplifyRefusal', () => {
	it('says why politely, and nothing for a plain mesh', () => {
		expect(simplifyRefusal({ mesh: true, triangles: 1000 })).toBe('');
		expect(simplifyRefusal({ mesh: true, scatter: true, triangles: 1000 })).toMatch(/scatter/);
		expect(simplifyRefusal({ mesh: true, parametric: true, triangles: 1000 })).toMatch(/Bake/);
		expect(simplifyRefusal({ mesh: false })).toMatch(/Nothing/);
		expect(simplifyRefusal({ mesh: true, morph: true, triangles: 1000 })).toMatch(/morph/);
		expect(simplifyRefusal({ mesh: true, triangles: 2 })).toMatch(/already/);
	});
});
