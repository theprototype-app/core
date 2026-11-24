import { describe, it, expect } from 'vitest';
import { bodyTuningOf, bodyTuningPatch, BODY_TUNING_KEYS } from '../../src/lib/physicsTuning.js';

// 102b row 1: per-object gravity scale + damping. Absent keys must give the pre-102b body exactly.
describe('102b body tuning', () => {
	const scene = { damping: { linear: 0, angular: 0.05 } };
	it('no own keys = gravity 1 and the scene damping (the shipped behaviour)', () => {
		expect(bodyTuningOf(undefined, scene)).toEqual({ gravityScale: 1, linear: 0, angular: 0.05 });
		expect(bodyTuningOf({ mode: 'dynamic', mass: 1 }, scene)).toEqual({ gravityScale: 1, linear: 0, angular: 0.05 });
		expect(bodyTuningOf({}, undefined)).toEqual({ gravityScale: 1, linear: 0, angular: 0 });
	});
	it('own values win, including zero and negative gravity', () => {
		expect(bodyTuningOf({ gravityScale: 0, linearDamping: 2, angularDamping: 0 }, scene)).toEqual({ gravityScale: 0, linear: 2, angular: 0 });
		expect(bodyTuningOf({ gravityScale: -0.5 }, scene).gravityScale).toBe(-0.5);
	});
	it('the patch clamps, keeps null as reset, drops junk', () => {
		expect(bodyTuningPatch({ gravityScale: 99, linearDamping: -1, angularDamping: 'lots' })).toEqual({ gravityScale: 5, linearDamping: 0 });
		expect(bodyTuningPatch({ gravityScale: null })).toEqual({ gravityScale: null });
		expect(bodyTuningPatch({ mass: 3 })).toEqual({});
		expect(bodyTuningPatch(null)).toEqual({});
	});
	it('names exactly three keys', () => expect([...BODY_TUNING_KEYS]).toEqual(['gravityScale', 'linearDamping', 'angularDamping']));
});

import { jointKindOf, jointParamsFor, jointEditPatch, JOINT_KINDS } from '../../src/lib/physicsTuning.js';

describe('102b joint kinds', () => {
	it('maps the words people use onto rapier kinds; weld stays fixed', () => {
		expect(jointKindOf('Ball')).toBe('spherical');
		expect(jointKindOf('slider')).toBe('prismatic');
		expect(jointKindOf('weld')).toBe('fixed');
		expect(jointKindOf('hinge')).toBe('revolute');
		expect(jointKindOf('rope')).toBe('rope');
		expect(jointKindOf('glue')).toBeNull();
		expect(jointKindOf(undefined)).toBeNull();
		expect(JOINT_KINDS.length).toBe(6);
	});
	it('a spring rests and a rope is taut at the current distance by default', () => {
		expect(jointParamsFor('spring', {}, 2.5)).toEqual({ rest: 2.5, stiffness: 50, damping: 2 });
		expect(jointParamsFor('rope', {}, 3)).toEqual({ length: 3 });
		expect(jointParamsFor('rope', { length: 0 }, 3)).toEqual({ length: 0.01 });
		expect(jointParamsFor('spring', { rest: 1, stiffness: 1e9, damping: -1 }, 2)).toEqual({ rest: 1, stiffness: 100000, damping: 0 });
	});
	it('slider limits are metres, ordered, optional', () => {
		expect(jointParamsFor('prismatic', { limits: [-1, 2] }, 0)).toEqual({ limits: [-1, 2] });
		expect(jointParamsFor('prismatic', { limits: [2, -1] }, 0)).toEqual({});
		expect(jointParamsFor('spherical', { limits: [0, 1] }, 0)).toEqual({});
	});
	it('an edit takes only what the kind has', () => {
		const spring = { id: 'j', kind: 'spring', a: 'a', b: 'b', rest: 1, stiffness: 50, damping: 2 };
		expect(jointEditPatch(spring, { stiffness: 80, length: 3 })).toEqual({ ...spring, stiffness: 80 });
		expect(jointEditPatch(spring, { length: 3 })).toBeNull();
		const slider = { id: 's', kind: 'prismatic', axisA: [0, 1, 0], limits: [0, 1] };
		expect(jointEditPatch(slider, { limits: null })).toEqual({ id: 's', kind: 'prismatic', axisA: [0, 1, 0] });
		expect(jointEditPatch(slider, { axis: 'x' })?.axisA).toEqual([1, 0, 0]);
		expect(jointEditPatch({ kind: 'rope', length: 2 }, { contacts: false })).toEqual({ kind: 'rope', length: 2, contacts: false });
		expect(jointEditPatch({ kind: 'rope', length: 2, contacts: false }, { contacts: true })).toEqual({ kind: 'rope', length: 2 });
		expect(jointEditPatch({ kind: 'future' }, { length: 1 })).toBeNull();
		expect(spring.stiffness).toBe(50); // never mutates
	});
});
