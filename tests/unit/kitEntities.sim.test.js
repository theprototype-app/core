// 34 R2 (kit-entities) — THE PROOF PORT: a Waves-like test scene in the headless logic sim.
// Twenty robots spawn at a portal, chase the players round a wall (the W1 class: the straight
// line from the portal to the players runs INTO the wall, so seeking alone pins them there),
// take damage from both players (the non-host's shots travel as requests to the authority),
// are knocked back, die and leave. Every check runs on two peers that must agree on every
// entity's state, a late joiner that must catch up, and a host that leaves mid-wave.
import { describe, it, expect } from 'vitest';
import { createKitSim } from './sim/kitEntitiesHarness.js';

const DT = 1 / 30;
/** the arena: a wall between the portal (z = -12) and the players (z = +10), open only at x > 3 */
const WORLD = {
	obstacles: [
		{ minX: -16, maxX: 3, minZ: 0, maxZ: 0.6 },
		{ x: 7, z: 5, r: 1 },
		{ x: -6, z: 6, r: 1.2 }
	],
	bounds: { minX: -16, maxX: 16, minZ: -16, maxZ: 14 },
	groundY: 0
};
const PORTAL = [-6, 0, -12];
const SHOT_RANGE = 4;
const SHOT_EVERY = 0.3;

/**
 * Run the Waves-like round. Game logic runs on whichever peer is the authority (a behaviour's
 * handlers, §4.4); SHOOTING runs on every player's own peer from its own replicated view.
 * @param {{peers?: string[], mover?: any, secs?: number, onStep?: (sim: any) => void, events?: boolean}} [o]
 */
function playRound(o = {}) {
	const peerIds = o.peers ?? ['A', 'B'];
	const sim = createKitSim({
		peers: peerIds,
		world: WORLD,
		players: { A: [-2, 0, 10], B: [3, 0, 11], C: [0, 0, 12] }
	});
	/** per peer: event counts */
	/** @type {Record<string, Record<string, number>>} */
	const seen = {};
	/** @param {string} id */
	const watch = (id) => {
		const k = sim.kit(id);
		seen[id] = { spawn: 0, death: 0, despawn: 0, damage: 0, stuck: 0 };
		k.api.spawner.onSpawn(() => seen[id].spawn++);
		k.api.spawner.onDespawn(() => seen[id].despawn++);
		k.api.health.onDeath(() => seen[id].death++);
		k.api.health.onDamage(() => seen[id].damage++);
		k.api.mover.onStuck(() => seen[id].stuck++);
		// knock-back on every hit, applied by the authority from its own event
		k.api.health.onDamage((/** @type {any} */ p) => {
			if (!p.authority || p.entity.dead) return;
			const shooter = sim.players[p.by] ?? sim.players.A;
			const dx = p.entity.pos[0] - shooter[0];
			const dz = p.entity.pos[2] - shooter[2];
			const d = Math.hypot(dx, dz) || 1;
			k.api.mover.knock(p.entity.id, [(dx / d) * 3, (dz / d) * 3]);
		});
	};
	for (const id of peerIds) watch(id);

	let spawned = false;
	let nextRetarget = 0;
	/** @type {Record<string, number>} */
	const nextShot = {};
	const secs = o.secs ?? 90;
	const n = Math.round(secs / DT);
	for (let i = 0; i < n; i++) {
		const t = sim.now();
		const authId = sim.authorityId();
		const auth = authId ? sim.kit(authId) : null;
		if (auth && !spawned && t >= 0.5) {
			const ids = auth.api.spawner.spawn({
				kind: 'robot',
				at: PORTAL,
				count: 20,
				spread: 3,
				hp: 30,
				tags: ['enemy'],
				removeAfter: 1,
				mover: { speed: 2.2, reach: 1.2, ...(o.mover ?? {}) }
			});
			expect(ids.length).toBe(20);
			spawned = true;
		}
		// THE BEHAVIOUR (authority): every robot chases its nearest connected player
		if (auth && t >= nextRetarget) {
			nextRetarget = t + 0.5;
			const live = [...sim.peers.values()].filter((p) => p.connected).map((p) => p.id);
			for (const r of auth.api.spawner.list({ kind: 'robot', alive: true })) {
				let best = live[0];
				let bd = Infinity;
				for (const pid of live) {
					const p = sim.players[pid];
					const d = Math.hypot(p[0] - r.pos[0], p[2] - r.pos[2]);
					if (d < bd) {
						bd = d;
						best = pid;
					}
				}
				auth.api.mover.seek(r.id, 'player:' + best);
			}
		}
		// THE PLAYERS (every peer, from its own view): shoot the nearest robot in range
		for (const p of sim.peers.values()) {
			if (!p.connected || t < (nextShot[p.id] ?? 0)) continue;
			nextShot[p.id] = t + SHOT_EVERY;
			const me = sim.players[p.id];
			let target = null;
			let bd = SHOT_RANGE;
			for (const r of p.kit.api.spawner.list({ alive: true })) {
				const d = Math.hypot(r.pos[0] - me[0], r.pos[2] - me[2]);
				if (d < bd) {
					bd = d;
					target = r;
				}
			}
			if (target) p.kit.api.health.damage(target.id, 10, p.id);
		}
		sim.step(DT);
		o.onStep?.(sim);
	}
	return { sim, seen };
}

/** every entity on `b` equals the authority's (after a flush) @param {any} a @param {any} b */
function agree(a, b) {
	const ka = [...a.kit.store.ents.keys()].sort();
	const kb = [...b.kit.store.ents.keys()].sort();
	if (ka.join() !== kb.join()) return 'ids differ: ' + ka.length + ' vs ' + kb.length;
	for (const id of ka) {
		const x = a.kit.store.ents.get(id);
		const y = b.kit.store.ents.get(id);
		if (x.dead !== y.dead) return id + ' dead ' + x.dead + ' vs ' + y.dead;
		if (Math.abs(a.kit.api.health.hp(id) - b.kit.api.health.hp(id)) > 1e-9)
			return id + ' hp ' + a.kit.api.health.hp(id) + ' vs ' + b.kit.api.health.hp(id);
		for (let k = 0; k < 3; k++)
			if (Math.abs(x.pos[k] - y.pos[k]) > 1e-9) return id + ' pos ' + x.pos + ' vs ' + y.pos;
	}
	return '';
}

describe('Waves-like round: 20 robots, 2 peers', () => {
	it('all 20 spawn on both peers, chase round the wall, take damage from BOTH players, die and leave', () => {
		const { sim, seen } = playRound();
		for (const id of ['A', 'B']) {
			expect(seen[id].spawn).toBe(20);
			expect(seen[id].death).toBe(20);
			expect(seen[id].despawn).toBe(20);
			expect(sim.kit(id).spawner.count()).toBe(0);
		}
		// B (not the authority) shot too: its shots crossed the wire as requests
		expect(sim.stats.requests).toBeGreaterThan(0);
		expect(sim.stats.refused).toBe(0);
	});

	it('the two peers agree on EVERY entity after every authority flush', () => {
		/** @type {string[]} */
		const bad = [];
		let checks = 0;
		let lastSent = 0;
		playRound({
			onStep: (sim) => {
				if (sim.stats.sent === lastSent) return;
				lastSent = sim.stats.sent;
				// compare only on ticks that flushed POSES (the authority flushes at 15 Hz)
				const a = sim.peers.get('A');
				const b = sim.peers.get('B');
				const moved = [...a.kit.store.ents.values()].some(
					(/** @type {any} */ e) => e.mover && e.mover.vel && (e.mover.vel[0] || e.mover.vel[1])
				);
				if (a.kit.store.moved.size) return; // a tick that changed poses without flushing them
				checks++;
				const why = agree(a, b);
				if (why) bad.push(sim.now().toFixed(2) + ' ' + why);
				void moved;
			}
		});
		expect(checks).toBeGreaterThan(200);
		expect(bad).toEqual([]);
	});

	it('no robot is ever stuck: each is always making headway, in reach, or queued behind one that is', () => {
		/** robot id -> {t, d, g} the last time it made 0.5 m of headway toward target g */
		const last = new Map();
		let worst = 0;
		playRound({
			onStep: (sim) => {
				const a = sim.kit('A');
				const t = sim.now();
				for (const e of a.store.ents.values()) {
					if (e.dead || !e.mover) {
						last.delete(e.id);
						continue;
					}
					const m = e.mover;
					// headway toward what it is heading for NOW (a re-path's waypoint walks AWAY from
					// the goal on purpose)
					const g = m.route[0] ?? m.goal;
					if (!g) continue;
					const d = Math.hypot(g[0] - e.pos[0], g[1] - e.pos[2]);
					const rec = last.get(e.id);
					const same = rec && rec.g[0] === g[0] && rec.g[1] === g[1];
					if (m.arrived || m.waiting || m.knock[0] || m.knock[1] || !same || d < rec.d - 0.5) {
						last.set(e.id, { t, d, g: [g[0], g[1]] });
						continue;
					}
					worst = Math.max(worst, t - rec.t);
				}
			}
		});
		// a recovery takes a stuck window (0.8 s) plus a detour; anything near 6 s is a jam
		expect(worst).toBeLessThan(6);
	});

	it('COUNTERFACTUAL: with stuck recovery off, robots pin themselves behind the wall and the round never ends', () => {
		const { sim, seen } = playRound({ mover: { stuckAfter: 1e9, avoid: 0 } });
		expect(seen.A.death).toBeLessThan(20);
		const pinned = sim
			.kit('A')
			.api.spawner.list({ alive: true })
			.filter((/** @type {any} */ r) => r.pos[2] < 0.6);
		expect(pinned.length).toBeGreaterThan(0);
	});
});

describe('Waves-like round: a late joiner and the host leaving mid-wave', () => {
	it('C joins at 8 s and catches up; A (the host) leaves at 15 s; B takes over and the wave still ends', () => {
		/** @type {string[]} */
		const bad = [];
		let joined = false;
		let dropped = false;
		/** B's view of how far the robots moved after the takeover */
		let movedAfter = 0;
		/** @type {Map<string, number[]>} */
		const at15 = new Map();
		const cSeen = { death: 0, despawn: 0 };
		const { sim, seen } = playRound({
			secs: 120,
			onStep: (s) => {
				const t = s.now();
				if (!joined && t >= 8) {
					joined = true;
					s.join('C');
					const c = s.kit('C');
					c.api.health.onDeath(() => cSeen.death++);
					c.api.spawner.onDespawn(() => cSeen.despawn++);
					const why = agree(s.peers.get('A'), s.peers.get('C'));
					if (why) bad.push('join: ' + why);
				}
				if (!dropped && t >= 15) {
					dropped = true;
					for (const e of s.kit('B').store.ents.values()) at15.set(e.id, [...e.pos]);
					s.drop('A');
				}
				if (
					dropped &&
					s.authorityId() === 'B' &&
					s.peers.get('C').kit.store.moved.size === 0 &&
					s.kit('B').store.moved.size === 0
				) {
					const why = agree(s.peers.get('B'), s.peers.get('C'));
					if (why) bad.push(t.toFixed(2) + ' ' + why);
				}
				if (dropped && t > 20 && !movedAfter) {
					for (const e of s.kit('B').store.ents.values()) {
						const p = at15.get(e.id);
						if (p) movedAfter = Math.max(movedAfter, Math.hypot(e.pos[0] - p[0], e.pos[2] - p[2]));
					}
				}
			}
		});
		expect(sim.authorityId()).toBe('B');
		expect(movedAfter).toBeGreaterThan(1); // the new authority's movers kept the robots walking
		expect(bad).toEqual([]);
		// every robot alive at the hand-over still died: B and C saw the whole wave end
		expect(seen.B.death).toBe(20);
		expect(sim.kit('B').api.spawner.count()).toBe(0);
		expect(sim.kit('C').api.spawner.count()).toBe(0);
		// C saw every death that happened after it joined, and every departure
		expect(cSeen.death).toBeGreaterThan(0);
		expect(cSeen.despawn).toBeGreaterThanOrEqual(cSeen.death);
	});
});
