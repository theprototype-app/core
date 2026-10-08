// 40 F12 — what the auto-quality notice says: one toast per drop, naming every toggle that drop
// newly lowered, each toggle announced once per session ("Lowered water quality to keep it
// smooth · Keep full quality").
import { describe, it, expect } from 'vitest';
import { newlyLowered, toAnnounce, noticeText, isLowered, QUALITY_TOGGLES, KEEP_FULL_LABEL } from '../../src/lib/qualityNoticeCore.js';
import { overridesAt } from '../../src/lib/qualityGovernorCore.js';

/** @param {number} level @param {Record<string, boolean>} [extra] */
const snap = (level, extra = {}) => ({ ...overridesAt(level), water: false, fluid: false, ...extra });

describe('quality notice (F12)', () => {
	it('the spec sentence, verbatim', () => {
		expect(noticeText(['water'])).toBe('Lowered water quality to keep it smooth');
		expect(KEEP_FULL_LABEL).toBe('Keep full quality');
	});

	it('lists several in toggle order with "and"', () => {
		expect(noticeText(['ao', 'shadows', 'resolution'])).toBe('Lowered shadows, resolution and ambient occlusion to keep it smooth');
		expect(noticeText(['post', 'water'])).toBe('Lowered water quality and the scene look to keep it smooth');
		expect(noticeText([])).toBe('');
	});

	it('the phone start (level 0 -> 4) lowers shadows, resolution and AO', () => {
		expect(newlyLowered(snap(0), snap(4))).toEqual(['shadows', 'resolution', 'ao']);
	});

	it('level 5 -> 6 with the water simplified names the water first', () => {
		expect(newlyLowered(snap(5), snap(6, { water: true }))).toEqual(['water', 'post']);
	});

	it('a further resolution step is not a new drop; a recovery is not a drop', () => {
		expect(newlyLowered(snap(2), snap(3))).toEqual([]); // 85 % -> 72 %
		expect(newlyLowered(snap(6, { water: true }), snap(5))).toEqual([]);
	});

	it('once per session: an announced toggle is never announced again', () => {
		expect(toAnnounce(['water', 'post'], ['post'])).toEqual(['water']);
		expect(toAnnounce(['water'], ['water'])).toEqual([]);
	});

	it('every toggle in the list has a lowered rule', () => {
		for (const t of QUALITY_TOGGLES) expect(isLowered(t.key, snap(9, { water: true, fluid: true }))).toBe(true);
		for (const t of QUALITY_TOGGLES) expect(isLowered(t.key, snap(0))).toBe(false);
	});
});
