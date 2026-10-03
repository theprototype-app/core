// 34 R3 (D1) — behaviours on the logic sim: the format, the authority, replicated state,
// session-clock timers that survive the host leaving, seeded rand, the two proof ports.
import { describe, it, expect } from 'vitest';
import { createBehaviourSim, exampleSource } from './behaviourSim.js';

const WAVES = exampleSource('waves-spawner.js');
const REACH = exampleSource('towers-reach.js');
const OBJECTS = [
	{ uuid: 'tpl-robot', name: 'Robot', pos: [0, 0, -8] },
	{ uuid: 'gate-1', name: 'Spawn gate', pos: [4, 0, -10] },
	{ uuid: 'floor', name: 'Floor', pos: [0, 0, 0], tags: ['ground'] },
	{ uuid: 'piece-1', name: 'Piece 1', pos: [0, 1, -1], tags: ['piece'] }
];

/** kill every living robot, asked from peer `from` @param {any} sim @param {string} from */
function killAll(sim, from) {
	const p = sim.peer(from);
	for (const e of p.kit.impls.spawner.extra.list({ kind: 'robot', alive: true })) p.kit.impls.health.damage(e.id, 999);
	sim.settle();
}
const robots = (/** @type {any} */ sim, /** @type {string} */ id) => sim.peer(id).kit.impls.spawner.count('robot');

describe('behaviours — a Waves-style spawner on kit entities', () => {
	it('round go -> wave 1 (2 robots) spawned ONCE, wave/alive replicated to every peer', async () => {
		const sim = createBehaviourSim({ peers: ['a', 'b', 'c'], objects: OBJECTS });
		await sim.load('waves', WAVES);
		sim.advance(100);
		sim.peer('c').kit.impls.round.start();
		sim.advance(3300); // the 3 s intro, then go
		sim.settle();
		expect(sim.peer('a').kit.impls.round.phase()).toBe('playing');
		expect(sim.states('waves')).toEqual(Array(3).fill(JSON.stringify({ wave: 1, alive: 2 })));
		expect([robots(sim, 'a'), robots(sim, 'b'), robots(sim, 'c')]).toEqual([2, 2, 2]);
		// spawned at the gate, drawn from the Robot template
		const e = sim.peer('b').kit.impls.spawner.extra.list({ kind: 'robot' })[0];
		expect(e.tpl).toBe('tpl-robot');
		expect(Math.abs(e.pos[0] - 4)).toBeLessThan(2);
		// the handler ran on the authority only
		expect(sim.peer('a').bhv.live('waves').fired['on.go'].n).toBe(1);
		expect(sim.peer('b').bhv.stats.dispatched).toBe(0);
		// ...and every peer sees it fired (the glow rides the document)
		expect(sim.peer('b').bhv.live('waves').fired['on.go'].n).toBe(1);
	});

	it('last robot dies -> next wave after `interval` on the session clock; sizes grow; last wave wins the round', async () => {
		const sim = createBehaviourSim({ peers: ['a', 'b'], objects: OBJECTS });
		await sim.load('waves', WAVES);
		sim.advance(100);
		sim.peer('b').kit.impls.round.start();
		sim.advance(3300);
		sim.settle();
		const sizes = [robots(sim, 'b')];
		for (let w = 2; w <= 5; w++) {
			killAll(sim, 'b'); // a non-authority player kills them (damage is asked, applied once)
			expect(JSON.parse(sim.states('waves')[1]).alive).toBe(0);
			sim.advance(2500);
			expect(robots(sim, 'a')).toBe(0); // not yet: interval is 3 s
			sim.advance(700);
			sim.settle();
			sizes.push(robots(sim, 'b'));
			expect(JSON.parse(sim.states('waves')[1]).wave).toBe(w);
		}
		expect(sizes).toEqual([2, 3, 4, 5, 6]);
		killAll(sim, 'a');
		sim.advance(3200);
		sim.settle();
		expect(sim.peer('b').kit.impls.round.phase()).toBe('won');
		expect(sim.peer('b').kit.impls.round.outcome()).toBe('All waves cleared');
	});

	it('the host leaves between waves: the next authority fires the pending timer (it lives in the document)', async () => {
		const sim = createBehaviourSim({ peers: ['a', 'b', 'c'], objects: OBJECTS });
		await sim.load('waves', WAVES);
		sim.advance(100);
		sim.peer('a').kit.impls.round.start();
		sim.advance(3300);
		sim.settle();
		killAll(sim, 'c');
		expect(sim.peer('b').bhv.live('waves').timers.map((/** @type {any} */ t) => t.method)).toEqual(['startWave']);
		sim.leave('a'); // the authority (smallest id) is gone mid-interval
		sim.advance(3300);
		sim.settle();
		expect(sim.authorityPeer().id).toBe('b');
		expect(sim.states('waves')).toEqual(Array(2).fill(JSON.stringify({ wave: 2, alive: 3 })));
		expect(robots(sim, 'c')).toBe(3);
	});

	it('a joiner with the SMALLEST id does not reset a game in progress (it waits for the document)', async () => {
		const sim = createBehaviourSim({ peers: ['m', 'n'], objects: OBJECTS });
		await sim.load('waves', WAVES);
		sim.advance(100);
		sim.peer('n').kit.impls.round.start();
		sim.advance(3300);
		sim.settle();
		expect(JSON.parse(sim.states('waves')[0]).wave).toBe(1);
		await sim.joinWithBehaviours('a'); // 'a' < 'm': the authority the moment it connects
		sim.settle();
		expect(sim.authorityPeer().id).toBe('a');
		expect(sim.states('waves')).toEqual(Array(3).fill(JSON.stringify({ wave: 1, alive: 2 })));
		// and it carries on: the wave dies, the joiner (now authority) starts wave 2
		killAll(sim, 'm');
		sim.advance(3300);
		sim.settle();
		expect(JSON.parse(sim.states('waves')[2]).wave).toBe(2);
	});

	it('the GRACE: a lowest-id joiner whose handshake is slow does not start the behaviour over the session', async () => {
		const sim = createBehaviourSim({ peers: ['m', 'n'], objects: OBJECTS, latency: 600 });
		await sim.load('waves', WAVES);
		sim.advance(100);
		sim.peer('n').kit.impls.round.start();
		sim.advance(5000);
		sim.settle();
		expect(JSON.parse(sim.states('waves')[0]).wave).toBe(1);
		const a = await sim.joinWithBehaviours('a');
		sim.advance(300); // 'a' ticks as the authority before any document can reach it
		expect(a.bhv.live('waves').synced).toBe(false);
		expect(a.bhv.live('waves').started).toBe(false);
		sim.advance(1500);
		sim.settle();
		expect(sim.states('waves')).toEqual(Array(3).fill(JSON.stringify({ wave: 1, alive: 2 })));
		expect(a.bhv.live('waves').fired['on.start']).toBeUndefined();
	});

	it('removed on every peer while a promoted joiner is the authority: its entities still leave (T2)', async () => {
		const sim = createBehaviourSim({ peers: ['m', 'n'], objects: OBJECTS });
		await sim.load('waves', WAVES);
		sim.advance(100);
		sim.peer('n').kit.impls.round.start();
		sim.advance(3300);
		sim.settle();
		await sim.joinWithBehaviours('a');
		sim.advance(3000);
		sim.settle();
		expect(sim.authorityPeer().id).toBe('a');
		expect(robots(sim, 'a')).toBe(2);
		for (const id of ['m', 'n', 'a']) sim.peer(id).unloadBehaviour('waves');
		sim.advance(500);
		sim.settle();
		expect([robots(sim, 'a'), robots(sim, 'm'), robots(sim, 'n')]).toEqual([0, 0, 0]);
	});

	it('a source edit (reload) keeps the replicated state; a new param applies at once', async () => {
		const sim = createBehaviourSim({ peers: ['a', 'b'], objects: OBJECTS });
		await sim.load('waves', WAVES);
		sim.advance(100);
		sim.peer('a').kit.impls.round.start();
		sim.advance(3300);
		sim.settle();
		await sim.load('waves', WAVES.replace('sizeStep: { value: 1,', 'sizeStep: { value: 4,'));
		sim.settle();
		expect(JSON.parse(sim.states('waves')[0])).toEqual({ wave: 1, alive: 2 });
		killAll(sim, 'a');
		sim.advance(3300);
		sim.settle();
		expect(robots(sim, 'b')).toBe(6); // 2 + 4·1
	});
});

describe('behaviours — Towers reach as a grab veto (a LOCAL event)', () => {
	const req = (/** @type {number} */ d) => ({ point: [0, 1.6, -d], eye: [0, 1.6, 0], feetY: 0, uuid: 'piece-1', name: 'Piece 1', hand: 'desktop' });
	it('refuses beyond the reach on the grabbing peer (not the authority), allows within', async () => {
		const sim = createBehaviourSim({ peers: ['a', 'b'], objects: OBJECTS });
		await sim.load('reach', REACH);
		sim.settle();
		const rules = sim.peer('b').kit.impls.rules.extra;
		expect(rules.checkGrab(req(1.0)).ok).toBe(true);
		const far = rules.checkGrab(req(2.0));
		expect(far).toMatchObject({ ok: false, reason: 'Too far - climb closer' });
		// it ran where the grab happened, and the shared rule table is untouched
		expect(sim.peer('b').bhv.live('reach').fired['on.grabRequest'].n).toBe(2);
		expect(sim.peer('a').bhv.live('reach').fired['on.grabRequest']).toBeUndefined();
		expect(sim.peer('a').kit.impls.rules.reach()).toBe(0);
		// the ground is never refused
		expect(rules.checkGrab({ ...req(5), uuid: 'floor', name: 'Floor' }).ok).toBe(true);
	});
	it('the knob (setParam) changes the verdict at once on that peer', async () => {
		const sim = createBehaviourSim({ peers: ['a'], objects: OBJECTS });
		await sim.load('reach', REACH);
		const rules = sim.peer('a').kit.impls.rules.extra;
		expect(rules.checkGrab(req(2.0)).ok).toBe(false);
		sim.peer('a').bhv.setParam('reach', 'reach', 2.5);
		expect(rules.checkGrab(req(2.0)).ok).toBe(true);
	});
	it('unloading the behaviour removes its veto (T2: its listeners leave with it)', async () => {
		const sim = createBehaviourSim({ peers: ['a'], objects: OBJECTS });
		await sim.load('reach', REACH);
		const rules = sim.peer('a').kit.impls.rules.extra;
		expect(rules.checkGrab(req(2.0)).ok).toBe(false);
		sim.peer('a').unloadBehaviour('reach');
		expect(rules.checkGrab(req(2.0)).ok).toBe(true);
	});
});

describe('behaviours — the runtime rules', () => {
	const SRC = `export default behaviour({
	params: { n: 3 },
	state: { rolls: [], count: 0 },
	on: {
		start() { this.roll(); },
		grabRequest({ refuse }) { this.state.count = 99; }
	},
	roll() { for (let i = 0; i < this.params.n; i++) this.state.rolls.push(this.randInt(1, 6)); }
});`;
	it('rand is seeded per dispatch: two sessions roll the same numbers; start runs once', async () => {
		const one = createBehaviourSim({ peers: ['a', 'b'] });
		one.advance(2100); // past the handshake grace: nobody holds a document, 'a' may start it
		await one.load('dice', SRC);
		one.advance(200);
		const two = createBehaviourSim({ peers: ['a'] });
		await two.load('dice', SRC);
		two.advance(200);
		const r1 = JSON.parse(one.states('dice')[1]).rolls;
		expect(r1.length).toBe(3);
		expect(JSON.parse(two.states('dice')[0]).rolls).toEqual(r1);
		one.advance(2000);
		expect(JSON.parse(one.states('dice')[0]).rolls.length).toBe(3);
	});
	it('a local handler may not write state (put back, counted)', async () => {
		const sim = createBehaviourSim({ peers: ['a', 'b'] });
		sim.advance(2100);
		await sim.load('dice', SRC);
		sim.advance(200);
		sim.peer('b').kit.impls.rules.extra.checkGrab({ point: [0, 0, 0], eye: [0, 1, 0], feetY: 0 });
		expect(JSON.parse(sim.states('dice')[1]).count).toBe(0);
		expect(sim.peer('b').bhv.stats.refusedWrites).toBe(1);
	});
	it('the loop guard stops a runaway handler without stopping the runtime', async () => {
		const sim = createBehaviourSim({ peers: ['a'] });
		await sim.load('loop', 'export default behaviour({ state: {x: 0}, on: { start() { while (true) { this.state.x++; } } } });');
		sim.advance(100);
		const live = sim.peer('a').bhv.live('loop');
		expect(live.errors[0].message).toMatch(/loop limit/i);
		expect(live.started).toBe(true);
	});
	it('an unknown event is a problem, not a crash', async () => {
		const sim = createBehaviourSim({ peers: ['a'] });
		await sim.load('odd', 'export default behaviour({ on: { noSuchThing() {} } });');
		expect(sim.peer('a').bhv.live('odd').problems).toEqual(['on.noSuchThing: no such event']);
	});
});
