// 103 H11 — Judge for: the toggle set, the 46 B1 migration, the once-only auto-on, the collapse.
import { describe, it, expect } from 'vitest';
import { normalizeJudge, initialJudge, targetOf, hereTarget, judgeParts, shouldAutoOn, collapseParts } from '../../src/lib/judgeForCore.js';

describe('judgeForCore', () => {
	it('normalizes to known ids in menu order, no repeats', () => {
		expect(normalizeJudge(['pc', 'x', 'this', 'pc'])).toEqual(['this', 'pc']);
		expect(normalizeJudge('quest')).toEqual([]);
	});
	it('a stored set wins; otherwise the old single target migrates, quest = never chose', () => {
		expect(initialJudge('["quest"]', 'phone')).toEqual(['quest']);
		expect(initialJudge('not json', 'phone')).toEqual([]);
		expect(initialJudge(null, 'phone')).toEqual(['phone']);
		expect(initialJudge(null, 'desktop')).toEqual(['pc']);
		expect(initialJudge(null, 'quest')).toEqual([]);
		expect(initialJudge(null, null)).toEqual([]);
	});
	it('maps toggles onto meter targets', () => {
		expect(targetOf('this', 'phone')).toBe('phone');
		expect(targetOf('pc', 'phone')).toBe('desktop');
		expect(targetOf('quest', 'desktop')).toBe('quest');
		expect(hereTarget({ headset: true, deviceClass: 'desktop' })).toBe('quest');
		expect(hereTarget({ headset: false, deviceClass: 'desktop' })).toBe('desktop');
		expect(hereTarget({ headset: false, deviceClass: 'tablet' })).toBe('phone');
	});
	it('dedupes parts by target (This device on a PC with PC on = one part)', () => {
		expect(judgeParts(['pc', 'this', 'quest'], 'desktop')).toEqual([
			{ id: 'this', target: 'desktop' },
			{ id: 'quest', target: 'quest' }
		]);
		expect(judgeParts([], 'desktop')).toEqual([]);
	});
	it('auto-on: only over 100 %, only once, never after a hand touch', () => {
		expect(shouldAutoOn({ on: [], percent: 101, spent: false })).toBe(true);
		expect(shouldAutoOn({ on: [], percent: 100, spent: false })).toBe(false);
		expect(shouldAutoOn({ on: [], percent: 500, spent: true })).toBe(false);
		expect(shouldAutoOn({ on: ['this'], percent: 500, spent: false })).toBe(false);
	});
	it('collapse keeps the worst part and counts the rest', () => {
		expect(collapseParts([{ target: 'phone', percent: 40 }, { target: 'quest', percent: 642 }, { target: 'desktop', percent: 12 }])).toEqual({ worst: 1, more: 2 });
	});
});
