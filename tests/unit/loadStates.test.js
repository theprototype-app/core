// @ts-nocheck — assertions on nullable returns; the module itself is fully typed
import { describe, it, expect, beforeEach } from 'vitest';
import {
	noteAttempt,
	noteBytes,
	noteParsing,
	noteRetryWait,
	noteFailed,
	noteDone,
	loadOf,
	failedLoads,
	visualState,
	progressOf,
	describeLoadError,
	describeLoad,
	HttpError,
	StallError,
	RETRY_DELAYS,
	VIS_LOADING,
	VIS_STUCK,
	VIS_FAILED,
	setLoadClockForTest,
	resetLoadsForTest,
	normalizeGrid,
	normalizeStyle,
	initialPlaceholderStyle,
	normalizeStuckSeconds,
	DEFAULT_GRID
} from '../../src/lib/loadStates.js';

// 36 U9: the per-file load states behind the placeholders.
const URL = 'https://cdn.example/packs/kit/Wall/glTF-Binary/Wall.glb';
let now = 0;
beforeEach(() => {
	now = 1000;
	setLoadClockForTest(() => now);
	resetLoadsForTest();
});

describe('visual state', () => {
	it('loading while bytes keep arriving, amber after `stuck` of silence', () => {
		noteAttempt(URL, 0);
		noteBytes(URL, 100, 1000);
		expect(visualState(loadOf(URL), now, 10000)).toBe(VIS_LOADING);
		now += 9999;
		expect(visualState(loadOf(URL), now, 10000)).toBe(VIS_LOADING);
		now += 1;
		expect(visualState(loadOf(URL), now, 10000)).toBe(VIS_STUCK);
		// one more chunk and it is loading again
		noteBytes(URL, 200, 1000);
		expect(visualState(loadOf(URL), now, 10000)).toBe(VIS_LOADING);
	});
	it('a backoff wait is amber, a final failure is red, a done file has no record', () => {
		noteAttempt(URL, 0);
		noteRetryWait(URL, describeLoadError(new HttpError(503)), RETRY_DELAYS[0]);
		expect(visualState(loadOf(URL), now, 10000)).toBe(VIS_STUCK);
		noteFailed(URL, describeLoadError(new HttpError(503)));
		expect(visualState(loadOf(URL), now, 10000)).toBe(VIS_FAILED);
		expect(failedLoads().map((l) => l.url)).toEqual([URL]);
		noteAttempt(URL, 0); // a manual retry
		expect(visualState(loadOf(URL), now, 10000)).toBe(VIS_LOADING);
		noteDone(URL);
		expect(loadOf(URL)).toBe(null);
	});
	it('parsing is never stuck (the bytes are here)', () => {
		noteAttempt(URL, 0);
		noteParsing(URL);
		now += 60000;
		expect(visualState(loadOf(URL), now, 10000)).toBe(VIS_LOADING);
	});
});

describe('progress', () => {
	it('bytes over total, clamped, 1 while parsing, -1 for an unknown size', () => {
		noteAttempt(URL, 0);
		expect(progressOf(loadOf(URL))).toBe(0);
		noteBytes(URL, 250, 1000);
		expect(progressOf(loadOf(URL))).toBe(0.25);
		noteBytes(URL, 1500, 1000); // decompressed > compressed content-length
		expect(progressOf(loadOf(URL))).toBe(1);
		noteAttempt(URL, 1);
		noteBytes(URL, 400, 0);
		expect(progressOf(loadOf(URL))).toBe(-1);
		noteParsing(URL);
		expect(progressOf(loadOf(URL))).toBe(1);
	});
});

describe('which failures retry', () => {
	it('retries network/CORS, 408/429/5xx and a stall; not 4xx or a parse error', () => {
		expect(describeLoadError(new TypeError('Failed to fetch'))).toMatchObject({ status: 0, retryable: true });
		expect(describeLoadError(new HttpError(503))).toMatchObject({ status: 503, retryable: true });
		expect(describeLoadError(new HttpError(429)).retryable).toBe(true);
		expect(describeLoadError(new HttpError(408)).retryable).toBe(true);
		expect(describeLoadError(new StallError(30000))).toMatchObject({ status: 0, retryable: true });
		expect(describeLoadError(new HttpError(404))).toMatchObject({ status: 404, reason: 'file not found', retryable: false });
		expect(describeLoadError(new HttpError(403)).retryable).toBe(false);
		expect(describeLoadError(new Error('Unexpected token in JSON')).retryable).toBe(false);
	});
	it('backoff is three retries, 1 / 3 / 9 s', () => {
		expect(RETRY_DELAYS).toEqual([1000, 3000, 9000]);
	});
	it('the tooltip names the URL, the status and the reason', () => {
		noteFailed(URL, describeLoadError(new HttpError(404)));
		const text = describeLoad(loadOf(URL));
		expect(text).toContain('404');
		expect(text).toContain('file not found');
		expect(text).toContain(URL);
	});
});

describe('settings normalize', () => {
	it('style, grid and stuck seconds', () => {
		expect(normalizeStyle('modern')).toBe('modern');
		expect(normalizeStyle('boxes')).toBe('boxes');
		expect(normalizeStyle('nonsense')).toBe('modern');
		expect(normalizeGrid(null)).toEqual(DEFAULT_GRID);
		expect(normalizeGrid({ on: false, size: 99, color: 'red', opacity: -1, speed: 2 })).toEqual({
			on: false,
			size: 10,
			color: DEFAULT_GRID.color,
			opacity: 0,
			speed: 2
		});
		expect(normalizeStuckSeconds(0)).toBe(1);
		expect(normalizeStuckSeconds('15')).toBe(15);
		expect(normalizeStuckSeconds(undefined)).toBe(10);
	});
});

// 36 L1: Modern is the default; an explicit pick (1.21's stored value included) is kept.
describe('placeholder style default', () => {
	/** @param {Record<string, string>} kv */
	const reader = (kv) => (/** @type {string} */ k) => (k in kv ? kv[k] : null);
	it('never chose -> Modern', () => {
		expect(initialPlaceholderStyle(reader({}))).toBe('modern');
	});
	it('an explicit "Colored boxes" from 1.21 (no flag) stays boxes', () => {
		expect(initialPlaceholderStyle(reader({ placeholderStyle: '"boxes"' }))).toBe('boxes');
	});
	it('a 1.22 pick (flag set) is kept either way', () => {
		expect(initialPlaceholderStyle(reader({ placeholderStyle: '"boxes"', placeholderStyleChosen: '1' }))).toBe('boxes');
		expect(initialPlaceholderStyle(reader({ placeholderStyle: '"modern"', placeholderStyleChosen: '1' }))).toBe('modern');
	});
	it('garbage falls back to the default', () => {
		expect(initialPlaceholderStyle(reader({ placeholderStyle: '{oops' }))).toBe('modern');
		expect(initialPlaceholderStyle(() => { throw new Error('storage blocked'); })).toBe('modern');
	});
});
