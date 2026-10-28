// Lock messages act for the connection they arrive on (lockTrust.js): a `locked` table from
// the session host may name anyone, from anyone else only the sender itself; control
// requests are limited per peer and object.
import { describe, it, expect } from 'vitest';
import {
	acceptedLockRows,
	mergeLockRows,
	holdsLock,
	isHeld,
	createRequestLimiter,
	LOCK_REQUEST_GAP_MS
} from '../../src/lib/lockTrust.js';

const A = 'peer-a';
const B = 'peer-b';
const ME = 'peer-me';

describe('acceptedLockRows', () => {
	it('keeps every row from the session host except ours', () => {
		const rows = acceptedLockRows(
			[[A, 'u1'], [B, 'u2'], [ME, 'u3']],
			{ from: A, selfId: ME, fromHost: true, mayLock: true }
		);
		expect(rows).toEqual([[A, 'u1'], [B, 'u2']]);
	});

	it('keeps only the sender\'s own rows from anyone else', () => {
		const rows = acceptedLockRows(
			[[A, 'u1'], [B, 'u2'], [B, 'u3'], [ME, 'u4']],
			{ from: A, selfId: ME, fromHost: false, mayLock: true }
		);
		expect(rows).toEqual([[A, 'u1']]);
	});

	it('takes nothing from a sender that may not lock, host or not', () => {
		const table = [[A, 'u1'], [B, 'u2']];
		expect(acceptedLockRows(table, { from: A, selfId: ME, fromHost: false, mayLock: false })).toEqual([]);
		expect(acceptedLockRows(table, { from: A, selfId: ME, fromHost: true, mayLock: false })).toEqual([]);
	});

	it('drops malformed and repeated rows', () => {
		const rows = acceptedLockRows(
			[null, 'x', [A], [A, 7], [7, 'u'], [A, ''], [A, 'u1'], [A, 'u1'], [A, 'x'.repeat(200)]],
			{ from: A, selfId: ME, fromHost: false, mayLock: true }
		);
		expect(rows).toEqual([[A, 'u1']]);
	});

	it('answers a non-array or an empty sender with nothing', () => {
		expect(acceptedLockRows({}, { from: A, selfId: ME, fromHost: true, mayLock: true })).toEqual([]);
		expect(acceptedLockRows([[A, 'u1']], { from: '', selfId: ME, fromHost: false, mayLock: true })).toEqual([]);
	});

	it('copies the rows (extra payload fields do not ride along)', () => {
		const rows = acceptedLockRows([[A, 'u1', 'extra']], { from: A, selfId: ME, fromHost: false, mayLock: true });
		expect(rows).toEqual([[A, 'u1']]);
	});
});

describe('mergeLockRows', () => {
	it('adds only what the table lacks', () => {
		const table = [[A, 'u1']];
		expect(mergeLockRows(table, [[A, 'u1'], [B, 'u2']])).toEqual([[A, 'u1'], [B, 'u2']]);
	});
	it('tolerates a missing table', () => {
		expect(mergeLockRows(undefined, [[A, 'u1']])).toEqual([[A, 'u1']]);
	});
});

describe('holdsLock / isHeld', () => {
	const table = [[A, 'u1'], [B, 'u2']];
	it('names the holder', () => {
		expect(holdsLock(table, A, 'u1')).toBe(true);
		expect(holdsLock(table, B, 'u1')).toBe(false);
		expect(isHeld(table, 'u2')).toBe(true);
		expect(isHeld(table, 'u3')).toBe(false);
		expect(holdsLock(null, A, 'u1')).toBe(false);
	});
});

describe('createRequestLimiter', () => {
	it('allows one request per peer and object per window', () => {
		const lim = createRequestLimiter();
		expect(lim.allow(A, 'u1', 1000)).toBe(true);
		expect(lim.allow(A, 'u1', 1000 + LOCK_REQUEST_GAP_MS - 1)).toBe(false);
		// another object, another peer: their own windows
		expect(lim.allow(A, 'u2', 1500)).toBe(true);
		expect(lim.allow(B, 'u1', 1500)).toBe(true);
		expect(lim.allow(A, 'u1', 1000 + LOCK_REQUEST_GAP_MS)).toBe(true);
	});

	it('a refused request does not extend the window', () => {
		const lim = createRequestLimiter(3000);
		expect(lim.allow(A, 'u1', 0)).toBe(true);
		expect(lim.allow(A, 'u1', 2000)).toBe(false);
		expect(lim.allow(A, 'u1', 3000)).toBe(true);
	});

	it('prunes itself and forgets a peer that left', () => {
		const lim = createRequestLimiter(3000);
		for (let i = 0; i < 300; i++) lim.allow(A, 'u' + i, 0);
		// after the window every old entry is spent and the next call prunes them
		expect(lim.allow(B, 'x', 10000)).toBe(true);
		lim.allow(A, 'fresh', 10000);
		expect(lim.allow(A, 'fresh', 10001)).toBe(false);
		lim.drop(A);
		expect(lim.allow(A, 'fresh', 10002)).toBe(true);
	});
});
