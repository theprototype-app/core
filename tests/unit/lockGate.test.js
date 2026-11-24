// 80a K3: who holds an object when two peers took it at once (earliest stamp, then the lower
// peer id), and what a receiver does with an edit of an object somebody else holds.
import { describe, it, expect } from 'vitest';
import {
	acceptedLockRows,
	lockBeats,
	holderOf,
	sortLockTable,
	gatedUuid,
	LOCK_GATED,
	lockGateVerdict,
	stampedRows,
	claimStamp,
	LOCK_RACE_MS
} from '../../src/lib/lockTrust.js';

const A = 'peer-a';
const B = 'peer-b';
const C = 'peer-c';
const ME = 'peer-me';

describe('lockBeats', () => {
	it('the earlier stamp wins', () => {
		expect(lockBeats({ peer: B, at: 100 }, { peer: A, at: 200 })).toBe(true);
		expect(lockBeats({ peer: A, at: 200 }, { peer: B, at: 100 })).toBe(false);
	});
	it('equal stamps fall to the lower peer id, the same answer on every peer', () => {
		expect(lockBeats({ peer: A, at: 100 }, { peer: B, at: 100 })).toBe(true);
		expect(lockBeats({ peer: B, at: 100 }, { peer: A, at: 100 })).toBe(false);
	});
	it('an unstamped row (an older peer) loses to any stamped one', () => {
		expect(lockBeats({ peer: B, at: 5 }, { peer: A, at: undefined })).toBe(true);
		expect(lockBeats({ peer: A, at: undefined }, { peer: B, at: 5 })).toBe(false);
		expect(lockBeats({ peer: A }, { peer: B })).toBe(true);
	});
	it('is a strict order (a row never beats itself)', () => {
		expect(lockBeats({ peer: A, at: 1 }, { peer: A, at: 1 })).toBe(false);
	});
});

describe('holderOf', () => {
	it('picks the winner among remote rows and our own stamp', () => {
		const table = [[B, 'u', 300], [C, 'u', 200]];
		expect(holderOf(table, 'u')).toBe(C);
		expect(holderOf(table, 'u', { self: ME, at: 250 })).toBe(C);
		expect(holderOf(table, 'u', { self: ME, at: 150 })).toBe(ME);
		expect(holderOf(table, 'x')).toBe(null);
		expect(holderOf(table, 'x', { self: ME, at: 1 })).toBe(ME);
	});
	it('ignores malformed rows', () => {
		expect(holderOf([null, [B], [7, 'u'], [B, 'u', 'x']], 'u')).toBe(B);
	});
});

describe('sortLockTable', () => {
	it('puts the winner of every object first, so `find` answers the holder', () => {
		const sorted = sortLockTable([[B, 'u', 300], [A, 'v'], [C, 'u', 200]]);
		expect(sorted.find((l) => l[1] === 'u')[0]).toBe(C);
		expect(sorted.length).toBe(3);
	});
	it('returns the same order whatever order the rows arrived in', () => {
		const rows = [[B, 'u', 300], [C, 'u', 200], [A, 'u', 200], [A, 'w']];
		const one = sortLockTable(rows);
		const two = sortLockTable([...rows].reverse());
		expect(one).toEqual(two);
	});
});

describe('stamped rows on the wire', () => {
	it('acceptedLockRows keeps a finite stamp and drops anything else in the third place', () => {
		const rows = acceptedLockRows([[A, 'u1', 42], [A, 'u2', 'x'], [A, 'u3', Infinity]], { from: A, selfId: ME, fromHost: false, mayLock: true });
		expect(rows).toEqual([[A, 'u1', 42], [A, 'u2'], [A, 'u3']]);
	});
	it('stampedRows pairs a lock message\'s uuids with its stamps', () => {
		expect(stampedRows(A, ['u1', 'u2'], [10, 20])).toEqual([[A, 'u1', 10], [A, 'u2', 20]]);
		expect(stampedRows(A, ['u1', 'u2'], undefined)).toEqual([[A, 'u1'], [A, 'u2']]);
		expect(stampedRows(A, ['u1'], ['x'])).toEqual([[A, 'u1']]);
	});
});

describe('gatedUuid', () => {
	it('names the object an edit touches', () => {
		expect(gatedUuid({ type: 'move', uuid: 'u' })).toBe('u');
		expect(gatedUuid({ type: 'objectParameters', uuid: 'u', parameter: 'x' })).toBe('u');
		expect(gatedUuid({ type: 'nodedata', id: 'n', graphId: 'u' })).toBe('u');
		expect(gatedUuid({ type: 'shadergraph', key: 'u' })).toBe('u');
	});
	it('ignores the scene graph, other messages and junk', () => {
		expect(gatedUuid({ type: 'nodedata', id: 'n' })).toBe(null);
		expect(gatedUuid({ type: 'nodedata', id: 'n', graphId: 'scene' })).toBe(null);
		expect(gatedUuid({ type: 'shadergraph', key: 'post:1' })).toBe(null);
		expect(gatedUuid({ type: 'camera', uuid: 'u' })).toBe(null);
		expect(gatedUuid({ type: 'toString', uuid: 'u' })).toBe(null);
		expect(gatedUuid(null)).toBe(null);
	});
	it('covers the object edits', () => {
		for (const t of ['move', 'name', 'delete', 'color', 'objectParameters', 'geometry', 'verts', 'meshgeo', 'splineedit', 'animdata', 'graphcreate', 'graphdelete', 'nodecreate', 'nodemove', 'nodedata', 'nodedelete', 'edgecreate', 'edgedelete'])
			expect(Object.prototype.hasOwnProperty.call(LOCK_GATED, t)).toBe(true);
	});
});

describe('lockGateVerdict', () => {
	const base = { selfId: ME, table: [], mine: null, runtime: false };
	it('applies an edit of an object nobody holds, or one the sender holds', () => {
		expect(lockGateVerdict({ ...base, data: { type: 'move', uuid: 'u' }, from: A })).toBe('apply');
		expect(lockGateVerdict({ ...base, table: [[A, 'u', 1]], data: { type: 'move', uuid: 'u' }, from: A })).toBe('apply');
	});
	it('rejects an edit of an object WE hold (we answer, the sender reverts)', () => {
		expect(lockGateVerdict({ ...base, mine: { self: ME, at: 5 }, data: { type: 'move', uuid: 'u' }, from: A })).toBe('reject');
	});
	it('drops an edit of an object a third peer holds', () => {
		expect(lockGateVerdict({ ...base, table: [[B, 'u', 1]], data: { type: 'name', uuid: 'u', name: 'x' }, from: A })).toBe('drop');
	});
	it('parks an edit from a peer that also claims the object (a hand-over still on its way)', () => {
		expect(lockGateVerdict({ ...base, table: [[B, 'u', 1], [A, 'u', 2]], data: { type: 'move', uuid: 'u' }, from: A })).toBe('park');
	});
	it('a losing claim of ours does not protect the object from its holder', () => {
		expect(lockGateVerdict({ ...base, table: [[A, 'u', 1]], mine: { self: ME, at: 5 }, data: { type: 'move', uuid: 'u' }, from: A })).toBe('apply');
	});
	it('lets a running world move things (physics, play): only `move` is exempt', () => {
		expect(lockGateVerdict({ ...base, runtime: true, table: [[B, 'u', 1]], data: { type: 'move', uuid: 'u' }, from: A })).toBe('apply');
		expect(lockGateVerdict({ ...base, runtime: true, table: [[B, 'u', 1]], data: { type: 'delete', uuid: 'u' }, from: A })).toBe('drop');
	});
	it('passes every message the gate does not cover', () => {
		expect(lockGateVerdict({ ...base, table: [[B, 'u', 1]], data: { type: 'camera', uuid: 'u' }, from: A })).toBe('apply');
	});
});

describe('claimStamp (a claim cannot be dated back past the race window)', () => {
	const now = 1_000_000;
	it('keeps the stamp we already stored for an object the peer still holds', () => {
		expect(claimStamp({ claimed: 5, prev: 900_000, contested: true, now })).toBe(900_000);
	});
	it('takes a fresh claim on a free object as sent', () => {
		expect(claimStamp({ claimed: 5, prev: undefined, contested: false, now })).toBe(5);
	});
	it('clamps a claim on an object somebody holds to the race window', () => {
		expect(claimStamp({ claimed: 5, prev: undefined, contested: true, now })).toBe(now - LOCK_RACE_MS);
		expect(claimStamp({ claimed: now - 100, prev: undefined, contested: true, now })).toBe(now - 100);
	});
	it('leaves an unstamped claim unstamped (it loses every tie)', () => {
		expect(claimStamp({ claimed: undefined, prev: undefined, contested: true, now })).toBe(undefined);
	});
	it('so a claim dated back cannot take an object held for longer than the window', () => {
		const holder = { peer: 'peer-z', at: now - 60_000 };
		const forged = { peer: 'peer-a', at: claimStamp({ claimed: 0, prev: undefined, contested: true, now }) };
		expect(lockBeats(holder, forged)).toBe(true);
	});
});
