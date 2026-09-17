import { describe, it, expect, beforeEach } from 'vitest';
import {
	sessionNow,
	sessionOffset,
	setClockReference,
	setClockSelf,
	recordClockSample,
	noteRemoteSessionClock,
	dropPeerClock,
	resetSessionClock,
	estimateFromSamples,
	targetOffset,
	onSessionClockJump,
	ADOPT_THRESHOLD_MS,
	GROSS_SKEW_MS,
	MIN_SAMPLES
} from '../../src/lib/sessionClock.js';

// 25-E. The session clock is a pure decision over a handful of samples: WHICH peer we
// keep time by, WHEN an estimate is trustworthy enough to move the clock, and the two
// traps — a reference that keeps time by us, and a departure that must not snap every
// later stamp back onto a clock nobody else uses.

let n = 0;
/** a fresh peer id per test, because the sample rings are module state */
const fresh = () => 'peer' + ++n;

beforeEach(() => {
	resetSessionClock();
	setClockSelf('me');
});

describe('sessionNow', () => {
	it('is our own clock while we host', () => {
		const a = Date.now();
		const s = sessionNow();
		expect(s - a).toBeGreaterThanOrEqual(0);
		expect(s - a).toBeLessThan(20);
		expect(sessionOffset()).toBe(0);
	});

	it('adopts a GROSS skew from its reference on the very first sample', () => {
		const host = fresh();
		setClockReference(host);
		recordClockSample(host, 90_000, 20);
		expect(sessionOffset()).toBe(90_000);
		expect(Math.abs(sessionNow() - (Date.now() + 90_000))).toBeLessThan(20);
	});

	it('waits for MIN_SAMPLES before moving on a small skew', () => {
		const host = fresh();
		setClockReference(host);
		for (let i = 0; i < MIN_SAMPLES - 1; i++) recordClockSample(host, 300, 10);
		expect(sessionOffset()).toBe(0);
		recordClockSample(host, 300, 10);
		expect(sessionOffset()).toBe(300);
	});

	it('ignores samples from anybody but the reference', () => {
		setClockReference(fresh());
		const other = fresh();
		for (let i = 0; i < 6; i++) recordClockSample(other, 90_000, 10);
		expect(sessionOffset()).toBe(0);
	});

	it('does not chase noise under the adoption threshold', () => {
		const host = fresh();
		setClockReference(host);
		for (let i = 0; i < 6; i++) recordClockSample(host, ADOPT_THRESHOLD_MS - 5, 10);
		expect(sessionOffset()).toBe(0);
	});

	it('is TRANSITIVE: a reference that follows its own host hands that clock on', () => {
		const joiner = fresh();
		setClockReference(joiner);
		// the joiner's raw clock is 10 s ahead of ours, and it keeps time by a host that
		// is 5 s behind IT — so the session is 5 s ahead of us
		noteRemoteSessionClock(joiner, -5_000, 'the-host');
		for (let i = 0; i < MIN_SAMPLES; i++) recordClockSample(joiner, 10_000, 10);
		expect(sessionOffset()).toBe(5_000);
		expect(targetOffset()).toBe(5_000);
	});

	it('refuses a clock handed back by a reference that follows US (the loop guard)', () => {
		const loop = fresh();
		setClockReference(loop);
		noteRemoteSessionClock(loop, 7_000, 'me');
		for (let i = 0; i < MIN_SAMPLES; i++) recordClockSample(loop, 2_000, 10);
		// its RAW clock is still used — only the part it copied from us is dropped
		expect(sessionOffset()).toBe(2_000);
	});

	it('an older peer (no `so` on the pong) reads as its raw clock', () => {
		const old = fresh();
		setClockReference(old);
		noteRemoteSessionClock(old, undefined, undefined);
		for (let i = 0; i < MIN_SAMPLES; i++) recordClockSample(old, 4_000, 10);
		expect(sessionOffset()).toBe(4_000);
	});

	it('KEEPS the offset when the reference departs, and drops it only on leaving', () => {
		const host = fresh();
		setClockReference(host);
		recordClockSample(host, 60_000, 10);
		dropPeerClock(host);
		setClockReference(null);
		expect(sessionOffset()).toBe(60_000);
		resetSessionClock();
		expect(sessionOffset()).toBe(0);
	});

	it('the gross-skew fast path is exactly GROSS_SKEW_MS', () => {
		const host = fresh();
		setClockReference(host);
		recordClockSample(host, GROSS_SKEW_MS - 1, 10);
		expect(sessionOffset()).toBe(0);
		const other = fresh();
		setClockReference(other);
		recordClockSample(other, GROSS_SKEW_MS + 1, 10);
		expect(sessionOffset()).toBe(GROSS_SKEW_MS + 1);
	});
});

describe('onSessionClockJump', () => {
	it('reports each adoption as the jump it made, and a reset as the jump back', () => {
		/** @type {number[]} */
		const jumps = [];
		const off = onSessionClockJump((d) => jumps.push(d));
		const host = fresh();
		setClockReference(host);
		recordClockSample(host, -90_000, 10);
		recordClockSample(host, -90_000, 10);
		recordClockSample(host, -89_900, 10); // median unchanged: no second jump
		resetSessionClock();
		off();
		expect(jumps).toEqual([-90_000, 90_000]);
	});

	it('a throwing listener does not stop the clock or the others', () => {
		/** @type {number[]} */
		const seen = [];
		const a = onSessionClockJump(() => {
			throw new Error('boom');
		});
		const b = onSessionClockJump((d) => seen.push(d));
		const host = fresh();
		setClockReference(host);
		recordClockSample(host, 5_000, 10);
		a();
		b();
		expect(sessionOffset()).toBe(5_000);
		expect(seen).toEqual([5_000]);
	});
});

describe('estimateFromSamples (moved from musicClock)', () => {
	it('takes the median of the lowest-RTT half', () => {
		const est = estimateFromSamples({ offsets: [300, 310, 900, 305], rtts: [10, 12, 400, 11] });
		expect(est?.offset).toBe(302.5);
		expect(est?.samples).toBe(4);
	});
	it('answers null for an empty ring', () => {
		expect(estimateFromSamples({ offsets: [], rtts: [] })).toBe(null);
	});
});
