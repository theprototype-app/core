// 80a-fix4-ui E2: the Asset Browser's ambientCG search finds a TYPED ID. ambientCG matches titles ("Wood 051"), never
// ids, so "Wood051" found nothing; an id-shaped query is asked in its title form and the exact id goes first.
import { describe, it, expect } from 'vitest';
import { acgSearchQuery, exactIdFirst, normalizeAmbientCg } from '../../src/lib/cc0/cc0Core.js';

describe('E2 ambientCG search by id', () => {
	it('an id-shaped query is asked by its title form', () => {
		expect(acgSearchQuery('Wood051')).toBe('Wood 051');
		expect(acgSearchQuery(' PavingStones142 ')).toBe('Paving Stones 142');
		expect(acgSearchQuery('Metal032A')).toBe('Metal 032A');
		expect(acgSearchQuery('Ground054')).toBe('Ground 054');
	});
	it('words are asked as typed', () => {
		expect(acgSearchQuery('wood floor')).toBe('wood floor');
		expect(acgSearchQuery('Wood 051')).toBe('Wood 051');
		expect(acgSearchQuery('metal')).toBe('metal');
		expect(acgSearchQuery('')).toBe('');
	});
	it('the typed id is the first row of what the title search answers', () => {
		const page = {
			assets: [
				{ id: 'Wood050', title: 'Wood 050' },
				{ id: 'Wood051', title: 'Wood 051' },
				{ id: 'Wood052', title: 'Wood 052' }
			]
		};
		const rows = exactIdFirst(normalizeAmbientCg(page), 'wood051');
		expect(rows.map((r) => r.id)).toEqual(['Wood051', 'Wood050', 'Wood052']);
		// not an id: the order is the source's
		expect(exactIdFirst(normalizeAmbientCg(page), 'wood').map((r) => r.id)).toEqual(['Wood050', 'Wood051', 'Wood052']);
	});
});
