// 98-int (device-lab-3, HONOR at Auto): after a few preset switches the governor sat at "post off" and every pro look drew only
// its sky. The ladder now takes a LIGHTER look first: fog / god rays / lens flare / TRAA / AO go, the grade stays.
import { describe, it, expect } from 'vitest';
import { GOVERNOR_STEPS, overridesAt, PHONE_START_LEVEL } from '../../src/lib/qualityGovernorCore.js';
import { liteLook, LITE_DROPS, PRO_LOOKS } from '../../src/lib/post/proPresetsCore.js';

const at = (/** @type {string} */ key) => GOVERNOR_STEPS.findIndex((s) => s.key === key) + 1;

describe('98-int: a lighter look before no look', () => {
	it('lookLite comes right before post off, after the phone start level', () => {
		expect(at('lookLite')).toBe(at('post') - 1);
		expect(at('lookLite')).toBeGreaterThan(PHONE_START_LEVEL);
		expect(overridesAt(at('lookLite'))).toMatchObject({ lookLite: true, postOff: false });
		expect(overridesAt(at('lookLite') - 1).lookLite).toBe(false);
	});
	it('every pro look keeps something visible at the lighter step', () => {
		for (const [name, look] of Object.entries(PRO_LOOKS)) {
			const kept = liteLook(look.effects).map((e) => e.kind);
			expect(kept.length, name).toBeGreaterThan(0);
			expect(kept, name).toContain('tonemapping');
			for (const k of LITE_DROPS) expect(kept, name).not.toContain(k);
		}
	});
});
