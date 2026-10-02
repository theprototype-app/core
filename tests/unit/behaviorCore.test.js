// @ts-nocheck — assertions on nullable returns; the module itself is fully typed
import { describe, it, expect } from 'vitest';
import {
	normalizeBehavior,
	normalizeState,
	restState,
	stateIsNewer,
	poseAt,
	nextState,
	openPosition,
	boxMinusBox,
	frameSlabs,
	boxCorners
} from '../../src/lib/behaviorCore.js';

// 33 P2: the pure half of animated pack items.
const DOOR = normalizeBehavior({ type: 'door', clip: 'open', closeClip: 'close', trigger: 'click', autoplay: false, sound: 'door' });
const DUR = { idle: 1, open: 1, close: 1 };

describe('normalizeBehavior', () => {
	it('keeps the contract fields and defaults a door collider to follow', () => {
		expect(DOOR).toEqual({ type: 'door', clip: 'open', closeClip: 'close', trigger: 'click', autoplay: false, sound: 'door', collider: 'follow' });
	});
	it('refuses an unknown type or a missing clip', () => {
		expect(normalizeBehavior({ type: 'spin', clip: 'a' })).toBeNull();
		expect(normalizeBehavior({ type: 'door' })).toBeNull();
		expect(normalizeBehavior(null)).toBeNull();
	});
	it('honours autoplay ONLY for a loop (nothing else may play on its own)', () => {
		expect(normalizeBehavior({ type: 'door', clip: 'open', autoplay: true }).autoplay).toBe(false);
		expect(normalizeBehavior({ type: 'oneshot', clip: 'pull', autoplay: true }).autoplay).toBe(false);
		expect(normalizeBehavior({ type: 'loop', clip: 'loop', autoplay: true }).autoplay).toBe(true);
		expect(normalizeBehavior({ type: 'loop', clip: 'loop' }).autoplay).toBe(false);
	});
	it('defaults an unknown trigger to click and drops a closeClip equal to clip', () => {
		const b = normalizeBehavior({ type: 'toggle', clip: 'on', closeClip: 'on', trigger: 'laser' });
		expect(b.trigger).toBe('click');
		expect(b.closeClip).toBeNull();
		expect(b.collider).toBeNull();
	});
});

describe('poses', () => {
	it('rests at the open clip t=0 before any trigger and in Edit whatever the state', () => {
		expect(poseAt(DOOR, restState(), DUR, 5000, true)).toEqual({ clip: 'open', time: 0, moving: false });
		const open = { on: true, at: 0, from: 0, n: 1 };
		expect(poseAt(DOOR, open, DUR, 5000, false)).toEqual({ clip: 'open', time: 0, moving: false });
	});
	it('a door opens at clip speed and holds open', () => {
		const s = nextState(DOOR, restState(), DUR, 1000);
		expect(s).toEqual({ on: true, at: 1000, from: 0, n: 1 });
		expect(poseAt(DOOR, s, DUR, 1500, true).time).toBeCloseTo(0.5);
		expect(poseAt(DOOR, s, DUR, 9000, true)).toEqual({ clip: 'open', time: 1, moving: false });
	});
	it('closing half-way through opening starts the close clip from half-way', () => {
		const opening = nextState(DOOR, restState(), DUR, 0);
		const closing = nextState(DOOR, opening, DUR, 500);
		expect(closing.on).toBe(false);
		expect(closing.from).toBeCloseTo(0.5);
		const p = poseAt(DOOR, closing, DUR, 600, true);
		expect(p.clip).toBe('close');
		expect(p.time).toBeCloseTo(0.6); // 1 - 0.4 open
		expect(poseAt(DOOR, closing, DUR, 5000, true)).toEqual({ clip: 'close', time: 1, moving: false });
	});
	it('without a closeClip a door plays the open clip backwards', () => {
		const spec = normalizeBehavior({ type: 'toggle', clip: 'open' });
		const open = { on: true, at: 0, from: 0, n: 1 };
		const shut = nextState(spec, open, DUR, 3000);
		expect(poseAt(spec, shut, DUR, 3250, true)).toEqual({ clip: 'open', time: 0.75, moving: true });
	});
	it('a oneshot plays once per trigger and stops at its end', () => {
		const spec = normalizeBehavior({ type: 'oneshot', clip: 'pull' });
		const s1 = nextState(spec, restState(), { pull: 2 }, 0);
		expect(poseAt(spec, s1, { pull: 2 }, 500, true).time).toBeCloseTo(0.5);
		expect(poseAt(spec, s1, { pull: 2 }, 9000, true)).toEqual({ clip: 'pull', time: 2, moving: false });
		const s2 = nextState(spec, s1, { pull: 2 }, 10000);
		expect(s2.n).toBe(2);
		expect(poseAt(spec, s2, { pull: 2 }, 10100, true).time).toBeCloseTo(0.1);
	});
	it('an ambient loop runs on the session phase only while active; a plain loop waits for its trigger', () => {
		const amb = normalizeBehavior({ type: 'loop', clip: 'loop', autoplay: true });
		expect(poseAt(amb, restState(), { loop: 2 }, 5500, true).time).toBeCloseTo(1.5);
		expect(poseAt(amb, restState(), { loop: 2 }, 5500, false).time).toBe(0);
		expect(nextState(amb, restState(), { loop: 2 }, 0)).toBeNull();
		const plain = normalizeBehavior({ type: 'loop', clip: 'loop' });
		expect(poseAt(plain, restState(), { loop: 2 }, 5500, true).moving).toBe(false);
		const on = nextState(plain, restState(), { loop: 2 }, 5000);
		expect(poseAt(plain, on, { loop: 2 }, 7500, true).time).toBeCloseTo(0.5);
	});
	it('a forced direction that changes nothing returns null (proximity on an open door)', () => {
		const open = nextState(DOOR, restState(), DUR, 0);
		expect(nextState(DOOR, open, DUR, 100, true)).toBeNull();
		expect(nextState(DOOR, open, DUR, 100, false).on).toBe(false);
	});
	it('openPosition clamps a stale from', () => {
		expect(openPosition({ on: true, at: 0, from: 9, n: 1 }, 1, 0)).toBe(1);
	});
});

describe('state merge', () => {
	it('latest stamp wins, the count breaks a tie', () => {
		const a = { on: true, at: 100, from: 0, n: 1 };
		expect(stateIsNewer(a, { on: false, at: 99, from: 0, n: 5 })).toBe(false);
		expect(stateIsNewer(a, { on: false, at: 100, from: 0, n: 2 })).toBe(true);
		expect(stateIsNewer(null, a)).toBe(true);
	});
	it('normalizeState rejects non-finite input', () => {
		expect(normalizeState({ on: true, at: 'x', from: 0, n: 1 })).toBeNull();
		expect(normalizeState({ on: 1, at: 5, from: -2, n: 2.7 })).toEqual({ on: false, at: 5, from: 0, n: 2 });
	});
});

describe('the doorway', () => {
	// the fixture door: a one-piece frame box over x [-0.65, 0.65], y [0, 2.15], z [-0.1, 0.1]
	const frame = [-0.65, 0, -0.1, 0.65, 2.15, 0.1];
	const leaf = [-0.48, 0.01, -0.04, 0.48, 1.98, 0.04];
	it('cutting the leaf out of the frame box leaves posts and a lintel, and nothing in the opening', () => {
		const slabs = frameSlabs([frame], [leaf]);
		// left post, right post, threshold sliver dropped? (0.01 tall = kept at minSize 0.01), lintel
		const inOpening = slabs.filter((s) => s[0] < 0 && s[3] > 0 && s[1] < 1 && s[4] > 1);
		expect(inOpening).toEqual([]);
		expect(slabs.some((s) => s[3] <= -0.48 + 1e-9)).toBe(true); // a left post
		expect(slabs.some((s) => s[0] >= 0.48 - 1e-9)).toBe(true); // a right post
		expect(slabs.some((s) => s[1] >= 1.98 - 1e-9)).toBe(true); // a lintel
	});
	it('a lid resting ON a chest leaves the chest body whole; a trapdoor opens through a floor ring', () => {
		const body = [0, 0, 0, 1, 0.5, 0.6];
		expect(frameSlabs([body], [[0, 0.5, 0, 1, 0.56, 0.6]])).toEqual([body]);
		const ring = [-1, -0.2, -1, 1, 0, 1];
		const slabs = frameSlabs([ring], [[-0.5, -0.1, -0.5, 0.5, -0.05, 0.5]]);
		expect(slabs.filter((s) => s[0] < 0 && s[3] > 0 && s[2] < 0 && s[5] > 0)).toEqual([]);
		expect(slabs.length).toBe(4);
	});
	it('33-scenes: a garden gate (a low leaf in a tall frame) opens up to its frame top', () => {
		// town-kit FenceGate, measured: the oak frame box and the picket leaf
		const gateFrame = [-1, 0, -0.06, 1, 1.96, 0.06];
		const gateLeaf = [-0.87, 0.08, -0.05, 0.85, 1.05, 0.04];
		const slabs = frameSlabs([gateFrame], [gateLeaf]);
		// nothing across the gateway above the leaf, up to the frame's top
		expect(slabs.filter((s) => s[0] < 0 && s[3] > 0 && s[4] > 1.05)).toEqual([]);
		expect(slabs.some((s) => s[3] <= -0.87 + 1e-9) && slabs.some((s) => s[0] >= 0.85 - 1e-9)).toBe(true); // both posts stay
		// a DOOR fills its frame: its lintel is exactly what it was
		const door = frameSlabs([frame], [leaf]);
		expect(door.filter((s) => s[1] >= 1.98 - 1e-9).length).toBe(1);
		expect(door.find((s) => s[1] >= 1.98 - 1e-9)?.[1]).toBeCloseTo(1.98, 9);
	});
	it('33-scenes: a static part 1 cm proud of the leaf (a gate\'s iron straps) leaves no sliver wall', () => {
		const iron = [-0.88, 0.26, 0.02, 0.88, 0.86, 0.05];
		const gateLeaf = [-0.87, 0.08, -0.05, 0.85, 1.05, 0.04];
		const slabs = frameSlabs([iron], [gateLeaf]);
		expect(slabs.filter((s) => s[0] < 0 && s[3] > 0)).toEqual([]);
	});
	it('no overlap = the box unchanged; a hole covering it = nothing left', () => {
		expect(boxMinusBox([0, 0, 0, 1, 1, 1], [2, 2, 2, 3, 3, 3])).toEqual([[0, 0, 0, 1, 1, 1]]);
		expect(boxMinusBox([0, 0, 0, 1, 1, 1], [-1, -1, -1, 2, 2, 2])).toEqual([]);
	});
	it('boxCorners gives 8 points', () => {
		expect(boxCorners([0, 0, 0, 1, 2, 3]).length).toBe(24);
	});
});
