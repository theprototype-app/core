import { describe, it, expect } from 'vitest';
import { finishTier, capsFor, cappedSteps, sunScreen, FINISH_KINDS } from '../../src/lib/post/finishCore.js';
import { registerPostEffect, planPostStack, stackCounts } from '../../src/lib/scenePost.js';

// the registry contract the finish effects declare (postEffects.js needs GL to import; the
// planner only needs `isPass`, which is what this mirrors)
for (const kind of FINISH_KINDS) registerPostEffect(kind, { label: kind, group: 'camera', isPass: true, params: [], make: () => null });
registerPostEffect('vignette', { label: 'Vignette', group: 'camera', params: [], make: () => null });

describe('98 P4 finish tiers', () => {
	it('picks quest / phone / pc', () => {
		expect(finishTier({ headset: true, phone: true })).toBe('quest');
		expect(finishTier({ presenting: true })).toBe('quest');
		expect(finishTier({ phone: true })).toBe('phone');
		expect(finishTier({})).toBe('pc');
	});
	it('caps the fog and god-ray march on a phone, none in a headset', () => {
		expect(cappedSteps(24, capsFor('phone').fogSteps)).toBe(8);
		expect(cappedSteps(24, capsFor('pc').fogSteps)).toBe(24);
		expect(cappedSteps(64, capsFor('pc').raySamples)).toBe(48);
		expect(cappedSteps(48, capsFor('quest').raySamples)).toBe(0);
		expect(cappedSteps(3, capsFor('phone').fogSteps)).toBe(3);
	});
});

describe('98 P4 sun on screen', () => {
	// identity view-projection: world xy maps straight to clip xy, w = 1 everywhere
	const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
	// a projection whose w = -z (camera looks down -z)
	const persp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0];
	it('puts a sun straight ahead in the middle', () => {
		const at = sunScreen([0, 0, -1], [0, 0, 0], persp);
		expect(at.visible).toBe(true);
		expect(at.x).toBeCloseTo(0.5);
		expect(at.y).toBeCloseTo(0.5);
		expect(at.fade).toBe(1);
	});
	it('a sun behind the camera is not visible', () => {
		expect(sunScreen([0, 0, 1], [0, 0, 0], persp).visible).toBe(false);
	});
	it('fades out off screen', () => {
		const at = sunScreen([0.9, 0, -0.3], [0, 0, 0], persp);
		expect(at.x).toBeGreaterThan(1);
		expect(at.fade).toBeLessThan(1);
		expect(sunScreen([1, 0, 0], [0, 0, 0], identity).visible).toBe(true);
	});
});

describe('98 P4 off = no pass in the stack', () => {
	it('a finish effect present but disabled builds no pass', () => {
		const stack = { enabled: true, changedAt: 1, effects: FINISH_KINDS.map((kind, i) => ({ id: 'f' + i, kind, enabled: false, params: {} })) };
		expect(stackCounts(stack).passes).toBe(0);
	});
	it('each enabled finish effect is its own pass and breaks a merge run', () => {
		const entries = [
			{ id: 'a', kind: 'vignette', enabled: true, params: {} },
			{ id: 'b', kind: 'godrays', enabled: true, params: {} },
			{ id: 'c', kind: 'vignette', enabled: true, params: {} }
		];
		expect(planPostStack(entries).passCount).toBe(3);
	});
});
