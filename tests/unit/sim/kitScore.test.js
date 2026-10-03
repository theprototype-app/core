// 34 R2 — kit.score on the logic sim: counted once, credited to the right player, reset per round,
// best per device, leaderboard rows the same on every peer.
import { describe, it, expect } from 'vitest';
import { createSim, agree } from './logicSim.js';
import { rankRows } from '../../../src/lib/kit/score.js';

const S = (/** @type {any} */ sim, /** @type {string} */ id) => sim.peer(id).kit.impls.score;
const Rd = (/** @type {any} */ sim, /** @type {string} */ id) => sim.peer(id).kit.impls.round;

describe('kit.score — once, and to whom', () => {
	it('a shared pulse seen by all three peers adds ONE point (the setvariable-add double count, gone)', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'], latency: 40 });
		for (const id of ['a', 'b', 'c']) sim.peer(id).kit.runNodeAction('kit-score-add', { amount: 1 }, { rid: 'node:gem:77.5' });
		sim.settle();
		expect([...sim.peers.values()].map((p) => p.kit.impls.score.total())).toEqual([1, 1, 1]);
	});
	it('a player\'s own add credits that player; mine() is per peer', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		S(sim, 'b').add(3);
		S(sim, 'a').add(2);
		S(sim, 'b').add(1);
		sim.settle();
		expect(S(sim, 'a').total()).toBe(6);
		expect([S(sim, 'a').mine(), S(sim, 'b').mine()]).toEqual([2, 4]);
		expect(S(sim, 'a').extra.of('b')).toBe(4);
		expect(agree(sim)).toBe(true);
	});
	it('a named player is credited whoever asks; set() and reset()', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		S(sim, 'a').add(5, 'c');
		S(sim, 'b').set(10);
		S(sim, 'b').set(7, 'a');
		sim.settle();
		expect([S(sim, 'b').total(), S(sim, 'b').extra.of('c'), S(sim, 'b').extra.of('a')]).toEqual([10, 5, 7]);
		S(sim, 'b').reset();
		sim.settle();
		expect([S(sim, 'a').total(), S(sim, 'a').extra.leaderboard()]).toEqual([0, []]);
	});
	it('`scored` events reach every peer once per add, with the running total', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'] });
		/** @type {any[]} */
		const heard = [];
		S(sim, 'c').on('scored', (/** @type {any} */ p) => heard.push(p));
		S(sim, 'b').add(2);
		S(sim, 'c').add(3);
		sim.settle();
		expect(heard.map((p) => [p.player, p.amount, p.total])).toEqual([
			['b', 2, 2],
			['c', 3, 5]
		]);
	});
});

describe('kit.score — rounds and bests', () => {
	it('a new kit round zeroes the scores; a point in the round\'s first frame counts in the new round', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		Rd(sim, 'a').configure(0, 0, 'lose', 1);
		Rd(sim, 'a').start();
		S(sim, 'b').add(4);
		sim.settle();
		Rd(sim, 'a').restart();
		S(sim, 'a').add(1); // same frame as the restart, before any tick
		sim.settle();
		expect(S(sim, 'b').total()).toBe(1);
		sim.advance(500);
		expect(S(sim, 'b').total()).toBe(1);
	});
	it('autoReset off keeps a match score across rounds', () => {
		const sim = createSim({ peers: ['a'] });
		S(sim, 'a').extra.configure({ autoReset: false });
		Rd(sim, 'a').configure(0, 0, 'lose', 1);
		Rd(sim, 'a').start();
		S(sim, 'a').add(4);
		Rd(sim, 'a').restart();
		sim.advance(200);
		expect(S(sim, 'a').total()).toBe(4);
	});
	it('the round ending files a device best on EVERY device that beat its own, and says so locally', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		sim.peer('b').storage.set('score:default', 50); // b's device already holds 50
		/** @type {Record<string, number>} */
		const bests = { a: 0, b: 0 };
		for (const id of ['a', 'b']) S(sim, id).on('newBest', () => bests[id]++);
		Rd(sim, 'a').configure(0, 0, 'lose', 1);
		Rd(sim, 'a').start();
		S(sim, 'a').add(30);
		Rd(sim, 'b').win();
		sim.settle();
		expect(bests).toEqual({ a: 1, b: 0 });
		expect([S(sim, 'a').best(), S(sim, 'b').best()]).toEqual([30, 50]);
		expect((sim.peer('a').emitted ?? []).find((/** @type {any} */ e) => e.event === 'newBest')).toMatchObject({ local: true });
	});
	it('with kit.levels in play the best is per game and level', () => {
		const sim = createSim({ peers: ['a'] });
		sim.peer('a').kit.impls.levels.extra.define({ id: 'g', list: [{ id: '1' }, { id: '2' }], unlock: 'all' });
		sim.peer('a').kit.impls.levels.select('2');
		Rd(sim, 'a').configure(0, 0, 'lose', 1);
		Rd(sim, 'a').start();
		S(sim, 'a').add(9);
		Rd(sim, 'a').lose();
		expect(sim.peer('a').storage.get('score:g:2')).toBe(9);
	});
});

describe('kit.score — the leaderboard', () => {
	it('rows sorted by score then id, the same on every peer, with ranks and "me"', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'] });
		S(sim, 'a').add(5, 'zed');
		S(sim, 'a').add(5, 'amy');
		S(sim, 'a').add(9, 'b');
		sim.settle();
		const fromC = S(sim, 'c').extra.leaderboard();
		expect(fromC.map((/** @type {any} */ r) => [r.id, r.rank])).toEqual([
			['b', 1],
			['amy', 2],
			['zed', 3]
		]);
		expect(S(sim, 'b').extra.leaderboard()[0].me).toBe(true);
		expect(S(sim, 'c').leader()).toBe('b');
		expect(S(sim, 'a').extra.results()).toMatchObject({ total: 19, players: expect.any(Array) });
		expect(rankRows({ x: 1, a: 1 })[0].id).toBe('a');
	});
});
