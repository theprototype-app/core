// 36 F22 — selecting inside and behind things: the pure rules (selectThrough.js).
import { describe, it, expect } from 'vitest';
import {
	pickStack,
	primaryIndex,
	isSeeThrough,
	nonBlockingKind,
	normalizePassThrough,
	gamePassThrough,
	altCycleIndex,
	gameRayEntry,
	PASS_DEFAULTS
} from '../../src/lib/selectThrough.js';

/** a fake top-level object + a hit on it */
/** @param {string} uuid @param {any} [userData] @param {any} [material] @returns {any} */
const obj = (uuid, userData = {}, material = { transparent: false, opacity: 1 }) => ({ uuid, userData, material, visible: true, parent: null });
/** @param {any} o @param {number} distance */
const hitOn = (o, distance) => ({ object: o, distance, face: { materialIndex: 0 } });
/** @param {any} o */
const topOf = (o) => o;

const water = obj('water', { water: { version: 1, shape: 'box' } });
const fluidTank = obj('tank', { fluid: { version: 1 } }, { transparent: true, opacity: 0.4 });
const fish = obj('fish');
const sand = obj('sand');
const trigger = obj('trigger', { physics: { sensor: true } });
const groupTrigger = obj('zone', { physics: { group: 'water' } });
const glass = obj('glass', {}, { transparent: true, opacity: 0.5 });

describe('nonBlockingKind', () => {
	it('names water volumes, fluid tanks and triggers', () => {
		expect(nonBlockingKind(water)).toBe('water');
		expect(nonBlockingKind(fluidTank)).toBe('water');
		expect(nonBlockingKind(trigger)).toBe('trigger');
		expect(nonBlockingKind(groupTrigger)).toBe('trigger');
		expect(nonBlockingKind(fish)).toBe(null);
	});
});

describe('the editor pick (defaults: water passes, transparent + triggers block)', () => {
	it('a click through the aquarium water selects the fish', () => {
		const stack = pickStack([hitOn(water, 1), hitOn(fish, 1.5), hitOn(sand, 2)], topOf);
		expect(stack[primaryIndex(stack)].uuid).toBe('fish');
	});
	it('a click through a fluid tank selects the duck inside it (even if the glass were opaque enough)', () => {
		const stack = pickStack([hitOn(fluidTank, 1), hitOn(fish, 1.5)], topOf);
		expect(stack[primaryIndex(stack)].uuid).toBe('fish');
	});
	it('with nothing behind it, the water itself is selected (its surface edge, an open ocean)', () => {
		const stack = pickStack([hitOn(water, 3)], topOf);
		expect(stack[primaryIndex(stack)].uuid).toBe('water');
	});
	it('the defaults keep transparent surfaces and triggers clickable', () => {
		expect(isSeeThrough(hitOn(glass, 1), glass)).toBe(false);
		expect(isSeeThrough(hitOn(trigger, 1), trigger)).toBe(false);
	});
	it('the setting turns each kind on and off', () => {
		const all = { water: true, transparent: true, triggers: true };
		expect(isSeeThrough(hitOn(glass, 1), glass, all)).toBe(true);
		expect(isSeeThrough(hitOn(trigger, 1), trigger, all)).toBe(true);
		const none = { water: false, transparent: false, triggers: false };
		const stack = pickStack([hitOn(water, 1), hitOn(fish, 1.5)], topOf, none);
		expect(stack[primaryIndex(stack)].uuid).toBe('water');
	});
	it('normalizePassThrough fills the gaps from the defaults', () => {
		expect(normalizePassThrough(undefined)).toEqual(PASS_DEFAULTS);
		expect(normalizePassThrough({ triggers: true })).toEqual({ water: true, transparent: false, triggers: true });
		expect(normalizePassThrough({ water: 'yes' })).toEqual(PASS_DEFAULTS);
	});
});

describe('Alt+click cycles front to back', () => {
	const stack = pickStack([hitOn(water, 1), hitOn(fish, 1.5), hitOn(sand, 2)], topOf);
	it('the first Alt+click takes the FRONT (the water itself)', () => {
		expect(altCycleIndex(stack, { x: 100, y: 100 }, null)).toEqual({ index: 0, of: 3 });
	});
	it('the next one on the same spot walks down, and wraps', () => {
		expect(altCycleIndex(stack, { x: 102, y: 101 }, { x: 100, y: 100, uuid: 'water' }).index).toBe(1);
		expect(altCycleIndex(stack, { x: 100, y: 100 }, { x: 100, y: 100, uuid: 'fish' }).index).toBe(2);
		expect(altCycleIndex(stack, { x: 100, y: 100 }, { x: 100, y: 100, uuid: 'sand' }).index).toBe(0);
	});
	it('a different spot starts over at the front', () => {
		expect(altCycleIndex(stack, { x: 200, y: 100 }, { x: 100, y: 100, uuid: 'fish' }).index).toBe(0);
	});
	it('nothing under the cursor', () => {
		expect(altCycleIndex([], { x: 0, y: 0 }, null)).toEqual({ index: -1, of: 0 });
	});
});

describe("a game's rays", () => {
	it('skip water and triggers by default', () => {
		const pass = gamePassThrough(undefined);
		const stack = pickStack([hitOn(trigger, 0.5), hitOn(water, 1), hitOn(fish, 1.5)], topOf, pass);
		expect(gameRayEntry(stack)?.uuid).toBe('fish');
	});
	it('a lone trigger is still reachable', () => {
		const stack = pickStack([hitOn(trigger, 0.5)], topOf, gamePassThrough(undefined));
		expect(gameRayEntry(stack)?.uuid).toBe('trigger');
	});
	it('a game can opt back in (play.rayHits)', () => {
		const pass = gamePassThrough({ water: true, triggers: true });
		const stack = pickStack([hitOn(trigger, 0.5), hitOn(water, 1), hitOn(fish, 1.5)], topOf, pass);
		expect(gameRayEntry(stack)?.uuid).toBe('trigger');
	});
	it('respects the reach', () => {
		const stack = pickStack([hitOn(water, 1), hitOn(fish, 5)], topOf, gamePassThrough(undefined));
		expect(gameRayEntry(stack, 3)?.uuid).toBe('water');
		expect(gameRayEntry(stack, 6)?.uuid).toBe('fish');
	});
});
