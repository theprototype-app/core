// panel-gestures item 7: the tab-strip touch model's pure half — axis lock, long-press lift, the
// slop re-check when the timer fires (98-int's fieldMenu trap), drop / menu / tap on release.
import { describe, it, expect } from 'vitest';
import { createTabGesture, axisOf, outsideBy, AXIS_PX, LIFT_MS, MENU_MS, TEAR_PX } from '../../src/lib/ui/tabTouch.js';

describe('constants', () => {
	it('match the brief: 8 px lock, 350 ms lift, 48 px tear-off, the menu after the lift', () => {
		expect(AXIS_PX).toBe(8);
		expect(LIFT_MS).toBe(350);
		expect(TEAR_PX).toBe(48);
		expect(MENU_MS).toBeGreaterThan(LIFT_MS);
	});
});

describe('axisOf', () => {
	it('is null under the lock distance', () => {
		expect(axisOf(5, 5)).toBeNull();
		expect(axisOf(0, 7.9)).toBeNull();
	});
	it('locks to the larger component; a 45° tie scrolls', () => {
		expect(axisOf(9, 2)).toBe('x');
		expect(axisOf(-2, 9)).toBe('y');
		expect(axisOf(7, 7)).toBe('x');
	});
});

describe('outsideBy', () => {
	const r = { left: 100, top: 50, right: 300, bottom: 80 };
	it('is false inside and within the margin', () => {
		expect(outsideBy(r, 200, 60)).toBe(false);
		expect(outsideBy(r, 200, 80 + 47)).toBe(false);
		expect(outsideBy(r, 100 - 48, 60)).toBe(false);
	});
	it('is true past the margin on any side', () => {
		expect(outsideBy(r, 200, 80 + 49)).toBe(true);
		expect(outsideBy(r, 200, 50 - 49)).toBe(true);
		expect(outsideBy(r, 300 + 49, 60)).toBe(true);
	});
});

describe('createTabGesture', () => {
	it('a quick tap stays a tap (the click switches tabs)', () => {
		const g = createTabGesture();
		g.down(1, 10, 10);
		expect(g.move(1, 12, 11)).toBe('wait');
		expect(g.up(1)).toBe('tap');
		expect(g.phase).toBe('idle');
	});
	it('a sideways swipe locks to scroll and never lifts, drags or opens a menu', () => {
		const g = createTabGesture();
		g.down(1, 10, 10);
		expect(g.move(1, 22, 12)).toBe('scroll');
		expect(g.lift()).toBe(false);
		expect(g.move(1, 80, 12)).toBe('ignore');
		expect(g.owns()).toBe(false);
		expect(g.up(1)).toBe('none');
	});
	it('a vertical drag locks to nothing', () => {
		const g = createTabGesture();
		g.down(1, 10, 10);
		expect(g.move(1, 11, 30)).toBe('vertical');
		expect(g.lift()).toBe(false);
		expect(g.move(1, 11, 200)).toBe('ignore');
		expect(g.up(1)).toBe('none');
	});
	it('the lift timer re-checks the slop with the last position it saw', () => {
		const g = createTabGesture();
		g.down(1, 10, 10);
		// travel the browser reported without our move handler locking an axis (a pre-lock read)
		g.move(1, 15, 10);
		expect(g.lift()).toBe(true);
		const h = createTabGesture();
		h.down(1, 10, 10);
		h.move(1, 30, 10); // locked to scroll
		expect(h.lift()).toBe(false);
	});
	it('long-press then travel drags; the release drops', () => {
		const g = createTabGesture();
		g.down(7, 10, 10);
		expect(g.lift()).toBe(true);
		expect(g.owns()).toBe(true);
		expect(g.move(7, 12, 12)).toBe('hold'); // a lifted finger's wobble is not a drag
		expect(g.move(7, 10, 40)).toBe('drag-start'); // any axis once lifted
		expect(g.move(7, 10, 90)).toBe('drag');
		expect(g.menuDue()).toBe(false); // moving cancels the menu
		expect(g.up(7)).toBe('drop');
	});
	it('long-press held still opens the menu at MENU_MS; let go early opens it on release', () => {
		const g = createTabGesture();
		g.down(1, 10, 10);
		g.lift();
		expect(g.menuDue()).toBe(true);
		expect(g.phase).toBe('menu');
		expect(g.move(1, 10, 60)).toBe('ignore'); // the menu owns the rest of the gesture
		expect(g.up(1)).toBe('none');
		const h = createTabGesture();
		h.down(1, 10, 10);
		h.lift();
		expect(h.up(1)).toBe('menu');
	});
	it('another pointer is ignored; a cancel reports whether a lifted tab must be put back', () => {
		const g = createTabGesture();
		g.down(1, 10, 10);
		expect(g.move(2, 90, 90)).toBe('ignore');
		expect(g.up(2)).toBe('ignore');
		expect(g.cancel()).toBe(false);
		g.down(1, 10, 10);
		g.lift();
		g.move(1, 10, 60);
		expect(g.cancel()).toBe(true);
		expect(g.phase).toBe('idle');
	});
});
