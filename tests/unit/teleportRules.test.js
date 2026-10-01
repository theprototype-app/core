import { describe, it, expect } from 'vitest';
import {
	normalizeBounds,
	shrinkBox,
	inBox,
	segmentHitsBox,
	rasterSegmentClear,
	teleportVerdictPure,
	WALKABLE_NORMAL_Y
} from '../../src/lib/teleportRules.js';
import { walkable } from '../../src/lib/dungeonPlay.js';

// 31 K1 (D2/S1): the bounded teleport's rules, with no headset and no scene.

/** @param {number} x @param {number} y @param {number} z */
const P = (x, y, z) => ({ x, y, z });

// a 6 x 6 dungeon raster, origin (0, 0): a room x 1..4, z 1..4 split by a wall at x = 3
// (cells x = 3, z 1..4), everything else wall
function dungeon() {
	const W = 6;
	const H = 6;
	const grid = new Array(W * H).fill(1);
	for (let z = 1; z <= 4; z++) for (let x = 1; x <= 4; x++) grid[z * W + x] = 0;
	for (let z = 1; z <= 4; z++) grid[z * W + 3] = 1;
	return { grid, width: W, height: H, minX: 0, minY: 0, floorValue: 0 };
}

describe('normalizeBounds', () => {
	it('keeps six finite numbers and orders each axis', () => {
		expect(normalizeBounds({ min: [2, 0, -1], max: [-2, 3, 1] })).toEqual({ min: [-2, 0, -1], max: [2, 3, 1] });
	});
	it('refuses anything else', () => {
		expect(normalizeBounds(null)).toBe(null);
		expect(normalizeBounds({ min: [0, 0], max: [1, 1, 1] })).toBe(null);
		expect(normalizeBounds({ min: [0, 0, NaN], max: [1, 1, 1] })).toBe(null);
		expect(normalizeBounds({ min: [0, 0, 0], max: [1e9, 1, 1] })).toBe(null);
		expect(normalizeBounds({ min: ['a', 0, 0], max: [1, 1, 1] })).toBe(null);
	});
});

describe('shrinkBox', () => {
	it('pulls x and z in, leaves y', () => {
		expect(shrinkBox({ min: [-5, 0, -5], max: [5, 3, 5] }, 0.3)).toEqual({ min: [-4.7, 0, -4.7], max: [4.7, 3, 4.7] });
	});
	it('a thin box collapses onto its centre line, never inverts', () => {
		const b = shrinkBox({ min: [0, 0, 0], max: [0.4, 1, 10] }, 0.3);
		expect(b.min[0]).toBeCloseTo(0.2);
		expect(b.max[0]).toBeCloseTo(0.2);
		expect(b.min[2]).toBeCloseTo(0.3);
	});
});

describe('segmentHitsBox', () => {
	const wall = { min: [2, 0, -5], max: [2.2, 3, 5] };
	it('a line through the wall hits it', () => expect(segmentHitsBox(P(0, 1.1, 0), P(4, 1.1, 0), wall)).toBe(true));
	it('a line stopping short does not', () => expect(segmentHitsBox(P(0, 1.1, 0), P(1.9, 1.1, 0), wall)).toBe(false));
	it('a line over it does not', () => expect(segmentHitsBox(P(0, 3.5, 0), P(4, 3.5, 0), wall)).toBe(false));
	it('a line beside it does not', () => expect(segmentHitsBox(P(0, 1.1, 6), P(4, 1.1, 6), wall)).toBe(false));
	it('an axis-parallel line inside the slab hits', () => expect(segmentHitsBox(P(2.1, 1, -9), P(2.1, 1, 9), wall)).toBe(true));
});

describe('rasterSegmentClear', () => {
	const d = dungeon();
	it('within one side of the room is clear', () => expect(rasterSegmentClear(d, P(1.5, 0, 1.5), P(2.5, 0, 4.5), walkable)).toBe(true));
	it('across the dividing wall is not', () => expect(rasterSegmentClear(d, P(1.5, 0, 2.5), P(4.5, 0, 2.5), walkable)).toBe(false));
});

describe('teleportVerdictPure', () => {
	const bounds = { min: [-5, -0.5, -5], max: [5, 0.4, 5] };
	it('a floor target inside the bounds is ok', () => {
		expect(teleportVerdictPure({ from: P(0, 0, 0), to: P(2, 0, 2), normalY: 1, bounds })).toEqual({ ok: true, reason: 'ok' });
	});
	it('a steep surface (a wall face) is refused', () => {
		expect(teleportVerdictPure({ to: P(1, 1, 0), normalY: WALKABLE_NORMAL_Y - 0.01 }).reason).toBe('steep');
		expect(teleportVerdictPure({ to: P(1, 1, 0), normalY: WALKABLE_NORMAL_Y }).ok).toBe(true);
	});
	it('outside the bounds is refused, and a box top above them too', () => {
		expect(teleportVerdictPure({ to: P(6, 0, 0), bounds }).reason).toBe('outside');
		expect(teleportVerdictPure({ to: P(0, 1, 0), bounds }).reason).toBe('outside');
	});
	it('a raster: a wall cell is off-floor, a line across the wall is wall-cell', () => {
		const raster = dungeon();
		expect(teleportVerdictPure({ from: P(1.5, 0, 2.5), to: P(3.5, 0, 2.5), raster, walkable }).reason).toBe('off-floor');
		expect(teleportVerdictPure({ from: P(1.5, 0, 2.5), to: P(4.5, 0, 2.5), raster, walkable }).reason).toBe('wall-cell');
		expect(teleportVerdictPure({ from: P(1.5, 0, 1.5), to: P(2.5, 0, 3.5), raster, walkable }).ok).toBe(true);
	});
	it('a collider between the ends blocks; one you stand inside does not', () => {
		const wall = { min: [2, 0, -5], max: [2.2, 3, 5] };
		expect(teleportVerdictPure({ from: P(0, 0, 0), to: P(4, 0, 0), colliders: [wall] }).reason).toBe('blocked');
		expect(teleportVerdictPure({ from: P(0, 0, 0), to: P(1.5, 0, 0), colliders: [wall] }).ok).toBe(true);
		const room = { min: [-3, 0, -3], max: [3, 3, 3] };
		expect(teleportVerdictPure({ from: P(0, 0, 0), to: P(2, 0, 2), colliders: [room] }).ok).toBe(true);
	});
	it('a mesh on the way blocks; nothing named passes', () => {
		expect(teleportVerdictPure({ from: P(0, 0, 0), to: P(1, 0, 0), meshBlocked: true }).reason).toBe('blocked');
		expect(teleportVerdictPure({ to: P(1, 0, 0) }).ok).toBe(true);
		expect(teleportVerdictPure({ to: P(NaN, 0, 0) }).ok).toBe(false);
	});
	it('inBox honours an epsilon on the faces', () => {
		expect(inBox(P(5, 0.4, 5), bounds)).toBe(true);
		expect(inBox(P(5.01, 0, 0), bounds)).toBe(false);
	});
});
