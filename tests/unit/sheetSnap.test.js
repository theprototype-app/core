import { describe, it, expect } from 'vitest';
import { detentHeights, snapDetent, stepDetent, FLICK_VELOCITY } from '../../src/lib/ui/sheetSnap.js';

// 38 R3: the mobile Sheet's resting place. A slow release goes to the NEAREST detent, a
// flick goes one detent in its direction (even when another is nearer), and below the
// lowest detent a sheet closes — unless it is not dismissible.
describe('sheetSnap', () => {
	const heights = detentHeights(844); // the 390x844 phone the redesign is shot at
	const all = ['peek', 'half', 'full'];

	it('detent heights for a 844px phone', () => {
		expect(heights).toEqual({ peek: 148, half: 422, full: 796 });
		const tiny = detentHeights(200);
		expect(tiny.peek).toBeLessThanOrEqual(tiny.half);
		expect(tiny.half).toBeLessThanOrEqual(tiny.full);
	});

	it('a slow release settles on the nearest detent', () => {
		expect(snapDetent({ height: 400, velocity: 0, heights, detents: all })).toBe('half');
		expect(snapDetent({ height: 700, velocity: 0.1, heights, detents: all })).toBe('full');
		expect(snapDetent({ height: 200, velocity: -0.1, heights, detents: all })).toBe('peek');
	});

	it('a flick moves one detent in its direction, past a nearer one', () => {
		const fast = FLICK_VELOCITY + 0.3;
		// released just under full but flicked DOWN: half, not full
		expect(snapDetent({ height: 780, velocity: fast, heights, detents: all })).toBe('half');
		// released just above peek, flicked UP: half
		expect(snapDetent({ height: 160, velocity: -fast, heights, detents: all })).toBe('half');
		// flicked up from above the top: stays full
		expect(snapDetent({ height: 796, velocity: -fast, heights, detents: all })).toBe('full');
	});

	it('dismisses below the lowest detent; never when not dismissible', () => {
		expect(snapDetent({ height: 40, velocity: 0, heights, detents: all })).toBe('closed');
		expect(snapDetent({ height: 120, velocity: 1.2, heights, detents: all })).toBe('closed');
		expect(snapDetent({ height: 40, velocity: 0, heights, detents: all, dismissible: false })).toBe('peek');
		expect(snapDetent({ height: 120, velocity: 1.2, heights, detents: all, dismissible: false })).toBe('peek');
	});

	it('a sheet limited to some detents only uses those', () => {
		expect(snapDetent({ height: 300, velocity: 0, heights, detents: ['half', 'full'] })).toBe('half');
		expect(snapDetent({ height: 120, velocity: 0, heights, detents: ['half', 'full'] })).toBe('closed');
	});

	it('stepDetent: keyboard / handle tap', () => {
		expect(stepDetent('peek', 1, all, heights)).toBe('half');
		expect(stepDetent('full', 1, all, heights)).toBe('full');
		expect(stepDetent('half', -1, all, heights)).toBe('peek');
		expect(stepDetent('peek', -1, all, heights)).toBe('closed');
		expect(stepDetent('peek', -1, all, heights, false)).toBe('peek');
	});
});

// 40 F1: a FREE-HEIGHT phone sheet (the Inspector, the menus, the dock …) rests where the finger
// left it, snaps onto its min / max near them, and closes when swiped down to the end.
import { settleSheet, phoneSheetMax, SNAP_PX } from '../../src/lib/ui/sheetSnap.js';
describe('settleSheet (40 F1)', () => {
	const g = { min: 180, max: 640 };
	it('a slow release stays where it is, clamped, and snaps onto the ends', () => {
		expect(settleSheet({ ...g, height: 400, velocity: 0 })).toBe(400);
		expect(settleSheet({ ...g, height: 640 - SNAP_PX + 4, velocity: 0 })).toBe(640);
		expect(settleSheet({ ...g, height: 180 + SNAP_PX - 4, velocity: 0 })).toBe(180);
		expect(settleSheet({ ...g, height: 900, velocity: 0 })).toBe(640);
	});
	it('swiped down to the end closes; a dismissible:false sheet rests on its min', () => {
		expect(settleSheet({ ...g, height: 40, velocity: 0.1 })).toBe('closed');
		expect(settleSheet({ ...g, height: 0, velocity: 0 })).toBe('closed');
		expect(settleSheet({ ...g, height: 40, velocity: 0.1, dismissible: false })).toBe(180);
	});
	it('a flick down from the min closes, from higher up it goes to the min; a flick up -> max', () => {
		expect(settleSheet({ ...g, height: 190, velocity: FLICK_VELOCITY + 0.4 })).toBe('closed');
		expect(settleSheet({ ...g, height: 500, velocity: FLICK_VELOCITY + 0.4 })).toBe(180);
		expect(settleSheet({ ...g, height: 300, velocity: -(FLICK_VELOCITY + 0.4) })).toBe(640);
	});
	it('the phone sheet room keeps the top bar and the selection strip clear', () => {
		expect(phoneSheetMax(844)).toBe(844 - 76 - 64);
		expect(phoneSheetMax(844, { stripH: 60 })).toBe(844 - 76 - 64 - 60);
		expect(phoneSheetMax(200)).toBe(160);
	});
});
