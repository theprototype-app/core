// 102b-papercuts (scout row 18): an effect that reaches no object is no longer silently inert
import { describe, it, expect } from 'vitest';
import { validateScene } from '../../src/lib/ai/runtimeCore.js';
import { publishLiveStates, nodeLiveStates, liveStateGraph, clearLiveStates, INERT_LINE } from '../../src/lib/nodeLiveState.js';
import { get } from 'svelte/store';

const EFFECTS = new Set(['spin', 'setcolor', 'script']);
const world = (/** @type {any} */ w) => ({
	nodes: [],
	edges: [],
	objects: { box: { name: 'Box' } },
	envLit: true,
	isSource: () => false,
	isAction: () => false,
	inputsOf: () => [],
	isObjectEffect: (/** @type {string} */ t) => EFFECTS.has(t),
	...w
});
const codes = (/** @type {any} */ r) => r.issues.map((/** @type {any} */ i) => i.code);

describe('validate_scene: effect-no-object', () => {
	it('a scene-graph Spin with no selector is flagged (warning)', () => {
		const r = validateScene(world({ nodes: [{ id: 's', type: 'spin', data: {} }] }));
		expect(codes(r)).toContain('effect-no-object');
		expect(r.issues.find((/** @type {any} */ i) => i.code === 'effect-no-object').level).toBe('warning');
	});
	it('a selector with no object picked still acts on nothing', () => {
		const r = validateScene(world({ nodes: [{ id: 's', type: 'spin' }, { id: 'o', type: 'objectselector', data: { selected: '' } }], edges: [{ source: 's', target: 'o' }] }));
		expect(codes(r)).toContain('effect-no-object');
	});
	it('wired to a picked object, in an object graph, or with its own target: fine', () => {
		expect(codes(validateScene(world({ nodes: [{ id: 's', type: 'spin' }, { id: 'o', type: 'objectselector', data: { selected: 'box' } }], edges: [{ source: 's', target: 'o' }] })))).not.toContain('effect-no-object');
		expect(codes(validateScene(world({ nodes: [{ id: 's', type: 'spin', __graph: 'box' }] })))).not.toContain('effect-no-object');
		expect(codes(validateScene(world({ nodes: [{ id: 's', type: 'setcolor', data: { target: 'box' } }] })))).not.toContain('effect-no-object');
	});
	it('a Script with outputs is a value, not an effect', () => {
		expect(codes(validateScene(world({ nodes: [{ id: 's', type: 'script', data: { outputs: [{ name: 'n', type: 'number' }] } }] })))).not.toContain('effect-no-object');
	});
	it('a World without the probe (an older caller) is unchanged', () => {
		const w = world({ nodes: [{ id: 's', type: 'spin' }] });
		delete w.isObjectEffect;
		expect(codes(validateScene(w))).not.toContain('effect-no-object');
	});
});

describe('the card line', () => {
	it('an inert effect shows INERT_LINE ahead of its own reader', () => {
		liveStateGraph.set('scene');
		clearLiveStates();
		publishLiveStates({
			nodes: [{ id: 'a', type: 'counter' }, { id: 'b', type: 'spin' }],
			now: 1000,
			time: 1,
			motionTime: 1,
			motionRests: false,
			capturing: null,
			value: () => 2,
			pulseAt: () => null,
			inert: (/** @type {any} */ n) => n.id === 'b'
		});
		expect(get(nodeLiveStates)).toEqual({ a: 'count 2', b: INERT_LINE });
		expect(INERT_LINE.length).toBeLessThanOrEqual(40); // the card clips at 40
		liveStateGraph.set(null);
	});
});
