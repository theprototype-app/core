// @ts-nocheck — a fixture test: sets are built by hand and asserted by the checks themselves
// 51 union — THE SEAM between 51-edit's instance lists and 51-sources' set format. The edit
// tools read what a set DRAWS (string ids) and hand back edited lists; blockOf must turn the
// difference into overrides / painted-record rewrites and leave everything else alone, so an
// edited seeded fill stays a seed + overrides (no explicit bytes) and reads back the same on a
// second "peer" (a JSON wire hop).
import { describe, test, expect, vi } from 'vitest';
import { normalizeScatter, encodeInstances, instancesOf } from '../../src/lib/terrainScatterCore.js';
import { base64ToBytes } from '../../src/lib/terrainPaintCore.js';

const B = { minX: -20, minZ: -20, sizeX: 40, sizeZ: 40 };
// readScatter's two terrain reads, as the pure core answers them (no mask, no scene)
vi.mock('../../src/lib/terrainSurface.js', () => ({
	terrainBounds: () => B,
	scatterSetInstances: (object, setId) => {
		const set = normalizeScatter(object.userData.terrainScatter, base64ToBytes).sets.find((s) => s.id === setId);
		return instancesOf(set, B, base64ToBytes);
	}
}));
const { readScatter, blockOf, indexOfInstance, newSet } = await import('../../src/lib/scatterEditAdapter.js');

const b64 = (u) => Buffer.from(u).toString('base64');
const ROCK = { kind: 'primitive', type: 'Dodecahedron' };
const CONE = { kind: 'primitive', type: 'Cone' };
const terrainWith = (block) => ({ userData: { terrain: true, terrainScatter: JSON.parse(JSON.stringify(block)) } });
const wire = (block) => terrainWith(block); // a peer / a reload reads the same JSON
const drawn = (object, id) => {
	const set = normalizeScatter(object.userData.terrainScatter, base64ToBytes).sets.find((s) => s.id === id);
	return set ? instancesOf(set, B, base64ToBytes) : [];
};
const seeded = { v: 1, sets: [{ id: 'rocks', source: ROCK, align: false, data: '', count: 0, seed: 777, gen: { count: 50, scaleMin: 0.5, scaleMax: 2, rot: true }, tint: 0.4 }] };
const painted = [
	{ x: 1, z: 2, yaw: 0.5, scale: 1.2 },
	{ x: -3, z: 4, yaw: 1, scale: 0.8 },
	{ x: 5, z: -6, yaw: 2, scale: 1 }
];
const mixed = { v: 1, sets: [{ id: 'p:Cone', source: CONE, align: true, data: b64(encodeInstances(painted, B)), count: 3, collider: 'box' }] };

describe('51 union: scatterEditAdapter over the set format', () => {
	test('an untouched read writes the block back unchanged', () => {
		for (const block of [seeded, mixed]) {
			const o = terrainWith(block);
			const data = readScatter(o);
			expect(blockOf(data.sets, data.bounds)).toEqual(normalizeScatter(o.userData.terrainScatter, base64ToBytes));
		}
	});

	test('editing a seeded fill writes overrides, keeps seed/gen/tint, and reads back the edit on a peer', () => {
		const o = terrainWith(seeded);
		const data = readScatter(o);
		const set = data.sets[0];
		expect(set.list.length).toBe(50);
		const i = indexOfInstance(set, 'g7');
		set.list = set.list.map((p, k) => (k === i ? { ...p, x: 3.25, z: -4.5, yaw: 1.5, scale: 1.75 } : p)).filter((p) => p.id !== 'g9');
		const block = blockOf(data.sets, data.bounds);
		const s = block.sets[0];
		expect(s.data).toBe('');
		expect(s.seed).toBe(777);
		expect(s.gen).toEqual(seeded.sets[0].gen);
		expect(s.tint).toBe(0.4);
		expect(s.ov).toEqual({ 7: { x: 3.25, z: -4.5, yaw: 1.5, scale: 1.75 }, 9: { del: 1 } });
		const peer = drawn(wire(block), 'rocks');
		expect(peer.length).toBe(49);
		expect(peer.find((p) => p.id === 'g9')).toBeUndefined();
		expect(peer.find((p) => p.id === 'g7')).toMatchObject({ x: 3.25, z: -4.5, yaw: 1.5, scale: 1.75 });
		// every other slot is exactly the seed's
		const base = drawn(o, 'rocks');
		for (const p of peer) if (p.id !== 'g7') expect(p).toEqual(base.find((q) => q.id === p.id));
	});

	test('painted records are rewritten / dropped in place; set fields ride through', () => {
		const o = terrainWith(mixed);
		const data = readScatter(o);
		const set = data.sets[0];
		set.list = [{ ...set.list[0], yaw: 0.25 }, set.list[2]]; // p1 deleted, p0 turned
		const block = blockOf(data.sets, data.bounds);
		expect(block.sets[0]).toMatchObject({ id: 'p:Cone', align: true, collider: 'box', count: 2 });
		const peer = drawn(wire(block), 'p:Cone');
		expect(peer.map((p) => p.id)).toEqual(['p0', 'p1']);
		expect(peer[0].yaw).toBeCloseTo(0.25, 3);
		expect(peer[1].x).toBeCloseTo(5, 1);
	});

	test('id-less entries (objects -> scatter) append painted records; a new set is all records', () => {
		const o = terrainWith(seeded);
		const data = readScatter(o);
		data.sets[0].list = [...data.sets[0].list, { x: 0, z: 0, yaw: 0, scale: 1 }, { x: 2, z: 2, yaw: 0, scale: 1 }];
		data.sets.push(newSet(CONE, [{ x: -1, z: -1, yaw: 0, scale: 1 }]));
		const block = blockOf(data.sets, data.bounds);
		expect(block.sets[0]).toMatchObject({ count: 2, seed: 777 });
		expect(block.sets[0].ov).toBeUndefined();
		expect(drawn(wire(block), 'rocks').length).toBe(52);
		expect(block.sets[1]).toMatchObject({ id: 'p:Cone', count: 1 });
	});

	test('a set erased to nothing leaves no row; no sets clears the block', () => {
		const o = terrainWith(mixed);
		const data = readScatter(o);
		data.sets[0].list = [];
		expect(blockOf(data.sets, data.bounds)).toBeNull();
	});
});
