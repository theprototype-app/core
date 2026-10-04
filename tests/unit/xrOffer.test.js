// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { offerDecision } from '../../src/lib/xrOffer.js';

// 36 A2: when the headset browser may offer "Enter VR" by itself.
const base = { hasOffer: true, supported: true, enabled: true, declined: false, settled: false, passthrough: false };
describe('offerDecision', () => {
	it('offers VR where offerSession exists and VR is supported', () => {
		expect(offerDecision(base)).toBe('immersive-vr');
	});
	it('follows the Play preference: passthrough on → AR', () => {
		expect(offerDecision({ ...base, passthrough: true })).toBe('immersive-ar');
	});
	it('feature-detects: no offerSession, or the mode unsupported → nothing', () => {
		expect(offerDecision({ ...base, hasOffer: false })).toBe(false);
		expect(offerDecision({ ...base, supported: false })).toBe(false);
	});
	it('respects a decline, the setting, and once per page', () => {
		expect(offerDecision({ ...base, declined: true })).toBe(false);
		expect(offerDecision({ ...base, enabled: false })).toBe(false);
		expect(offerDecision({ ...base, settled: true })).toBe(false);
	});
});
