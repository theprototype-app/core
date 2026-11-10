// 78 PL11 + PL22: phone frame limits, and frames the governor already answers read as a calm note
import { describe, it, expect } from 'vitest';
import { tierOf, footerTier } from '../../src/lib/sceneBudget.js';

describe('phone frame limits', () => {
	it('a steady 30 fps phone is green; the headset limits it was judged by called it red', () => {
		expect(tierOf('frameP95', 33.4, 'phone')).toBe('green');
		expect(tierOf('frameP95', 33.4, 'vr')).toBe('red');
		expect(tierOf('frameP95', 60, 'phone')).toBe('red');
	});
	it('rows with no phone limits keep the mobile (vr) ones, as before', () => {
		expect(tierOf('calls', 3000, 'phone')).toBe(tierOf('calls', 3000, 'vr'));
	});
});

describe('footerTier', () => {
	it('frame rows over while the governor lowers quality read as a note', () => {
		expect(footerTier({ frameP95: 60, longTasks: 30 }, 'desktop', true)).toBe('note');
		expect(footerTier({ frameP95: 60 }, 'desktop', false)).toBe('red');
	});
	it('a scene over on what it holds still warns', () => {
		expect(footerTier({ frameP95: 60, calls: 1e6 }, 'desktop', true)).toBe('red');
	});
	it('a scene within budget stays green', () => {
		expect(footerTier({ frameP95: 10 }, 'desktop', true)).toBe('green');
	});
});
