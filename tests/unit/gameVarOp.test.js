// @ts-nocheck — plain fixtures
// fix-agenttest item 10: a SHARED Set Variable writes once per event — the authority applies each
// event's rid once (N peers see one stamp; a slow peer used to count it again from the value it
// already received), and every other peer sends the event there.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { get } from 'svelte/store';
import { gameState, applyGameVarOp, GAMEVAR_RID_WINDOW, GAMEVAR_RID_SHARED, gameVar, commitGameState, mergeGameState } from '../../src/lib/gameState.js';
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

// 54i row n: the rids an event applied travel IN the game state, so two peers that disagree about the
// authority (each applying the event it was sent) cannot count it twice
describe('applyGameVarOp across two writers (peers that disagree about the authority)', () => {
	const st = (o) => ({ state: 'menu', round: 0, startedAt: 0, pausedAt: 0, pausedMs: 0, outcome: '', vars: {}, changedAt: 0, ...o });
	beforeEach(() => gameState.set(st({ vars: { k: 0, t: 0 }, varsAt: { k: 1, t: 1 }, changedAt: 1 })));

	it('a write carries the rid it applied', () => {
		applyGameVarOp({ rid: 'var:addK:500.5', name: 'k', op: 'add', value: 1 });
		expect(get(gameState).varOps).toEqual(['var:addK:500.5']);
	});

	it('an Add the other writer already applied (its write arrived first) is not applied again', () => {
		// the other writer applied the click's Add 1 and its write reached us before the event did
		const other = st({ vars: { k: 1, t: 0 }, varsAt: { k: 600, t: 1 }, changedAt: 600, varOps: ['var:addK:601.25'] });
		commitGameState(mergeGameState(get(gameState), other), { silent: true, stamp: 600, varsAt: { k: 600, t: 1 } });
		expect(applyGameVarOp({ rid: 'var:addK:601.25', name: 'k', op: 'add', value: 1 })).toBe(false);
		expect(gameVar('k')).toBe(1);
	});

	it('a toggle the other writer already flipped is not flipped back', () => {
		const other = st({ vars: { k: 0, t: 1 }, varsAt: { k: 1, t: 700 }, changedAt: 700, varOps: ['var:setT:701.5'] });
		commitGameState(mergeGameState(get(gameState), other), { silent: true, stamp: 700, varsAt: { k: 1, t: 700 } });
		// our requester resolved NOT t after the first write had landed: 0
		expect(applyGameVarOp({ rid: 'var:setT:701.5', name: 't', op: 'set', value: 0 })).toBe(false);
		expect(gameVar('t')).toBe(1);
	});

	it('two writers that apply one event at once keep ONE result, and both rids', () => {
		applyGameVarOp({ rid: 'var:addK:800', name: 'k', op: 'add', value: 1 });
		const mine = get(gameState);
		// the other writer applied the same event from the same value, a moment later
		const other = st({ vars: { k: 1, t: 0 }, varsAt: { k: mine.changedAt + 3, t: 1 }, changedAt: mine.changedAt + 3, varOps: ['var:addK:800'] });
		const merged = mergeGameState(mine, other);
		expect(merged.vars.k).toBe(1);
		expect(merged.varOps).toEqual(['var:addK:800']);
	});

	it('the shared window is bounded, and an older state that only brings rids is still taken', () => {
		const local = st({ vars: { k: 2 }, varsAt: { k: 900 }, changedAt: 900, varOps: ['a'] });
		const older = st({ vars: { k: 2 }, varsAt: { k: 900 }, changedAt: 800, varOps: ['b'] });
		expect(mergeGameState(local, older)?.varOps).toEqual(['a', 'b']);
		expect(mergeGameState(local, { ...older, varOps: ['a'] })).toBe(null);
		const many = Array.from({ length: GAMEVAR_RID_SHARED + 10 }, (_, i) => 'r' + i);
		expect(mergeGameState(st({ changedAt: 1 }), st({ changedAt: 2, varOps: many })).varOps).toHaveLength(GAMEVAR_RID_SHARED);
	});
});
