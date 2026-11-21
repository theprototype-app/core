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
