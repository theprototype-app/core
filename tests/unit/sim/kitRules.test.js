// 34 R2 — kit.rules on the logic sim: reach, the grab veto, bounds, jump. The Towers rule
// ("you can't take an object from further than ~1.3 m; climb onto other pieces to reach")
// generalised into a rule any game sets once.
import { describe, it, expect } from 'vitest';
import { createSim, agree } from './logicSim.js';
import { normalizeRuleBounds, insideBox, clampToBox } from '../../../src/lib/kit/rules.js';

const rulesOf = (/** @type {any} */ sim, /** @type {string} */ id) => sim.peer(id).kit.impls.rules;

describe('kit.rules — one value for the whole session', () => {
	it('a reach set on ANY peer reaches every peer through the authority', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'] });
		rulesOf(sim, 'c').setReach(1.3);
		sim.settle();
		expect(['a', 'b', 'c'].map((id) => rulesOf(sim, id).reach())).toEqual([1.3, 1.3, 1.3]);
		expect(agree(sim)).toBe(true);
	});
	it('values clamp and 0 removes a rule', () => {
		const sim = createSim({ peers: ['a'] });
		const r = rulesOf(sim, 'a');
		r.setReach(99);
		expect(r.reach()).toBe(20);
		r.setReach(0.1);
		expect(r.reach()).toBe(0.3);
		r.setReach(0);
		expect(r.reach()).toBe(0);
		expect(r.extra.current().reach).toBe(null);
		r.setJump(9);
		expect(r.jump()).toBe(5);
		r.setJump(-1);
		expect(r.extra.current().jump).toBe(null);
	});
	it('set({reach, jump, bounds}) and clearRules', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		rulesOf(sim, 'b').extra.set({ reach: 2, jump: 1.2, bounds: { min: [5, 0, 5], max: [-5, 4, -5] } });
		sim.settle();
		const cur = rulesOf(sim, 'a').extra.current();
		expect(cur).toEqual({ reach: 2, jump: 1.2, bounds: { min: [-5, 0, -5], max: [5, 4, 5] } });
		rulesOf(sim, 'a').clearRules();
		sim.settle();
		expect(rulesOf(sim, 'b').extra.current()).toEqual({ reach: null, jump: null, bounds: null });
	});
	it('a malformed bounds is refused and changes nothing', () => {
		const sim = createSim({ peers: ['a'] });
		const r = rulesOf(sim, 'a');
		expect(r.setBounds([0, 0], [1, 1, 1])).toEqual({ ok: false, reason: 'bounds need two finite corners' });
		expect(r.extra.current().bounds).toBe(null);
	});
	it('a set node changes the rule once, from whichever peers saw the press', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		for (const id of ['a', 'b']) sim.peer(id).kit.runNodeAction('kit-rules-setReach', { metres: 2.5 }, { rid: 'node:r:1' });
		sim.settle();
		expect(rulesOf(sim, 'b').reach()).toBe(2.5);
		expect(sim.peer('a').kit.doc().rev).toBe(1);
		expect(sim.peer('a').kit.evalNodeValue('kit-rules-reach', {})).toBe(2.5);
	});
});

describe('kit.rules.checkGrab — reach from the BODY, then the vetoes', () => {
	const eye = [0, 1.7, 0];
	it('the Towers climb: a piece on a 2.6 m ledge is out of reach from the floor, in reach from a 1 m step', () => {
		const sim = createSim({ peers: ['a'] });
		const r = rulesOf(sim, 'a');
		r.setReach(1.3);
		const ledge = [0.6, 2.6 + 0.6, 0]; // just over the ledge edge, above the head
		expect(r.extra.checkGrab({ point: ledge, eye, feetY: 0 }).ok).toBe(false);
		// standing on a 1 m block: eye 2.7, feet 1.0
		expect(r.extra.checkGrab({ point: ledge, eye: [0, 2.7, 0], feetY: 1 }).ok).toBe(true);
	});
	it('a crate at your feet is in reach (the feet-to-eye segment, never the eye alone)', () => {
		const sim = createSim({ peers: ['a'] });
		const r = rulesOf(sim, 'a');
		r.setReach(1.3);
		const v = r.extra.checkGrab({ point: [0.5, 0.2, 0], eye, feetY: 0 });
		expect(v.ok).toBe(true);
		expect(v.distance).toBeCloseTo(0.5, 5);
	});
	it('with no reach anywhere, a far point is fine', () => {
		const sim = createSim({ peers: ['a'] });
		expect(rulesOf(sim, 'a').extra.checkGrab({ point: [40, 0, 0], eye, feetY: 0 }).ok).toBe(true);
	});
	it('an explicit reach (the scene\'s, resolved by the app) is honoured when the kit sets none', () => {
		const sim = createSim({ peers: ['a'] });
		expect(rulesOf(sim, 'a').extra.checkGrab({ point: [3, 1, 0], eye, feetY: 0, reach: 2 }).ok).toBe(false);
	});
	it('a veto refuses with its own reason; the first refusal wins; a throwing veto is skipped', () => {
		const sim = createSim({ peers: ['a'] });
		const r = rulesOf(sim, 'a');
		/** @type {any[]} */
		const seen = [];
		r.extra.onGrabRequest(() => {
			throw new Error('a broken game rule');
		});
		r.extra.onGrabRequest((/** @type {any} */ req) => {
			seen.push(req);
			if (req.name.startsWith('Locked')) req.refuse('Only the top piece');
		});
		r.extra.onGrabRequest((/** @type {any} */ req) => req.refuse('never reached'));
		const ok = r.extra.checkGrab({ point: [0.4, 1, 0], eye, feetY: 0, uuid: 'u1', name: 'Locked crate', hand: 'left' });
		expect(ok).toEqual({ ok: false, reason: 'Only the top piece', distance: expect.any(Number) });
		expect(seen[0]).toMatchObject({ uuid: 'u1', name: 'Locked crate', hand: 'left', reach: null });
		// a piece the first veto accepts meets the next one
		expect(r.extra.checkGrab({ point: [0.4, 1, 0], eye, feetY: 0, name: 'Crate' }).reason).toBe('never reached');
	});
	it('the reach is asked BEFORE the vetoes (a far piece never bothers them)', () => {
		const sim = createSim({ peers: ['a'] });
		const r = rulesOf(sim, 'a');
		r.setReach(1);
		let asked = 0;
		r.extra.onGrabRequest(() => asked++);
		expect(r.extra.checkGrab({ point: [5, 1, 0], eye, feetY: 0 }).reason).toBe('Too far — get closer');
		expect(asked).toBe(0);
	});
	it('`refused` is LOCAL: only the grabbing peer hears it, its node pulse stays local, a silent hover emits nothing', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		rulesOf(sim, 'a').setReach(1);
		sim.settle();
		/** @type {Record<string, number>} */
		const heard = { a: 0, b: 0 };
		for (const id of ['a', 'b']) rulesOf(sim, id).on('refused', () => heard[id]++);
		rulesOf(sim, 'b').extra.checkGrab({ point: [5, 1, 0], eye, feetY: 0, silent: true });
		expect(heard).toEqual({ a: 0, b: 0 });
		rulesOf(sim, 'b').extra.checkGrab({ point: [5, 1, 0], eye, feetY: 0 });
		sim.settle();
		expect(heard).toEqual({ a: 0, b: 1 });
		expect(sim.peer('b').emitted).toEqual([{ piece: 'rules', event: 'refused', payload: expect.objectContaining({ reason: 'Too far — get closer' }), at: expect.any(Number), local: true }]);
		expect(sim.sent('kit').filter((m) => (m.msg.ev ?? []).some((/** @type {any} */ e) => e.name === 'refused'))).toEqual([]);
	});
	it('a veto is torn down by its off()', () => {
		const sim = createSim({ peers: ['a'] });
		const r = rulesOf(sim, 'a');
		const off = r.extra.onGrabRequest((/** @type {any} */ req) => req.refuse('no'));
		expect(r.extra.checkGrab({ point: [0, 1, 0], eye, feetY: 0 }).ok).toBe(false);
		off();
		expect(r.extra.checkGrab({ point: [0, 1, 0], eye, feetY: 0 }).ok).toBe(true);
	});
});

describe('kit.rules — bounds', () => {
	it('inside / clamp against the kit box (and everything is inside with none)', () => {
		const sim = createSim({ peers: ['a'] });
		const r = rulesOf(sim, 'a');
		expect(r.extra.inside([100, 0, 0])).toBe(true);
		r.setBounds([-2, 0, -2], [2, 3, 2]);
		expect(r.extra.inside([1, 1, 1])).toBe(true);
		expect(r.extra.inside({ x: 3, y: 1, z: 0 })).toBe(false);
		expect(r.extra.clamp([3, -1, 0])).toEqual([2, 0, 0]);
	});
	it('pure helpers', () => {
		expect(normalizeRuleBounds([1, 2, 3], [0, 5, 1])).toEqual({ min: [0, 2, 1], max: [1, 5, 3] });
		expect(normalizeRuleBounds([1, 2], [0, 5, 1])).toBe(null);
		expect(insideBox([0, 0, 0], null)).toBe(true);
		expect(clampToBox([9, 9, 9], null)).toEqual([9, 9, 9]);
	});
});
