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
