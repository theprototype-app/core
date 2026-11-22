// 78 F25: the slow-initiator rules — the adaptive pace caps and the handoff vote (pure halves).
import { describe, it, expect } from 'vitest';
import {
	paceLimits,
	handoffCandidate,
	handoffDue,
	handoffBlocked,
	HANDOFF_SETTLE_MS,
	BASE_SUBSTEPS,
	BASE_FEED,
	HARD_SUBSTEPS,
	MAX_FEED,
	HANDOFF_SUSTAIN_MS,
	HANDOFF_COOLDOWN_MS,
	VOTE_STALE_MS
} from '../../src/lib/simPace.js';

const DT = 1 / 60;

describe('paceLimits', () => {
	it('an unmeasured run keeps the old caps (8 substeps, 0.25 s)', () => {
		expect(paceLimits(0, DT)).toEqual({ maxSub: BASE_SUBSTEPS, feed: BASE_FEED });
	});
	it('a cheap substep buys more substeps and more feed, up to the hard caps', () => {
		const cheap = paceLimits(0.05, DT);
		expect(cheap.maxSub).toBe(HARD_SUBSTEPS);
		expect(cheap.feed).toBeCloseTo(Math.min(MAX_FEED, HARD_SUBSTEPS * DT), 6);
		const mid = paceLimits(0.5, DT); // 14 ms budget / 0.5 = 28
		expect(mid.maxSub).toBe(28);
		expect(mid.feed).toBeCloseTo(Math.min(MAX_FEED, 28 * DT), 6);
	});
	it('78-int u1: a hitch never feeds more than 0.25 s, however cheap a substep is', () => {
		expect(MAX_FEED).toBe(0.25);
		for (const ms of [0.01, 0.05, 0.3, 1, 3]) expect(paceLimits(ms, DT).feed).toBeLessThanOrEqual(0.25 + 1e-9);
	});
	it('an expensive substep never goes below the old caps', () => {
		expect(paceLimits(10, DT)).toEqual({ maxSub: BASE_SUBSTEPS, feed: BASE_FEED });
	});
	it('a 4 fps frame (250 ms) is fully covered when a substep costs 0.3 ms', () => {
		const { maxSub, feed } = paceLimits(0.3, DT);
		expect(feed).toBeGreaterThanOrEqual(0.25);
		expect(maxSub * DT).toBeGreaterThanOrEqual(0.25);
	});
});

describe('handoffCandidate', () => {
	const now = 100000;
	it('picks the fastest fresh vote clearly faster than me', () => {
		const votes = [
			{ peerId: 'b', frameMs: 30, at: now },
			{ peerId: 'c', frameMs: 17, at: now }
		];
		expect(handoffCandidate(100, votes, now)).toBe('c');
	});
	it('needs a clear margin (at most 60 % of my frame time)', () => {
		expect(handoffCandidate(100, [{ peerId: 'b', frameMs: 61, at: now }], now)).toBe(null);
		expect(handoffCandidate(100, [{ peerId: 'b', frameMs: 60, at: now }], now)).toBe('b');
	});
	it('ignores stale and broken votes, and an unmeasured me', () => {
		expect(handoffCandidate(100, [{ peerId: 'b', frameMs: 10, at: now - VOTE_STALE_MS - 1 }], now)).toBe(null);
		expect(handoffCandidate(100, [{ peerId: 'b', frameMs: 0, at: now }], now)).toBe(null);
		expect(handoffCandidate(0, [{ peerId: 'b', frameMs: 10, at: now }], now)).toBe(null);
	});
	it('breaks a tie by the lower peer id (the same answer on every peer)', () => {
		const votes = [
			{ peerId: 'z', frameMs: 16, at: now },
			{ peerId: 'k', frameMs: 16, at: now }
		];
		expect(handoffCandidate(100, votes, now)).toBe('k');
	});
});

describe('handoffDue (hysteresis)', () => {
	it('hands over only after the same candidate stayed best for the sustain time', () => {
		const st = { candidate: null, since: 0, lastHandoff: -1e9 };
		expect(handoffDue(st, 'b', 1000)).toBe(null); // first sighting
		expect(handoffDue(st, 'b', 1000 + HANDOFF_SUSTAIN_MS - 1)).toBe(null);
		expect(handoffDue(st, 'b', 1000 + HANDOFF_SUSTAIN_MS)).toBe('b');
	});
	it('a change of candidate (or none) restarts the sustain clock', () => {
		const st = { candidate: null, since: 0, lastHandoff: -1e9 };
		handoffDue(st, 'b', 0);
		expect(handoffDue(st, 'c', 2000)).toBe(null);
		expect(handoffDue(st, 'c', 2000 + HANDOFF_SUSTAIN_MS - 1)).toBe(null);
		expect(handoffDue(st, null, 2000 + HANDOFF_SUSTAIN_MS)).toBe(null);
		expect(handoffDue(st, 'c', 2000 + HANDOFF_SUSTAIN_MS + 1)).toBe(null);
	});
	it('at most once per cooldown', () => {
		const st = { candidate: null, since: 0, lastHandoff: -1e9 };
		handoffDue(st, 'b', 0);
		expect(handoffDue(st, 'b', HANDOFF_SUSTAIN_MS)).toBe('b');
		handoffDue(st, 'c', HANDOFF_SUSTAIN_MS + 1);
		expect(handoffDue(st, 'c', HANDOFF_SUSTAIN_MS * 2 + 1)).toBe(null); // inside the cooldown
		expect(handoffDue(st, 'c', HANDOFF_SUSTAIN_MS + HANDOFF_COOLDOWN_MS)).toBe('c');
	});
});

describe('handoffBlocked (78-int u1: never mid-carry or mid-throw)', () => {
	it('a held body blocks the handoff', () => {
		expect(handoffBlocked(true, 0, 1000)).toBe(true);
		expect(handoffBlocked(true, 1000, 1000)).toBe(true);
	});
	it('it waits HANDOFF_SETTLE_MS after the last carry ended, then allows', () => {
		expect(handoffBlocked(false, 1000, 1000 + HANDOFF_SETTLE_MS - 1)).toBe(true);
		expect(handoffBlocked(false, 1000, 1000 + HANDOFF_SETTLE_MS)).toBe(false);
	});
	it('a run that never carried is not blocked', () => {
		expect(handoffBlocked(false, 0, 5)).toBe(false);
	});
});
