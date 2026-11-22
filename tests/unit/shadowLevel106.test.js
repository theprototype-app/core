// @ts-nocheck — tier strings on purpose (an unknown tier must cap to Basic)
import { describe, it, expect } from 'vitest';
import {
	SHADOW_LEVELS,
	shadowLevelOf,
	shadowTierOf,
	drawnShadowLevel,
	contactShadowsOn,
	levelParams,
	cascadeReach,
	cappedNote
} from '../../src/lib/shadows/shadowLevelCore.js';

describe('106 shadow level core', () => {
	it('absent or unknown is Basic (old scenes, old peers)', () => {
		expect(shadowLevelOf(undefined)).toBe('basic');
		expect(shadowLevelOf(null)).toBe('basic');
		expect(shadowLevelOf('ultra')).toBe('basic');
		for (const l of SHADOW_LEVELS) expect(shadowLevelOf(l)).toBe(l);
	});
	it('tiers from the finish facts', () => {
		expect(shadowTierOf({ presenting: true })).toBe('quest');
		expect(shadowTierOf({ headset: true, phone: true })).toBe('quest');
		expect(shadowTierOf({ phone: true })).toBe('phone');
		expect(shadowTierOf({})).toBe('pc');
	});
	it('caps per tier and never lifts Off', () => {
		expect(drawnShadowLevel('far', 'pc')).toBe('far');
		expect(drawnShadowLevel('soft', 'pc')).toBe('soft');
		expect(drawnShadowLevel('far', 'phone')).toBe('basic');
		expect(drawnShadowLevel('far', 'quest')).toBe('basic');
		expect(drawnShadowLevel('off', 'quest')).toBe('off');
		expect(drawnShadowLevel(undefined, 'pc')).toBe('basic');
		expect(drawnShadowLevel('far', 'tv')).toBe('basic');
	});
	it('contact shadows only in Soft / Far on tiers that fit', () => {
		expect(contactShadowsOn('soft', 'pc')).toBe(true);
		expect(contactShadowsOn('far', 'pc')).toBe(true);
		expect(contactShadowsOn('basic', 'pc')).toBe(false);
		expect(contactShadowsOn('far', 'phone')).toBe(false);
		expect(contactShadowsOn('far', 'quest')).toBe(false);
	});
	it('Basic is the identity (today: radius 1, no cascades)', () => {
		expect(levelParams('basic')).toMatchObject({ radius: 1, cascades: false });
		expect(levelParams('far').cascades).toBe(true);
		expect(levelParams('nope')).toBe(levelParams('basic'));
	});
	it('cascade reach follows the scene size within 40..200 m', () => {
		expect(cascadeReach(5)).toBe(40);
		expect(cascadeReach(50)).toBe(125);
		expect(cascadeReach(500)).toBe(200);
		expect(cascadeReach(NaN)).toBe(200);
	});
	it('says when the device draws less', () => {
		expect(cappedNote('far', 'phone')).toBe('This device draws Basic');
		expect(cappedNote('far', 'pc')).toBe('');
		expect(cappedNote('basic', 'quest')).toBe('');
	});
});
