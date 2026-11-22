import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
	patrolTarget,
	firedText,
	registerLiveState,
	publishLiveStates,
	nodeLiveStates,
	liveStateGraph,
	liveStatesWanted,
	clearLiveStates,
	hasLiveState
} from '../../src/lib/nodeLiveState.js';

// 78 F7: one live line under a card, from a registry of cheap readers, for the shown graph only.
const square = { points: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], speed: 1 };

/** @param {any[]} nodes @param {Partial<any>} [over] */
const tick = (nodes, over = {}) => ({
	nodes,
	now: 0,
	time: 100,
	motionTime: 0.5,
	motionRests: false,
	capturing: null,
	value: () => 0,
	pulseAt: () => null,
	...over
});

describe('patrolTarget: the point a Path patrol is heading to', () => {
	it('loop: walks 1 -> 2 -> 3 -> 4 -> back to 1', () => {
		expect(patrolTarget(square, 0.5)).toBe(2);
		expect(patrolTarget(square, 1.5)).toBe(3);
		expect(patrolTarget(square, 2.5)).toBe(4);
		expect(patrolTarget(square, 3.5)).toBe(1);
	});
	it('ping-pong: out to the last point, then back', () => {
		const pp = { ...square, mode: 'pingpong' };
		expect(patrolTarget(pp, 0.5)).toBe(2);
		expect(patrolTarget(pp, 2.5)).toBe(4);
		expect(patrolTarget(pp, 3.5)).toBe(3); // walking back along 3 -> 4 means heading to 3
		expect(patrolTarget(pp, 5.5)).toBe(1);
	});
	it('nothing to say with fewer than two points or no speed', () => {
		expect(patrolTarget({ points: [[0, 0, 0]] }, 1)).toBe(null);
		expect(patrolTarget({ ...square, speed: 0 }, 1)).toBe(null);
	});
});

describe('live states', () => {
	beforeEach(() => {
		clearLiveStates();
		liveStateGraph.set(null);
	});

	it('firedText: only the last 10 seconds', () => {
		expect(firedText(null)).toBe(null);
		expect(firedText(0.4)).toBe('fired just now');
		expect(firedText(2.25)).toBe('fired 2.3 s ago');
		expect(firedText(11)).toBe(null);
	});

	it('nothing is computed while no editor shows a graph', () => {
		expect(liveStatesWanted()).toBe(false);
		publishLiveStates(tick([{ id: 'c', type: 'counter', data: {} }], { value: () => 3 }));
		expect(get(nodeLiveStates)).toEqual({});
	});

	it('built-ins: counter, latch, a trigger, a resting motion node, a patrol; other graphs and muted nodes are skipped', () => {
		liveStateGraph.set('scene');
		const nodes = [
			{ id: 'c', type: 'counter', data: {} },
			{ id: 'l', type: 'latch', data: {} },
			{ id: 'k', type: 'onclick', data: {} },
			{ id: 's', type: 'spin', data: {} },
			{ id: 'p', type: 'pathpatrol', data: square },
			{ id: 'o', type: 'counter', data: {}, __graph: 'obj-1' },
			{ id: 'm', type: 'counter', data: { muted: true } }
		];
		const values = /** @type {Record<string, any>} */ ({ c: 3, l: true, o: 9, m: 1 });
		publishLiveStates(tick(nodes, { value: (/** @type {any} */ n) => values[n.id], pulseAt: (/** @type {string} */ id) => (id === 'k' ? 99 : null) }));
		expect(get(nodeLiveStates)).toEqual({ c: 'count 3', l: 'on', k: 'fired 1.0 s ago', p: 'to point 2' });
	});

	it('Animate in editor off: motion nodes say they rest; a capturing patrol says it is placing points', () => {
		liveStateGraph.set('scene');
		publishLiveStates(
			tick(
				[
					{ id: 's', type: 'spin', data: {} },
					{ id: 'p', type: 'pathpatrol', data: square }
				],
				{ motionRests: true }
			)
		);
		expect(get(nodeLiveStates)).toEqual({ s: 'resting until Play', p: 'resting until Play' });
		clearLiveStates();
		publishLiveStates(tick([{ id: 'p', type: 'pathpatrol', data: square }], { capturing: 'p' }));
		expect(get(nodeLiveStates)).toEqual({ p: 'placing points' });
	});

	it('throttled to ~4 Hz, and a throwing reader shows nothing instead of breaking the tick', () => {
		liveStateGraph.set('scene');
		const off = registerLiveState('zz-test', () => {
			throw new Error('boom');
		});
		expect(hasLiveState('zz-test')).toBe(true);
		publishLiveStates(tick([{ id: 'c', type: 'counter', data: {} }, { id: 'z', type: 'zz-test', data: {} }], { value: () => 1 }));
		expect(get(nodeLiveStates)).toEqual({ c: 'count 1' });
		publishLiveStates(tick([{ id: 'c', type: 'counter', data: {} }], { now: 100, value: () => 2 }));
		expect(get(nodeLiveStates)).toEqual({ c: 'count 1' }); // 100 ms later: not yet
		publishLiveStates(tick([{ id: 'c', type: 'counter', data: {} }], { now: 300, value: () => 2 }));
		expect(get(nodeLiveStates)).toEqual({ c: 'count 2' });
		off();
		expect(hasLiveState('zz-test')).toBe(false);
	});
});
