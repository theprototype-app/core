import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { writeStl, readStl, write3mf, read3mf, threeMfModel, openEdges, partsBounds, scaleForLongestSide, partTriangles, hexColor } from '../../src/lib/export3d/print3dCore.js';

// 102 M2: the 3D-print writers round-trip their triangle counts, write millimetres, sit the
// part on the bed, keep a colour per object in 3MF, and count open edges.

/** a part from a three geometry, moved by `offset` metres @param {any} g @param {number[]} [offset] @param {number[] | null} [color] */
function partOf(g, offset = [0, 0, 0], color = null) {
	const positions = new Float32Array(g.attributes.position.array);
	for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) positions[i + a] += offset[a];
	return { name: 'p', positions, index: g.index ? Uint32Array.from(g.index.array) : null, color };
}

describe('binary STL', () => {
	it('round-trips the triangle count of every part, merged', () => {
		const a = partOf(new THREE.BoxGeometry(1, 1, 1));
		const b = partOf(new THREE.SphereGeometry(0.5, 16, 12), [2, 0, 0]);
		const buffer = writeStl([a, b]);
		const read = readStl(buffer);
		expect(read.triangles).toBe(partTriangles(a) + partTriangles(b));
		expect(buffer.byteLength).toBe(84 + read.triangles * 50);
	});

	it('writes millimetres, Z up, on the bed and scaled', () => {
		// a 2 m tall, 1 m wide box standing at y 5: 2000 mm tall in Z, bottom at z = 0
		const box = partOf(new THREE.BoxGeometry(1, 2, 1), [0, 5, 0]);
		const { positions } = readStl(writeStl([box]));
		const z = [...positions].filter((_, i) => i % 3 === 2);
		expect(Math.min(...z)).toBeCloseTo(0, 3);
		expect(Math.max(...z)).toBeCloseTo(2000, 2);
		const half = readStl(writeStl([box], { scale: 0.5 })).positions;
		expect(Math.max(...[...half].filter((_, i) => i % 3 === 2))).toBeCloseTo(1000, 2);
	});
});

describe('3MF', () => {
	it('is a millimetre package with one object per part and its colour', () => {
		const red = partOf(new THREE.BoxGeometry(1, 1, 1), [0, 0, 0], [1, 0, 0]);
		const blue = partOf(new THREE.BoxGeometry(1, 1, 1), [3, 0, 0], [0, 0, 1]);
		const read = read3mf(write3mf([red, blue]));
		expect(read.unit).toBe('millimeter');
		expect(read.objects.length).toBe(2);
		expect(read.triangles).toBe(24);
		expect(read.colors).toEqual(['#FF0000', '#0000FF']);
		// welded: a box is 8 corners, not 24 three-way-split ones
		expect(read.objects[0].vertices).toBe(8);
	});

	it('escapes part names', () => {
		const p = { ...partOf(new THREE.BoxGeometry(1, 1, 1)), name: 'A <b> & "c"' };
		expect(threeMfModel([p])).toContain('name="A &lt;b&gt; &amp; &quot;c&quot;"');
	});

	it('hexColor clamps and pads', () => {
		expect(hexColor([0, 0.5, 2])).toBe('#0080FF');
	});
});

describe('open edges (the manifold warning)', () => {
	it('0 for a closed box, counted for an open one', () => {
		expect(openEdges([partOf(new THREE.BoxGeometry(1, 1, 1))])).toBe(0);
		expect(openEdges([partOf(new THREE.SphereGeometry(1, 16, 12))])).toBe(0);
		// a plane is one quad: its four border edges are open
		expect(openEdges([partOf(new THREE.PlaneGeometry(1, 1))])).toBe(4);
		// a soup (three's toNonIndexed) welds back: still closed
		expect(openEdges([partOf(new THREE.BoxGeometry(1, 1, 1).toNonIndexed())])).toBe(0);
	});
});

describe('bounds and the scale prompt', () => {
	it('measures metres and turns a longest side in mm into a scale', () => {
		const b = partsBounds([partOf(new THREE.BoxGeometry(0.1, 0.05, 0.02))]);
		expect(b?.size[0]).toBeCloseTo(0.1, 6);
		expect(scaleForLongestSide([0.1, 0.05, 0.02], 50)).toBeCloseTo(0.5, 6);
		expect(partsBounds([])).toBe(null);
	});
});
