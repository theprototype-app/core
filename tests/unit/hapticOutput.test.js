// 103 (H6): the vibration output layer with no browser and no motor — the pattern -> actuator
// mapping (pure, over a described device), the gate (Edit / switched off / paused / reduced
// motion), the strength setting, stopping part-way, and the Vibrate node's / game-feel mappings.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { planHaptic, padMagnitudes, vibratePattern, scheduleFor, playHaptic, stopHaptics, setHapticEnvForTest, hapticOutputDebug, resetHapticOutputDebug } from '../../src/lib/hapticOutput.js';
import { hapticSchedule, customHapticSchedule, registerXrHaptics } from '../../src/lib/hapticPatterns.js';
import { setGameSetting, debugResetGameSettings, hapticLevel, hapticsAllowed, coreValuesFrom } from '../../src/lib/gameSettings.js';
import { feelVibration } from '../../src/lib/gameFeelActions.js';
import { isLocked, editorMode } from '../../src/stores/sceneStore';
import { gameState } from '../../src/lib/gameState.js';
import { motionPref } from '../../src/lib/motion.js';
import { safeStorage, debugResetStorage } from '../../src/lib/safeStorage.js';

/** isLocked is typed by its null start; it is three-state (null / true / false) */
const lock = (/** @type {any} */ v) => /** @type {any} */ (isLocked).set(v);

const PAD = { index: 0, effects: ['dual-rumble'], pulse: false };
const XBOX = { index: 1, effects: ['dual-rumble', 'trigger-rumble'], pulse: false };
const FIREFOX = { index: 2, effects: [], pulse: true };
const NONE = { xr: false, pads: [], vibrate: false };

describe('the mapping (pure)', () => {
	it('a pad gets one dual-rumble per pulse, timed like the pattern', () => {
		const calls = planHaptic(hapticSchedule('hit'), { xr: false, pads: [PAD], vibrate: true });
		expect(calls.map((c) => [c.out, c.at])).toEqual([
			['pad', 0],
			['pad', 55]
		]);
		const first = /** @type {any} */ (calls[0]);
		expect(first.effect).toBe('dual-rumble');
		expect(first.params).toEqual({ duration: 35, startDelay: 0, strongMagnitude: 0.85, weakMagnitude: 0.85 });
	});

	it('a light tap is mostly the weak motor; a hand picks one side', () => {
		expect(padMagnitudes(0.2, undefined, false)).toEqual({ strongMagnitude: 0.1, weakMagnitude: 0.2 });
		expect(padMagnitudes(0.8, 'left', false)).toEqual({ strongMagnitude: 0.8, weakMagnitude: 0 });
		expect(padMagnitudes(0.8, 'right', false)).toEqual({ strongMagnitude: 0, weakMagnitude: 0.8 });
	});

	it('trigger rumble where the pad lists it, only for firm pulses, on the hand that asked', () => {
		const calls = /** @type {any[]} */ (planHaptic(hapticSchedule('rumble'), { xr: false, pads: [XBOX], vibrate: false }));
		expect(calls.every((c) => c.effect === 'trigger-rumble')).toBe(true);
		expect(calls[0].params.leftTrigger).toBe(0.5);
		expect(calls[0].params.rightTrigger).toBe(0.5);
		expect(calls[3].params.leftTrigger).toBe(0); // 0.28: too light for a trigger
		expect(padMagnitudes(1, 'left', true)).toMatchObject({ leftTrigger: 0.5, rightTrigger: 0 });
		expect(padMagnitudes(1, 'right', true)).toMatchObject({ leftTrigger: 0, rightTrigger: 0.5 });
	});

	it("Firefox's pulse actuator as the fallback", () => {
		const calls = planHaptic(hapticSchedule('bump'), { xr: false, pads: [FIREFOX], vibrate: true });
		expect(calls).toEqual([{ at: 0, out: 'padpulse', pad: 2, intensity: 0.45, ms: 28 }]);
	});

	it('every connected pad buzzes; the phone only when no pad took it', () => {
		const both = planHaptic(hapticSchedule('tap'), { xr: false, pads: [PAD, XBOX], vibrate: true });
		expect(both.map((c) => c.out)).toEqual(['pad', 'pad']);
		const phone = planHaptic(hapticSchedule('tap'), { xr: false, pads: [{ index: 0, effects: [], pulse: false }], vibrate: true });
		expect(phone.map((c) => c.out)).toEqual(['vibrate']);
	});

	it('in a headset only the XR controllers buzz (no second, wrong buzz)', () => {
		const calls = planHaptic(hapticSchedule('success'), { xr: true, pads: [PAD], vibrate: true }, 'left');
		expect(calls.map((c) => c.out)).toEqual(['xr', 'xr', 'xr']);
		expect(/** @type {any} */ (calls[0]).hand).toBe('left');
	});

	it('nothing there (iOS): no calls at all', () => {
		expect(planHaptic(hapticSchedule('rumble'), NONE)).toEqual([]);
	});

	it('a phone pattern turns strength into length, keeps the gaps, never under 10 ms', () => {
		// success: 0.3/40 @0, 0.5/40 @90, 0.8/70 @180
		expect(vibratePattern(hapticSchedule('success'))).toEqual([23, 67, 28, 62, 62]);
		expect(vibratePattern(hapticSchedule('tap'))).toEqual([10]);
		// a pulse that would run into the next is cut where the next starts
		expect(vibratePattern([{ at: 0, intensity: 1, ms: 300 }, { at: 100, intensity: 1, ms: 50 }])).toEqual([100, 0, 50]);
		// a first pulse that starts late begins with a silent gap
		expect(vibratePattern([{ at: 40, intensity: 1, ms: 50 }])).toEqual([0, 40, 50]);
	});

	it('a custom buzz is one pulse, clamped; a pattern is scaled', () => {
		expect(customHapticSchedule(0.7, 250)).toEqual([{ at: 0, intensity: 0.7, ms: 250 }]);
		expect(customHapticSchedule(3, 5000)).toEqual([{ at: 0, intensity: 1, ms: 1000 }]);
		expect(customHapticSchedule(0, 100)).toEqual([]);
		expect(scheduleFor({ strength: 0.5, ms: 100 }, 0.5)).toEqual([{ at: 0, intensity: 0.25, ms: 100 }]);
		expect(scheduleFor('bump', 0.5)[0].intensity).toBeCloseTo(0.225);
		expect(scheduleFor('nope')).toEqual([]);
	});

	it('the default feel that goes with the game-feel nodes, and its off switch', () => {
		expect(feelVibration('camerashake', { strength: 0.15, seconds: 0.35 })).toEqual({ spec: { strength: 0.545, ms: 350 } });
		expect(feelVibration('hitpause', { ms: 80 })).toEqual({ spec: 'hit', scale: 0.7 });
		expect(feelVibration('screenflash', { strength: 0.6 })).toEqual({ spec: 'tap', scale: 1.6 });
		expect(feelVibration('camerashake', { vibrate: false })).toBe(null);
		expect(feelVibration('announce', {})).toBe(null);
	});
});

describe('the runtime (fake device)', () => {
	beforeEach(() => {
		for (const key of safeStorage.keys()) safeStorage.removeItem(key);
		debugResetStorage();
		debugResetGameSettings();
		motionPref.set('full');
		lock(true);
		editorMode.set('edit');
		gameState.update((s) => ({ ...s, state: 'playing' }));
		setHapticEnvForTest({ xr: false, pads: [PAD], vibrate: true });
		resetHapticOutputDebug();
		vi.useFakeTimers();
	});
	afterEach(() => {
		stopHaptics('test');
		vi.useRealTimers();
		setHapticEnvForTest(null);
		lock(null);
		gameState.update((s) => ({ ...s, state: 'menu' }));
	});

	it('plays in Play, schedules the later pulses, records each call', () => {
		expect(playHaptic('hit')).toBe(true);
		expect(hapticOutputDebug().calls.length).toBe(1);
		vi.advanceTimersByTime(60);
		expect(hapticOutputDebug().calls.length).toBe(2);
	});

	it('silent in Edit (the existing gate); Interact plays', () => {
		lock(null);
		expect(playHaptic('bump')).toBe(false);
		expect(hapticOutputDebug().calls.length).toBe(0);
		editorMode.set('interact');
		expect(playHaptic('bump')).toBe(true);
	});

	it('the player switch and the strength setting', () => {
		setGameSetting('hapticStrength', 50);
		expect(hapticLevel()).toBe(0.5);
		playHaptic('bump');
		expect(/** @type {any} */ (hapticOutputDebug().calls[0]).params.weakMagnitude).toBeCloseTo(0.225);
		setGameSetting('haptics', false);
		expect(hapticLevel()).toBe(0);
		expect(playHaptic('bump')).toBe(false);
	});

	it('stops part-way: leaving Play, a pause, an explicit stop', () => {
		playHaptic('rumble');
		expect(hapticOutputDebug().pending).toBe(3);
		lock(false); // the exit transient: not playing
		expect(hapticOutputDebug().pending).toBe(0);
		expect(hapticOutputDebug().lastStop).toBe('left-game');
		lock(true);
		playHaptic('rumble');
		gameState.update((s) => ({ ...s, state: 'paused' }));
		expect(hapticOutputDebug().pending).toBe(0);
		expect(hapticOutputDebug().lastStop).toBe('paused');
		vi.advanceTimersByTime(1000);
		expect(hapticOutputDebug().calls.length).toBe(2); // the two first pulses only
		expect(playHaptic('bump')).toBe(false); // paused: nothing new either
	});

	it('reduced motion = off by default; a stored choice wins', () => {
		motionPref.set('reduce');
		expect(coreValuesFrom({}).haptics).toBe(false);
		expect(coreValuesFrom({ haptics: true }).haptics).toBe(true);
		motionPref.set('full');
		expect(coreValuesFrom({}).haptics).toBe(true);
		expect(hapticsAllowed()).toBe(true);
	});

	it('the XR sink takes the pulses in a headset', () => {
		const seen = /** @type {any[]} */ ([]);
		registerXrHaptics({ active: () => true, pulse: (i, ms, hand) => seen.push([i, ms, hand]) });
		setHapticEnvForTest(null); // read the "browser": the sink says a session runs
		playHaptic('bump', { hand: 'right' });
		expect(seen).toEqual([[0.45, 28, 'right']]);
		registerXrHaptics(null);
	});
});
