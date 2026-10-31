// 69 T1 — behaviour files run in the sandbox guest: a hostile file reaches nothing of the realm
// that runs the app, and the state sync around re-entrant kit calls keeps core.js's semantics.
// BEHAVIOUR_REALM=host runs the same file in the host realm (the counterfactual: `reach` is
// non-empty there — node has `process`, `fetch`, `setTimeout`, and the Function constructor reaches
// the host global).
import { describe, it, expect } from 'vitest';
import { createBehaviourSim } from './behaviourSim.js';

const HOSTILE = `
export default behaviour({
	name: 'Hostile',
	state: { reach: ['not run'] },
	inputs: ['probe'],
	on: {
		probe() {
			const g = (function () {}).constructor('return this')();
			this.state.reach = ['window', 'document', 'localStorage', 'indexedDB', 'fetch', 'XMLHttpRequest', 'WebSocket',
				'RTCPeerConnection', 'navigator', 'location', 'process', 'require', 'setTimeout', 'Buffer', '__host']
				.filter((k) => typeof g[k] !== 'undefined');
		}
	}
});
`;

const REENTRY = `
export default behaviour({
	name: 'Reentry',
	state: { log: [], scores: [0, 0] },
	inputs: ['go'],
	on: {
		go() {
			const scores = this.state.scores; // a nested object held across a kit call
			this.state.log.push('before');
			kit.score.add(5); // fires kit.score's change event synchronously on the authority
			scores[0] = kit.score.total(); // read-after-write sees the add
			this.state.log.push('after');
			this.bump();
		}
	},
	bump() {
		this.state.scores[1] += 1;
	}
});
`;

describe('behaviours in the guest', () => {
	it('a hostile file sees no window, storage, network, timers or host global', async () => {
		const sim = createBehaviourSim({ peers: ['a', 'b'] });
		await sim.load('h', HOSTILE);
		sim.advance(2500);
		sim.settle();
		sim.peer('a').bhv.input('h', 'probe', {}, sim.now());
		sim.settle();
		const state = JSON.parse(sim.states('h')[0]);
		if (process.env.BEHAVIOUR_REALM === 'host') expect(state.reach).toEqual(expect.arrayContaining(['fetch', 'process', 'setTimeout']));
		else expect(state.reach).toEqual([]);
	});

	it('state written before and after a re-entrant kit call, a held nested object and a method all land', async () => {
		const sim = createBehaviourSim({ peers: ['a', 'b'] });
		await sim.load('r', REENTRY);
		sim.advance(2500);
		sim.settle();
		sim.peer('a').bhv.input('r', 'go', {}, sim.now());
		sim.settle();
		expect(sim.states('r')).toEqual(Array(2).fill(JSON.stringify({ log: ['before', 'after'], scores: [5, 1] })));
	});
});
