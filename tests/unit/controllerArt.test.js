// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
	controllerFamily,
	sessionFamily,
	familyLabel,
	controllerSvg,
	litFor,
	DEFAULT_ART_COLORS
} from '../../src/lib/tours/controllerArt.js';

// 36 U3b: the VR welcome's controller diagrams.
describe('controllerFamily (WebXR input profiles)', () => {
	it('Quest 3 / 3S Touch Plus and Quest Pro are the ringless family', () => {
		expect(controllerFamily(['meta-quest-touch-plus', 'generic-trigger-squeeze-thumbstick'])).toBe('quest3');
		expect(controllerFamily(['meta-quest-touch-pro'])).toBe('quest3');
	});
	it('Quest 2 (Touch v3) and older Touch are the ring family', () => {
		expect(controllerFamily(['oculus-touch-v3', 'oculus-touch-v2', 'oculus-touch'])).toBe('quest2');
		expect(controllerFamily(['oculus-touch-v2'])).toBe('quest2');
	});
	it('hands, other headsets and nothing at all are generic', () => {
		expect(controllerFamily(['generic-hand'])).toBe('generic');
		expect(controllerFamily(undefined)).toBe('generic');
		expect(controllerFamily([])).toBe('generic');
	});
	it('a session answers with the first source that names a family (a hand first is skipped)', () => {
		const session = { inputSources: [{ profiles: ['generic-hand'] }, { profiles: ['oculus-touch-v3'] }] };
		expect(sessionFamily(session)).toBe('quest2');
		expect(sessionFamily(null)).toBe('generic');
		expect(familyLabel('quest3')).toBe('Quest 3 / 3S controllers');
	});
});

describe('controllerSvg', () => {
	const litParts = (svg) =>
		[...svg.matchAll(/data-part="([a-z]+)"[^>]*?stroke="([^"]+)"/g)].filter((m) => m[2] === DEFAULT_ART_COLORS.accent).map((m) => m[1]);
	it('lights exactly the asked parts, per hand, and names them under the hand', () => {
		const svg = controllerSvg({ lit: { left: ['stick'], right: ['trigger', 'grip'] } });
		expect(litParts(svg).sort()).toEqual(['grip', 'stick', 'trigger']);
		expect(svg).toContain('>Trigger · Grip<');
		expect(svg).toContain('>Stick<');
		expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
	});
	it('maps hand-independent names onto each hand (face-upper = Y left / B right)', () => {
		const left = controllerSvg({ hands: 'left', lit: { left: ['face-upper', 'system'] } });
		expect(litParts(left).sort()).toEqual(['menu', 'y']);
		const right = controllerSvg({ hands: 'right', lit: { right: ['face-upper', 'system'] } });
		expect(litParts(right).sort()).toEqual(['b', 'meta']);
		// a button the hand does not have is ignored, not drawn lit
		expect(litParts(controllerSvg({ hands: 'right', lit: { right: ['x'] } }))).toEqual([]);
	});
	it('the Quest 2 drawing carries the tracking ring; Quest 3 / 3S does not', () => {
		const ring = (svg) => (svg.match(/stroke-width="9"/g) ?? []).length;
		expect(ring(controllerSvg({ family: 'quest2' }))).toBe(2);
		expect(ring(controllerSvg({ family: 'quest3' }))).toBe(0);
	});
	it('one hand is half as wide as two', () => {
		const width = (svg) => Number(svg.match(/ width="(\d+)"/)[1]);
		expect(width(controllerSvg({ hands: 'left' }))).toBe(212);
		expect(width(controllerSvg({ hands: 'both' }))).toBe(432);
	});
});

describe('litFor', () => {
	it('spreads a step’s controls onto the hands', () => {
		expect(litFor({ hand: 'both', parts: ['grip'] })).toEqual({ left: ['grip'], right: ['grip'] });
		expect(litFor({ hand: 'right', parts: ['meta'] })).toEqual({ left: [], right: ['meta'] });
		expect(litFor(undefined)).toEqual({ left: [], right: [] });
	});
});
