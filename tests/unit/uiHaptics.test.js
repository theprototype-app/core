// 103 (H13): the editor's touch feedback with no browser and a FAKE motor — the event -> pattern
// mapping, the levels, the value feel (tick / detent / limit), the rate cap (skipped, not queued),
// every gate (level, kind, touch only, Play / Interact, a recording film take), the old switch's
// migration, and the rule that nothing but the phone actuator calls navigator.vibrate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
	UI_HAPTIC_EVENTS,
	scalePattern,
	valueFeel,
	wholeDetents,
	uiHaptic,
	feelValue,
	uiHapticPrefs,
	setUiHapticPrefs,
	resetUiHapticPrefs,
	setUiHapticsQuiet,
	setUiHapticsClockForTest,
	setUiInputForTest,
	reloadUiHapticPrefsForTest,
	uiHapticsDebug,
	resetUiHapticsDebug
} from '../../src/lib/uiHaptics.js';
import { setPhoneVibrateForTest } from '../../src/lib/hapticPatterns.js';
import { isLocked, editorMode } from '../../src/stores/sceneStore';
import { motionPref } from '../../src/lib/motion.js';
import { safeStorage, debugResetStorage } from '../../src/lib/safeStorage.js';
import { get } from 'svelte/store';

/** @type {(number | number[])[]} */
let motor = [];
let t = 1000;
const advance = (/** @type {number} */ ms) => (t += ms);

beforeEach(() => {
	motor = [];
	t = 1000;
	setPhoneVibrateForTest((p) => (motor.push(p), true));
	setUiHapticsClockForTest(() => t);
	debugResetStorage?.();
	safeStorage.removeItem('ui:touchFeedback');
	safeStorage.removeItem('touchControlsPrefs');
	motionPref.set('full');
	reloadUiHapticPrefsForTest();
	/** @type {any} */ (isLocked).set(null);
	editorMode.set('edit');
	setUiHapticsQuiet('film', false);
	resetUiHapticsDebug();
	setUiInputForTest('touch');
});
afterEach(() => {
	setPhoneVibrateForTest(null);
	setUiHapticsClockForTest(null);
	motionPref.set('system');
});

describe('the mapping (pure)', () => {
	it('every brief event has a pattern; on and off feel different', () => {
		for (const n of ['tick', 'detent', 'limit', 'on', 'off', 'select', 'confirm', 'warn']) expect(UI_HAPTIC_EVENTS[n]?.length).toBeGreaterThan(0);
		expect(UI_HAPTIC_EVENTS.on).not.toEqual(UI_HAPTIC_EVENTS.off);
		// a limit is firmer than a detent, a detent than a tick
		expect(UI_HAPTIC_EVENTS.limit[0]).toBeGreaterThan(UI_HAPTIC_EVENTS.detent[0]);
		expect(UI_HAPTIC_EVENTS.detent[0]).toBeGreaterThan(UI_HAPTIC_EVENTS.tick[0]);
	});
	it('a level scales the ON lengths, never the gaps, floor 8 ms; Off is nothing', () => {
		expect(scalePattern([12], 'medium')).toEqual([12]);
		expect(scalePattern([12], 'strong')).toEqual([18]);
		expect(scalePattern([12], 'light')).toEqual([8]);
		expect(scalePattern([8, 40, 8], 'strong')).toEqual([12, 40, 12]);
		expect(scalePattern([4], 'light')).toEqual([8]);
		expect(scalePattern([12], 'off')).toEqual([]);
	});
	it('value feel: tick, detent on landing or passing, limit once on arrival', () => {
		const o = { min: 0, max: 10, detents: [5] };
		expect(valueFeel(2, 3, o)).toBe('tick');
		expect(valueFeel(4, 5, o)).toBe('detent');
		expect(valueFeel(4, 6, o)).toBe('detent'); // jumped over it
		expect(valueFeel(5, 6, o)).toBe('tick'); // leaving it is a tick
		expect(valueFeel(9, 10, o)).toBe('limit');
		expect(valueFeel(10, 10, o)).toBe(null); // held at the end: silent
		expect(valueFeel(1, 0, o)).toBe('limit'); // the min wins over the 0 detent
		expect(valueFeel(3, 3, o)).toBe(null);
		expect(valueFeel(Number.NaN, 3, o)).toBe(null);
	});
	it('whole numbers crossed on a fractional drag', () => {
		expect(wholeDetents(0.5, 3.2)).toEqual([1, 3]);
		expect(wholeDetents(1.1, 1.4)).toEqual([]);
		expect(valueFeel(0.9, 1.05, { detents: wholeDetents(0.9, 1.05) })).toBe('detent');
		expect(valueFeel(1, 1.05, { detents: wholeDetents(1, 1.05) })).toBe('tick');
	});
});

describe('the service', () => {
	it('plays the level-scaled pattern on the phone motor', () => {
		expect(uiHaptic('on')).toBe(true);
		expect(motor).toEqual([scalePattern(UI_HAPTIC_EVENTS.on, 'light')]);
		setUiHapticPrefs({ level: 'strong' });
		advance(100);
		uiHaptic('on');
		expect(motor[1]).toEqual(scalePattern(UI_HAPTIC_EVENTS.on, 'strong'));
	});
	it('rate cap: ticks closer than 40 ms are SKIPPED, not queued (<= 25 a second)', () => {
		let played = 0;
		for (let i = 0; i < 100; i++) {
			setUiInputForTest('touch'); // the finger keeps moving
			if (uiHaptic('tick')) played++;
			advance(10); // a 100 Hz drag for one second
		}
		expect(played).toBe(25);
		expect(motor.length).toBe(25);
		expect(uiHapticsDebug().skipped.rate).toBe(75);
	});
	it('a detent and a limit are never eaten by the cap', () => {
		uiHaptic('tick');
		advance(5);
		expect(uiHaptic('detent')).toBe(true);
		advance(5);
		expect(uiHaptic('limit')).toBe(true);
	});
	it('feelValue drives a slider drag: ticks, the default detent, ONE limit', () => {
		const o = { min: 0, max: 10, detents: [5] };
		let v = 3;
		for (const next of [4, 5, 6, 7, 8, 9, 10, 10, 10]) {
			advance(50);
			feelValue(v, next, o);
			v = next;
		}
		const names = uiHapticsDebug().calls.map((/** @type {any} */ c) => c.name);
		expect(names).toEqual(['tick', 'detent', 'tick', 'tick', 'tick', 'tick', 'limit']);
	});
});

describe('the gates', () => {
	it('Off and a kind switched off are silent', () => {
		setUiHapticPrefs({ level: 'off' });
		expect(uiHaptic('select')).toBe(false);
		setUiHapticPrefs({ level: 'medium', values: false });
		expect(uiHaptic('tick')).toBe(false);
		expect(uiHaptic('select')).toBe(true); // buttons still on
		expect(uiHaptic('select', { kind: 'gestures' })).toBe(true);
		setUiHapticPrefs({ gestures: false });
		advance(100);
		expect(uiHaptic('select', { kind: 'gestures' })).toBe(false);
	});
	it('only touch (or pen): a mouse and the keyboard are silent; a stale touch too', () => {
		setUiInputForTest('mouse');
		expect(uiHaptic('select')).toBe(false);
		setUiInputForTest('key');
		expect(uiHaptic('select')).toBe(false);
		setUiInputForTest('pen');
		expect(uiHaptic('select')).toBe(true);
		setUiInputForTest('touch');
		advance(2000);
		expect(uiHaptic('select')).toBe(false); // the last touch is long gone (a gamepad drove this)
		expect(uiHaptic('select', { touch: true })).toBe(true); // a long-press timer vouches for it
		expect(uiHapticsDebug().skipped.input).toBe(3);
	});
	it('never in Interact or Play, unless the caller is the on-screen game buttons', () => {
		editorMode.set('interact');
		expect(uiHaptic('select')).toBe(false);
		editorMode.set('edit');
		/** @type {any} */ (isLocked).set(true);
		expect(uiHaptic('select')).toBe(false);
		expect(uiHaptic('select', { play: true })).toBe(true);
	});
	it('silent while a film take records; film\'s own fixed buzz still plays', () => {
		setUiHapticsQuiet('film', true);
		expect(uiHaptic('tick')).toBe(false);
		expect(uiHaptic('select', { touch: true, play: true, pattern: [15] })).toBe(true);
		expect(motor).toEqual([[15]]);
		setUiHapticsQuiet('film', false);
		advance(100);
		expect(uiHaptic('tick')).toBe(true);
	});
	it('film\'s fixed buzz obeys Off, not the kind switches', () => {
		setUiHapticPrefs({ buttons: false });
		expect(uiHaptic('select', { touch: true, play: true, pattern: [80] })).toBe(true);
		setUiHapticPrefs({ level: 'off' });
		expect(uiHaptic('select', { touch: true, play: true, pattern: [80] })).toBe(false);
	});
});

describe('the setting', () => {
	it('defaults to Light, Off under reduced motion (until chosen)', () => {
		expect(get(uiHapticPrefs).level).toBe('light');
		motionPref.set('reduce');
		expect(get(uiHapticPrefs).level).toBe('off');
		setUiHapticPrefs({ level: 'medium' });
		motionPref.set('full');
		motionPref.set('reduce');
		expect(get(uiHapticPrefs).level).toBe('medium'); // a choice sticks
	});
	it('migrates the old Haptic tick: on -> Light, off -> Off', () => {
		safeStorage.setItem('touchControlsPrefs', JSON.stringify({ visibility: 'auto', showInEdit: false, haptics: false, scope: 'game' }));
		reloadUiHapticPrefsForTest();
		expect(get(uiHapticPrefs).level).toBe('off');
		safeStorage.setItem('touchControlsPrefs', JSON.stringify({ haptics: true }));
		motionPref.set('reduce');
		reloadUiHapticPrefsForTest();
		expect(get(uiHapticPrefs).level).toBe('light');
	});
	it('stores its own key; the category reset writes the default, not a second migration', () => {
		safeStorage.setItem('touchControlsPrefs', JSON.stringify({ haptics: false }));
		reloadUiHapticPrefsForTest();
		setUiHapticPrefs({ level: 'strong', snap: false });
		expect(JSON.parse(safeStorage.getItem('ui:touchFeedback') || '{}')).toMatchObject({ level: 'strong', snap: false });
		resetUiHapticPrefs();
		expect(safeStorage.getItem('ui:touchFeedback')).toBe('{}');
		reloadUiHapticPrefsForTest();
		expect(get(uiHapticPrefs)).toEqual({ level: 'light', buttons: true, values: true, snap: true, gestures: true });
	});
});

describe('one actuator', () => {
	it('nothing in src/ calls navigator.vibrate but hapticPatterns.phoneVibrate', () => {
		const root = path.resolve(__dirname, '../../src');
		/** @type {string[]} */
		const offenders = [];
		const walk = (/** @type {string} */ dir) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) walk(p);
				else if (/\.(js|ts|svelte)$/.test(e.name) && !p.endsWith(path.join('lib', 'hapticPatterns.js'))) {
					const lines = fs.readFileSync(p, 'utf8').split('\n');
					lines.forEach((l, i) => {
						if (/navigator\s*\.\s*vibrate\s*(\?\.)?\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)) offenders.push(path.relative(root, p) + ':' + (i + 1));
					});
				}
			}
		};
		walk(root);
		expect(offenders).toEqual([]);
	});
});

describe('snapping', () => {
	it('feelSnap: the first call is the baseline, each CHANGE is one snap detent, null is silent', async () => {
		const { feelSnap } = await import('../../src/lib/uiHaptics.js');
		const g = {};
		expect(feelSnap(g, 0.5)).toBe(false);
		expect(feelSnap(g, 0.5)).toBe(false);
		expect(feelSnap(g, 1)).toBe(true);
		expect(feelSnap(g, null)).toBe(false);
		expect(feelSnap(g, 1)).toBe(true);
		setUiHapticPrefs({ snap: false });
		expect(feelSnap(g, 2)).toBe(false);
		expect(uiHapticsDebug().calls.every((/** @type {any} */ c) => c.kind === 'snap' && c.name === 'detent')).toBe(true);
	});
});
