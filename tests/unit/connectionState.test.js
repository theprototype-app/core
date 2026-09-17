import { describe, it, expect } from 'vitest';
import {
	sessionSize,
	roomIsFull,
	approvalRemaining,
	APPROVAL_WINDOW_MS,
	MAX_PENDING_APPROVALS,
	SOFT_PEER_CAP_DEFAULT,
	HARD_PEER_CAP
} from '../../src/lib/connectionState.js';

// 27-E. These two functions decide whether a session may take one more person, and they
// exist because the same arithmetic was written out four times against the WRONG store.
// They are pure and take a peer-shaped argument, so they need no browser and no mesh.

describe('sessionSize', () => {
	it('counts you even when you are alone', () => {
		expect(sessionSize(null)).toBe(1);
		expect(sessionSize(undefined)).toBe(1);
		expect(sessionSize({})).toBe(1);
		expect(sessionSize({ openedPeers: new Set() })).toBe(1);
	});

	it('counts the OPEN connections plus you', () => {
		expect(sessionSize({ openedPeers: new Set(['a', 'b']) })).toBe(3);
	});

	it('is unmoved by a whitelist full of people who never arrived', () => {
		// the trap: `userdata` is written at DIAL time. A peer object carrying a long
		// roster and no open channel is a host sitting alone, and must read as 1.
		const dialledNobodyArrived = { openedPeers: new Set(), userdata: new Array(16).fill(['x']) };
		expect(sessionSize(dialledNobodyArrived)).toBe(1);
		expect(roomIsFull(dialledNobodyArrived)).toBe(false);
	});
});

describe('roomIsFull', () => {
	/** @param {number} n */
	const withPeers = (n) => ({ openedPeers: new Set(Array.from({ length: n }, (_, i) => 'p' + i)) });

	it('refuses at the hard cap and not one person before it', () => {
		expect(roomIsFull(withPeers(HARD_PEER_CAP - 2))).toBe(false); // 15 in the room
		expect(roomIsFull(withPeers(HARD_PEER_CAP - 1))).toBe(true); // 16 in the room
	});

	it('never refuses an empty session', () => {
		expect(roomIsFull(null)).toBe(false);
	});
});

describe('the constants the UI and the wire both read', () => {
	it('keeps the soft cap under the hard one, or the warning could never fire', () => {
		expect(SOFT_PEER_CAP_DEFAULT).toBeLessThan(HARD_PEER_CAP);
		expect(SOFT_PEER_CAP_DEFAULT).toBeGreaterThanOrEqual(2);
	});

	it('bounds the pending queue below the hard cap', () => {
		expect(MAX_PENDING_APPROVALS).toBeGreaterThan(0);
		expect(MAX_PENDING_APPROVALS).toBeLessThan(HARD_PEER_CAP);
	});
});

describe('approvalRemaining', () => {
	it('starts at the full window and floors at zero', () => {
		expect(approvalRemaining(Date.now())).toBeGreaterThan(APPROVAL_WINDOW_MS - 1000);
		expect(approvalRemaining(Date.now() - APPROVAL_WINDOW_MS - 5000)).toBe(0);
	});

	it('treats a missing stamp as expired rather than as forever', () => {
		// an absent stamp used to read as epoch 0, which is the safe direction: expired.
		expect(approvalRemaining(0)).toBe(0);
		expect(approvalRemaining(undefined)).toBe(0);
	});
});
