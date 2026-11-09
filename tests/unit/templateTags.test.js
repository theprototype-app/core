// showhide-v8 §5: a few tags beside the Templates search (the most relevant), the rest under More; Featured first
import { describe, it, expect } from 'vitest';
import { rankTags, featuredFirst } from '../../src/lib/sceneTemplates.js';

const E = (slug, tags, extra = {}) => ({ slug, tags, ...extra });
const entries = [
	E('a', ['vr', 'physics', 'greybox']),
	E('b', ['physics', 'racing']),
	E('c', ['physics', 'vr']),
	E('d', ['puzzle', 'Physics']),
	E('e', ['zen', 'puzzle', 'puzzle'])
];

describe('rankTags', () => {
	it('keeps the n tags most entries carry, ties by name; the rest go under More, by name', () => {
		const { shown, more } = rankTags(entries, 3);
		expect(shown).toEqual(['physics', 'puzzle', 'vr']);
		expect(more).toEqual(['greybox', 'Physics', 'racing', 'zen']);
	});
	it('counts a tag once per entry (a duplicate in one entry is not relevance)', () => {
		expect(rankTags([E('x', ['zen', 'zen', 'zen']), E('y', ['a']), E('z', ['a'])], 1).shown).toEqual(['a']);
	});
	it('an ACTIVE tag stays out even when it ranks low (the counterfactual: inactive, it is under More)', () => {
		expect(rankTags(entries, 2).more).toContain('zen');
		const { shown, more } = rankTags(entries, 2, ['zen']);
		expect(shown).toEqual(['physics', 'puzzle', 'zen']);
		expect(more).not.toContain('zen');
	});
	it('ignores an active tag the tab does not have, and an empty tab has nothing', () => {
		expect(rankTags(entries, 1, ['nope']).shown).toEqual(['physics']);
		expect(rankTags([], 5)).toEqual({ shown: [], more: [] });
	});
});

describe('featuredFirst', () => {
	it('puts featured entries first and keeps the provider order inside each half', () => {
		const list = [E('1', []), E('2', [], { featured: true }), E('3', []), E('4', [], { featured: true })];
		expect(featuredFirst(list).map((e) => e.slug)).toEqual(['2', '4', '1', '3']);
	});
	it('leaves a list with no featured entry unchanged', () => {
		const list = [E('1', []), E('2', [])];
		expect(featuredFirst(list).map((e) => e.slug)).toEqual(['1', '2']);
	});
});
