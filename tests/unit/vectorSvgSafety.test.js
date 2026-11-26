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

// 64-int (QUESTIONS-64-int Q1): one path past the per-shape cap is simplified to fit, never cut off
import { fitSvgItems } from '../../src/lib/vector/vectorSvgSafety.js';
import { MAX_NODES, cleanVector } from '../../src/lib/vector/vectorRecord.js';

describe('fitSvgItems: a path over the per-shape node cap', () => {
	const wavy = (n, closed = true) => {
		const nodes = [];
		for (let i = 0; i < n; i++) {
			const a = (i / n) * Math.PI * 2;
			const r = 40 + 6 * Math.sin(a * 60);
			nodes.push({ x: 50 + r * Math.cos(a), y: 50 + r * Math.sin(a), ix: 0, iy: 0, ox: 0, oy: 0, smooth: false });
		}
		return { closed, nodes };
	};
	const area = (nodes) => {
		let s = 0;
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i];
			const b = nodes[(i + 1) % nodes.length];
			s += a.x * b.y - b.x * a.y;
		}
		return Math.abs(s) / 2;
	};
	test('12 000 points -> at most the cap, the outline kept (area within 1 %), and cleanVector keeps every node', () => {
		const item = { name: 'Blob', params: { kind: 'path', paths: [wavy(12000)] }, matrix: [1, 0, 0, 1, 0, 0] };
		const { items, simplified } = fitSvgItems([item], MAX_NODES);
		const kept = items[0].params.paths[0].nodes;
		expect(kept.length).toBeLessThanOrEqual(MAX_NODES);
		expect(kept.length).toBeGreaterThan(MAX_NODES * 0.9);
		expect(simplified).toEqual([{ name: 'Blob', before: 12000, after: kept.length }]);
		expect(Math.abs(area(kept) - area(item.params.paths[0].nodes)) / area(item.params.paths[0].nodes)).toBeLessThan(0.01);
		// the counterfactual: unfitted, the record cap keeps the first 4 000 nodes = a third of the outline
		const cut = cleanVector(item.params).paths[0].nodes;
		expect(cut.length).toBe(MAX_NODES);
		expect(area(cut) / area(item.params.paths[0].nodes)).toBeLessThan(0.5);
		expect(cleanVector(items[0].params).paths[0].nodes.length).toBe(kept.length);
		// deterministic, and the input is not mutated
		expect(fitSvgItems([item], MAX_NODES).items[0].params.paths[0].nodes).toEqual(kept);
		expect(item.params.paths[0].nodes.length).toBe(12000);
	});
	test('an open path keeps both ends; several subpaths share the budget; under the cap nothing changes', () => {
		const open = wavy(9000, false);
		const { items } = fitSvgItems([{ params: { kind: 'path', paths: [open, wavy(3000)] } }], MAX_NODES);
		const [a, b] = items[0].params.paths;
		expect(a.nodes[0]).toBe(open.nodes[0]);
		expect(a.nodes[a.nodes.length - 1]).toBe(open.nodes[8999]);
		expect(a.nodes.length + b.nodes.length).toBeLessThanOrEqual(MAX_NODES);
		expect(b.nodes.length).toBeGreaterThan(500);
		const small = { params: { kind: 'path', paths: [wavy(100)] } };
		const r = fitSvgItems([small], MAX_NODES);
		expect(r.items[0]).toBe(small);
		expect(r.simplified).toEqual([]);
	});
});

describe('svgItemsVerdict counts the points the FILE had (64-int Q1)', () => {
	test('a fitted item counts its `before`, so fitting never walks past the 40 000-point file cap', () => {
		const item = { params: { paths: [{ closed: true, nodes: new Array(4000).fill({ x: 0, y: 0 }) }] } };
		expect(svgItemsVerdict([item])).toBe(null);
		expect(svgItemsVerdict([{ ...item, fitted: { name: 'x', before: 12000, after: 4000 } }])).toBe(null);
		expect(svgItemsVerdict([{ ...item, fitted: { name: 'x', before: MAX_SVG_NODES + 1, after: 4000 } }])).toMatch(/points; the limit is/);
	});
});
