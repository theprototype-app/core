// 36 I4 — the settings search matches label + group + section + keywords, every word of the query.
import { describe, it, expect } from 'vitest';
import { rowMatches, matchSpans, registerSettingsKeywords, keywordsFor } from '../../src/lib/settingsSearch.js';

describe('rowMatches', () => {
	it('matches the row text, its group and its section', () => {
		expect(rowMatches('grid', { text: 'Cell size', group: 'Grid', section: 'Scene' })).toBe(true);
		expect(rowMatches('cell', { text: 'Cell size', group: 'Grid', section: 'Scene' })).toBe(true);
		expect(rowMatches('scene', { text: 'Cell size', group: 'Grid', section: 'Scene' })).toBe(true);
		expect(rowMatches('teleport', { text: 'Cell size', group: 'Grid', section: 'Scene' })).toBe(false);
	});
	it("matches a ROW's keyword the label never says (by the row's name)", () => {
		expect(rowMatches('dark', { text: 'Theme UI theme for this device', name: 'Theme', section: 'Interface' })).toBe(true);
		expect(rowMatches('dark', { text: 'Custom theme', name: 'Custom theme', section: 'Interface' })).toBe(false);
	});
	it("a SECTION's words are a fallback only: off by default, on when asked", () => {
		expect(rowMatches('quest', { text: 'VR flying', name: 'VR flying', section: 'VR' })).toBe(false);
		expect(rowMatches('quest', { text: 'VR flying', name: 'VR flying', section: 'VR' }, { fallback: true })).toBe(true);
		// "quest" is a keyword of the Snap turn ROW, so that one matches directly
		expect(rowMatches('quest', { text: 'Snap turn', name: 'Snap turn', section: 'VR' })).toBe(true);
	});
	it('every word of the query must be found (in any of the places)', () => {
		expect(rowMatches('snap comfort', { text: 'Snap turn', name: 'Snap turn', section: 'VR' })).toBe(true);
		expect(rowMatches('grid colour', { text: 'Line colour', group: 'Grid', section: 'Scene' })).toBe(true);
		expect(rowMatches('grid teleport', { text: 'Line colour', group: 'Grid', section: 'Scene' })).toBe(false);
	});
	it("an ancestor section's data-keywords count (the contract for sections other lanes add)", () => {
		expect(rowMatches('hologram', { text: 'Loading placeholders', extra: ['loading placeholder hologram'] })).toBe(true);
	});
	it('an empty query matches everything', () => {
		expect(rowMatches('  ', { text: 'x' })).toBe(true);
	});
});

describe('registerSettingsKeywords', () => {
	it('adds words to a group label and takes them away again', () => {
		const off = registerSettingsKeywords('Loading', ['Placeholder', 'stuck']);
		expect(keywordsFor('loading')).toEqual(['placeholder', 'stuck']);
		expect(rowMatches('stuck', { text: 'Stuck after', group: 'LOADING' })).toBe(true);
		expect(rowMatches('placeholder', { text: 'Style', group: 'Loading' })).toBe(true);
		off();
		expect(keywordsFor('Loading')).toEqual([]);
		expect(rowMatches('placeholder', { text: 'Style', group: 'Loading' })).toBe(false);
	});
	it("keeps a built-in row's words when another registration under it is removed", () => {
		const before = keywordsFor('Theme').length;
		const off = registerSettingsKeywords('Theme', ['skin']);
		expect(keywordsFor('Theme').length).toBe(before + 1);
		off();
		expect(keywordsFor('Theme').length).toBe(before);
		expect(before).toBeGreaterThan(0);
	});
});

describe('matchSpans', () => {
	it('finds every word, case-insensitively, merged where they touch', () => {
		expect(matchSpans('Grid line colour', 'grid colour')).toEqual([[0, 4], [10, 16]]);
		expect(matchSpans('Snap snap', 'snap')).toEqual([[0, 4], [5, 9]]);
		expect(matchSpans('abc', 'ab bc')).toEqual([[0, 3]]);
		expect(matchSpans('abc', '')).toEqual([]);
	});
});
