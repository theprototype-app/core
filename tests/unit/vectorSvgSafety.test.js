// @ts-nocheck — a fixture test: results are asserted non-null by the checks themselves
// 64-vector row 5: an imported SVG is untrusted. One row per rule of vectorSvgSafety.js — refused
// with a plain sentence, or read with everything that could run or fetch taken out.
import { describe, test, expect } from 'vitest';
import { checkSvgText, svgItemsVerdict, MAX_SVG_BYTES, MAX_SVG_ELEMENTS, MAX_SVG_SHAPES, MAX_SVG_NODES } from '../../src/lib/vector/vectorSvgSafety.js';

const svg = (body, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100"${attrs}>${body}</svg>`;
const square = '<path d="M10 10 H90 V90 H10 Z" fill="#ff0000"/>';
const ok = (text) => {
	const r = checkSvgText(text);
	expect(r.ok).toBe(true);
	return /** @type {any} */ (r);
};
const refused = (text) => {
	const r = checkSvgText(text);
	expect(r.ok).toBe(false);
	expect(typeof (/** @type {any} */ (r).reason)).toBe('string');
	return /** @type {any} */ (r).reason;
};

describe('SVG import safety', () => {
	test('a plain drawing passes untouched', () => {
		const text = svg(square);
		const r = ok(text);
		expect(r.text).toBe(text);
		expect(r.stripped).toEqual([]);
	});

	test('no script: <script> (any case, a namespace prefix, CDATA, self-closing) is taken out', () => {
		for (const s of ['<script>alert(1)</script>', '<SCRIPT type="text/javascript"><![CDATA[alert(1)]]></SCRIPT>', '<svg:script>x()</svg:script>', '<script href="https://evil.example/x.js"/>']) {
			const r = ok(svg(s + square));
			expect(r.text).not.toMatch(/script/i);
			expect(r.text).toContain('M10 10');
		}
	});

	test('no event handlers: on*= attributes are taken out, quoted or not', () => {
		const r = ok(svg(`<path d="M0 0 L1 1" onclick="alert(1)" onload='x()' onmouseover=y() />`, ' onload="alert(1)"'));
		expect(r.text).not.toMatch(/\son[a-z]+\s*=/i);
		expect(r.stripped).toContain('handler');
	});

	test('no foreignObject: embedded HTML is taken out with everything inside it', () => {
		const r = ok(svg(`<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"></iframe></div></foreignObject>` + square));
		expect(r.text).not.toMatch(/foreignObject|iframe|evil/i);
	});

	test('no external references fetched: image, off-document href / xlink:href, url(http..), @import, xml-stylesheet', () => {
		const r = ok(
			'<?xml-stylesheet href="https://evil.example/a.css"?>' +
				svg(
					`<style>@import url("https://evil.example/b.css"); path{fill:red}</style>` +
						`<image href="https://evil.example/c.png" width="10" height="10"/>` +
						`<use xlink:href="https://evil.example/d.svg#x"/>` +
						`<use href="#keep"/>` +
						`<path id="keep" d="M0 0 L5 5" fill="url(https://evil.example/e.svg#g)" filter="url( 'http://evil.example/f' )"/>` +
						`<rect width="5" height="5" fill="url(#grad)"/>`
				)
		);
		expect(r.text).not.toMatch(/evil\.example/);
		// same-document references stay (SVGLoader's <use> and gradient fills)
		expect(r.text).toContain('href="#keep"');
		expect(r.text).toContain('url(#grad)');
	});

	test('no XML entities (billion laughs): refused, not expanded', () => {
		const reason = refused('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>' + svg('<text>&b;</text>'));
		expect(reason).toMatch(/entit/i);
	});

	test('size cap: a file over the limit is refused with its size in the sentence', () => {
		const big = svg(square + ' '.repeat(MAX_SVG_BYTES));
		expect(refused(big)).toMatch(/MB; the limit is 2 MB/);
	});

	test('element cap: more drawable elements than the limit are refused', () => {
		const many = svg('<path d="M0 0 L1 1"/>'.repeat(MAX_SVG_ELEMENTS + 1));
		expect(refused(many)).toMatch(/elements; the limit is/);
		ok(svg('<path d="M0 0 L1 1"/>'.repeat(100)));
	});

	test('shape and point caps on what was read', () => {
		const one = { params: { paths: [{ nodes: [{}, {}, {}] }] } };
		expect(svgItemsVerdict([one])).toBeNull();
		expect(svgItemsVerdict(Array(MAX_SVG_SHAPES + 1).fill(one))).toMatch(/shapes; the limit is/);
		const heavy = { params: { paths: [{ nodes: Array(MAX_SVG_NODES + 1).fill({}) }] } };
		expect(svgItemsVerdict([heavy])).toMatch(/points; the limit is/);
	});

	test('not an SVG / not text: refused', () => {
		expect(refused('<html><body>hi</body></html>')).toMatch(/No <svg>/);
		expect(refused(/** @type {any} */ (null))).toMatch(/not text/);
	});

	test('a banned element that survives the strip (a malformed nest) refuses the whole file', () => {
		// the non-greedy strip takes the inner pair; the outer opener is left behind -> refused
		expect(refused(svg('<script><script>a</script>b</script>' + square.replace('/>', '/><script'))));
	});
});
