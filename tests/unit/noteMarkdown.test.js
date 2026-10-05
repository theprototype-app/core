// 36 U11: note markdown -> a token tree (never HTML).
import { describe, it, expect } from 'vitest';
import { parseNote, parseInline, safeHref, notePlainSummary } from '../../src/lib/noteMarkdown.js';

describe('noteMarkdown', () => {
	it('blocks: headings, lists, quotes, paragraphs joined across lines', () => {
		const blocks = parseNote('# Title\nfirst line\nsecond line\n\n- one\n2. two\n> quoted\n---');
		expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'li', 'oli', 'quote', 'hr']);
		expect(blocks[0].level).toBe(1);
		expect(blocks[1].spans).toEqual([{ t: 'text', v: 'first line second line' }]);
		expect(blocks[3].n).toBe(2);
	});

	it('inline spans', () => {
		expect(parseInline('a **b** *c* `d` ~~e~~')).toEqual([
			{ t: 'text', v: 'a ' },
			{ t: 'b', v: 'b' },
			{ t: 'text', v: ' ' },
			{ t: 'i', v: 'c' },
			{ t: 'text', v: ' ' },
			{ t: 'code', v: 'd' },
			{ t: 'text', v: ' ' },
			{ t: 's', v: 'e' }
		]);
	});

	it('links keep only http(s)/mailto targets; anything else becomes text', () => {
		expect(parseInline('[ok](https://x.y)')).toEqual([{ t: 'a', v: 'ok', href: 'https://x.y' }]);
		const bad = parseInline('[bad](javascript:alert(1))');
		expect(bad.some((x) => x.t === 'a')).toBe(false);
		expect(bad[0].v.startsWith('bad')).toBe(true);
		expect(safeHref('data:text/html,hi')).toBe(null);
	});

	it('markup in the text stays text (the card renders tokens, never HTML)', () => {
		const spans = parseInline('<img src=x onerror=alert(1)>');
		expect(spans).toEqual([{ t: 'text', v: '<img src=x onerror=alert(1)>' }]);
	});

	it('an unclosed marker is literal and nothing loops', () => {
		expect(parseInline('a * b _ c ` d')).toEqual([{ t: 'text', v: 'a * b _ c ` d' }]);
		expect(notePlainSummary('**Bold** start\nmore')).toBe('Bold start more');
		expect(parseNote('')).toEqual([]);
	});
});
