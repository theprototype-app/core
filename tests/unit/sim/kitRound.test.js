// 34 R2 — kit.round on the logic sim: the phase machine every game re-built, proven with 2-4 fake
// peers, a fake clock and core's game singleton (faked with gameState's transitions).
import { describe, it, expect } from 'vitest';
import { createSim, agree } from './logicSim.js';

const R = (/** @type {any} */ sim, /** @type {string} */ id) => sim.peer(id).kit.impls.round;
const phases = (/** @type {any} */ sim) => [...sim.peers.values()].map((p) => p.kit.impls.round.phase());

describe('kit.round — start, intro, go', () => {
	it('Start -> a 3 s intro counting 3, 2, 1 on every peer -> play', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'] });
		R(sim, 'b').start();
		sim.advance(100);
		expect(phases(sim)).toEqual(['intro', 'intro', 'intro']);
		expect([...sim.peers.values()].map((p) => p.kit.impls.round.countdown())).toEqual([3, 3, 3]);
		sim.advance(1500);
		expect(R(sim, 'c').countdown()).toBe(2);
		sim.advance(1600);
		expect(phases(sim)).toEqual(['playing', 'playing', 'playing']);
		expect(R(sim, 'a').number()).toBe(1);
		// core's game singleton follows on every peer, with ONE fresh core round
		expect([...sim.peers.values()].map((p) => [p.game.get().state, p.game.get().round])).toEqual([
			['playing', 1],
			['playing', 1],
			['playing', 1]
		]);
	});
	it('two players pressing Start in the same frame start ONE round', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'] });
		R(sim, 'b').start();
		R(sim, 'c').start();
		sim.settle();
		expect(R(sim, 'a').number()).toBe(1);
		expect(sim.peer('a').game.get().round).toBe(1);
	});
	it('the same Start node seen by every peer is one press (stamp rid)', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		for (const id of ['a', 'b']) sim.peer(id).kit.runNodeAction('kit-round-start', {}, { rid: 'node:s:5' });
		sim.settle();
		expect(sim.peer('a').kit.doc().rids.filter((/** @type {string} */ r) => r === 'node:s:5').length).toBe(1);
		expect(sim.peer('b').game.get().round).toBe(1);
		expect(sim.peer('b').kit.stats.duplicate + sim.peer('a').kit.stats.duplicate).toBeGreaterThan(0);
	});
	it('with no intro, Start goes straight to play (both events)', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		/** @type {string[]} */
		const heard = [];
		R(sim, 'b').on('started', () => heard.push('started'));
		R(sim, 'b').on('go', () => heard.push('go'));
		R(sim, 'a').configure(0, 0, 'lose', 2);
		R(sim, 'a').start();
		sim.settle();
		expect(R(sim, 'b').phase()).toBe('playing');
		expect(heard).toEqual(['started', 'go']);
	});
});

describe('kit.round — Restart that works while playing', () => {
	it('restart mid-round: a new round, the intro again, a fresh core round (perRound content resets)', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		R(sim, 'a').start();
		sim.advance(5000);
		expect(R(sim, 'b').elapsed()).toBeGreaterThan(1.5);
		R(sim, 'b').restart();
		sim.settle();
		expect(R(sim, 'a').phase()).toBe('intro');
		expect(R(sim, 'a').number()).toBe(2);
		expect(sim.peer('b').game.get().round).toBe(2);
		expect(R(sim, 'a').elapsed()).toBe(0);
	});
});

describe('kit.round — pause, the clock and the limit', () => {
	it('pause stops the shared clock for everyone; resume continues from there', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		R(sim, 'a').configure(0, 0, 'lose', 2);
		R(sim, 'a').start();
		sim.advance(2000);
		R(sim, 'b').pause();
		sim.settle();
		const at = R(sim, 'a').elapsed();
		expect(sim.peer('b').game.get().state).toBe('paused');
		sim.advance(5000);
		expect(R(sim, 'a').elapsed()).toBeCloseTo(at, 5);
		expect(R(sim, 'b').elapsed()).toBeCloseTo(at, 5);
		R(sim, 'b').resume();
		sim.advance(1000);
		expect(R(sim, 'a').elapsed()).toBeGreaterThan(at + 0.8);
		expect(R(sim, 'a').elapsed()).toBeLessThan(at + 1.2);
	});
	it('the clock running out loses the round (reason "time"); Add time pushes it back', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		R(sim, 'a').configure(0, 10, 'lose', 2);
		R(sim, 'a').start();
		sim.advance(8000);
		R(sim, 'b').extend(5);
		sim.advance(4000);
		expect(R(sim, 'a').phase()).toBe('playing');
		expect(R(sim, 'a').remaining()).toBeGreaterThan(2);
		sim.advance(4000);
		expect(phases(sim)).toEqual(['lost', 'lost']);
		expect(R(sim, 'b').outcome()).toBe('time');
		expect(R(sim, 'b').elapsed()).toBeCloseTo(15, 0);
		expect(sim.peer('b').game.get()).toMatchObject({ state: 'over', outcome: 'lost' });
	});
	it('a survive-the-timer game WINS when the clock runs out', () => {
		const sim = createSim({ peers: ['a'] });
		R(sim, 'a').configure(0, 5, 'win', 2);
		R(sim, 'a').start();
		sim.advance(5200);
		expect(R(sim, 'a').phase()).toBe('won');
	});
	it('won -> results after the outro; Start from the results is round 2', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		/** @type {any[]} */
		const results = [];
		R(sim, 'b').on('results', (/** @type {any} */ p) => results.push(p));
		R(sim, 'a').configure(0, 0, 'lose', 2);
		R(sim, 'a').start();
		sim.advance(3000);
		R(sim, 'b').win('all gems');
		sim.advance(1000);
		expect(R(sim, 'a').phase()).toBe('won');
		sim.advance(1500);
		expect(phases(sim)).toEqual(['results', 'results']);
		expect(results).toEqual([{ round: 1, outcome: 'all gems', won: true }]);
		R(sim, 'b').start();
		sim.settle();
		expect(R(sim, 'a').number()).toBe(2);
	});
	it('win / lose with no round running is refused', () => {
		const sim = createSim({ peers: ['a'] });
		expect(R(sim, 'a').win()).toEqual({ ok: false, reason: 'no round is running' });
	});
});

describe('kit.round — authority changes, joiners, other writers', () => {
	it('the host leaves mid-intro: play still begins ONCE, on time, for everyone left', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'] });
		let gos = 0;
		R(sim, 'c').on('go', () => gos++);
		R(sim, 'a').start();
		sim.advance(1200);
		sim.leave('a');
		sim.advance(2400);
		expect(phases(sim)).toEqual(['playing', 'playing']);
		expect(gos).toBe(1);
		expect(R(sim, 'b').elapsed()).toBeCloseTo(R(sim, 'c').elapsed(), 3);
		expect(R(sim, 'b').elapsed()).toBeLessThan(1);
	});
	it('a late joiner reads the same phase, clock and countdown, and hears no history', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		R(sim, 'a').configure(0, 60, 'lose', 2);
		R(sim, 'a').start();
		sim.advance(7000);
		const late = sim.add('c');
		let heard = 0;
		late.kit.impls.round.on('started', () => heard++);
		late.kit.impls.round.on('go', () => heard++);
		sim.join('c');
		sim.settle();
		expect(late.kit.impls.round.phase()).toBe('playing');
		expect(late.kit.impls.round.elapsed()).toBeCloseTo(R(sim, 'a').elapsed(), 3);
		expect(late.kit.impls.round.remaining()).toBeCloseTo(R(sim, 'a').remaining(), 3);
		expect(heard).toBe(0);
		expect(late.game.get().state).toBe('playing');
		expect(agree(sim)).toBe(true);
	});
	it("a game-state change the kit did not make (a Set Game State node, the shell) is adopted", () => {
		const sim = createSim({ peers: ['a', 'b'] });
		R(sim, 'a').configure(0, 0, 'lose', 2);
		R(sim, 'a').start();
		sim.advance(500);
		// a Set Game State 'paused' node runs on every peer from one replicated stamp
		for (const id of ['a', 'b']) sim.peer(id).game.set('paused');
		sim.settle();
		expect(phases(sim)).toEqual(['paused', 'paused']);
		for (const id of ['a', 'b']) sim.peer(id).game.set('playing');
		sim.settle();
		expect(phases(sim)).toEqual(['playing', 'playing']);
		sim.peer('a').game.set('menu');
		sim.settle();
		expect(phases(sim)).toEqual(['menu', 'menu']);
	});
	it("the kit's own game writes are NOT re-adopted (no echo)", () => {
		const sim = createSim({ peers: ['a', 'b'] });
		R(sim, 'a').configure(0, 0, 'lose', 2);
		R(sim, 'a').start();
		sim.advance(500);
		R(sim, 'a').pause();
		sim.advance(500);
		R(sim, 'a').resume();
		sim.advance(500);
		expect(phases(sim)).toEqual(['playing', 'playing']);
		expect(sim.peer('a').kit.stats.refused).toBe(0);
	});
	it('every transition event is heard once per peer, and its node pulses once (on the authority)', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'] });
		/** @type {Record<string, number>} */
		const won = { a: 0, b: 0, c: 0 };
		for (const id of ['a', 'b', 'c']) R(sim, id).on('won', () => won[id]++);
		R(sim, 'a').configure(0, 0, 'lose', 2);
		R(sim, 'c').start();
		sim.advance(200);
		R(sim, 'b').win();
		R(sim, 'c').win(); // a second "win" in the same frame is refused (already won)
		sim.settle();
		expect(won).toEqual({ a: 1, b: 1, c: 1 });
		expect((sim.peer('a').emitted ?? []).filter((/** @type {any} */ e) => e.event === 'won').length).toBe(1);
	});
	it('node values read the same on every peer', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		R(sim, 'a').start();
		sim.advance(4000);
		for (const id of ['a', 'b']) {
			expect(sim.peer(id).kit.evalNodeValue('kit-round-phase', {})).toBe('playing');
			expect(sim.peer(id).kit.evalNodeValue('kit-round-playing', {})).toBe(true);
		}
	});
});
