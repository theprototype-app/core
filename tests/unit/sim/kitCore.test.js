// 34 R2 / B5: the kit runtime's own contract, proven on the headless logic sim with a TEST piece
// (a tally) so nothing here depends on what the real pieces do. The real pieces have their own
// files beside this one.
import { describe, it, expect } from 'vitest';
import { createSim, agree, FRAME_MS } from './logicSim.js';
import { RESEND_MS, newerDoc } from '../../../src/lib/kit/core.js';
import { kitNodeItems, specProblems, kitApi, kitNodeType, argsFromData } from '../../../src/lib/kit/spec.js';
import { pickAuthority, isAuthorityFor } from '../../../src/lib/kit/authority.js';
import { validateWireMessage } from '../../../src/lib/wireValidate.js';

/** a tally: add(n) (authority), total(), a `hit` event per add, and a timed `ring` 1 s after the
 * first add (a tick-derived moment, the round-countdown shape) */
const tally = {
	/** @type {import('../../../src/lib/kit/spec.js').KitSpec} */
	spec: {
		piece: 'tally',
		group: 'Kit: Tally',
		calls: [
			{ name: 'add', kind: 'action', label: 'Add', args: [{ key: 'amount', type: 'number', default: 1, min: 0, max: 10 }], authority: true },
			{ name: 'total', kind: 'value', label: 'Total', vtype: 'number', args: [] },
			{ name: 'hit', kind: 'event', label: 'On hit', args: [] },
			{ name: 'ring', kind: 'event', label: 'On ring', args: [] }
		]
	},
	initial: () => ({ total: 0, firstAt: 0, rang: false }),
	ops: {
		/** @param {any} s @param {any[]} args @param {any} ctx */
		add(s, [amount], ctx) {
			const n = Number(amount);
			if (!Number.isFinite(n) || n < 0) return { result: { ok: false, reason: 'bad amount' } };
			return {
				slice: { ...s, total: s.total + n, firstAt: s.firstAt || ctx.now() },
				events: [['hit', { amount: n, by: ctx.from }]],
				result: { ok: true, total: s.total + n }
			};
		},
		/** @param {any} s */
		ring(s) {
			return s.rang ? undefined : { slice: { ...s, rang: true }, events: [['ring', {}]] };
		}
	},
	/** @param {any} s @param {any} ctx */
	tick(s, ctx) {
		return s.firstAt && !s.rang && ctx.now() - s.firstAt >= 1000 ? [['ring', []]] : null;
	},
	/** @param {any} ctx */
	make(ctx) {
		return {
			/** @param {number} n */
			add: (n = 1) => ctx.request('add', [n]),
			total: () => ctx.slice().total,
			on: ctx.on
		};
	}
};
const PIECES = [{ name: 'tally', piece: tally }];

describe('authority — one peer decides, everyone agrees who', () => {
	it('the session host while present, else the initiator, else the smallest id', () => {
		expect(pickAuthority({ me: 'b', peers: ['a', 'c'], host: 'c' })).toBe('c');
		expect(pickAuthority({ me: 'b', peers: ['a'], host: 'c', initiator: 'b' })).toBe('b');
		expect(pickAuthority({ me: 'b', peers: ['c'], host: null })).toBe('b');
		expect(pickAuthority({ me: 'z', peers: ['y', 'x'] })).toBe('x');
	});
	it('a peer with no id is alone, so it is its own authority', () => {
		expect(isAuthorityFor({ me: null, peers: [] })).toBe(true);
	});
	it('every peer of a sim names the same authority', () => {
		const sim = createSim({ peers: ['c', 'a', 'b'], pieces: PIECES });
		expect(new Set(sim.authorities()).size).toBe(1);
		expect(sim.authorities()[0]).toBe('a');
	});
});

describe('the one write — actions anywhere, applied once by the authority', () => {
	it('an authority action reaches every peer', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'], pieces: PIECES });
		const r = sim.peer('a').kit.impls.tally.add(3);
		expect(r).toEqual({ ok: true, total: 3 });
		sim.settle();
		expect([...sim.peers.values()].map((p) => p.kit.impls.tally.total())).toEqual([3, 3, 3]);
		expect(agree(sim)).toBe(true);
	});
	it('a non-authority action is a REQUEST the authority applies — once', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'], pieces: PIECES });
		const r = sim.peer('c').kit.impls.tally.add(2);
		expect(r.pending).toBe(true);
		expect(sim.peer('c').kit.impls.tally.total()).toBe(0); // not optimistic
		sim.settle();
		expect(sim.peer('c').kit.impls.tally.total()).toBe(2);
		expect(sim.peer('a').kit.stats.applied).toBe(1);
		expect(sim.peer('c').kit.pending.size).toBe(0);
		expect(agree(sim)).toBe(true);
	});
	it('two peers pressing in the same frame make TWO changes, each exactly once', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'], pieces: PIECES });
		sim.peer('b').kit.impls.tally.add(1);
		sim.peer('c').kit.impls.tally.add(1);
		sim.settle();
		expect(sim.peer('a').kit.impls.tally.total()).toBe(2);
		expect(agree(sim)).toBe(true);
	});
	it('a request re-sent before its acknowledgement arrives is applied ONCE (the rid window)', () => {
		// latency longer than the resend interval: the requester re-sends while the first copy is
		// still in flight, so the authority receives the same request twice
		const sim = createSim({ peers: ['a', 'b'], pieces: PIECES, latency: RESEND_MS + 200 });
		sim.peer('b').kit.impls.tally.add(5);
		sim.advance(RESEND_MS * 4);
		expect(sim.peer('b').kit.stats.resent).toBeGreaterThan(0);
		expect(sim.peer('a').kit.stats.duplicate).toBeGreaterThan(0);
		expect(sim.peer('a').kit.impls.tally.total()).toBe(5);
		expect(sim.peer('b').kit.impls.tally.total()).toBe(5);
	});
	it('a refused action changes nothing and says why', () => {
		const sim = createSim({ peers: ['a', 'b'], pieces: PIECES });
		const r = sim.peer('a').kit.impls.tally.add(-1);
		expect(r).toEqual({ ok: false, reason: 'bad amount' });
		sim.settle();
		expect(sim.peer('b').kit.doc().rev).toBe(0);
	});
});

describe('host leaves — the next authority carries on, nothing lost, nothing doubled', () => {
	it('a request the host never applied is applied by the next authority', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'], pieces: PIECES, latency: 50 });
		sim.peer('a').kit.impls.tally.add(1);
		sim.settle();
		sim.peer('c').kit.impls.tally.add(4); // in flight to everyone…
		sim.leave('a'); // …and the authority is gone before it lands
		sim.advance(RESEND_MS * 3);
		expect(sim.authorities()).toEqual(['b', 'b']);
		expect(sim.peer('b').kit.impls.tally.total()).toBe(5);
		expect(sim.peer('c').kit.impls.tally.total()).toBe(5);
		expect(sim.peer('c').kit.pending.size).toBe(0);
	});
	it("the new authority continues the old one's document (rev keeps climbing)", () => {
		const sim = createSim({ peers: ['a', 'b'], pieces: PIECES });
		sim.peer('a').kit.impls.tally.add(1);
		sim.settle();
		const rev = sim.peer('b').kit.doc().rev;
		const at = sim.peer('b').kit.doc().at;
		sim.leave('a');
		sim.peer('b').kit.impls.tally.add(1);
		expect(sim.peer('b').kit.doc().rev).toBe(rev + 1);
		expect(sim.peer('b').kit.doc().at).toBeGreaterThan(at);
		expect(sim.peer('b').kit.impls.tally.total()).toBe(2);
	});
	it('a peer that was the requester AND becomes the authority applies its own pending request', () => {
		const sim = createSim({ peers: ['a', 'b'], pieces: PIECES, latency: 100 });
		sim.peer('b').kit.impls.tally.add(7);
		sim.leave('a');
		sim.step();
		expect(sim.peer('b').kit.impls.tally.total()).toBe(7);
		expect(sim.peer('b').kit.pending.size).toBe(0);
	});
});

describe('events — every peer hears them, the node pulse happens once', () => {
	it('listeners fire on every peer; the node emit only on the authority', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'], pieces: PIECES });
		/** @type {Record<string, number>} */
		const heard = {};
		for (const p of sim.peers.values()) p.kit.impls.tally.on('hit', () => (heard[p.id] = (heard[p.id] ?? 0) + 1));
		sim.peer('b').kit.impls.tally.add(1);
		sim.settle();
		expect(heard).toEqual({ a: 1, b: 1, c: 1 });
		expect((sim.peer('a').emitted ?? []).length).toBe(1);
		expect(sim.peer('b').emitted).toBeUndefined();
		expect(sim.peer('c').emitted).toBeUndefined();
	});
	it('a late joiner adopts the document and hears NO history', () => {
		const sim = createSim({ peers: ['a', 'b'], pieces: PIECES });
		sim.peer('a').kit.impls.tally.add(2);
		sim.settle();
		const late = sim.add('c');
		let heard = 0;
		late.kit.impls.tally.on('hit', () => heard++);
		sim.join('c');
		sim.settle();
		expect(late.kit.impls.tally.total()).toBe(2);
		expect(heard).toBe(0);
		expect(agree(sim)).toBe(true);
	});
	it('a tick-derived moment fires once, even when the authority changes before it', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'], pieces: PIECES });
		let rings = 0;
		sim.peer('c').kit.impls.tally.on('ring', () => rings++);
		sim.peer('a').kit.impls.tally.add(1);
		sim.advance(500);
		sim.leave('a');
		sim.advance(1500);
		expect(rings).toBe(1);
		expect(sim.peer('b').kit.slice('tally').rang).toBe(true);
		expect(agree(sim)).toBe(true);
	});
});

describe('a scene clear — every peer resets, and a stale document cannot come back', () => {
	it('a reset beats the pre-clear document a peer that missed the clear offers back', () => {
		const sim = createSim({ peers: ['a', 'b'], pieces: PIECES });
		sim.peer('a').kit.impls.tally.add(3);
		sim.settle();
		const stale = sim.peer('b').kit.snapshot();
		sim.advance(100);
		sim.peer('a').kit.reset();
		sim.peer('b').kit.reset();
		sim.peer('a').kit.receive(stale); // e.g. a third peer's handshake from before the clear
		expect(sim.peer('a').kit.impls.tally.total()).toBe(0);
	});
});

describe('the wire — every message the kit sends is one the app accepts', () => {
	it('a whole session of kit traffic passes wireValidate (the sim throws otherwise)', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'], pieces: PIECES });
		for (let i = 0; i < 5; i++) sim.peer(['a', 'b', 'c'][i % 3]).kit.impls.tally.add(1);
		sim.advance(2000);
		expect(sim.refused).toEqual([]);
		expect(sim.sent('kit').length).toBeGreaterThan(0);
		expect(sim.sent('kitreq').length).toBeGreaterThan(0);
	});
	it('wireValidate refuses malformed kit messages', () => {
		expect(validateWireMessage({ type: 'kit', doc: { rev: 1, at: 1, rids: [], slices: {} } })).toBe(true);
		expect(validateWireMessage({ type: 'kit', doc: { rev: NaN, at: 1, rids: [], slices: {} } })).toBe(false);
		expect(validateWireMessage({ type: 'kit', doc: { rev: 1, at: 1, rids: [], slices: [] } })).toBe(false);
		expect(validateWireMessage({ type: 'kit', doc: null })).toBe(false);
		expect(validateWireMessage({ type: 'kit', doc: { rev: 1, at: 1, rids: [], slices: {} }, ev: 'x' })).toBe(false);
		expect(validateWireMessage({ type: 'kitreq', rid: 'r', piece: 'p', op: 'o', args: [] })).toBe(true);
		expect(validateWireMessage({ type: 'kitreq', rid: '', piece: 'p', op: 'o', args: [] })).toBe(false);
		expect(validateWireMessage({ type: 'kitreq', rid: 'r', piece: 'p', op: 'o', args: {} })).toBe(false);
	});
	it('documents order by (at, rev, by) — latest wins', () => {
		expect(newerDoc({ rev: 1, at: 9 }, { rev: 2, at: 1 })).toBe(true);
		expect(newerDoc({ rev: 2, at: 1 }, { rev: 1, at: 1 })).toBe(true);
		expect(newerDoc({ rev: 1, at: 1, by: 'b' }, { rev: 1, at: 1, by: 'a' })).toBe(true);
		expect(newerDoc({ rev: 1, at: 1, by: 'a' }, { rev: 1, at: 1, by: 'a' })).toBe(false);
	});
});

describe('one spec -> the api AND the nodes', () => {
	it('the test piece passes the spec check', () => {
		expect(specProblems(tally.spec)).toEqual([]);
	});
	it('a malformed spec is named, call by call', () => {
		const bad = { piece: 'Bad', group: '', calls: [{ name: 'x', kind: 'nope', label: '', args: [{ key: 'trigger', type: 'number' }] }] };
		const problems = specProblems(bad);
		expect(problems.length).toBeGreaterThanOrEqual(4);
	});
	it('kitNodeItems: one node per call, typed, with a trigger input on actions', () => {
		const items = kitNodeItems(tally.spec);
		expect(items.map((i) => i.type)).toEqual(['kit-tally-add', 'kit-tally-total', 'kit-tally-hit', 'kit-tally-ring']);
		const add = items[0];
		expect(add.inputs?.[0]).toBe('trigger');
		expect(add.io.inputs.trigger).toBe('event');
		expect(add.io.inputs.amount).toBe('number');
		expect(add.defaults).toEqual({ amount: 1 });
		expect(add.params).toEqual([{ key: 'amount', kind: 'range', min: 0, max: 10, step: 1 }]);
		expect(items[1].io.output).toBe('number');
		expect(items[2].io.output).toBe('event');
	});
	it('kitApi: actions + values pass through, events become on<Name>(fn) journaled for teardown', () => {
		/** @type {(() => void)[]} */
		const journal = [];
		const sim = createSim({ peers: ['a'], pieces: PIECES });
		const api = kitApi(tally.spec, sim.peer('a').kit.impls.tally, { onDispose: (fn) => journal.push(fn) });
		let hits = 0;
		api.onHit(() => hits++);
		api.add(2);
		expect(api.total()).toBe(2);
		expect(hits).toBe(1);
		expect(journal.length).toBe(1);
		journal.forEach((fn) => fn()); // the module unloads
		api.add(1);
		expect(hits).toBe(1);
	});
	it('a replicated press SEEN BY EVERY PEER is one change (the stamp-derived rid)', () => {
		const sim = createSim({ peers: ['a', 'b', 'c'], pieces: PIECES, latency: 40 });
		// the stamp lands on the three peers in different frames, and each runs the node
		sim.peer('c').kit.runNodeAction('kit-tally-add', { amount: 1 }, { rid: 'node:n1:123.4' });
		sim.step();
		sim.peer('b').kit.runNodeAction('kit-tally-add', { amount: 1 }, { rid: 'node:n1:123.4' });
		sim.advance(60);
		sim.peer('a').kit.runNodeAction('kit-tally-add', { amount: 1 }, { rid: 'node:n1:123.4' });
		sim.settle();
		expect(sim.peer('a').kit.impls.tally.total()).toBe(1);
		expect(agree(sim)).toBe(true);
		// …and the NEXT press (a new stamp) is a new change
		for (const id of ['a', 'b', 'c']) sim.peer(id).kit.runNodeAction('kit-tally-add', { amount: 1 }, { rid: 'node:n1:130.0' });
		sim.settle();
		expect(sim.peer('c').kit.impls.tally.total()).toBe(2);
	});
	it('an `owned` call gets the module id and journals ONE disown per module', () => {
		/** @type {any[]} */
		const calls = [];
		/** @type {string[]} */
		const disowned = [];
		const spec = { piece: 'own', group: 'G', calls: [{ name: 'spawn', kind: 'action', label: 'S', owned: true, args: [{ key: 'n', type: 'number' }] }] };
		const impl = { spawn: (/** @type {any[]} */ ...a) => calls.push(a), disown: (/** @type {string} */ id) => disowned.push(id), on: () => () => {} };
		/** @type {(() => void)[]} */
		const journal = [];
		const api = kitApi(/** @type {any} */ (spec), impl, { onDispose: (fn) => journal.push(fn), moduleId: 'waves' });
		api.spawn(2);
		api.spawn();
		expect(calls).toEqual([[2, 'waves'], [undefined, 'waves']]);
		expect(journal.length).toBe(1);
		journal[0]();
		expect(disowned).toEqual(['waves']);
	});
	it('a node runs the SAME function the api calls (node path == code path)', () => {
		const sim = createSim({ peers: ['a', 'b'], pieces: PIECES });
		sim.peer('b').kit.runNodeAction(kitNodeType('tally', 'add'), { amount: 4 });
		sim.settle();
		expect(sim.peer('a').kit.evalNodeValue('kit-tally-total', {})).toBe(4);
		expect(sim.peer('b').kit.evalNodeValue('kit-tally-total', {})).toBe(4);
		expect(sim.peer('a').kit.runNodeAction('kit-tally-total', {})).toBe(null); // a value is not an action
		expect(argsFromData(tally.spec.calls[0], { amount: 'x' })).toEqual([1]); // a bad wire value falls back
	});
});

describe('the fake clock', () => {
	it('advances in frames and delivers in order', () => {
		const sim = createSim({ peers: ['a', 'b'], pieces: PIECES, latency: 100 });
		const t0 = sim.now();
		sim.peer('a').kit.impls.tally.add(1);
		sim.advance(FRAME_MS * 3);
		expect(sim.peer('b').kit.impls.tally.total()).toBe(0); // still in flight
		sim.advance(100);
		expect(sim.peer('b').kit.impls.tally.total()).toBe(1);
		expect(sim.now() - t0).toBe(FRAME_MS * 3 + 100);
	});
});
