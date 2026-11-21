// 102 M4: the pure half of anonymous play statistics — buckets, the state fold, the device class,
// the tracker's one-start / net-end / retraction rules and the hard cap per play.
import { describe, it, expect } from 'vitest';
import { timeBucket, playStateOf, playDeviceOf, cleanLevel, createPlayTracker, PLAY_EVENT_CAP, BEACON_MAX_EVENTS, TIME_BUCKETS } from '../../src/lib/play/playStatsCore.js';
import { onPlayStats, notifyPlayStats, playStatsListening } from '../../src/lib/cloudHooks.js';
import { get } from 'svelte/store';

const ok = () => true;
/** collect every body that went out */
const sink = () => {
	/** @type {any[]} */ const got = [];
	return { got, send: (/** @type {any} */ b) => (got.push(b), true) };
};

describe('timeBucket', () => {
	it('maps seconds to the stored buckets, edges included', () => {
		expect([0, 29.9, 30, 59, 60, 179, 180, 599, 600, 1799, 1800, 99999].map(timeBucket)).toEqual([
			'lt30s', 'lt30s', '30s1m', '30s1m', '1to3', '1to3', '3to10', '3to10', '10to30', '10to30', 'gt30', 'gt30'
		]);
	});
	it('treats nonsense as zero', () => {
		expect(timeBucket(-5)).toBe('lt30s');
		expect(timeBucket(NaN)).toBe('lt30s');
		expect(TIME_BUCKETS).toHaveLength(6);
	});
});

describe('playStateOf', () => {
	it('folds gameState into the closed vocabulary', () => {
		expect(playStateOf({ state: 'playing' })).toBe('playing');
		expect(playStateOf({ state: 'paused' })).toBe('paused');
		expect(playStateOf({ state: 'menu' })).toBe('menu');
		expect(playStateOf({ state: 'over', outcome: 'win' })).toBe('won');
		expect(playStateOf({ state: 'over', outcome: 'Lose' })).toBe('lost');
		expect(playStateOf({ state: 'over', outcome: 'time up' })).toBe('over');
		expect(playStateOf({ state: 'warp-9' })).toBe('none');
	});
	it('a scene without game rules says none', () => {
		expect(playStateOf({ state: 'menu' }, false)).toBe('none');
		expect(playStateOf(null)).toBe('none');
	});
});

describe('playDeviceOf', () => {
	it('is a class, nothing finer: headset / phone / desktop', () => {
		expect(playDeviceOf({ ua: 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/35.0' })).toBe('headset');
		expect(playDeviceOf({ ua: 'Mozilla/5.0 (Linux; Android 15; Pixel) Mobile' })).toBe('phone');
		expect(playDeviceOf({ ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' })).toBe('phone');
		expect(playDeviceOf({ ua: 'Mozilla/5.0 (X11; Linux x86_64)', coarse: true })).toBe('phone');
		expect(playDeviceOf({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('desktop');
	});
});

describe('cleanLevel', () => {
	it('keeps letters, digits and _ .- (32 chars), as the Worker does', () => {
		expect(cleanLevel('Level 2')).toBe('Level 2');
		expect(cleanLevel('<b>Boss</b> "room"')).toBe('b Boss b room');
		expect(cleanLevel('x'.repeat(50))).toHaveLength(32);
		expect(cleanLevel(null)).toBe('');
	});
});

describe('createPlayTracker', () => {
	it('sends nothing before Play is pressed', () => {
		const t = createPlayTracker({ scene: 'abc', device: 'desktop' });
		const s = sink();
		expect(t.flush(1000, s.send)).toBeNull();
		expect(s.got).toHaveLength(0);
	});

	it('a bad scene id never counts', () => {
		const t = createPlayTracker({ scene: "x' OR 1", device: 'desktop' });
		t.playing(true, 0);
		expect(t.flush(5000, ok)).toBeNull();
	});

	it('first hide: start + one end, with the time bucket, level and state', () => {
		const t = createPlayTracker({ scene: 'abc', device: 'phone' });
		t.playing(true, 1000);
		t.level('Level 1');
		t.state('playing');
		const b = t.flush(1000 + 45_000, ok);
		expect(b).toEqual({ v: 1, s: 'abc', d: 'phone', e: [{ k: 'start' }, { k: 'end', t: '30s1m', l: 'Level 1', g: 'playing', w: 1 }] });
	});

	it('time counts only while playing (stop / start add up)', () => {
		const t = createPlayTracker({ scene: 'abc', device: 'desktop' });
		t.playing(true, 0);
		t.playing(false, 20_000);
		t.playing(true, 100_000);
		expect(t.peek(115_000).seconds).toBe(35);
	});

	it('a later hide retracts the previous end and sends the new one; nothing new = nothing sent', () => {
		const t = createPlayTracker({ scene: 'abc', device: 'desktop' });
		const s = sink();
		t.playing(true, 0);
		t.state('playing');
		t.flush(10_000, s.send);
		expect(t.flush(12_000, s.send)).toBeNull(); // same bucket, same level, same state
		t.state('won');
		const b = t.flush(200_000, s.send);
		expect(b?.e).toEqual([
			{ k: 'end', t: 'lt30s', l: '', g: 'playing', w: -1 },
			{ k: 'end', t: '3to10', l: '', g: 'won', w: 1 }
		]);
		// net: one start, one end (the sum the server takes)
		const all = s.got.flatMap((x) => x.e);
		expect(all.filter((e) => e.k === 'start')).toHaveLength(1);
		expect(all.filter((e) => e.k === 'end').reduce((n, e) => n + e.w, 0)).toBe(1);
	});

	it('a send that did not go out is not remembered (the next hide retries the same thing)', () => {
		const t = createPlayTracker({ scene: 'abc', device: 'desktop' });
		t.playing(true, 0);
		expect(t.flush(5000, () => false)).toBeNull();
		expect(t.flush(5000, () => {
			throw new Error('no network');
		})).toBeNull();
		const b = t.flush(5000, ok);
		expect(b?.e.map((e) => e.k)).toEqual(['start', 'end']);
		expect(b?.e.some((e) => e.w === -1)).toBe(false);
	});

	it('hard cap: one play never sends more than PLAY_EVENT_CAP events, and every beacon fits the Worker', () => {
		const t = createPlayTracker({ scene: 'abc', device: 'desktop' });
		const s = sink();
		t.playing(true, 0);
		for (let i = 0; i < 100; i++) {
			t.state(i % 2 ? 'paused' : 'playing');
			t.level('L' + i);
			t.flush(i * 1000, s.send);
		}
		const all = s.got.flatMap((x) => x.e);
		expect(all.length).toBeLessThanOrEqual(PLAY_EVENT_CAP);
		expect(s.got.every((x) => x.e.length <= BEACON_MAX_EVENTS)).toBe(true);
		// what went out still nets to exactly one start and one end
		expect(all.filter((e) => e.k === 'start')).toHaveLength(1);
		expect(all.filter((e) => e.k === 'end').reduce((n, e) => n + e.w, 0)).toBe(1);
	});

	it('the tracker never sends an id of the play: the body has only v / s / d / e', () => {
		const t = createPlayTracker({ scene: 'abc', device: 'desktop' });
		t.playing(true, 0);
		const b = t.flush(1000, ok);
		expect(Object.keys(b || {}).sort()).toEqual(['d', 'e', 's', 'v']);
		for (const e of b?.e || []) expect(Object.keys(e).every((k) => ['k', 't', 'l', 'g', 'w'].includes(k))).toBe(true);
	});
});

describe('cloudHooks onPlayStats', () => {
	it('no listener: nothing sent, false back (an engine with no plugin sends nothing)', () => {
		expect(get(playStatsListening)).toBe(false);
		expect(notifyPlayStats({ v: 1, s: 'abc', d: 'desktop', e: [{ k: 'start' }] })).toBe(false);
	});
	it('a listener gets a copy and its true says it went out; off stops it', () => {
		/** @type {any[]} */ const got = [];
		const off = onPlayStats((b) => (got.push(b), true));
		expect(get(playStatsListening)).toBe(true);
		const body = { v: /** @type {1} */ (1), s: 'abc', d: 'desktop', e: [{ k: 'start' }] };
		expect(notifyPlayStats(body)).toBe(true);
		got[0].s = 'changed';
		expect(body.s).toBe('abc');
		off();
		expect(get(playStatsListening)).toBe(false);
		expect(notifyPlayStats(body)).toBe(false);
	});
	it('a listener that throws does not break the page', () => {
		const off = onPlayStats(() => {
			throw new Error('boom');
		});
		expect(notifyPlayStats({ v: 1, s: 'abc', d: 'desktop', e: [] })).toBe(false);
		off();
	});
});
