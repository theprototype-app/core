// @ts-nocheck — plain fixtures
// 102b-hud (row 19): camera shake / screen flash / hit pause, on the real leaf. Only in Play (shake)
// or Play + Interact (flash, pause); reduced motion scales shake and flash down; the shake is taken
// back off the camera after the draw.
import { describe, it, expect, beforeEach } from 'vitest';
import { isLocked, editorMode } from '../../src/stores/sceneStore';
import { motionPref } from '../../src/lib/motion';
import { cameraShake, shakeOffset, applyShake, hitPause, frameHeldByHitPause, gameFeelFxDebug, resetGameFeelFx } from '../../src/lib/gameFeelFx.js';

const cam = () => ({ position: { x: 1, y: 2, z: 3, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }, rotation: { x: 0.1, y: 0, z: 0 } });

beforeEach(() => {
	resetGameFeelFx();
	isLocked.set(null);
	editorMode.set('edit');
	motionPref.set('full');
});

describe('camera shake', () => {
	it('refused outside Play, starts in Play, fades to nothing', () => {
		expect(cameraShake()).toBe(false);
		isLocked.set(true);
		expect(cameraShake({ strength: 0.5, seconds: 0.2 })).toBe(true);
		const t0 = performance.now();
		expect(shakeOffset(t0 + 10)).not.toBe(null);
		expect(shakeOffset(t0 + 1000)).toBe(null);
	});
	it('applyShake moves the camera for one draw and puts it back; never in XR', () => {
		isLocked.set(true);
		cameraShake({ strength: 1, seconds: 1 });
		const c = cam();
		expect(applyShake(c, true)).toBe(null);
		const undo = applyShake(c, false);
		expect(undo).toBeTypeOf('function');
		const moved = c.position.x !== 1 || c.position.y !== 2 || c.position.z !== 3;
		expect(moved).toBe(true);
		undo();
		expect([c.position.x, c.position.y, c.position.z, c.rotation.x, c.rotation.z]).toEqual([1, 2, 3, 0.1, 0]);
	});
	it('reduced motion: a quarter of the strength', () => {
		isLocked.set(true);
		motionPref.set('reduce');
		cameraShake({ strength: 0.8 });
		expect(gameFeelFxDebug().lastShake.strength).toBeCloseTo(0.2);
	});
});

describe('hit pause', () => {
	it('holds frames in Interact or Play for the given time', () => {
		expect(hitPause(100)).toBe(false);
		editorMode.set('interact');
		expect(hitPause(100)).toBe(true);
		expect(frameHeldByHitPause()).toBe(true);
	});
});
