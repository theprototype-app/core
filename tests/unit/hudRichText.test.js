import { describe, it, expect } from 'vitest';
import {
	parseHudRichText,
	hudRichTextPlain,
	RICH_RUN_LIMIT,
	RICH_SOURCE_LIMIT
} from '../../src/lib/hudRichText.js';

// 27-I (audit L9). This module turns authored text into runs a HUD renders, and the text
// can arrive in a REPLICATED document — so "it is simply never markup" is a security
// property, not an implementation detail. The module's own header says as much:
// "`<img onerror=alert(1)>` matches no token, so it comes out as one".
//
// The structural guarantee is in the type union itself: a run is text, icon or br. There
// is no html kind, so there is nothing for a hostile string to become. These tests pin
// that, plus the two limits that stop one element re-rendering 10k nodes per runtime tick.

/** @param {string} s */
const kinds = (s) => [...new Set(parseHudRichText(s).map((r) => r.kind))];
/** Only text runs carry bold/italic/colour — narrow ONCE here rather than at every
 * assertion, since `br` has no such fields and reading them off the union is an error.
 * @param {string} s @returns {{kind: string, text: string, bold: boolean, italic: boolean, color: string}[]} */
const textRuns = (s) => /** @type {any[]} */ (parseHudRichText(s).filter((r) => r.kind === 'text'));

/** @param {string} s */
const textOf = (s) =>
	parseHudRichText(s)
		.filter((r) => r.kind === 'text')
		.map((r) => r.text)
		.join('');

describe('it is a total function', () => {
	it('produces a valid run list for every input, including nonsense', () => {
		for (const v of ['', ' ', '***', '<', '&amp;', '{', '{}', '{color:}', null, undefined, 42])
			expect(Array.isArray(parseHudRichText(/** @type {any} */ (v))), String(v)).toBe(true);
	});

	it('gives plain text exactly ONE text run', () => {
		const runs = parseHudRichText('Score: 12');
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ kind: 'text', text: 'Score: 12', bold: false, italic: false });
	});
});

describe('hostile input can only ever be text', () => {
	const hostile = [
		'<img onerror=alert(1)>',
		'<script>alert(1)</script>',
		'<b onmouseover="steal()">hi</b>',
		'<iframe src=evil></iframe>',
		'{color:url(javascript:alert(1))}x{/color}',
		'{color:var(--secret)}x',
		'{icon:../../etc/passwd}'
	];

	for (const input of hostile)
		it('keeps as text: ' + input.slice(0, 28), () => {
			const runs = parseHudRichText(input);
			// no run may be anything but the three known kinds…
			expect(runs.every((r) => r.kind === 'text' || r.kind === 'icon' || r.kind === 'br')).toBe(true);
			// …and nothing here names a real icon or a valid colour, so it is all text
			expect(runs.every((r) => r.kind === 'text')).toBe(true);
			// the angle brackets survive AS CHARACTERS rather than being consumed as markup
			if (input.startsWith('<')) expect(textOf(input)).toContain('<');
		});

	it('refuses a colour that is not a hex literal or a token name', () => {
		expect(textRuns('{color:url(evil)}danger{/color}').every((r) => r.color === '')).toBe(true);
		expect(textOf('{color:url(evil)}danger{/color}')).toContain('danger');
	});

	it('accepts the two colour forms it documents, and pops the stack', () => {
		const runs = textRuns('{color:#f00}a{/color}b');
		expect(runs.find((r) => r.text === 'a')?.color).toBe('#f00');
		// the stack popped, so the colour does not leak onward
		expect(runs.find((r) => r.text === 'b')?.color).toBe('');
		expect(textRuns('{color:accent}a')[0]?.color).toBe('accent');
	});

	it('treats an unpartnered or unknown brace as literal characters', () => {
		expect(textOf('{not-a-tag}hello')).toContain('{not-a-tag}');
		expect(textOf('a { b')).toContain('{');
	});
});

describe('the markup it DOES understand', () => {
	it('reads ** as bold before * as italic', () => {
		expect(textRuns('**x**')[0]).toMatchObject({ text: 'x', bold: true, italic: false });
		expect(textRuns('*x*')[0]).toMatchObject({ text: 'x', italic: true, bold: false });
	});

	it('turns a newline into a br run', () => {
		expect(kinds('a\nb')).toContain('br');
	});
});

describe('the limits that keep one element cheap', () => {
	it('caps the run list', () => {
		const runs = parseHudRichText('*a*'.repeat(RICH_RUN_LIMIT * 3));
		expect(runs.length).toBeLessThanOrEqual(RICH_RUN_LIMIT);
	});

	it('caps the source it reads at all', () => {
		const total = textRuns('x'.repeat(RICH_SOURCE_LIMIT * 3)).reduce((n, r) => n + r.text.length, 0);
		expect(total).toBeLessThanOrEqual(RICH_SOURCE_LIMIT);
	});
});

describe('hudRichTextPlain', () => {
	it('returns a string and keeps the words while dropping the markup', () => {
		const plain = hudRichTextPlain('**Score**: {color:#f00}12{/color}');
		expect(typeof plain).toBe('string');
		expect(plain).toContain('Score');
		expect(plain).toContain('12');
		expect(plain).not.toContain('**');
		expect(plain).not.toContain('{color');
	});
});
