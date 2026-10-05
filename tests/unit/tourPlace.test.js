// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { placeCard, overlaps, targetSelectors, CARD_MARGIN } from '../../src/lib/tours/place.js';

// 36 I5: the 2D tour card never covers what it points at and never leaves the screen.
const CARD = { w: 340, h: 190 };
// the editor's real chrome at 1280×720 (measured on 1.20): + button, tools pill, Play, logo, Connect
const TARGETS_1280 = {
	add: { x: 16, y: 612, w: 44, h: 44 },
	tools: { x: 459, y: 664, w: 362, h: 40 },
	play: { x: 615, y: 660, w: 50, h: 50 },
	logo: { x: 8, y: 8, w: 48, h: 48 },
	connect: { x: 409, y: 8, w: 462, h: 54 }
};
const inside = (p, card, vw, vh) =>
	p.x >= CARD_MARGIN - 0.5 && p.y >= CARD_MARGIN - 0.5 && p.x + p.w <= vw - CARD_MARGIN + 0.5 && p.y + card.h <= vh - CARD_MARGIN + 0.5;

describe('placeCard', () => {
	it('puts the card beside every editor target at 1280×720, on screen and not over it', () => {
		for (const [name, t] of Object.entries(TARGETS_1280)) {
			const p = placeCard(t, CARD, 1280, 720);
			expect(inside(p, CARD, 1280, 720), name).toBe(true);
			expect(overlaps({ x: p.x, y: p.y, w: p.w, h: CARD.h }, t), name).toBe(false);
		}
	});
	it('centres without a target or when asked', () => {
		expect(placeCard(null, CARD, 1280, 720).side).toBe('center');
		expect(placeCard(TARGETS_1280.add, CARD, 1280, 720, 'center').side).toBe('center');
	});
	it('honours a preferred side when it fits, and falls back when it does not', () => {
		const t = { x: 600, y: 300, w: 80, h: 40 };
		expect(placeCard(t, CARD, 1280, 720, 'left').side).toBe('left');
		expect(placeCard(TARGETS_1280.play, CARD, 1280, 720, 'bottom').side).toBe('top');
	});
	it('is a sheet on a phone, on the side away from the target (folded 360 px and unfolded widths)', () => {
		for (const [vw, vh] of [[360, 780], [412, 915]]) {
			const low = placeCard({ x: 16, y: vh - 100, w: 44, h: 44 }, CARD, vw, vh);
			expect(low.side).toBe('sheet-top');
			expect(low.w).toBe(vw - 2 * CARD_MARGIN);
			const high = placeCard({ x: 8, y: 8, w: 48, h: 48 }, CARD, vw, vh);
			expect(high.side).toBe('sheet-bottom');
			expect(high.y + CARD.h).toBeLessThanOrEqual(vh - CARD_MARGIN);
		}
		// unfolded foldable is wide enough for the anchored card
		expect(placeCard(TARGETS_1280.add, CARD, 884, 1000).side).not.toMatch(/sheet/);
	});
});

describe('targetSelectors', () => {
	it('a data-tour id first, then the built-in fallback; a selector passes through', () => {
		expect(targetSelectors('add', { add: '#mobile-add-button' })).toEqual(['[data-tour="add"]', '#mobile-add-button']);
		expect(targetSelectors('#play-button')).toEqual(['#play-button']);
		expect(targetSelectors('[data-x]')).toEqual(['[data-x]']);
		expect(targetSelectors('')).toEqual([]);
		expect(targetSelectors('a"b')).toEqual(['[data-tour="ab"]']);
	});
});
