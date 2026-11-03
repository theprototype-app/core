// @ts-nocheck — fixture boxes from footprint helpers that return Box | null by contract
// 94 SP6 — the play HUD's top safe area (src/lib/play/hudSafeArea.js)
import { describe, it, expect } from 'vitest';
import { hudTopShift, topFootprint, overlaps, bottomFootprint, hudBottomLift } from '../../src/lib/play/hudSafeArea.js';

// N6 folded: 390 x 844. The play chrome row: exit ✕ top-left, Playing chip top-centre, Menu pill top-right.
const VW = 390;
const VH = 844;
const ROW = [
	{ left: 12, top: 12, right: 56, bottom: 56 }, // #play-exit
	{ left: 150, top: 12, right: 240, bottom: 44 }, // #play-banner
	{ left: 262, top: 16, right: 374, bottom: 50 } // #game-shell-menu-button
];

describe('topFootprint', () => {
	it('places top-left / top-center / top-right from the authored pixels', () => {
		expect(topFootprint({ anchor: 'top-left', x: 10, y: 4, w: 100, h: 20 }, VW)).toEqual({ left: 10, top: 4, right: 110, bottom: 24 });
		expect(topFootprint({ anchor: 'top-right', x: 10, y: 4, w: 100, h: 20 }, VW)).toEqual({ left: 280, top: 4, right: 380, bottom: 24 });
		expect(topFootprint({ anchor: 'top-center', x: 0, y: 0, w: 200, h: 40 }, VW)).toEqual({ left: 95, top: 0, right: 295, bottom: 40 });
	});
	it('ignores every other anchor', () => {
		expect(topFootprint({ anchor: 'center', w: 10, h: 10 }, VW)).toBeNull();
		expect(topFootprint({ anchor: 'bottom-left', w: 10, h: 10 }, VW)).toBeNull();
		expect(topFootprint({ anchor: 'middle-right', w: 10, h: 10 }, VW)).toBeNull();
	});
	it('grows with the player HUD text size', () => {
		expect(topFootprint({ anchor: 'top-left', x: 0, y: 0, w: 100, h: 20 }, VW, 1.5)).toEqual({ left: 0, top: 0, right: 150, bottom: 30 });
	});
});

describe('hudTopShift', () => {
	it('Sky Run at 390 px: the title + timer band moves below the chrome row', () => {
		const band = topFootprint({ anchor: 'top-center', x: 0, y: 0, w: 390, h: 92 }, VW);
		const title = topFootprint({ anchor: 'top-center', x: 0, y: 8, w: 300, h: 30 }, VW);
		const shift = hudTopShift([band, title], ROW, VH);
		expect(shift).toBe(56 + 6);
		// after the shift nothing touches the row
		for (const s of [band, title]) for (const c of ROW) expect(overlaps({ ...s, top: s.top + shift, bottom: s.bottom + shift }, c)).toBe(false);
	});
	it('nothing collides: nothing moves (a desktop window keeps its layout)', () => {
		const score = topFootprint({ anchor: 'top-left', x: 80, y: 70, w: 120, h: 24 }, 1280);
		expect(hudTopShift([score], ROW, 800)).toBe(0);
		expect(hudTopShift([], ROW, VH)).toBe(0);
		expect(hudTopShift([score], [], VH)).toBe(0);
	});
	it('only the TOP band of chrome counts (the bottom-left embed chrome does not push the top HUD)', () => {
		const bottomChrome = [{ left: 10, top: 800, right: 200, bottom: 832 }];
		const tall = { left: 0, top: 0, right: 390, bottom: 844 };
		expect(hudTopShift([tall], bottomChrome, VH)).toBe(0);
	});
	it('a touch of sub-pixel contact is not a collision', () => {
		const s = { left: 56.2, top: 0, right: 140, bottom: 30 };
		expect(hudTopShift([s], [ROW[0]], VH)).toBe(0);
	});
});

describe('hudBottomLift', () => {
	// the play entry's embed chrome: ⛶ / Open ↗ / Remix ↗ at the bottom-left, 10 px in
	const EMBED = [{ left: 10, top: 802, right: 250, bottom: 834 }];
	it('Mini Golf at 390 px: the bottom tip lifts above the embed chrome links', () => {
		const tip = bottomFootprint({ anchor: 'bottom-center', x: 0, y: 16, w: 360, h: 28 }, VW, VH);
		expect(tip).toEqual({ left: 15, top: 800, right: 375, bottom: 828 });
		const lift = hudBottomLift([tip], EMBED, VH);
		expect(lift).toBe(828 - (802 - 6));
		for (const c of EMBED) expect(overlaps({ ...tip, top: tip.top - lift, bottom: tip.bottom - lift }, c)).toBe(false);
	});
	it('nothing collides, or no bottom chrome: nothing moves', () => {
		const right = bottomFootprint({ anchor: 'bottom-right', x: 10, y: 10, w: 80, h: 30 }, VW, VH);
		expect(hudBottomLift([right], EMBED, VH)).toBe(0);
		expect(hudBottomLift([right], [], VH)).toBe(0);
		expect(hudBottomLift([right], ROW, VH)).toBe(0);
	});
	it('a top or centre anchor has no bottom footprint', () => {
		expect(bottomFootprint({ anchor: 'top-left', w: 10, h: 10 }, VW, VH)).toBe(null);
		expect(bottomFootprint({ anchor: 'center', w: 10, h: 10 }, VW, VH)).toBe(null);
	});
});
