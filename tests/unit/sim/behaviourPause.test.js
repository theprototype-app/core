// 54i F15 (roadmap 78) — "configure limit 30 → start → pause 6 s → resume ⇒ lost 'Out of time' after
// ~6 s of play". The research run's own data (r1-kit.json) shows the round went `lost` exactly 10.0 s
// of WALL time after `go`: the lab's behaviour node still held the starter Countdown (10 s,
// `this.after(1, 'tick')` → kit.round.lose('Out of time')), and behaviour timers ran on the session
// clock straight through the pause. kit.round's own clock was right all along (its tick path is
// proven here too). Behaviour timers now count PLAY time: held while the game is paused.
import { describe, it, expect } from 'vitest';
import { createBehaviourSim } from './behaviourSim.js';
import { BEHAVIOUR_STARTER } from '../../../src/lib/behaviours/starter.js';
import { behaviourPausedSince } from '../../../src/lib/behaviours/core.js';

/** @param {any} sim @param {string} id */
const R = (sim, id) => sim.peer(id).kit.impls.round;

/** the lab: 2 peers, the starter Countdown (10 s), a 30 s round with a 1 s intro @param {'round' | 'game'} via */
async function lab(via) {
	const sim = createBehaviourSim({ peers: ['a', 'b'] });
	await sim.load('countdown', BEHAVIOUR_STARTER);
	sim.advance(2500); // past the joiner grace: the authority acts
	R(sim, 'b').configure(1, 30, 'lose', 1);
	sim.settle();
	R(sim, 'b').start();
	sim.advance(1100); // the intro, then go: the Countdown starts at 10
	sim.settle();
	expect(R(sim, 'a').phase()).toBe('playing');
	sim.advance(3000); // 3 s of play
	if (via === 'round') R(sim, 'b').pause();
	else for (const id of ['a', 'b']) sim.peer(id).game.set('paused'); // a Set Game State node / the pause menu
	sim.advance(6300);
	sim.settle();
	expect(R(sim, 'a').phase()).toBe('paused');
	if (via === 'round') R(sim, 'b').resume();
	else for (const id of ['a', 'b']) sim.peer(id).game.set('playing');
	sim.settle();
	return sim;
}

describe('behaviour timers hold through a game pause (54i F15)', () => {
	for (const via of /** @type {const} */ (['round', 'game'])) {
		it(`paused via ${via}: the Countdown stops with the round's clock; 6 s after resuming the round still plays`, async () => {
			const sim = await lab(via);
			// the countdown did not move during the pause (it was at 7 after 3 s of play)
			expect(JSON.parse(sim.states('countdown')[0]).left).toBe(7);
			sim.advance(6000);
			sim.settle();
			expect(R(sim, 'a').phase()).toBe('playing');
			expect(R(sim, 'b').phase()).toBe('playing');
			// 9 s of play: 21 s left on the round's 30 s limit, on every peer
			expect(Math.round(R(sim, 'b').remaining())).toBe(21);
			expect(JSON.parse(sim.states('countdown')[1]).left).toBe(1);
			// the Countdown still ends the round after 10 s of PLAY (not of wall time)
			sim.advance(1200);
			sim.settle();
			expect(R(sim, 'a').phase()).toBe('lost');
			expect(R(sim, 'a').outcome()).toBe('Out of time');
		});
	}

	it('a timer set DURING the pause counts from the resume', async () => {
		const sim = createBehaviourSim({ peers: ['a'] });
		await sim.load(
			'late',
			`export default behaviour({ name: 'Late', state: { rang: 0 }, on: { paused() { this.after(2, 'ring'); } }, ring() { this.state.rang += 1; } });`
		);
		sim.advance(2500);
		R(sim, 'a').configure(0, 0, 'lose', 0);
		R(sim, 'a').start();
		sim.advance(500);
		R(sim, 'a').pause();
		sim.advance(5000);
		sim.settle();
		expect(JSON.parse(sim.states('late')[0]).rang).toBe(0);
		R(sim, 'a').resume();
		sim.advance(1500);
		sim.settle();
		expect(JSON.parse(sim.states('late')[0]).rang).toBe(0);
		sim.advance(700);
		sim.settle();
		expect(JSON.parse(sim.states('late')[0]).rang).toBe(1);
	});

	it('behaviourPausedSince reads the game singleton, then kit.round', () => {
		expect(behaviourPausedSince({ state: 'playing', pausedAt: 0 }, { phase: 'playing' })).toBe(0);
		expect(behaviourPausedSince({ state: 'paused', pausedAt: 1234 }, null)).toBe(1234);
		expect(behaviourPausedSince({ state: 'playing' }, { phase: 'paused', pausedAt: 99 })).toBe(99);
		expect(behaviourPausedSince(null, null)).toBe(0);
	});
});
