// 34 R2 (kit-entities) — kit.spawner / kit.health / kit.mover as KIT PIECES, proven in the kit's
// headless logic sim (B5, tests/unit/sim/logicSim.js): the spec generates both faces, a node
// press seen by every peer acts ONCE, a non-authority's damage reaches the authority, a late
// joiner gets the whole set in its handshake, and the host leaving mid-wave hands the movers on.
import { describe, it, expect } from 'vitest';
import { createSim } from './logicSim.js';
import { specProblems, kitNodeItems } from '../../../src/lib/kit/spec.js';
import { KIT_PIECES } from '../../../src/lib/kit/index.js';
import { entitiesOfKit, setEntityHost } from '../../../src/lib/kit/entityHub.js';
import spawnerSpec from '../../../src/lib/kit/spawner.spec.js';
import healthSpec from '../../../src/lib/kit/health.spec.js';
import moverSpec from '../../../src/lib/kit/mover.spec.js';

/** @param {any} sim @param {string} id */
const rt = (sim, id) => entitiesOfKit(sim.peer(id).kit);
/** every peer holds the same entities (ids, hp, dead, pose) @param {any} sim */
function entitiesAgree(sim) {
	const views = [...sim.peers.values()].map((p) =>
		JSON.stringify(
			[...(entitiesOfKit(p.kit)?.store.ents.values() ?? [])].map((e) => [
				e.id,
				e.kind,
				e.health.hp,
				e.dead,
				e.pos.map((/** @type {number} */ v) => +v.toFixed(6))
			])
		)
	);
	return views.every((v) => v === views[0]);
}

/** step until a frame ends with the authority's poses all flushed AND delivered, then compare
 * (poses travel at 15 Hz; between flushes a receiver is legitimately a few cm behind)
 * @param {any} sim @param {string} auth */
function agreeAfterFlush(sim, auth) {
	for (let i = 0; i < 120; i++) {
		sim.step();
		if (rt(sim, auth).store.moved.size === 0 && entitiesAgree(sim)) return true;
	}
	return false;
}

describe('the entity pieces are spec-generated', () => {
	it('three clean specs, in the table, each generating its node group', () => {
		for (const spec of [spawnerSpec, healthSpec, moverSpec]) expect(specProblems(spec)).toEqual([]);
		const names = KIT_PIECES.map((r) => r.name);
		for (const n of ['spawner', 'health', 'mover']) expect(names).toContain(n);
		for (const r of KIT_PIECES) expect(r.name).toBe(r.piece.spec.piece);
		const spawn = kitNodeItems(spawnerSpec).find((i) => i.type === 'kit-spawner-spawn');
		expect(spawn?.inputs?.[0]).toBe('trigger');
		expect(spawn?.io.inputs.template).toBe('object');
		expect(kitNodeItems(healthSpec).find((i) => i.type === 'kit-health-died')?.io.output).toBe(
			'event'
		);
		expect(kitNodeItems(spawnerSpec).find((i) => i.type === 'kit-spawner-count')?.io.output).toBe(
			'number'
		);
	});

	it('api.kit.<piece> has every spec call (on<Name> for events) plus the code-only extras', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		const api = sim.peer('a').kit.api({ onDispose: () => {} });
		for (const k of [
			'spawn',
			'despawn',
			'clear',
			'count',
			'onSpawned',
			'onDespawned',
			'onEmptied',
			'list',
			'get',
			'setTags',
			'setData'
		])
			expect(typeof api.spawner[k]).toBe('function');
		for (const k of [
			'damage',
			'damageArea',
			'heal',
			'revive',
			'hp',
			'onDied',
			'onDamaged',
			'max',
			'alive'
		])
			expect(typeof api.health[k]).toBe('function');
		for (const k of ['chase', 'halt', 'knock', 'onStuck', 'seek', 'patrol', 'state'])
			expect(typeof api.mover[k]).toBe('function');
	});
});

describe('entity pieces in the logic sim (2 peers)', () => {
	it('a Spawn NODE pressed on every peer makes ONE wave (the request id is the stamp), and both peers hold it', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		const data = { kind: 'robot', count: 3, spread: 1, hp: 20, speed: 0, at: [0, 0, 0] };
		// the same replicated stamp reaches both peers' flowRuntime: both run the node
		for (const id of ['b', 'a'])
			sim.peer(id).kit.runNodeAction('kit-spawner-spawn', data, { rid: 'node:n1:1000.5' });
		sim.settle();
		expect(rt(sim, 'a').store.ents.size).toBe(3);
		expect(rt(sim, 'b').store.ents.size).toBe(3);
		expect(entitiesAgree(sim)).toBe(true);
		// COUNTERFACTUAL: two different stamps (two presses) make two waves
		sim.peer('b').kit.runNodeAction('kit-spawner-spawn', data, { rid: 'node:n1:1001.5' });
		sim.settle();
		expect(rt(sim, 'a').store.ents.size).toBe(6);
	});

	it('damage asked on the non-authority reaches the authority, kills, and every peer hears died + emptied', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		/** @type {Record<string, string[]>} */
		const heard = { a: [], b: [] };
		for (const id of ['a', 'b']) {
			const api = sim.peer(id).kit.api({ onDispose: () => {} });
			api.health.onDied((/** @type {any} */ p) => heard[id].push('died:' + p.authority));
			api.spawner.onEmptied((/** @type {any} */ p) => heard[id].push('emptied:' + p.authority));
		}
		const a = sim.peer('a').kit.api({});
		const [id] = a.spawner.spawn({ kind: 'robot', at: [1, 0, 1], hp: 10, removeAfter: 0.2 });
		sim.settle();
		const b = sim.peer('b').kit.api({});
		const r = b.health.damage(id, 4);
		expect(r).toBeUndefined(); // pending on the requester: the authority applies it
		sim.settle();
		expect(a.health.hp(id)).toBe(6);
		expect(b.health.hp(id)).toBe(6);
		b.health.damage(id, 50);
		sim.settle();
		expect(heard.a).toEqual(['died:true', 'emptied:true']);
		expect(heard.b).toEqual(['died:false', 'emptied:false']);
		// the damage is credited to the peer that asked
		expect(rt(sim, 'a').store.ents.get(id).health.by).toBe('b');
		sim.advance(400); // removeAfter
		expect(a.spawner.count()).toBe(0);
		expect(b.spawner.count()).toBe(0);
	});

	it('a value node reads replicated state; an event the authority witnessed pulses its node there only', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		/** @type {string[]} */
		const pulses = [];
		for (const id of ['a', 'b'])
			setEntityHost(sim.peer(id).kit, {
				pulse: (piece, ev) => pulses.push(id + ':kit-' + piece + '-' + ev)
			});
		sim.peer('a').kit.api({}).spawner.spawn({ kind: 'bat', count: 2, spread: 1 });
		sim.settle();
		expect(sim.peer('b').kit.evalNodeValue('kit-spawner-count', { kind: 'bat' })).toBe(2);
		expect(sim.peer('b').kit.evalNodeValue('kit-spawner-count', { kind: 'cat' })).toBe(0);
		expect(pulses.filter((p) => p.endsWith('spawned'))).toEqual([
			'a:kit-spawner-spawned',
			'a:kit-spawner-spawned'
		]);
	});

	it('a late joiner gets every entity in its handshake (kit.snapshots) and agrees', () => {
		const sim = createSim({ peers: ['a', 'b'], latency: 0 });
		sim
			.peer('a')
			.kit.api({})
			.spawner.spawn({ kind: 'robot', count: 5, spread: 2, mover: { speed: 2 } });
		sim.settle();
		sim.peer('a').kit.api({}).mover.chase('robot', 'nowhere'); // goals that resolve to nothing: idle
		sim.advance(500);
		sim.join('c');
		sim.settle();
		expect(rt(sim, 'c').store.ents.size).toBe(5);
		expect(agreeAfterFlush(sim, 'a')).toBe(true);
	});

	it('the host leaves mid-wave: the next authority rebuilds the movers and keeps them walking', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'], latency: 0 });
		const players = { p: [0, 0, 20] };
		for (const id of ['a', 'b', 'c'])
			setEntityHost(sim.peer(id).kit, {
				resolveTarget: (ref) => (ref === 'player' ? players.p : null)
			});
		sim
			.peer('a')
			.kit.api({})
			.spawner.spawn({ kind: 'robot', count: 6, spread: 2, mover: { speed: 2 } });
		sim.settle();
		sim.peer('a').kit.api({}).mover.chase('robot', 'player');
		sim.advance(2000);
		const before = [...rt(sim, 'b').store.ents.values()].map((e) => e.pos[2]);
		sim.leave('a');
		// the new authority re-issues the order (game logic re-runs on whoever is authority)
		sim.peer('b').kit.api({}).mover.chase('robot', 'player');
		sim.advance(2000);
		const after = [...rt(sim, 'b').store.ents.values()].map((e) => e.pos[2]);
		expect(after.every((z, i) => z > before[i] + 2)).toBe(true);
		expect(agreeAfterFlush(sim, 'b')).toBe(true);
	});
	it('a joiner with a LOWER id becomes the authority on connect: it adopts the wave instead of wiping it', () => {
		const sim = createSim({ peers: ['m', 'n'], latency: 0 });
		const players = { p: [0, 0, 30] };
		const hostFor = (/** @type {string} */ id) =>
			setEntityHost(sim.peer(id).kit, {
				resolveTarget: (ref) => (ref === 'player' ? players.p : null)
			});
		hostFor('m');
		hostFor('n');
		sim
			.peer('m')
			.kit.api({})
			.spawner.spawn({ kind: 'robot', count: 4, spread: 2, mover: { speed: 2 } });
		sim.settle();
		sim.peer('m').kit.api({}).mover.chase('robot', 'player');
		sim.advance(1000);
		sim.add('a');
		hostFor('a');
		sim.join('a'); // 'a' < 'm': the authority moves to the newcomer the moment it connects
		sim.settle();
		expect(rt(sim, 'a').debug().authority).toBe(true);
		for (const id of ['a', 'm', 'n']) expect(rt(sim, id).store.ents.size).toBe(4);
		// and the new authority keeps the wave walking (game logic re-issues its order there)
		const z0 = [...rt(sim, 'n').store.ents.values()].map((e) => e.pos[2]);
		sim.peer('a').kit.api({}).mover.chase('robot', 'player');
		sim.advance(1500);
		const z1 = [...rt(sim, 'n').store.ents.values()].map((e) => e.pos[2]);
		expect(z1.every((z, i) => z > z0[i] + 1)).toBe(true);
		expect(agreeAfterFlush(sim, 'a')).toBe(true);
	});
	it('a NEW ROUND (kit.round start / restart) clears the wave on every peer', () => {
		const sim = createSim({ peers: ['a', 'b'], latency: 0 });
		const a = sim.peer('a').kit.api({});
		a.round.configure(0);
		a.round.start();
		sim.settle();
		a.spawner.spawn({ kind: 'robot', count: 5, spread: 2 });
		sim.settle();
		expect(rt(sim, 'b').store.ents.size).toBe(5);
		sim.peer('b').kit.api({}).round.restart();
		sim.settle();
		expect(rt(sim, 'a').store.ents.size).toBe(0);
		expect(rt(sim, 'b').store.ents.size).toBe(0);
		// and the same round going on (pause / resume) keeps them
		a.spawner.spawn({ kind: 'robot', count: 3, spread: 2 });
		a.round.pause();
		a.round.resume();
		sim.settle();
		expect(rt(sim, 'b').store.ents.size).toBe(3);
	});
	it("T2: a module's entities carry its id and leave with it (disown on the authority only)", () => {
		const sim = createSim({ peers: ['a', 'b'], latency: 0 });
		const sp = sim.peer('a').kit.impls.spawner;
		// what kitApi's `owned` wrapper hands the impl: the spec's 8 args, then the module id
		sp.spawn(
			{ kind: 'robot', count: 3, spread: 1 },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			'waves'
		);
		sp.spawn('bat', '', [0, 0, 0], 2, 1, 5, 0, 1, 'other');
		sp.spawn({ kind: 'crate' }); // a node / core call: no owner
		sim.settle();
		expect([...rt(sim, 'b').store.ents.values()].filter((e) => e.own === 'waves').length).toBe(3);
		// a non-authority unloading its copy of the module leaves the session's entities alone
		expect(sim.peer('b').kit.impls.spawner.disown('waves')).toBe(0);
		expect(sp.disown('waves')).toBe(3);
		sim.settle();
		expect(rt(sim, 'b').store.ents.size).toBe(3);
		expect([...rt(sim, 'b').store.ents.values()].map((e) => e.own).sort()).toEqual([
			'',
			'other',
			'other'
		]);
	});
	it("T2 through the SDK face: a module's spawn is owned, and its teardown clears exactly its entities", () => {
		const sim = createSim({ peers: ['a', 'b'], latency: 0 });
		/** @type {(() => void)[]} */
		const journal = [];
		const mod = sim
			.peer('a')
			.kit.api({
				moduleId: 'waves',
				onDispose: (/** @type {() => void} */ fn) => journal.push(fn)
			});
		mod.spawner.spawn({ kind: 'robot', count: 4, spread: 1 });
		mod.spawner.spawn({ kind: 'robot', count: 2, spread: 1 });
		sim
			.peer('a')
			.kit.api({ moduleId: 'other', onDispose: () => {} })
			.spawner.spawn({ kind: 'bat', count: 1 });
		sim.settle();
		expect(rt(sim, 'b').store.ents.size).toBe(7);
		for (const fn of journal) fn(); // the module unloads
		sim.settle();
		expect([...rt(sim, 'b').store.ents.values()].map((e) => e.own)).toEqual(['other']);
	});
});

describe('78 F23: the dead leave the count, on every peer', () => {
	it('code spawns with no removeAfter leave 1 s after death (the node default), everywhere; emptied pulses once at the last death', () => {
		const sim = createSim({ peers: ['a', 'b'] });
		/** @type {string[]} */
		const pulses = [];
		for (const id of ['a', 'b'])
			setEntityHost(sim.peer(id).kit, { pulse: (piece, ev) => pulses.push(id + ':' + piece + '-' + ev) });
		const auth = sim.authorities()[0];
		const other = auth === 'a' ? 'b' : 'a';
		// research round 2's shape: a behaviour's spawn({kind, template, at, count, hp}) with no removeAfter
		sim.peer(other).kit.api({}).spawner.spawn({ kind: 'labfoe', count: 2, hp: 30 });
		sim.settle();
		const ids = [...rt(sim, auth).store.ents.keys()];
		expect(ids.length).toBe(2);
		for (const id of ids) sim.peer(other).kit.api({}).health.damage(id, 999);
		sim.settle();
		for (const id of ['a', 'b']) expect(sim.peer(id).kit.evalNodeValue('kit-spawner-count', { kind: '' }), id).toBe(0);
		expect(pulses.filter((p) => p.endsWith('emptied'))).toEqual([auth + ':spawner-emptied']);
		sim.advance(1200);
		for (const id of ['a', 'b']) {
			expect(rt(sim, id).store.ents.size, id + ' still holds the dead').toBe(0);
			expect(rt(sim, id).debug().count, id).toBe(0);
		}
		expect(pulses.filter((p) => p.endsWith('despawned')).length).toBe(2);
		expect(pulses.filter((p) => p.endsWith('emptied')).length).toBe(1); // the removals do not pulse it again
	});
	it('removeAfter: -1 keeps the dead (bodies on the floor) — the debug count says living, the store keeps them', () => {
		const sim = createSim({ peers: ['a'] });
		sim.peer('a').kit.api({}).spawner.spawn({ kind: 'corpse', count: 1, hp: 1, removeAfter: -1 });
		sim.settle();
		const [id] = [...rt(sim, 'a').store.ents.keys()];
		sim.peer('a').kit.api({}).health.damage(id, 5);
		sim.advance(3000);
		expect(rt(sim, 'a').store.ents.size).toBe(1);
		expect(rt(sim, 'a').debug()).toMatchObject({ count: 0, stored: 1, living: 0 });
	});
});

describe('78 F21: mover chase / halt and health damageArea on SPAWNED entities, from nodes on a non-authority', () => {
	it('spawn -> chase a target object -> halt -> damageArea: every peer agrees at each step', () => {
		const sim = createSim({ peers: ['a', 'b'], latency: 0 }); // poses compared exactly (agreeAfterFlush)
		const TARGET = 'target-uuid';
		for (const id of ['a', 'b'])
			setEntityHost(sim.peer(id).kit, { resolveTarget: (ref) => (ref === TARGET ? [5, 0.3, 5] : null) });
		const auth = sim.authorities()[0];
		const other = sim.peer(auth === 'a' ? 'b' : 'a');
		const node = (/** @type {string} */ type, /** @type {any} */ data, /** @type {number} */ n) => other.kit.runNodeAction(type, data, { rid: 'node:' + type + ':' + n });
		node('kit-spawner-spawn', { kind: 'enemy', template: '', at: [-3, 0.4, -3], count: 3, spread: 1, hp: 5, speed: 1, removeAfter: 1 }, 1);
		sim.settle();
		const pos = () => [...rt(sim, auth).store.ents.values()].map((e) => [e.pos[0], e.pos[2]]);
		const dist = () => pos().map(([x, z]) => Math.hypot(5 - x, 5 - z));
		expect(pos().length).toBe(3);
		const d0 = dist();
		// chase: a node naming the target OBJECT (an uuid the app resolves to its place)
		node('kit-mover-chase', { kind: 'enemy', target: TARGET }, 2);
		sim.advance(1500);
		const d1 = dist();
		expect(d1.every((d, i) => d < d0[i] - 0.8), 'every entity walked toward the target: ' + JSON.stringify({ d0, d1 })).toBe(true);
		expect(agreeAfterFlush(sim, auth)).toBe(true);
		// halt: they stop where they are
		node('kit-mover-halt', { kind: 'enemy' }, 3);
		sim.advance(300); // the halt lands and the last stride settles
		const p1 = pos();
		sim.advance(1500);
		const p2 = pos();
		expect(p2.every(([x, z], i) => Math.hypot(x - p1[i][0], z - p1[i][1]) < 0.05), 'halted: ' + JSON.stringify({ p1, p2 })).toBe(true);
		expect(agreeAfterFlush(sim, auth)).toBe(true);
		// damageArea around the first entity, radius 3 (kind '' = any): every one inside loses 2 hp
		const [cx, cz] = p2[0];
		const inside = p2.filter(([x, z]) => Math.hypot(x - cx, z - cz) <= 3).length;
		expect(inside).toBeGreaterThan(0);
		node('kit-health-damageArea', { at: [cx, 0.4, cz], radius: 3, amount: 2, kind: '' }, 4);
		sim.settle();
		sim.advance(200); // hp rides the 15 Hz pose flush
		for (const id of ['a', 'b']) {
			const hp = [...rt(sim, id).store.ents.values()].map((e) => e.health.hp);
			expect(hp.filter((v) => v === 3).length, id + ' hp ' + JSON.stringify(hp)).toBe(inside);
		}
		// and again until they die: the Count node goes to 0 on both peers
		node('kit-health-damageArea', { at: [cx, 0.4, cz], radius: 3, amount: 10, kind: '' }, 5);
		sim.settle();
		sim.advance(200);
		for (const id of ['a', 'b']) expect(sim.peer(id).kit.evalNodeValue('kit-spawner-count', { kind: 'enemy' })).toBe(3 - inside);
	});
});
