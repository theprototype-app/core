// 71 AS4 — every counter of the invite / join limits, with the clock passed in.
import { describe, it, expect } from 'vitest';
import { makeRecord, revokeRecord, spendUse, newToken } from '../../src/lib/inviteCore.js';
import {
	INVITE_LIMITS as L,
	liveInvites,
	mintVerdict,
	pruneMints,
	createJoinGate,
	failedRowText,
	pauseToastText,
	joinWhyText
} from '../../src/lib/inviteLimits.js';

const T0 = 1_800_000_000_000;
const rec = (/** @type {any} */ opts = {}, now = T0) => makeRecord(newToken(), opts, now);

describe('71 AS4 live invites', () => {
	it('counts only invites usable right now', () => {
		const live = rec();
		const revoked = revokeRecord(rec());
		const used = spendUse(rec({ maxUses: 1 }), 'a');
		const expired = rec({ expiry: '10m' }, T0 - 11 * 60_000);
		expect(liveInvites([live, revoked, used, expired], T0)).toBe(1);
		expect(liveInvites([], T0)).toBe(0);
		expect(liveInvites(/** @type {any} */ (null), T0)).toBe(0);
	});
});

describe('71 AS4 minting', () => {
	it('allows the 20th live invite and refuses the 21st with a message', () => {
		const list = Array.from({ length: 19 }, () => rec());
		expect(mintVerdict(list, [], T0).ok).toBe(true);
		const full = [...list, rec()];
		const v = mintVerdict(full, [], T0);
		expect(v.ok).toBe(false);
		expect(v.ok === false && v.reason).toBe('live');
		expect(v.ok === false && v.message).toMatch(/20 invite links that still work/);
	});
	it('a revoked or expired invite frees a live slot', () => {
		const full = Array.from({ length: 20 }, () => rec());
		full[0] = revokeRecord(full[0]);
		expect(mintVerdict(full, [], T0).ok).toBe(true);
	});
	it('refuses the 11th mint inside 10 minutes and says when to try again', () => {
		const mints = Array.from({ length: 10 }, (_, i) => T0 - (9 - i) * 30_000); // the oldest 4.5 min ago
		const v = mintVerdict([], mints, T0);
		expect(v.ok).toBe(false);
		expect(v.ok === false && v.reason).toBe('rate');
		// the oldest of the ten leaves the window 5.5 minutes from now
		expect(v.ok === false && v.retryInMs).toBe(L.mintWindowMs - 4.5 * 60_000);
		expect(v.ok === false && v.message).toMatch(/Try again in 6 minutes/);
		expect(mintVerdict([], mints.slice(1), T0).ok).toBe(true);
	});
	it('a mint older than the window no longer counts (and forgetting a record does not reset the count)', () => {
		const old = Array.from({ length: 10 }, () => T0 - L.mintWindowMs);
		expect(mintVerdict([], old, T0).ok).toBe(true);
		const recent = Array.from({ length: 10 }, () => T0 - 1000);
		expect(mintVerdict([], recent, T0).ok).toBe(false); // no records at all, still refused
	});
	it('pruneMints keeps only what the window can see', () => {
		expect(pruneMints([T0 - L.mintWindowMs - 1, T0 - 5, NaN, T0 + 1000], T0)).toEqual([T0 - 5]);
		expect(pruneMints(/** @type {any} */ ('junk'), T0)).toEqual([]);
	});
});

describe('71 AS4 failed proofs and the pause', () => {
	it('ten failures in a minute do not pause; the eleventh does, exactly once', () => {
		const g = createJoinGate();
		for (let i = 0; i < 10; i++) {
			const r = g.fail('p' + i, 'bad-proof', {}, T0 + i * 1000);
			expect(r.justPaused).toBe(false);
			expect(r.paused).toBe(false);
		}
		const tip = g.fail('p10', 'unknown', {}, T0 + 10_000);
		expect(tip.justPaused).toBe(true);
		expect(g.paused(T0 + 10_001)).toBe(true);
		const more = g.fail('p11', 'unknown', {}, T0 + 11_000);
		expect(more.justPaused).toBe(false);
		expect(more.paused).toBe(true);
		expect(g.summary().count).toBe(12);
	});
	it('failures during a pause do not re-arm it once it ends; a flood that goes on pauses again', () => {
		const g = createJoinGate();
		for (let i = 0; i <= L.failMax; i++) g.fail('p' + i, 'unknown', {}, T0);
		for (let i = 0; i < 30; i++) g.fail('q' + i, 'unknown', {}, T0 + 1000 + i * 100); // during the pause
		const after = T0 + L.pauseMs + 1;
		expect(g.paused(after)).toBe(false);
		expect(g.fail('x1', 'unknown', {}, after).paused).toBe(false);
		expect(g.fail('x2', 'unknown', {}, after + 1).paused).toBe(false);
		for (let i = 3; i <= L.failMax; i++) expect(g.fail('x' + i, 'unknown', {}, after + i).paused).toBe(false);
		expect(g.fail('x-tip', 'unknown', {}, after + 100).justPaused).toBe(true);
		expect(g.summary().count).toBe(L.failMax + 1 + 30 + L.failMax + 1);
	});
	it('failures spread over more than a minute never pause', () => {
		const g = createJoinGate();
		for (let i = 0; i < 40; i++) expect(g.fail('p' + i, 'unknown', {}, T0 + i * 7000).paused).toBe(false);
	});
	it('the pause lasts 60 s and then lifts by itself', () => {
		const g = createJoinGate();
		for (let i = 0; i <= L.failMax; i++) g.fail('p' + i, 'unknown', {}, T0);
		expect(g.paused(T0 + L.pauseMs - 1)).toBe(true);
		expect(g.pauseLeft(T0 + 30_000)).toBe(30_000);
		expect(g.paused(T0 + L.pauseMs)).toBe(false);
	});
	it('Resume now lifts it; Dismiss clears the row but keeps a running pause', () => {
		const g = createJoinGate();
		for (let i = 0; i <= L.failMax; i++) g.fail('p' + i, 'unknown', {}, T0);
		g.dismiss();
		expect(g.summary().count).toBe(0);
		expect(g.paused(T0 + 1)).toBe(true);
		g.resume();
		expect(g.paused(T0 + 1)).toBe(false);
		// and the window restarts: one more failure does not re-tip
		expect(g.fail('x', 'unknown', {}, T0 + 2).paused).toBe(false);
	});
	it('the row keeps one entry per peer, the newest 12, and counts every dial', () => {
		const g = createJoinGate();
		for (let i = 0; i < 30; i++) g.fail('P' + i, i % 2 ? 'expired' : 'bad-proof', { kind: i === 29 ? 'agent' : undefined }, T0 + i * 10_000);
		g.fail('p29', 'used', {}, T0 + 400_000); // a re-dial refreshes its row (ids compare lower-case)
		const s = g.summary();
		expect(s.count).toBe(31);
		expect(s.rows.length).toBe(L.failedKeep);
		expect(s.rows.at(-1)).toEqual({ peerId: 'p29', reason: 'used', at: T0 + 400_000 });
		expect(s.rows.filter((r) => r.peerId === 'p29').length).toBe(1);
		g.forget('P28');
		expect(g.summary().rows.some((r) => r.peerId === 'p28')).toBe(false);
	});
	it('the summary is a copy (a store write cannot reach back in)', () => {
		const g = createJoinGate();
		g.fail('a', 'unknown', {}, T0);
		const s = g.summary();
		s.rows[0].peerId = 'zzz';
		expect(g.summary().rows[0].peerId).toBe('a');
	});
	it('reset forgets everything', () => {
		const g = createJoinGate();
		for (let i = 0; i <= L.failMax; i++) g.fail('p' + i, 'unknown', {}, T0);
		g.reset();
		expect(g.paused(T0)).toBe(false);
		expect(g.summary()).toEqual({ count: 0, rows: [], pausedUntil: 0, since: 0 });
	});
});

describe('71 AS4 re-joins on one invite', () => {
	it('two quick re-joins are free, the third waits, then one per 30 s', () => {
		const g = createJoinGate();
		expect(g.rejoin('inv', 'a', T0).ok).toBe(true);
		expect(g.rejoin('inv', 'a', T0 + 1000).ok).toBe(true);
		const third = g.rejoin('inv', 'a', T0 + 2000);
		expect(third.ok).toBe(false);
		expect(third.ok === false && third.retryInMs).toBeGreaterThan(25_000);
		const wait = third.ok === false ? third.retryInMs : 0;
		expect(g.rejoin('inv', 'a', T0 + 2000 + wait - 500).ok).toBe(false);
		const t1 = T0 + 2000 + wait + 500;
		expect(g.rejoin('inv', 'a', t1).ok).toBe(true);
		// steady state: one per 30 s
		expect(g.rejoin('inv', 'a', t1 + 29_000).ok).toBe(false);
		expect(g.rejoin('inv', 'a', t1 + 30_500).ok).toBe(true);
	});
	it('is per invite and per peer', () => {
		const g = createJoinGate();
		g.rejoin('inv', 'a', T0);
		g.rejoin('inv', 'a', T0);
		expect(g.rejoin('inv', 'a', T0).ok).toBe(false);
		expect(g.rejoin('inv', 'B', T0).ok).toBe(true);
		expect(g.rejoin('other', 'a', T0).ok).toBe(true);
		expect(g.rejoin('inv', 'A', T0).ok).toBe(false); // the same peer, any case
	});
});

describe('71 AS4 copy', () => {
	it('says one and many', () => {
		expect(failedRowText(1)).toBe('1 failed invite join');
		expect(failedRowText(11)).toBe('11 failed invite joins');
		expect(pauseToastText(11)).toMatch(/paused for 60 s: 11 invite joins failed/);
	});
	it('the joiner reads its reason, and an unknown one falls back', () => {
		expect(joinWhyText('invite-paused', 'AB12CD')).toMatch(/AB12CD has paused invite joins/);
		expect(joinWhyText('invite-slow', 'AB12CD')).toMatch(/Wait half a minute/);
		expect(joinWhyText(undefined, 'AB12CD')).toBeNull();
		expect(joinWhyText('<b>x</b>', 'AB12CD')).toBeNull();
	});
});
