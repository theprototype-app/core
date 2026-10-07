import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// 38 R2: the `check:tokens` scanner. What it must catch is every way a component paints a
// colour of its own; what it must NOT catch is everything that merely looks like one — a
// Svelte block (`{#each}`), an HTML entity, an id selector, a token utility, a note in a
// comment — or the hard fail (R11) blocks honest work and someone turns it off.
const require = createRequire(import.meta.url);
const { scanText, DEFINITIONS } = require('../../scripts/check-tokens.cjs');

/** @param {string} text */
const kinds = (text) => scanText(text).map((/** @type {any} */ h) => h.kind + ':' + h.match);

describe('check:tokens scanText', () => {
	it('flags hex literals, including var() fallbacks and alpha forms', () => {
		expect(kinds('color: #fff;')).toEqual(['hex:#fff']);
		expect(kinds('background: var(--surface-2, #374151);')).toEqual(['hex:#374151']);
		expect(kinds("const c = '#1b212dcc';")).toEqual(['hex:#1b212dcc']);
	});

	it('flags rgb/rgba/hsl literals', () => {
		expect(kinds('border: 1px solid rgb(75 85 99 / 0.6);')).toEqual(['rgb/hsl:rgb(7']);
		expect(kinds('color: rgba(255, 255, 255, 0.2)')).toEqual(['rgb/hsl:rgba(2']);
		expect(kinds('fill: hsl(210 40% 50%)')).toEqual(['rgb/hsl:hsl(2']);
	});

	it('flags Tailwind palette utilities with variants and opacity', () => {
		expect(kinds('<div class="bg-gray-800 hover:text-red-400 border-blue-500/50">')).toEqual([
			'palette:bg-gray-800',
			'palette:text-red-400',
			'palette:border-blue-500/50'
		]);
		expect(kinds('<span class="text-white bg-black">')).toEqual(['palette:text-white', 'palette:bg-black']);
		expect(kinds('<b class="bg-primary-600">')).toEqual(['palette:bg-primary-600']);
	});

	it('leaves token utilities, token vars and look-alikes alone', () => {
		expect(kinds('<div class="bg-surface-2 text-text-muted border-border-strong rounded-card">')).toEqual([]);
		expect(kinds('color: var(--accent); background: var(--surface-inset);')).toEqual([]);
		expect(kinds('{#each items as item}{#if a}{/if}{/each}')).toEqual([]);
		expect(kinds('<a href="#add-row">&#123;</a> #play-button { clip-path: none }')).toEqual([]);
		expect(kinds('<span class="text-xs text-left border-2 bg-transparent">')).toEqual([]);
	});

	it('ignores colours named in comments, but keeps line numbers', () => {
		const src = ['/* was #fff */', '<!-- bg-gray-800 -->', '// rgb(1 2 3)', 'a { color: #000 }', "x = 'https://e.x/#abc'"].join('\n');
		const hits = scanText(src);
		expect(hits.map((/** @type {any} */ h) => [h.line, h.match])).toEqual([[4, '#000']]);
	});

	it('a tokens-ok pragma WITH a reason exempts its line; a bare one is itself a violation', () => {
		expect(kinds("const tint = '#ffffff'; // tokens-ok: the picker's starting value")).toEqual([]);
		expect(kinds('<div style="color: #fff"> <!-- tokens-ok: canvas pixels -->')).toEqual([]);
		expect(kinds("const tint = '#ffffff'; // tokens-ok")).toEqual(['pragma:tokens-ok without a reason', 'hex:#ffffff']);
		expect(kinds("const tint = '#ffffff'; // tokens-ok: x")).toEqual(['hex:#ffffff']);
	});

	it('a tokens-ok-begin … tokens-ok-end block exempts every line inside it, and only those', () => {
		const src = ['/* tokens-ok-begin: node category hues (graph data) */', "a: '#ff0000',", "b: 'rgb(1 2 3)',", '/* tokens-ok-end */', "c: '#00ff00'"].join('\n');
		expect(scanText(src).map((/** @type {any} */ h) => [h.line, h.match])).toEqual([[5, '#00ff00']]);
	});

	it('the files that DEFINE the tokens are the only ones outside the scan', () => {
		expect([...DEFINITIONS].sort()).toEqual(['src/styles/theme.css', 'src/styles/tokens.css']);
	});
});
