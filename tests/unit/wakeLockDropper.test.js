// 102b-play row 3: Screen Wake Lock reasons and the colour dropper's pure parts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writable } from 'svelte/store';
import { wakeWanted, holdWake, startWakeLock, wakeLockDebug, wakeLockSupported } from '../../src/lib/wakeLock.js';
import { dropperSpot, applyPickedColor, eyeDropperSupported } from '../../src/lib/ui/eyeDropper.js';

describe('wakeWanted', () => {
	it('wants the lock only while a reason holds and the page is visible', () => {
		expect(wakeWanted([], true)).toBe(false);
		expect(wakeWanted(['play'], true)).toBe(true);
		expect(wakeWanted(new Set(['film']), false)).toBe(false);
	});
});

describe('without the API it is a silent no-op', () => {
	it('starts nothing and holds nothing', () => {
		expect(wakeLockSupported()).toBe(false);
		const stop = startWakeLock([{ reason: 'play', store: writable(true), holds: (v) => v }]);
		expect(wakeLockDebug().reasons).toEqual([]);
		stop();
		expect(eyeDropperSupported()).toBe(false);
	});
});

describe('with the API: reasons keep one lock', () => {
	/** @type {any[]} */
	let sentinels;
	beforeEach(() => {
		sentinels = [];
		vi.stubGlobal('navigator', {
			wakeLock: {
				request: vi.fn(async () => {
					const s = { released: false, release: vi.fn(async () => (s.released = true)), addEventListener: () => {} };
					sentinels.push(s);
					return s;
				})
			}
		});
	});
	it('asks once while any reason holds, releases when the last goes', async () => {
		const play = writable(false);
		const film = writable(false);
		const stop = startWakeLock([
			{ reason: 'play', store: play, holds: (v) => v },
			{ reason: 'film', store: film, holds: (v) => v }
		]);
		play.set(true);
		await Promise.resolve();
		await Promise.resolve();
		film.set(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(sentinels.length).toBe(1);
		play.set(false); // the recording still holds it
		await new Promise((r) => setTimeout(r, 0));
		expect(sentinels[0].released).toBe(false);
		film.set(false);
		await new Promise((r) => setTimeout(r, 0));
		expect(sentinels[0].released).toBe(true);
		stop();
		holdWake('x', false);
		vi.unstubAllGlobals();
	});
});

describe('dropper', () => {
	it('sits right of the field, or left when the right edge has no room', () => {
		expect(dropperSpot({ left: 100, right: 130, top: 50, height: 24 }, 800, 24)).toEqual({ left: 134, top: 50 });
		expect(dropperSpot({ left: 760, right: 790, top: 10, height: 20 }, 800, 24)).toEqual({ left: 732, top: 8 });
	});
	it('writes a picked colour as input + change, and refuses junk', () => {
		/** @type {string[]} */
		const seen = [];
		const input = /** @type {any} */ ({ value: '#000000', dispatchEvent: (/** @type {Event} */ e) => seen.push(e.type) });
		vi.stubGlobal('Event', class { constructor(/** @type {string} */ t) { this.type = t; } });
		expect(applyPickedColor(input, '#A1B2C3')).toBe(true);
		expect(input.value).toBe('#a1b2c3');
		expect(seen).toEqual(['input', 'change']);
		expect(applyPickedColor(input, 'red')).toBe(false);
		vi.unstubAllGlobals();
	});
});
