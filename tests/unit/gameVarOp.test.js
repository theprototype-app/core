// @ts-nocheck — plain fixtures
// fix-agenttest item 10: a SHARED Set Variable writes once per event — the authority applies each
// event's rid once (N peers see one stamp; a slow peer used to count it again from the value it
// already received), and every other peer sends the event there.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { gameState, applyGameVarOp, GAMEVAR_RID_WINDOW, gameVar, commitGameState, mergeGameState } from '../../src/lib/gameState.js';
import { validateWireMessage } from '../../src/lib/wireValidate.js';

beforeEach(() => gameState.update((s) => ({ ...s, vars: {} })));

describe('applyGameVarOp', () => {
	it('applies an event once however many peers send it', () => {
		const ev = { rid: 'var:addN:12.5', name: 'n', op: 'add', value: 1 };
		expect(applyGameVarOp(ev)).toBe(true);
		expect(applyGameVarOp({ ...ev })).toBe(false);
		expect(applyGameVarOp({ ...ev })).toBe(false);
		expect(gameVar('n')).toBe(1);
		expect(applyGameVarOp({ ...ev, rid: 'var:addN:13' })).toBe(true);
		expect(gameVar('n')).toBe(2);
	});

	it('a toggle (set to the requester-resolved NOT) flips once per event', () => {
		expect(applyGameVarOp({ rid: 'var:setT:1', name: 't', op: 'set', value: 1 })).toBe(true);
		// the slow peer's copy of the same event, resolved from the value it already received
		expect(applyGameVarOp({ rid: 'var:setT:1', name: 't', op: 'set', value: 0 })).toBe(false);
		expect(gameVar('t')).toBe(1);
	});

	it('subtracts, and forgets only past its window', () => {
		applyGameVarOp({ rid: 'var:s:0', name: 'hp', op: 'set', value: 10 });
		applyGameVarOp({ rid: 'var:s:1', name: 'hp', op: 'subtract', value: 3 });
		expect(gameVar('hp')).toBe(7);
		for (let i = 0; i < GAMEVAR_RID_WINDOW; i++) applyGameVarOp({ rid: 'w:' + i, name: 'x', op: 'add', value: 0 });
		expect(applyGameVarOp({ rid: 'var:s:1', name: 'hp', op: 'subtract', value: 3 })).toBe(true);
	});

	it('is validated on the wire and room-scoped', () => {
		expect(validateWireMessage({ type: 'gamevarop', rid: 'var:a:1', name: 'n', op: 'add', value: 1 })).toBe(true);
		expect(validateWireMessage({ type: 'gamevarop', rid: 'var:a:1', name: 'n', op: 'mul', value: 1 })).toBe(false);
		expect(validateWireMessage({ type: 'gamevarop', rid: '', name: 'n', op: 'set', value: 1 })).toBe(false);
		expect(validateWireMessage({ type: 'gamevarop', rid: 'r', name: 'n', op: 'set', value: 'x' })).toBe(false);
		const scenes = readFileSync(new URL('../../src/lib/peerScenes.js', import.meta.url), 'utf8');
		expect(scenes).toMatch(/'game', 'gamevarop', 'kit'/);
	});

	it('the Set Variable node routes its shared write through the authority, keyed by node + stamp', () => {
		const src = readFileSync(new URL('../../src/lib/flowRuntime.js', import.meta.url), 'utf8');
		expect(src).toMatch(/shareGameVarOp\(\{ rid: 'var:' \+ node\.id \+ ':' \+ stamp, name, op, value: v \}\)/);
		expect(src).not.toMatch(/if \(!sandboxedWrite\(stamp\)\) setGameVar\(name, value\);/);
	});
});

describe('mergeGameState: each variable keeps its own stamp', () => {
	const st = (o) => ({ state: 'menu', round: 0, startedAt: 0, pausedAt: 0, pausedMs: 0, outcome: '', vars: {}, changedAt: 0, ...o });

	it('a later state write with an older variable does not undo the authority\'s add (the game-state clobber)', () => {
		const authority = st({ state: 'playing', vars: { score: 5 }, varsAt: { score: 1047 }, changedAt: 1047 });
		const peer = st({ state: 'playing', vars: { score: 0 }, varsAt: { score: 900 }, changedAt: 1050 });
		// the authority receives the peer's newer write: keeps its own score
		const a = mergeGameState(authority, peer);
		expect(a.state).toBe('playing');
		expect(a.changedAt).toBe(1050);
		expect(a.vars.score).toBe(5);
		// the peer receives the authority's OLDER write: still takes the newer score
		const b = mergeGameState(peer, authority);
		expect(b.changedAt).toBe(1050);
		expect(b.vars.score).toBe(5);
	});

	it('takes a variable this side never had, whatever the state stamps say', () => {
		const m = mergeGameState(st({ vars: {}, varsAt: {}, changedAt: 2000 }), st({ vars: { n: 1 }, varsAt: { n: 1500 }, changedAt: 1500 }));
		expect(m.vars.n).toBe(1);
	});

	it('a removal travels as a tombstone, and a later write brings the variable back', () => {
		const removed = st({ vars: {}, varsAt: { n: 3000 }, changedAt: 3000 });
		expect(mergeGameState(st({ vars: { n: 4 }, varsAt: { n: 2000 }, changedAt: 2000 }), removed).vars).toEqual({});
		expect(mergeGameState(removed, st({ vars: { n: 9 }, varsAt: { n: 3100 }, changedAt: 3100 })).vars).toEqual({ n: 9 });
	});

	it('a state without varsAt (an older peer, a restore) is whole-singleton latest-wins, as before', () => {
		const local = st({ vars: { n: 4, k: 1 }, varsAt: { n: 2000, k: 2000 }, changedAt: 2000 });
		expect(mergeGameState(local, st({ vars: { n: 7 }, changedAt: 2500 })).vars).toEqual({ n: 7 });
		expect(mergeGameState(local, st({ vars: { n: 7 }, changedAt: 1500 }))).toBe(null);
	});

	it('an older state with nothing newer is refused (null), an equal one is taken', () => {
		const local = st({ state: 'paused', vars: { n: 1 }, varsAt: { n: 100 }, changedAt: 500 });
		expect(mergeGameState(local, { ...local, state: 'menu', changedAt: 400 })).toBe(null);
		expect(mergeGameState(local, { ...local, state: 'over' }).state).toBe('over');
	});

	it('a local write stamps only what it changed, and a removal', () => {
		gameState.set(st({ vars: { a: 1, b: 2 }, varsAt: { a: 10, b: 20 }, changedAt: 20 }));
		const after = commitGameState({ vars: { a: 1, c: 3 } }, { silent: true, stamp: 99 });
		expect(after.varsAt).toEqual({ a: 10, b: 99, c: 99 });
		const next = commitGameState({ state: 'playing' }, { silent: true, stamp: 120 });
		expect(next.varsAt).toEqual({ a: 10, b: 99, c: 99 });
	});
});
