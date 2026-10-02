import { describe, it, expect } from 'vitest';
import { callsTier, perfParts, CALLS_WARN, CALLS_LIMIT } from '../../src/lib/fpsMeter.js';

// 33 Q1: the draw-call budget on the counter — "150 is limit for quest". Amber past 120,
// red past 150; the desktop counter and the VR strip both read `callsTier`.
describe('callsTier', () => {
	it('the thresholds are the Quest budget', () => {
		expect(CALLS_WARN).toBe(120);
		expect(CALLS_LIMIT).toBe(150);
	});
	it('ok up to 120, amber past it, red past 150 (both bounds inclusive of the lower tier)', () => {
		expect(callsTier(0)).toBe('ok');
		expect(callsTier(120)).toBe('ok');
		expect(callsTier(121)).toBe('warn');
		expect(callsTier(150)).toBe('warn');
		expect(callsTier(151)).toBe('over');
		expect(callsTier(900)).toBe('over');
	});
	it('nothing measured is no tier, not "ok"', () => {
		expect(callsTier(null)).toBe(null);
		expect(callsTier(undefined)).toBe(null);
		expect(callsTier(NaN)).toBe(null);
	});
});

describe('perfParts', () => {
	it('a reading becomes the four parts the counter draws, with the tier', () => {
		const p = perfParts({ fps: 72, ms: 13.9, calls: 163, tris: 248000, source: 'xr' });
		expect(p).toEqual({ fps: '72 fps', ms: '13.9 ms', calls: '163 calls', tris: '248k tris', tier: 'over' });
	});
	it('an empty reading has no parts beyond the placeholder', () => {
		const p = perfParts({ fps: null, ms: null, calls: null, tris: null, source: null });
		expect(p).toEqual({ fps: '— fps', ms: null, calls: null, tris: null, tier: null });
	});
});
