// @ts-nocheck — a fixture test: sets are built by hand and asserted by the checks themselves
// 51 — THE SCATTER SET FORMAT (params + seed + overrides). The rules this file holds:
// the same seed + params + overrides give the same instances twice and on two "peers" (two
// independent wire round trips), a slot is a STABLE id (raising the count moves nothing), a
// re-roll keeps the hand edits, a 1.38 set loads byte-identical, and the edit API rewrites
// painted records / generated overrides without touching anything else.
import { describe, test, expect } from 'vitest';
import {
	normalizeScatter,
	encodeInstances,
	decodeInstances,
	instancesOf,
	generateSlots,
	withOverrides,
	withSeed,
	slotDraws,
	pickSource,
	sourceOf,
	sourceKey,
	blockVersion,
	MAX_INSTANCES
} from '../../src/lib/terrainScatterCore.js';

const B = { minX: -20, minZ: -20, sizeX: 40, sizeZ: 40 };
const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const IO = { bounds: B, decode: unb64, encode: b64 };
/** a JSON wire hop: what a peer receives (and a reload reads) */
const wire = (block) => normalizeScatter(JSON.parse(JSON.stringify(block)), unb64);

const ROCK = { kind: 'primitive', type: 'Dodecahedron' };
const seeded = (extra = {}) => ({ id: 'rocks', source: ROCK, seed: 12345, gen: { count: 200, scaleMin: 0.5, scaleMax: 2, rot: true }, ...extra });

describe('51 set format: migration', () => {
	test('a 1.38 set normalizes to exactly the object it did before (no new keys, v1)', () => {
		const data = b64(encodeInstances([{ x: 1, z: 2, yaw: 0.5, scale: 1.2 }, { x: -3, z: 4, yaw: 1, scale: 0.8 }], B));
		const old = { v: 1, sets: [{ id: 'p:Cone', source: { kind: 'primitive', type: 'Cone' }, align: true, data, count: 2, collider: 'box' }] };
		const n = normalizeScatter(old, unb64);
		expect(n).toEqual(old);
		expect(JSON.stringify(n)).toBe(JSON.stringify(old));
		expect(Object.keys(n.sets[0])).toEqual(['id', 'source', 'align', 'data', 'count', 'collider']);
	});

	test('a 1.38 set draws its painted instances with p ids, nothing generated', () => {
		const data = b64(encodeInstances([{ x: 1, z: 2, yaw: 0.5, scale: 1.2 }], B));
		const set = normalizeScatter({ sets: [{ source: ROCK, data }] }, unb64).sets[0];
		const list = instancesOf(set, B, unb64);
		expect(list.map((i) => i.id)).toEqual(['p0']);
		expect(list[0].src).toBe(0);
	});

	test('the block stays v1 until a set uses a 51 field', () => {
		expect(blockVersion([{ count: 1 }])).toBe(1);
		expect(blockVersion([{ count: 0, gen: { count: 1 } }])).toBe(2);
		expect(blockVersion([{ count: 1, tint: 0.3 }])).toBe(2);
	});
});

describe('51 set format: determinism', () => {
	test('same seed + params + overrides = same instances, twice and across two peers', () => {
		const block = { v: 2, sets: [seeded({ ov: { 3: { del: 1 }, 7: { x: 1, z: 1 } }, tint: 0.4, sink: 0.1 })] };
		const peerA = wire(block).sets[0];
		const peerB = wire(JSON.parse(JSON.stringify(block))).sets[0];
		const a1 = instancesOf(peerA, B, unb64);
		const a2 = instancesOf(peerA, B, unb64);
		const b1 = instancesOf(peerB, B, unb64);
		expect(a1.length).toBe(199);
		expect(a2).toEqual(a1);
		expect(b1).toEqual(a1);
		// a reload of what peer A stored reads the same
		expect(instancesOf(wire({ v: 2, sets: [peerA] }).sets[0], B, unb64)).toEqual(a1);
	});

	test('a different seed gives a different layout', () => {
		const a = instancesOf(seeded(), B, unb64);
		const b = instancesOf(seeded({ seed: 54321 }), B, unb64);
		expect(a.length).toBe(b.length);
		expect(a.filter((p, i) => p.x === b[i].x).length).toBe(0);
	});

	test('slot ids are stable: raising the count moves no existing slot', () => {
		const small = generateSlots(seeded({ gen: { count: 50, scaleMin: 1, scaleMax: 1, rot: true } }), B);
		const big = generateSlots(seeded({ gen: { count: 400, scaleMin: 1, scaleMax: 1, rot: true } }), B);
		expect(big.slice(0, 50)).toEqual(small);
	});

	test('a mask rejecting one slot moves no other slot', () => {
		const all = generateSlots(seeded(), B);
		const masked = generateSlots(seeded(), B, { accept: (_x, _z, k) => k !== 10 });
		// 51-surface: COUNT mode = count PLACED, so the rejected slot's place goes to the next draw
		expect(masked.length).toBe(all.length);
		expect(masked.find((i) => i.slot === 10)).toBeUndefined();
		expect(masked.at(-1)?.slot).toBe(all.length);
		expect(masked.find((i) => i.slot === 11)).toEqual(all.find((i) => i.slot === 11));
	});

	test('spacing: no two generated instances closer than the spacing', () => {
		const list = generateSlots(seeded({ gen: { count: 800, scaleMin: 1, scaleMax: 1, rot: true, spacing: 2 } }), B);
		expect(list.length).toBeGreaterThan(50);
		expect(list.length).toBeLessThan(800);
		let min = Infinity;
		for (let i = 0; i < list.length; i++)
			for (let j = i + 1; j < list.length; j++) min = Math.min(min, Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z));
		expect(min).toBeGreaterThanOrEqual(2);
	});

	test('deleting a crowding slot does not make a crowded-out slot appear (spacing reads raw slots)', () => {
		const set = seeded({ gen: { count: 800, scaleMin: 1, scaleMax: 1, rot: true, spacing: 3 } });
		const before = instancesOf(set, B, unb64);
		const victim = before[5];
		const after = instancesOf(withOverrides(set, { [victim.id]: { del: true } }, IO), B, unb64);
		expect(after.length).toBe(before.length - 1);
		expect(after.map((i) => i.id)).toEqual(before.filter((i) => i !== victim).map((i) => i.id));
	});

	test('density mode counts over the bounds (0.1 / m² on 40x40 = 160 slots)', () => {
		const set = normalizeScatter({ sets: [{ source: ROCK, seed: 1, gen: { density: 0.1 } }] }, unb64).sets[0];
		expect(set.gen.density).toBe(0.1);
		expect(instancesOf(set, B, unb64).length).toBe(160);
	});

	test('slot draws are a pure function of (seed, k)', () => {
		expect(slotDraws(9, 4)).toEqual(slotDraws(9, 4));
		expect(slotDraws(9, 4)).not.toEqual(slotDraws(9, 5));
	});
});

describe('51 set format: overrides and re-roll', () => {
	test('move / rotate / scale / delete a generated slot', () => {
		const set = seeded();
		const ids = instancesOf(set, B, unb64).map((i) => i.id);
		const edited = withOverrides(set, { g0: { x: 5, z: 6 }, g1: { yaw: 1.5 }, g2: { scale: 3 }, g3: { del: true } }, IO);
		expect(edited.ov).toEqual({ 0: { x: 5, z: 6 }, 1: { yaw: 1.5 }, 2: { scale: 3 }, 3: { del: 1 } });
		const list = instancesOf(edited, B, unb64);
		const byId = Object.fromEntries(list.map((i) => [i.id, i]));
		expect([byId.g0.x, byId.g0.z]).toEqual([5, 6]);
		expect(byId.g1.yaw).toBe(1.5);
		expect(byId.g2.scale).toBe(3);
		expect(byId.g3).toBeUndefined();
		expect(list.length).toBe(ids.length - 1);
		// null clears an edit: back to the seed's pose
		const cleared = withOverrides(edited, { g0: null }, IO);
		expect(instancesOf(cleared, B, unb64).find((i) => i.id === 'g0')).toEqual(instancesOf(set, B, unb64)[0]);
		expect(set.ov).toBeUndefined(); // input untouched
	});

	test('a re-roll keeps the hand edits (keyed by slot)', () => {
		const edited = withOverrides(seeded(), { g4: { x: 1, z: 2, yaw: 0.25 }, g9: { del: true } }, IO);
		const rerolled = withSeed(edited, 999);
		const before = instancesOf(edited, B, unb64);
		const after = instancesOf(rerolled, B, unb64);
		expect(after.find((i) => i.id === 'g4')).toMatchObject({ x: 1, z: 2, yaw: 0.25 });
		expect(after.find((i) => i.id === 'g9')).toBeUndefined();
		// the unedited ones moved
		expect(after.find((i) => i.id === 'g5').x).not.toBe(before.find((i) => i.id === 'g5').x);
	});

	test('painted records: edit rewrites the record, delete drops it (and its pick byte)', () => {
		const data = b64(encodeInstances([{ x: 1, z: 1, yaw: 0, scale: 1 }, { x: 2, z: 2, yaw: 0, scale: 1 }, { x: 3, z: 3, yaw: 0, scale: 1 }], B));
		const set = normalizeScatter(
			{ sets: [{ source: ROCK, data, sources: [{ source: ROCK, w: 1 }, { source: { kind: 'primitive', type: 'Cone' }, w: 1 }], pick: b64(new Uint8Array([0, 1, 0])) }] },
			unb64
		).sets[0];
		expect(instancesOf(set, B, unb64).map((i) => i.src)).toEqual([0, 1, 0]);
		const next = withOverrides(set, { p0: { del: true }, p2: { x: -5, scale: 2 } }, IO);
		expect(next.count).toBe(2);
		const list = instancesOf(next, B, unb64);
		expect(list.map((i) => i.src)).toEqual([1, 0]);
		expect(list[1].x).toBeCloseTo(-5, 2);
		expect(list[1].scale).toBeCloseTo(2, 2);
		expect(list[0].x).toBeCloseTo(2, 2);
	});
});

describe('51 set format: mixed sets, tint, sink, sources, validation', () => {
	test('a mixed set picks its sources by weight (50/30/20 within a few percent)', () => {
		const sources = [
			{ source: ROCK, w: 50 },
			{ source: { kind: 'primitive', type: 'Box' }, w: 30 },
			{ source: { kind: 'primitive', type: 'Cone' }, w: 20 }
		];
		const set = normalizeScatter({ sets: [seeded({ sources, gen: { count: 5000, scaleMin: 1, scaleMax: 1 } })] }, unb64).sets[0];
		const counts = [0, 0, 0];
		for (const i of instancesOf(set, B, unb64)) counts[i.src]++;
		expect(counts[0] / 5000).toBeCloseTo(0.5, 1);
		expect(counts[1] / 5000).toBeCloseTo(0.3, 1);
		expect(counts[2] / 5000).toBeCloseTo(0.2, 1);
		expect(pickSource(sources, 0)).toBe(0);
		expect(pickSource(sources, 0.999)).toBe(2);
	});

	test('a one-entry sources list is not a mix (dropped); tint and sink clamp', () => {
		const set = normalizeScatter({ sets: [seeded({ sources: [{ source: ROCK, w: 1 }], tint: 7, sink: -40 })] }, unb64).sets[0];
		expect(set.sources).toBeUndefined();
		expect(set.tint).toBe(1);
		expect(set.sink).toBe(-2);
	});

	test('tint draws are spread over [-1, 1] and stable', () => {
		const list = instancesOf(seeded(), B, unb64);
		expect(Math.min(...list.map((i) => i.tint))).toBeLessThan(-0.8);
		expect(Math.max(...list.map((i) => i.tint))).toBeGreaterThan(0.8);
	});

	test('pack sources validate, key by path; bad paths are refused', () => {
		const s = sourceOf({ kind: 'pack', pack: 'nature-kit', item: 'Rock1', path: 'nature-kit/Rock1.glb', note: 'x' });
		expect(s).toEqual({ kind: 'pack', path: 'nature-kit/Rock1.glb', pack: 'nature-kit', item: 'Rock1', note: 'x' });
		expect(sourceKey(s)).toBe('k:nature-kit/Rock1.glb');
		expect(sourceOf({ kind: 'pack', path: '../etc/passwd' })).toBeNull();
		expect(sourceOf({ kind: 'library', hash: 'abc', name: 'Rock', note: 'Prefab "Gate" — look only' }).note).toBe('Prefab "Gate" — look only');
	});

	test('51 union: a prefab look keeps its prefab id (To objects brings the prefab back), keyed by its look', () => {
		const id = '3f0c1a52-9b7e-4d2a-8c11-0a6b5f1e2d34';
		const s = sourceOf({ kind: 'library', hash: 'abc', name: 'Gate', note: 'look only', prefab: id });
		expect(s).toEqual({ kind: 'library', hash: 'abc', name: 'Gate', note: 'look only', prefab: id });
		expect(sourceKey(s)).toBe('l:abc');
		expect(sourceOf({ kind: 'library', hash: 'abc', name: 'Rock' })).toEqual({ kind: 'library', hash: 'abc', name: 'Rock' });
		expect(sourceOf({ kind: 'library', hash: 'abc', prefab: '<script>' })).not.toHaveProperty('prefab');
		const set = normalizeScatter({ sets: [seeded({ source: s })] }, unb64).sets[0];
		expect(set.source.prefab).toBe(id);
	});

	test('bad overrides are dropped, not guessed at', () => {
		const set = normalizeScatter({ sets: [seeded({ ov: { 1: { x: 'a' }, nope: { del: 1 }, 99999: { del: 1 }, 2: { scale: 1e6 }, 3: { del: true } } })] }, unb64).sets[0];
		expect(set.ov).toEqual({ 2: { scale: 20 }, 3: { del: 1 } });
	});

	test('the instance cap holds across painted + generated (count clamps at normalize)', () => {
		const data = b64(encodeInstances(Array.from({ length: 100 }, () => ({ x: 0, z: 0, yaw: 0, scale: 1 })), B));
		const n = normalizeScatter({ sets: [{ source: ROCK, data }, seeded({ gen: { count: MAX_INSTANCES } })] }, unb64);
		expect(n.sets[1].gen.count).toBe(MAX_INSTANCES - 100);
	});

	test('a generated-only set survives normalize with no data', () => {
		const set = normalizeScatter({ sets: [seeded()] }, unb64).sets[0];
		expect(set).toMatchObject({ id: 'rocks', data: '', count: 0, seed: 12345 });
	});

	test('51-surface fields ride the gen block untouched', () => {
		const set = normalizeScatter({ sets: [seeded({ gen: { count: 10, slope: [0, 30], mode: 'fill' } })] }, unb64).sets[0];
		expect(set.gen.slope).toEqual([0, 30]);
		expect(set.gen.mode).toBe('fill');
	});

	test('decode/encode round trip unchanged (the 1.38 records)', () => {
		const list = [{ x: 1, z: 2, yaw: 0.5, scale: 1.2 }];
		expect(decodeInstances(encodeInstances(list, B), B)[0].scale).toBeCloseTo(1.2, 3);
	});
});

import { withSourceAdded, withSourceRemoved } from '../../src/lib/terrainScatterCore.js';

describe('51 E1: adding and removing sources of a mixed set', () => {
	const CONE = { kind: 'primitive', type: 'Cone' };
	const BOX = { kind: 'primitive', type: 'Box' };
	const painted = () =>
		normalizeScatter({ sets: [{ id: 's', source: ROCK, data: b64(encodeInstances([{ x: 1, z: 1, yaw: 0, scale: 1 }, { x: 2, z: 2, yaw: 0, scale: 1 }], B)) }] }, unb64).sets[0];

	test('adding a source makes a mix; painted records keep the first source', () => {
		const mixed = withSourceAdded(painted(), CONE, 2, IO);
		expect(mixed.sources).toEqual([{ source: ROCK, w: 1 }, { source: CONE, w: 2 }]);
		expect(instancesOf(mixed, B, unb64).map((i) => i.src)).toEqual([0, 0]);
		expect(withSourceAdded(mixed, CONE, 1, IO)).toBe(mixed); // already in it
	});

	test('removing a source drops its painted records and shifts later picks', () => {
		let set = withSourceAdded(withSourceAdded(painted(), CONE, 1, IO), BOX, 1, IO);
		set = { ...set, pick: b64(new Uint8Array([1, 2])) };
		const without = withSourceRemoved(set, 1, IO);
		expect(without.sources.map((e) => e.source.type)).toEqual(['Dodecahedron', 'Box']);
		expect(without.count).toBe(1);
		expect(instancesOf(without, B, unb64).map((i) => i.src)).toEqual([1]);
		const plain = withSourceRemoved(without, 0, IO);
		expect(plain.sources).toBeUndefined();
		expect(plain.pick).toBeUndefined();
		expect(plain.source).toEqual(BOX);
		expect(plain.count).toBe(1);
	});
});
