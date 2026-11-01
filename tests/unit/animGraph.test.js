// @ts-nocheck — fixture-heavy unit suite (graphs as literals), the checkJs convention for tests
// 57 M11 — the Animation states graph: normalize, transitions with conditions, crossfades between
// states, triggers used once, play-once states, the motion params and the Locomotion preset.
import { describe, it, expect } from 'vitest';
import { normalizeAnimGraph, newRun, stepGraph, motionParams, locomotionPreset } from '../../src/lib/tpanim/animGraph.js';

const KAYKIT = ['Cheer', 'Idle', 'Interact', 'Jump_Idle', 'Running_A', 'Walking_A', 'Walking_Backwards'];
const DUR = { Idle: 2, Walking_A: 1, Running_A: 0.8, Jump_Idle: 0.6, Cheer: 1.5 };

/** run the graph at 60 fps through a list of [seconds, params] phases; returns every frame */
function drive(graph, phases) {
	const run = newRun(graph, 0);
	const frames = [];
	let t = 0;
	for (const [secs, params] of phases)
		for (let i = 0; i < Math.round(secs * 60); i++) {
			t += 1 / 60;
			frames.push({ t, ...stepGraph(graph, run, typeof params === 'function' ? params(t) : params, t, KAYKIT, DUR) });
		}
	return frames;
}

describe('normalizeAnimGraph', () => {
	it('keeps a valid graph and drops what does not resolve', () => {
		const g = normalizeAnimGraph({
			states: [{ id: 'a', clip: 'Idle' }, { id: 'a', clip: 'dupe' }, { id: 'b', blend: { param: 'speed' } }],
			transitions: [{ from: 'a', to: 'b', fade: 9, when: [{ param: 'speed', op: '>', value: '1' }, { param: 'x', op: 'nope' }] }, { from: 'a', to: 'zzz' }],
			params: [{ name: 'speed' }, { name: 'speed' }],
			entry: 'nope',
			evil: 1
		});
		expect(g.states.map((s) => s.id)).toEqual(['a', 'b']);
		expect(g.entry).toBe('a');
		expect(g.transitions).toEqual([{ from: 'a', to: 'b', fade: 3, when: [{ param: 'speed', op: '>', value: 1 }] }]);
		expect(g.params).toEqual([{ name: 'speed', type: 'float' }]);
		expect(g.evil).toBeUndefined();
		expect(normalizeAnimGraph({ states: [] })).toBe(null);
		expect(normalizeAnimGraph(null)).toBe(null);
	});
});

describe('stepGraph', () => {
	const g = normalizeAnimGraph({
		entry: 'idle',
		params: [{ name: 'go', type: 'trigger' }],
		states: [{ id: 'idle', clip: 'Idle' }, { id: 'cheer', clip: 'Cheer', loop: false }],
		transitions: [
			{ from: 'idle', to: 'cheer', fade: 0.5, when: [{ param: 'go', op: 'trigger' }] },
			{ from: 'cheer', to: 'idle', fade: 0.25, when: [], exitTime: 1 }
		]
	});

	it('crossfades between states with weights that always sum to one and never jump', () => {
		const frames = drive(g, [[0.5, { go: -1 }], [3, { go: 0.6 }]]);
		const at = frames.findIndex((f) => f.entered);
		expect(frames[at].state).toBe('cheer');
		let prev = frames[at - 1].weights;
		for (const f of frames.slice(at, at + 40)) {
			const sum = Object.values(f.weights).reduce((a, b) => a + b, 0);
			expect(sum).toBeCloseTo(1, 9);
			expect(Math.abs((f.weights.Cheer ?? 0) - (prev.Cheer ?? 0))).toBeLessThan(0.1);
			prev = f.weights;
		}
		// half way through the 0.5 s fade both clips play
		const mid = frames[at + 15].weights;
		expect(mid.Idle).toBeGreaterThan(0.2);
		expect(mid.Cheer).toBeGreaterThan(0.2);
	});

	it('uses a trigger once, and a play-once state holds then leaves at its exit time', () => {
		const frames = drive(g, [[0.2, { go: -1 }], [4, { go: 0.25 }]]);
		const entries = frames.filter((f) => f.entered).map((f) => f.state);
		expect(entries).toEqual(['cheer', 'idle']); // the same stamp does not fire twice
		const inCheer = frames.filter((f) => f.state === 'cheer');
		expect(inCheer.at(-1).times.Cheer).toBeCloseTo(1.5 - 1e-4, 2); // pinned at its end before leaving
		expect(inCheer.length / 60).toBeGreaterThan(1.45); // exitTime 1 = the whole 1.5 s clip
	});

	it('an old trigger does not replay when a state is entered later', () => {
		const frames = drive(g, [[1, { go: 0.1 }]]);
		// fired at 0.1 s while in idle (entered at 0): it counts, once
		expect(frames.filter((f) => f.entered && f.state === 'cheer').length).toBe(1);
	});
});

describe('motionParams', () => {
	it('reads speed, vertical speed and grounded (not at a jump apex)', () => {
		const memo = { groundedFor: 1 };
		expect(motionParams([3, 0, 4], memo, 1 / 60)).toEqual({ speed: 5, vy: 0, grounded: true });
		expect(motionParams([0, 4, 0], memo, 1 / 60).grounded).toBe(false);
		// apex: |vy| small for a few frames only
		let p;
		for (let i = 0; i < 4; i++) p = motionParams([0, 0.1, 0], memo, 1 / 60);
		expect(p.grounded).toBe(false);
		for (let i = 0; i < 10; i++) p = motionParams([0, 0, 0], memo, 1 / 60);
		expect(p.grounded).toBe(true);
	});
});

describe('the Locomotion preset', () => {
	const g = locomotionPreset(KAYKIT);
	it('builds Move (idle/walk/run blend), Jump and Fall from the model’s clips', () => {
		expect(g.driver).toBe('motion');
		const move = g.states.find((s) => s.id === 'move');
		expect(move.blend).toMatchObject({ idle: 'Idle', walk: 'Walking_A', run: 'Running_A' });
		expect(g.states.find((s) => s.id === 'fall').clip).toBe('Jump_Idle');
	});

	it('walks, runs, jumps, falls and lands', () => {
		const memo = { groundedFor: 1 };
		const phase = (/** @type {number[]} */ vel) => () => motionParams(vel, memo, 1 / 60);
		const frames = drive(g, [
			[1, phase([0, 0, 0])],
			[1, phase([1.4, 0, 0])],
			[1, phase([4, 0, 0])],
			[0.3, phase([4, 4, 0])],
			[0.4, phase([4, -3, 0])],
			[0.6, phase([2, 0, 0])]
		]);
		const at = (/** @type {number} */ s) => frames[Math.round(s * 60) - 1];
		expect(at(0.9).weights.Idle).toBeCloseTo(1, 5);
		expect(at(1.9).weights.Walking_A).toBeGreaterThan(0.95);
		expect(at(2.9).weights.Running_A).toBeGreaterThan(0.95);
		expect(at(3.25).state).toBe('jump');
		expect(at(3.65).state).toBe('fall');
		expect(at(4.3).state).toBe('move');
		expect(frames.filter((f) => f.entered).map((f) => f.state)).toEqual(['jump', 'fall', 'move']);
	});
});
