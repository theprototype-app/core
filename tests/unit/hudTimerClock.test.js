// 92-correct row 1: an autostart HUD Timer counts from Play / the round, never from the editor;
// a pause stops it; a late joiner reads the host's round number.
import { describe, expect, test } from 'vitest';
import { autostartElapsed, wiredElapsed, roundSeconds, shellInUse } from '../../src/lib/hudTimerClock.js';

const T0 = 1_800_000_000_000;

describe('autostart timer, plain Play (no round)', () => {
	test('waits in the editor, however long the scene sits there', () => {
		const a = {};
		expect(autostartElapsed({ game: {}, nowMs: T0, playing: false, effNow: 10 }, a)).toBe(0);
		expect(autostartElapsed({ game: {}, nowMs: T0 + 60000, playing: false, effNow: 70 }, a)).toBe(0);
	});
	test('counts from the Play press, and starts over on the next Play', () => {
		const a = {};
		autostartElapsed({ game: {}, nowMs: T0, playing: false, effNow: 5 }, a);
		expect(autostartElapsed({ game: {}, nowMs: T0, playing: true, effNow: 20 }, a)).toBe(0);
		expect(autostartElapsed({ game: {}, nowMs: T0, playing: true, effNow: 26 }, a)).toBe(6);
		autostartElapsed({ game: {}, nowMs: T0, playing: false, effNow: 30 }, a);
		expect(autostartElapsed({ game: {}, nowMs: T0, playing: true, effNow: 40 }, a)).toBe(0);
	});
	test('the effect clock holding (a pause) holds the timer', () => {
		const a = {};
		autostartElapsed({ game: {}, nowMs: T0, playing: true, effNow: 0 }, a);
		expect(autostartElapsed({ game: {}, nowMs: T0, playing: true, effNow: 4 }, a)).toBe(4);
		// paused: effNow frozen at 4 while real time runs
		expect(autostartElapsed({ game: {}, nowMs: T0 + 9000, playing: true, effNow: 4 }, a)).toBe(4);
	});
});

describe('autostart timer, a game round', () => {
	const round = { state: 'playing', round: 1, startedAt: T0, pausedAt: 0, pausedMs: 0 };
	test('counts from the shared startedAt, so a late joiner reads the host number', () => {
		const host = {};
		const joiner = {};
		expect(autostartElapsed({ game: round, nowMs: T0 + 30000, playing: true, effNow: 100 }, host)).toBe(30);
		// the joiner arrives 30 s in, editor or Play does not matter: the round is shared
		expect(autostartElapsed({ game: round, nowMs: T0 + 30000, playing: false, effNow: 3 }, joiner)).toBe(30);
	});
	test('a pause stops it (live and banked spans)', () => {
		const paused = { ...round, state: 'paused', pausedAt: T0 + 10000 };
		expect(autostartElapsed({ game: paused, nowMs: T0 + 25000, playing: true, effNow: 0 }, {})).toBe(10);
		const resumed = { ...round, pausedMs: 15000 };
		expect(autostartElapsed({ game: resumed, nowMs: T0 + 30000, playing: true, effNow: 0 }, {})).toBe(15);
	});
	test('menu shows the full time; over holds where it stopped', () => {
		expect(autostartElapsed({ game: { ...round, state: 'menu' }, nowMs: T0 + 5000, playing: true, effNow: 0 }, {})).toBe(0);
		const a = {};
		const over = { ...round, state: 'over' };
		expect(autostartElapsed({ game: over, nowMs: T0 + 42000, playing: true, effNow: 0 }, a)).toBe(42);
		expect(autostartElapsed({ game: over, nowMs: T0 + 90000, playing: true, effNow: 0 }, a)).toBe(42);
	});
	test('helpers', () => {
		expect(shellInUse({})).toBe(false);
		expect(shellInUse({ round: 1 })).toBe(true);
		expect(roundSeconds({ startedAt: 0 }, T0)).toBe(0);
	});
});

describe('wired timer (Start pulse)', () => {
	test('counts from the stamp; only pauses after the start come off', () => {
		const a = {};
		// 3 s of pause banked before the start
		expect(wiredElapsed({ time: 100, stamp: 100, paused: 3 }, a)).toBe(0);
		expect(wiredElapsed({ time: 110, stamp: 100, paused: 3 }, a)).toBe(10);
		// a 4 s pause during the count
		expect(wiredElapsed({ time: 120, stamp: 100, paused: 7 }, a)).toBe(16);
		// a fresh Start re-anchors
		expect(wiredElapsed({ time: 130, stamp: 128, paused: 7 }, a)).toBe(2);
	});
});
