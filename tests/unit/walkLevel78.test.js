// 78 F11 — validate_scene says when a walk scene will not start its world on Play.
import { describe, it, expect } from 'vitest';
import { validateScene } from '../../src/lib/ai/runtimeCore.js';

/** @param {any} w */
const world = (w) => ({
	nodes: [],
	edges: [],
	triggers: {},
	now: 1000,
	objects: { lamp: { name: 'Lamp', light: true } },
	hudElements: [],
	hudScreens: [],
	play: { interaction: 'grab', grounded: false, spawn: { position: [0, 0, 0], yaw: 0 } },
	envLit: true,
	behaviours: [],
	isSource: () => false,
	isAction: () => false,
	inputsOf: () => [],
	...w
});
/** @param {any} r */
const codes = (r) => r.issues.map((/** @type {any} */ i) => i.code);

describe('78 F11 walk-no-physics', () => {
	it('a walk scene with moving bodies and no sim on Play is reported', () => {
		const r = validateScene(world({ play: { grounded: true, simOnPlay: false, spawn: { position: [0, 0, 0], yaw: 0 } }, dynamicBodies: true }));
		expect(codes(r)).toContain('walk-no-physics');
	});
	it('a walking Character Controller counts as walking', () => {
		const r = validateScene(world({ nodes: [{ id: 'w', type: 'charcontroller', data: { mode: 'walk' } }], dynamicBodies: true }));
		expect(codes(r)).toContain('walk-no-physics');
	});
	it('an all-static walk level is fine (it starts its world on Play by itself)', () => {
		const r = validateScene(world({ play: { grounded: true, spawn: { position: [0, 0, 0], yaw: 0 } }, dynamicBodies: false }));
		expect(codes(r)).not.toContain('walk-no-physics');
	});
	it('sim on Play on = fine', () => {
		const r = validateScene(world({ play: { grounded: true, simOnPlay: true, spawn: { position: [0, 0, 0], yaw: 0 } }, dynamicBodies: true }));
		expect(codes(r)).not.toContain('walk-no-physics');
	});
});
