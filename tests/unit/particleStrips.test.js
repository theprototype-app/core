// 37-fx: the vertex layouts behind the stretch / trails / ribbon particle modes, and the
// emitter-velocity estimate behind inherit velocity.
import { describe, it, expect } from 'vitest';
import {
	renderModeOf,
	segmentsOf,
	stripLayout,
	ribbonLayout,
	expandSlots,
	smoothEmitterVelocity,
	MAX_TRAIL_SEGMENTS
} from '../../src/lib/particleStrips.js';

describe('renderModeOf', () => {
	it('defaults to points and keeps the known modes', () => {
		expect(renderModeOf({})).toBe('points');
		expect(renderModeOf({ render: 'nonsense' })).toBe('points');
		expect(renderModeOf({ render: 'stretch' })).toBe('stretch');
		expect(renderModeOf({ render: 'trails', mode: 'burst' })).toBe('trails');
		expect(renderModeOf({ render: 'ribbon' })).toBe('ribbon');
	});
	it('draws a burst ribbon as trails (a burst has no birth order)', () => {
		expect(renderModeOf({ render: 'ribbon', mode: 'burst' })).toBe('trails');
		expect(renderModeOf({ render: 'ribbon', mode: 'impact' })).toBe('trails');
	});
});

describe('segmentsOf', () => {
	it('is 1 unless trails, and clamps the trail segments', () => {
		expect(segmentsOf({ trailSegments: 12 }, 'stretch')).toBe(1);
		expect(segmentsOf({}, 'trails')).toBe(8);
		expect(segmentsOf({ trailSegments: 1 }, 'trails')).toBe(2);
		expect(segmentsOf({ trailSegments: 99 }, 'trails')).toBe(MAX_TRAIL_SEGMENTS);
	});
});

describe('stripLayout', () => {
	it('gives each slot (segs+1)*2 vertices and segs quads, head to tail', () => {
		const l = stripLayout(3, 4);
		expect(l.verts).toBe(3 * 5 * 2);
		expect(l.index.length).toBe(3 * 4 * 6);
		expect(l.indicesPerSlot).toBe(24);
		// slot 1's vertices are contiguous, segment 0 first, both sides
		expect([...l.slotOf.slice(10, 20)]).toEqual(Array(10).fill(1));
		expect([...l.seg.slice(10, 14)]).toEqual([0, 0, 1, 1]);
		expect([...l.side.slice(10, 12)]).toEqual([-1, 1]);
	});
	it('never indexes across slots (a strip is one particle)', () => {
		const l = stripLayout(5, 3);
		for (let q = 0; q < l.index.length; q += 6) {
			const slots = new Set([...l.index.slice(q, q + 6)].map((/** @type {number} */ v) => l.slotOf[v]));
			expect(slots.size).toBe(1);
		}
	});
	it('draws the first N slots with drawRange N * indicesPerSlot', () => {
		const l = stripLayout(10, 2);
		const n = 4;
		const used = [...l.index.slice(0, n * l.indicesPerSlot)].map((/** @type {number} */ v) => l.slotOf[v]);
		expect(Math.max(...used)).toBe(n - 1);
	});
	it('switches to 32-bit indices past 65535 vertices', () => {
		expect(stripLayout(500, 16).index).toBeInstanceOf(Uint16Array);
		expect(stripLayout(2200, 16).index).toBeInstanceOf(Uint32Array);
	});
});

describe('ribbonLayout', () => {
	it('joins slot i (older end) to i+1 (younger), wrapping at the end', () => {
		const l = ribbonLayout(4);
		expect(l.verts).toBe(16);
		// quad 3 joins slot 3 to slot 0
		expect([...l.slotOf.slice(12, 16)]).toEqual([3, 3, 0, 0]);
		expect([...l.otherOf.slice(12, 16)]).toEqual([0, 0, 3, 3]);
		expect([...l.end.slice(12, 16)]).toEqual([0, 0, 1, 1]);
	});
	it('every vertex carries the quad pair, so both ends agree which is older', () => {
		const l = ribbonLayout(6);
		for (let q = 0; q < 6; q++) {
			const pair = (/** @type {number} */ v) => [l.slotOf[v], l.otherOf[v]].sort().join();
			const pairs = new Set([0, 1, 2, 3].map((k) => pair(q * 4 + k)));
			expect(pairs.size).toBe(1);
		}
	});
});

describe('expandSlots', () => {
	it('copies each slot into every vertex that samples it', () => {
		const l = ribbonLayout(3);
		const origins = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]);
		const self = expandSlots(origins, 3, l.slotOf, new Float32Array(l.verts * 3));
		const other = expandSlots(origins, 3, l.otherOf, new Float32Array(l.verts * 3));
		// quad 2: older end = slot 2, younger end = slot 0
		expect(self[2 * 4 * 3]).toBe(2);
		expect(self[(2 * 4 + 2) * 3]).toBe(0);
		expect(other[2 * 4 * 3]).toBe(0);
	});
});

describe('smoothEmitterVelocity', () => {
	it('is zero with no previous position or no usable dt', () => {
		expect(smoothEmitterVelocity([5, 5, 5], null, [1, 2, 3], 0.016)).toEqual([0, 0, 0]);
		expect(smoothEmitterVelocity([5, 5, 5], [0, 0, 0], [1, 2, 3], 0)).toEqual([0, 0, 0]);
		expect(smoothEmitterVelocity([5, 5, 5], [0, 0, 0], [1, 2, 3], 2)).toEqual([0, 0, 0]);
	});
	it('converges on a steady motion', () => {
		const vel = [0, 0, 0];
		let x = 0;
		for (let i = 0; i < 20; i++) {
			const prev = [x, 0, 0];
			x += 0.1; // 10 m/s at 100 Hz
			smoothEmitterVelocity(vel, prev, [x, 0, 0], 0.01);
		}
		expect(vel[0]).toBeCloseTo(10, 3);
		expect(vel[1]).toBe(0);
	});
	it('ignores a teleport instead of flinging particles', () => {
		const vel = [2, 0, 0];
		smoothEmitterVelocity(vel, [0, 0, 0], [100, 0, 0], 0.016);
		expect(vel).toEqual([2, 0, 0]);
	});
});
