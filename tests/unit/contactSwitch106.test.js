// @ts-nocheck — invented frame times and tier strings on purpose
// 106 S2b — the Contact shadows switch: tier gating, the governor's pre-step (contact goes FIRST, then the old
// ladder, unchanged), and the cost meter's arithmetic.
import { describe, it, expect } from 'vitest';
import { contactShadowsOn, CONTACT_ON_TIERS, CONTACT_NOT_HERE, TIER_CONTACT } from '../../src/lib/shadows/shadowLevelParams.js';
import { createGovernor, overridesAt, FULL_QUALITY, TIMING, MAX_LEVEL, CONTACT_STEP_LABEL } from '../../src/lib/qualityGovernorCore.js';
import { createContactMeter, contactCostText } from '../../src/lib/shadows/contactCost.js';

describe('106 S2b contact switch: tier gating', () => {
	it('Auto = the tier table at Soft / Far: off on every tier today', () => {
		for (const tier of ['pc', 'phone', 'quest']) {
			expect(TIER_CONTACT[tier]).toBe(false);
			for (const lvl of ['off', 'basic', 'soft', 'far']) expect(contactShadowsOn(lvl, tier, 'auto')).toBe(false);
		}
		// the old two-argument call is Auto
		expect(contactShadowsOn('far', 'pc')).toBe(false);
	});
	it('On draws wherever the pc tier draws shadows (Basic, Soft, Far), never at Off', () => {
		expect(contactShadowsOn('basic', 'pc', 'on')).toBe(true);
		expect(contactShadowsOn('soft', 'pc', 'on')).toBe(true);
		expect(contactShadowsOn('far', 'pc', 'on')).toBe(true);
		expect(contactShadowsOn('off', 'pc', 'on')).toBe(false);
	});
	it('On is refused on a phone and in a headset, with the reason', () => {
		for (const tier of ['phone', 'quest']) {
			expect(CONTACT_ON_TIERS[tier]).toBe(false);
			for (const lvl of ['basic', 'soft', 'far']) expect(contactShadowsOn(lvl, tier, 'on')).toBe(false);
			expect(CONTACT_NOT_HERE[tier]).toMatch(/^Not /);
		}
		expect(CONTACT_ON_TIERS.pc).toBe(true);
		expect(contactShadowsOn('far', 'tv', 'on')).toBe(false);
	});
	it('Off is never', () => {
		for (const tier of ['pc', 'phone', 'quest']) for (const lvl of ['basic', 'soft', 'far']) expect(contactShadowsOn(lvl, tier, 'off')).toBe(false);
	});
});

/** drive a governor with steady frames of `ms` from `t0` for `dur` ms, deciding every 250 ms */
function run(g, t0, dur, ms, ctx) {
	let t = t0;
	const moves = [];
	for (; t < t0 + dur; t += 16) {
		g.noteFrame(ms, t);
		if (Math.round(t) % 250 < 16) {
			const d = g.decide(t, ctx);
			if (d.moved) moves.push({ ...d, at: t, contactOff: g.contactOff() });
		}
	}
	return { t, moves };
}

const SLOW = 50;
const FAST = 8;

describe('106 S2b contact switch: the governor drops it FIRST', () => {
	it('the overrides gain contactOff=false at every level (the pre-step rides beside the level)', () => {
		expect(FULL_QUALITY.contactOff).toBe(false);
		for (let l = 0; l <= MAX_LEVEL; l++) expect(overridesAt(l).contactOff).toBe(false);
		expect(CONTACT_STEP_LABEL).toBe('Contact shadows off');
	});

	it('while contact is drawn: overload -> contact off (level stays 0), then shadows off (level 1)', () => {
		const g = createGovernor();
		const { moves } = run(g, 1000, 8000, SLOW, { heavy: true, contact: true });
		expect(moves[0]).toMatchObject({ moved: 'up', step: 'contact', level: 0, contactOff: true });
		expect(moves[1]).toMatchObject({ moved: 'up', level: 1, contactOff: true });
		expect(moves[1].step).toBeUndefined();
		// the second step waited for its hold after the first
		expect(moves[1].at - moves[0].at).toBeGreaterThanOrEqual(TIMING.stepHoldMs);
	});

	it('a device that does not draw contact sees exactly the old ladder', () => {
		const a = createGovernor();
		const b = createGovernor();
		const ra = run(a, 1000, 12000, SLOW, { heavy: true });
		const rb = run(b, 1000, 12000, SLOW, { heavy: true, contact: false });
		expect(ra.moves.map((m) => m.level)).toEqual(rb.moves.map((m) => m.level));
		expect(ra.moves[0]).toMatchObject({ moved: 'up', level: 1 });
		expect(ra.moves.every((m) => !m.step && m.contactOff === false)).toBe(true);
	});

	it('contact goes even in a scene too light for the ladder (it costs fill, not calls)', () => {
		const g = createGovernor();
		const { moves } = run(g, 1000, 12000, SLOW, { heavy: false, contact: true });
		expect(moves.length).toBe(1);
		expect(moves[0]).toMatchObject({ step: 'contact', level: 0, contactOff: true });
	});

	it('"Restore full quality" (snoozed) holds contact too', () => {
		const g = createGovernor();
		const { moves } = run(g, 1000, 8000, SLOW, { heavy: false, contact: true, snoozed: true });
		expect(moves).toEqual([]);
	});

	it('recovery walks the ladder back first, then gives contact back', () => {
		const g = createGovernor();
		// overloaded until the two steps (contact, then shadows) are taken, and not a frame longer
		let t = 1000;
		for (; g.level() < 1; t += 16) {
			g.noteFrame(SLOW, t);
			if (Math.round(t) % 250 < 16) g.decide(t, { heavy: true, contact: true });
		}
		expect(g.contactOff()).toBe(true);
		const down = run(g, t, 40000, FAST, { heavy: true, contact: true });
		expect(down.moves[0]).toMatchObject({ moved: 'down', level: 0, contactOff: true });
		expect(down.moves[1]).toMatchObject({ moved: 'down', level: 0, step: 'contact', contactOff: false });
	});

	it('a contact recovery that flaps stays off until the flap lock clears', () => {
		const g = createGovernor();
		let r = run(g, 1000, 4000, SLOW, { heavy: false, contact: true });
		expect(g.contactOff()).toBe(true);
		r = run(g, r.t, 12000, FAST, { heavy: false, contact: true });
		expect(g.contactOff()).toBe(false);
		// overloaded again right after it came back: off, and this time it is not retried
		r = run(g, r.t, 4000, SLOW, { heavy: false, contact: true });
		expect(g.contactOff()).toBe(true);
		r = run(g, r.t, 30000, FAST, { heavy: false, contact: true });
		expect(g.contactOff()).toBe(true);
		g.clearFlapLock();
		run(g, r.t, 12000, FAST, { heavy: false, contact: true });
		expect(g.contactOff()).toBe(false);
	});

	it('full quality (setLevel 0) and "contact no longer drawn" both clear the pre-step', () => {
		const g = createGovernor();
		let r = run(g, 1000, 4000, SLOW, { heavy: false, contact: true });
		expect(g.contactOff()).toBe(true);
		g.setLevel(0, r.t);
		expect(g.contactOff()).toBe(false);
		r = run(g, r.t, 4000, SLOW, { heavy: false, contact: true });
		expect(g.contactOff()).toBe(true);
		const d = g.decide(r.t + 1, { heavy: false, contact: false });
		expect(d).toMatchObject({ moved: 'down', step: 'contact', reason: 'contact not drawn' });
		expect(g.contactOff()).toBe(false);
	});
});

describe('106 S2b contact switch: the cost meter', () => {
	it('cost = median with the pass - median without it, once both sides have samples', () => {
		const m = createContactMeter({ min: 5 });
		for (let i = 0; i < 4; i++) m.feed(false, 1000, 2 + i * 0.01);
		for (let i = 0; i < 9; i++) m.feed(true, 1000, 3.5);
		expect(m.cost()).toBeNull();
		m.feed(false, 1000, 2);
		expect(m.cost().ms).toBeCloseTo(1.5, 1);
		expect(m.cost().pixels).toBe(1000);
	});
	it('a resize starts both sides again; junk is ignored', () => {
		const m = createContactMeter({ min: 2 });
		m.feed(true, 1000, 3);
		m.feed(true, 1000, 3);
		m.feed(false, 1000, 1);
		m.feed(false, 1000, 1);
		expect(m.cost().ms).toBe(2);
		m.feed(true, 2000, 3);
		expect(m.cost()).toBeNull();
		m.feed(true, 2000, NaN);
		m.feed(true, 2000, 5000);
		expect(m.counts()).toEqual({ on: 1, off: 0, pixels: 2000 });
	});
	it('the menu words, scaled to the pixels drawn now', () => {
		expect(contactCostText(null, 100)).toBe('');
		expect(contactCostText({ ms: 0.2, pixels: 100 }, 100)).toBe('under 1 ms');
		expect(contactCostText({ ms: 1.4, pixels: 100 }, 200)).toBe('about 3 ms');
	});
});
