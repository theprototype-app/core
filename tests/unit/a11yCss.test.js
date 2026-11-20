// 53 (A1 + A5): the build-time accessibility CSS transform (scripts/a11y-css.cjs) and the uiScale leaf.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { normalizeUiScale, UI_SCALES, cssPx } from '../../src/lib/uiScale.js';

const { scaleCssLengths, scaleValue } = createRequire(import.meta.url)('../../scripts/a11y-css.cjs');
const S = (/** @type {number | string} */ n) => `calc(${n}px * var(--ui-scale, 1))`;

describe('ui-scale-css: px lengths follow --ui-scale', () => {
	it('rewrites a plain length, a shorthand and a calc operand', () => {
		expect(scaleValue('12px')).toBe(S(12));
		expect(scaleValue('4px 8px')).toBe(`${S(4)} ${S(8)}`);
		expect(scaleValue('calc(100% - 12px)')).toBe(`calc(100% - ${S(12)})`);
		expect(scaleValue('-6px')).toBe(S(-6));
		expect(scaleValue('0.5rem 2.5px')).toBe(`0.5rem ${S(2.5)}`);
	});
	it('keeps hairlines, url(), strings and a value that already scales itself', () => {
		expect(scaleValue('1px solid var(--border)')).toBe('1px solid var(--border)');
		expect(scaleValue('0px')).toBe('0px');
		expect(scaleValue("url(\"data:image/svg+xml;utf8,<svg width='12px'/>\") 4px")).toBe(`url("data:image/svg+xml;utf8,<svg width='12px'/>") ${S(4)}`);
		expect(scaleValue("'12px'")).toBe("'12px'");
		expect(scaleValue('calc(16px * var(--ui-scale, 1))')).toBe('calc(16px * var(--ui-scale, 1))');
	});
	it('reads an exponent as part of the number and leaves sentinel lengths alone (80a-fix4-ui O4)', () => {
		// the minified rounded-full: was rewritten to `3.40282ecalc(38px * …)`, an invalid radius (square avatars)
		expect(scaleValue('3.40282e38px')).toBe('3.40282e38px');
		expect(scaleValue('9999999px')).toBe('9999999px');
		expect(scaleValue('1.2e1px')).toBe(S('1.2e1'));
		expect(scaleValue('2E1px 4px')).toBe(`${S('2E1')} ${S(4)}`);
		// a digit inside a name is not a length
		expect(scaleValue('var(--w12px)')).toBe('var(--w12px)');
	});
	it('never touches an at-rule prelude (breakpoints describe the screen)', () => {
		const out = scaleCssLengths('@media (max-width: 639.98px) { .a { padding: 8px; --t: 44px } }');
		expect(out).toContain('(max-width: 639.98px)');
		expect(out).toContain(`padding: ${S(8)}`);
		expect(out).toContain(`--t: ${S(44)}`);
	});
	it('skips a stylesheet with the pragma, and returns the input when nothing changes', () => {
		const off = '/* ui-scale: off */ .hud { left: 12px }';
		expect(scaleCssLengths(off)).toBe(off);
		const none = '.a { width: 50%; border: 1px solid }';
		expect(scaleCssLengths(none)).toBe(none);
	});
});

describe('uiScale', () => {
	it('steps 90..150 by 10, default 100, garbage reads as the default', () => {
		expect(UI_SCALES).toEqual([90, 100, 110, 120, 130, 140, 150]);
		expect(normalizeUiScale('124')).toBe(120);
		expect(normalizeUiScale(500)).toBe(150);
		expect(normalizeUiScale(10)).toBe(90);
		expect(normalizeUiScale('nope')).toBe(100);
	});
	it('cssPx reads a rewritten token back as pixels', () => {
		expect(cssPx('38px')).toBe(38);
		expect(cssPx(' calc(38px * 1.5)')).toBe(57);
		expect(cssPx('calc(44px*1)')).toBe(44);
		expect(cssPx('calc(38px * var(--ui-scale, 1))')).toBe(38);
		expect(Number.isNaN(cssPx(''))).toBe(true);
	});
});

describe('a11y-css: reduced-motion media follow data-motion', () => {
	const { transformA11yCss, motionSelector } = createRequire(import.meta.url)('../../scripts/a11y-css.cjs');
	it('re-keys a reduce block onto the attribute and drops the media', () => {
		const out = transformA11yCss('@media (prefers-reduced-motion: reduce) { .a, .b.svelte-x { transition: none } }');
		expect(out).not.toContain('@media');
		expect(out).toContain(":root[data-motion='reduce'] .a");
		expect(out).toContain(":root[data-motion='reduce'] .b.svelte-x");
	});
	it('keeps the other conditions of the query, and a root selector takes the attribute itself', () => {
		const out = transformA11yCss(":root[data-theme='bit8'] .x {} @media (prefers-reduced-motion: reduce) and (max-width: 640px) { :root[data-theme='bit8'] .x { animation: none } html.dark .y { opacity: 1 } }");
		expect(out).toContain('@media (max-width: 640px)');
		expect(out).toContain(":root[data-motion='reduce'][data-theme='bit8'] .x");
		expect(out).toContain("html[data-motion='reduce'].dark .y");
	});
	it('no-preference becomes "not reduced"; keyframes inside are untouched', () => {
		const out = transformA11yCss('@media (prefers-reduced-motion: no-preference) { .p { animation: spin 1s } @keyframes spin { from { opacity: 0 } } }');
		expect(out).toContain(":root:not([data-motion='reduce']) .p");
		expect(out).toContain('from {');
		expect(motionSelector('rootless', "[x]")).toBe(':root[x] rootless');
	});
});
