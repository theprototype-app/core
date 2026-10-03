// 34 R2 — kit.pickups on the logic sim: taken once, back after respawn, grants that reach score and
// the round clock, touch by the player's own position, reset per round.
import { describe, it, expect } from 'vitest';
import { createSim, agree } from './logicSim.js';
import { availableAt } from '../../../src/lib/kit/pickups.js';

const P = (/** @type {any} */ sim, /** @type {string} */ id) => sim.peer(id).kit.impls.pickups;
const S = (/** @type {any} */ sim, /** @type {string} */ id) => sim.peer(id).kit.impls.score;
const Rd = (/** @type {any} */ sim, /** @type {string} */ id) => sim.peer(id).kit.impls.round;
/** the same registration on every peer @param {any} sim @param {any[]} defs */
const registerAll = (sim, defs) => {
	for (const p of sim.peers.values()) for (const d of defs) p.kit.impls.pickups.extra.register(d);
};

describe('kit.pickups — once', () => {
	it('two players reaching the same gem in the same frame: one take, one score, credited to the first', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'] });
		registerAll(sim, [{ id: 'gem1', score: 5 }]);
		P(sim, 'b').collect('gem1');
		P(sim, 'c').collect('gem1');
		sim.settle();
		expect(S(sim, 'a').total()).toBe(5);
		expect(P(sim, 'a').extra.takenBy('gem1')).toBe('b');
		expect([S(sim, 'b').mine(), S(sim, 'c').mine()]).toEqual([5, 0]);
		expect(P(sim, 'c').available('gem1')).toBe(false);
		expect(agree(sim)).toBe(true);
	});
	it('a Collect node seen by every peer (a shared On Click) takes it once', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		for (const id of ['a', 'b']) sim.peer(id).kit.runNodeAction('kit-pickups-collect', { pickup: 'coin', score: 2, respawn: 0 }, { rid: 'node:c:9' });
		sim.settle();
		expect(S(sim, 'a').total()).toBe(2);
		expect(P(sim, 'b').available('coin')).toBe(false);
	});
	it('an unregistered pickup takes the node\'s own score and respawn (no code needed)', () => {
		const sim = createSim({ peers: ['a'] });
		sim.peer('a').kit.runNodeAction('kit-pickups-collect', { pickup: 'x', score: 3, respawn: 2 }, { rid: 'n:1' });
		expect(S(sim, 'a').total()).toBe(3);
		sim.advance(2100);
		expect(P(sim, 'a').available('x')).toBe(true);
	});
});

describe('kit.pickups — respawn', () => {
	it('comes back after its respawn seconds for everyone, ONCE, and can be taken again', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		registerAll(sim, [{ id: 'g', score: 1, respawn: 5 }]);
		let back = 0;
		P(sim, 'b').on('respawned', () => back++);
		P(sim, 'b').collect('g');
		sim.advance(3000);
		expect(P(sim, 'a').collect('g')).toEqual({ ok: false, reason: 'already taken' });
		sim.advance(2500);
		expect([P(sim, 'a').available('g'), P(sim, 'b').available('g')]).toEqual([true, true]);
		expect(back).toBe(1);
		P(sim, 'a').collect('g');
		sim.settle();
		expect(S(sim, 'b').total()).toBe(2);
	});
	it('a pickup with no respawn stays taken; the host leaving does not bring it back', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'] });
		registerAll(sim, [{ id: 'g' }]);
		P(sim, 'c').collect('g');
		sim.settle();
		sim.leave('a');
		sim.advance(10_000);
		expect(P(sim, 'b').available('g')).toBe(false);
		expect(P(sim, 'b').collect('g')).toEqual({ ok: false, reason: 'already taken' });
	});
});

describe('kit.pickups — grants and "all collected"', () => {
	it('a time grant adds to the running round; other grants ride the event', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		registerAll(sim, [{ id: 'clock', score: 0, grants: { time: 10, health: 2 } }]);
		/** @type {any[]} */
		const got = [];
		P(sim, 'b').on('collected', (/** @type {any} */ p) => got.push(p));
		Rd(sim, 'a').configure(0, 30, 'lose', 1);
		Rd(sim, 'a').start();
		sim.advance(5000);
		P(sim, 'b').collect('clock');
		sim.settle();
		expect(Rd(sim, 'a').remaining()).toBeGreaterThan(34);
		expect(got[0]).toMatchObject({ id: 'clock', by: 'b', grants: { time: 10, health: 2 } });
	});
	it('the last registered pickup taken fires allCollected once', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		registerAll(sim, [{ id: '1' }, { id: '2' }, { id: '3' }]);
		let all = 0;
		P(sim, 'a').on('allCollected', () => all++);
		for (const id of ['1', '2']) P(sim, 'b').collect(id);
		sim.settle();
		expect(P(sim, 'a').left()).toBe(1);
		expect(all).toBe(0);
		P(sim, 'b').collect('3');
		sim.settle();
		expect([all, P(sim, 'a').left(), P(sim, 'a').taken()]).toEqual([1, 0, 3]);
	});
});

describe('kit.pickups — touch', () => {
	it("a player walking over a gem takes it; standing still does not ask twice; another player's position is never used", () => {
		const sim = createSim({ peers: ['a', 'b'] });
		registerAll(sim, [{ id: 'g', score: 1, radius: 0.6 }]);
		const at = (/** @type {string} */ id) => (id === 'g' ? [2, 0.3, 0] : null);
		// b stands 3 m away: nothing
		expect(P(sim, 'b').extra.touchCheck([5, 1.7, 0], at)).toEqual([]);
		// b walks over it (the gem is at its feet, 1.4 m under the eye: the body segment touches it)
		expect(P(sim, 'b').extra.touchCheck([2.3, 1.7, 0], at)).toEqual(['g']);
		expect(P(sim, 'b').extra.touchCheck([2.3, 1.7, 0], at)).toEqual([]); // not asked again
		sim.settle();
		expect(P(sim, 'a').extra.takenBy('g')).toBe('b');
		expect(S(sim, 'b').mine()).toBe(1);
	});
});

describe('kit.pickups — rounds', () => {
	it('a new kit round puts every pickup back; a take in its first frame meets the new round', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		registerAll(sim, [{ id: 'g' }]);
		Rd(sim, 'a').configure(0, 0, 'lose', 1);
		Rd(sim, 'a').start();
		P(sim, 'b').collect('g');
		sim.settle();
		Rd(sim, 'a').restart();
		expect(P(sim, 'a').collect('g')).toMatchObject({ ok: true });
		sim.settle();
		expect(P(sim, 'b').extra.takenBy('g')).toBe('a');
	});
	it('availability is pure arithmetic on the stamp', () => {
		expect(availableAt(null, 5)).toBe(true);
		expect(availableAt({ at: 1000, respawn: 0 }, 1e9)).toBe(false);
		expect(availableAt({ at: 1000, respawn: 2 }, 2999)).toBe(false);
		expect(availableAt({ at: 1000, respawn: 2 }, 3000)).toBe(true);
	});
});
