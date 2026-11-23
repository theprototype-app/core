// @ts-nocheck
// fix-late-joiners row 3: play-link joiners spawn apart (spawn points first, a deterministic ring, a probe).
import { describe, it, expect } from 'vitest';
import { spawnCandidates, arrivingSlot, pickSpawn, SPAWN_CLEARANCE } from '../../src/lib/spawnSlots.js';

const spawn = { position: [2, 0, -3], yaw: 0.5 };
const ids = (n) => Array.from({ length: n }, (_, i) => 'peer-' + String.fromCharCode(97 + ((i * 7) % 26)) + i);

describe('spawnCandidates', () => {
	it('lists the spawn, then the marked spawn points by id, then a 40-spot ring; heights and facing kept', () => {
		const marks = [
			{ id: 'zz', position: [10, 1, 10], yaw: 1 },
			{ id: 'aa', position: [-10, 0, 5], yaw: 2 },
			{ id: 'dup', position: [2, 0, -3], yaw: 0 }
		];
		const c = spawnCandidates(spawn, marks);
		expect(c[0].position).toEqual([2, 0, -3]);
		expect(c[1].position).toEqual([-10, 0, 5]);
		expect(c[2].position).toEqual([10, 1, 10]);
		expect(c.filter((s) => s.ring).length).toBe(36);
		for (const s of c.filter((s) => s.ring)) {
			expect(s.position[1]).toBe(0);
			expect(s.yaw).toBe(0.5);
		}
		// the first ring spot is straight behind the facing
		const first = c.find((s) => s.ring);
		expect(first.position[0]).toBeCloseTo(2 + Math.sin(0.5) * 1.4);
		expect(first.position[2]).toBeCloseTo(-3 + Math.cos(0.5) * 1.4);
	});
	it('no spawn and no marks: nothing; marks alone: the first mark is the centre', () => {
		expect(spawnCandidates(null, [])).toEqual([]);
		const c = spawnCandidates(null, [{ id: 'b', position: [5, 0, 5], yaw: 0 }]);
		expect(c[0].position).toEqual([5, 0, 5]);
		expect(c.length).toBe(37);
	});
});

describe('two to sixteen players opening a play link at once', () => {
	for (const n of [2, 3, 8, 16]) {
		it(`${n} arriving players compute ${n} different spots, every pair at least the clearance apart`, () => {
			const roster = ids(n);
			const cands = spawnCandidates(spawn);
			// nobody has seen anybody: every peer sees the others as arriving
			const spots = roster.map((me) => pickSpawn(cands, arrivingSlot(me, roster, () => true), []).spot.position);
			for (let i = 0; i < n; i++)
				for (let j = i + 1; j < n; j++) expect(Math.hypot(spots[i][0] - spots[j][0], spots[i][2] - spots[j][2])).toBeGreaterThanOrEqual(SPAWN_CLEARANCE - 1e-9);
			// deterministic: the same answer computed twice
			expect(roster.map((me) => pickSpawn(cands, arrivingSlot(me, [...roster].reverse(), () => true), []).index)).toEqual(
				roster.map((me) => pickSpawn(cands, arrivingSlot(me, roster, () => true), []).index)
			);
		});
	}
	it('an editing host counted on both sides still gives two joiners different spots', () => {
		const roster = ['host', 'x-joiner', 'y-joiner'];
		const cands = spawnCandidates(spawn);
		const a = pickSpawn(cands, arrivingSlot('x-joiner', roster, () => true), [[50, 0, 50]]).spot.position;
		const b = pickSpawn(cands, arrivingSlot('y-joiner', roster, () => true), [[50, 0, 50]]).spot.position;
		expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeGreaterThanOrEqual(SPAWN_CLEARANCE);
	});
});

describe('one player at a time', () => {
	it('a lone player gets the spawn itself', () => {
		const r = pickSpawn(spawnCandidates(spawn), arrivingSlot('me', ['me', 'p2'], () => false), []);
		expect(r.index).toBe(0);
		expect(r.spot.position).toEqual([2, 0, -3]);
	});
	it('a late joiner finds the spawn taken by a visible avatar and walks on to the nearest free spot', () => {
		const r = pickSpawn(spawnCandidates(spawn), arrivingSlot('me', ['me', 'p2'], () => false), [[2, 1.7, -3]]);
		expect(r.index).toBe(1);
	});
	it('the probe refuses a spot inside geometry and may lift a spot onto the floor it found', () => {
		const cands = spawnCandidates(spawn);
		const probe = (s) => (s.ring ? { ...s, position: [s.position[0], 0.25, s.position[2]] } : null); // the spawn itself is blocked
		const r = pickSpawn(cands, { rank: 0, of: 1 }, [], probe);
		expect(r.index).toBe(1);
		expect(r.spot.position[1]).toBe(0.25);
		const none = pickSpawn(cands, { rank: 0, of: 1 }, [], () => null);
		expect(none.index).toBe(0); // everything refused: the spawn, never nothing
	});
});
