// 57 M3 — Blend by Speed: the 1D blend space, the easing, and the auto clip pick.
import { describe, it, expect } from 'vitest';
import { blendSpeedWeights, smoothWeights, clipForSlot, IDLE_SPEED } from '../../src/lib/tpanim/blendSpeed.js';

const sum = (/** @type {any} */ w) => w.idle + w.walk + w.run;

describe('blendSpeedWeights', () => {
	it('stands still, walks, runs — and always sums to one', () => {
		expect(blendSpeedWeights(0).weights).toEqual({ idle: 1, walk: 0, run: 0 });
		expect(blendSpeedWeights(IDLE_SPEED / 2).weights.idle).toBe(1);
		const mid = blendSpeedWeights(0.8).weights;
		expect(mid.idle).toBeGreaterThan(0);
		expect(mid.walk).toBeGreaterThan(0);
		expect(blendSpeedWeights(1.4).weights.walk).toBe(1);
		const jog = blendSpeedWeights(2.4).weights;
		expect(jog.walk).toBeGreaterThan(0);
		expect(jog.run).toBeGreaterThan(0);
		expect(blendSpeedWeights(9).weights.run).toBe(1);
		for (const s of [0, 0.3, 1, 1.4, 2, 3, 3.5, 6]) expect(sum(blendSpeedWeights(s).weights)).toBeCloseTo(1, 9);
	});

	it('is CONTINUOUS in speed (no snap anywhere along the ramp)', () => {
		let prev = blendSpeedWeights(0).weights;
		for (let s = 0.01; s < 5; s += 0.01) {
			const w = blendSpeedWeights(s).weights;
			expect(Math.abs(w.idle - prev.idle) + Math.abs(w.walk - prev.walk) + Math.abs(w.run - prev.run)).toBeLessThan(0.05);
			prev = w;
		}
	});

	it('plays walk and run at a pace that matches the speed, within limits', () => {
		expect(blendSpeedWeights(1.4).rates.walk).toBeCloseTo(1, 9);
		expect(blendSpeedWeights(1.8).rates.walk).toBeGreaterThan(1);
		expect(blendSpeedWeights(30).rates.run).toBeLessThanOrEqual(1.6);
		expect(blendSpeedWeights(0.2).rates.walk).toBeGreaterThanOrEqual(0.6);
	});

	it('hands a missing slot to its neighbour', () => {
		const noRun = blendSpeedWeights(6, { run: false }).weights;
		expect(noRun).toEqual({ idle: 0, walk: 1, run: 0 });
		const noWalk = blendSpeedWeights(1.2, { walk: false }).weights;
		expect(noWalk.walk).toBe(0);
		expect(sum(noWalk)).toBeCloseTo(1, 9);
		const noIdle = blendSpeedWeights(0, { idle: false }).weights;
		expect(noIdle.idle).toBe(0);
		expect(noIdle.walk).toBe(1);
	});
});

describe('smoothWeights', () => {
	it('eases 95% of the way in the crossfade time, and snaps at 0', () => {
		const cur = { idle: 1, walk: 0 };
		const target = { idle: 0, walk: 1 };
		/** @type {Record<string, number>} */
		let w = cur;
		for (let i = 0; i < 25; i++) w = smoothWeights(w, target, 0.01, 0.25);
		expect(w.walk).toBeGreaterThan(0.94);
		expect(w.walk).toBeLessThan(0.96);
		expect(smoothWeights(cur, target, 0.01, 0)).toEqual(target);
		// one frame never jumps more than a frame's share
		expect(smoothWeights(cur, target, 1 / 60, 0.25).walk).toBeLessThan(0.2);
	});
});

describe('clipForSlot', () => {
	const kaykit = ['Cheer', 'Idle', 'Running_A', 'Running_Strafe_Left', 'Walking_A', 'Walking_Backwards'];
	it('picks by name when the node names none', () => {
		expect(clipForSlot(kaykit, 'idle')).toBe('Idle');
		expect(clipForSlot(kaykit, 'walk')).toBe('Walking_A');
		expect(clipForSlot(kaykit, 'run')).toBe('Running_A');
		expect(clipForSlot(['Jump'], 'run')).toBe('');
	});
	it('uses the named clip when the model has it, else none', () => {
		expect(clipForSlot(kaykit, 'walk', 'Walking_Backwards')).toBe('Walking_Backwards');
		expect(clipForSlot(kaykit, 'walk', 'Nope')).toBe('');
	});
});
