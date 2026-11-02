// 76 FW3: the Templates modal's search — every word must appear in title, description,
// author or tags; the provider seam's query is normalized before anything reads it.
import { describe, expect, it } from 'vitest';
import { matchesQuery, normQuery, queryWords } from '../../src/lib/communitySearch.js';

const race = { title: 'Race', description: 'Laps against the clock', author: '@maker-one', tags: ['space', 'game'] };

describe('normQuery', () => {
	it('trims, single-spaces, lower-cases and caps at 60', () => {
		expect(normQuery('  Space   RACE \n')).toBe('space race');
		expect(normQuery('x'.repeat(80))).toHaveLength(60);
		expect(normQuery(null)).toBe('');
		expect(normQuery(undefined)).toBe('');
	});
	it('never ends on a space after the cap', () => {
		expect(normQuery('a'.repeat(59) + ' b')).toBe('a'.repeat(59));
	});
});

describe('queryWords', () => {
	it('splits, drops leading # and @, dedupes, keeps at most 6', () => {
		expect(queryWords('#space @maker space')).toEqual(['space', 'maker']);
		expect(queryWords('a b c d e f g h')).toHaveLength(6);
		expect(queryWords('# @')).toEqual([]);
	});
});

describe('matchesQuery', () => {
	it('an empty query matches everything', () => {
		expect(matchesQuery(race, '')).toBe(true);
		expect(matchesQuery({}, '   ')).toBe(true);
	});
	it('finds a word beyond the title: description, author, tags', () => {
		expect(matchesQuery(race, 'clock')).toBe(true);
		expect(matchesQuery(race, '@maker-one')).toBe(true);
		expect(matchesQuery(race, '#space')).toBe(true);
		expect(matchesQuery(race, 'SPACE race')).toBe(true);
	});
	it('every word must match (AND), substrings count', () => {
		expect(matchesQuery(race, 'space boat')).toBe(false);
		expect(matchesQuery(race, 'lap')).toBe(true);
	});
	it('tolerates missing and non-string fields', () => {
		expect(matchesQuery({ title: 'Boat', tags: [3, null, 'water'] }, 'water')).toBe(true);
		expect(matchesQuery({ title: 'Boat', tags: 'water' }, 'water')).toBe(false);
		expect(matchesQuery(null, 'x')).toBe(false);
	});
});
