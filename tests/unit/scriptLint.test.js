import { describe, it, expect } from 'vitest';
import { lintScript, formatLint } from '../../src/lib/scriptLint.js';
import { codeMask } from '../../src/lib/loopGuard.js';

// 34 D3: the determinism lint a v2 Script node (and a behaviour) must pass. Each rule is
// proven twice: it fires on the real thing, and it stays quiet on the same word inside a
// string, a comment, a member name or an object key — the false positive that would make
// the lint something people learn to ignore.

const rules = (/** @type {string} */ code) => lintScript(code).map((i) => i.rule);

describe('codeMask', () => {
	it('blanks strings, templates, comments and regexes and keeps every offset', () => {
		const src = 'a = "QQ"; // WW\nb = `EE${1}`; /RR/.test(s)';
		const m = codeMask(src);
		expect(m).not.toBeNull();
		expect(m?.length).toBe(src.length);
		expect(m?.split('\n').length).toBe(2);
		expect(m).not.toMatch(/QQ|WW|EE|RR/);
		expect(m).toMatch(/a = /);
	});
	it('refuses an unterminated string', () => {
		expect(codeMask('a = "oops')).toBeNull();
	});
});

describe('dom / storage / timers', () => {
	it('flags the page', () => {
		expect(rules('document.title = 1')).toEqual(['dom']);
		expect(rules('window.x = 1')).toEqual(['dom']);
		expect(rules('fetch("/x")')).toEqual(['dom']);
		expect(rules('eval("1")')).toEqual(['dom']);
		expect(rules('new Function("return 1")')).toEqual(['dom']);
		expect(rules('import("x")')).toEqual(['dom']);
	});
	it('flags storage and timers', () => {
		expect(rules('localStorage.setItem("a", 1)')).toEqual(['storage']);
		expect(rules('const db = indexedDB')).toEqual(['storage']);
		expect(rules('setTimeout(() => {}, 10)')).toEqual(['timers']);
	});
	it('stays quiet on the same words where they are not references', () => {
		expect(rules('// document.title = 1')).toEqual([]);
		expect(rules('const s = "localStorage window fetch"')).toEqual([]);
		expect(rules('const o = { window: 3, document: 4 }')).toEqual([]);
		expect(rules('object.document = 1; inputs.window')).toEqual([]);
		expect(rules('const documentCount = 2; const myWindow = 1')).toEqual([]);
		expect(rules('const v = a ? window : 0')).toEqual(['dom']);
	});
});

describe('nondeterminism', () => {
	it('flags every clock and roll a peer would see differently', () => {
		expect(rules('const r = Math.random()')).toEqual(['nondeterministic']);
		expect(rules('const t = Date.now()')).toEqual(['nondeterministic']);
		expect(rules('const d = new Date()')).toEqual(['nondeterministic']);
		expect(rules('const d = Date()')).toEqual(['nondeterministic']);
		expect(rules('performance.now()')).toEqual(['nondeterministic']);
		expect(rules('crypto.randomUUID()')).toEqual(['nondeterministic']);
	});
	it('allows the deterministic forms', () => {
		expect(rules('const s = Math.sin(time * 2) + Math.floor(inputs.a)')).toEqual([]);
		expect(rules('// Math.random() would desync')).toEqual([]);
		expect(rules('const randomish = hash(time)')).toEqual([]);
	});
});

describe('unbounded loops', () => {
	it('flags a loop with no way out', () => {
		expect(rules('while (true) { x++; }')).toEqual(['unbounded-loop']);
		expect(rules('while(1) x++;')).toEqual(['unbounded-loop']);
		expect(rules('for (;;) { x++; }')).toEqual(['unbounded-loop']);
		expect(rules('for (let i = 0; ; i++) { x++; }')).toEqual(['unbounded-loop']);
		expect(rules('do { x++; } while (true)')).toEqual(['unbounded-loop']);
	});
	it('accepts the same loops with an exit, and every bounded loop', () => {
		expect(rules('while (true) { if (x > 3) break; x++; }')).toEqual([]);
		expect(rules('for (;;) { return 1; }')).toEqual([]);
		expect(rules('do { if (x) throw new Error("no"); } while (true)')).toEqual([]);
		expect(rules('for (let i = 0; i < 10; i++) { x += i; }')).toEqual([]);
		expect(rules('while (x < 10) x++;')).toEqual([]);
		expect(rules('for (const p of inputs.list) {}')).toEqual([]);
		expect(rules('if (a) {} while (x < 3) { x++; }')).toEqual([]);
	});
});

describe('reporting', () => {
	it('reports line and column in source order', () => {
		const issues = lintScript('let a = 1;\nconst r = Math.random();\nwindow.x = r;');
		expect(issues.map((i) => [i.rule, i.line])).toEqual([
			['nondeterministic', 2],
			['dom', 3]
		]);
		expect(issues[0].col).toBe(11);
		expect(formatLint(issues)).toMatch(/^line 2: Math\.random/);
	});
	it('returns nothing for unparseable source (the compile reports that)', () => {
		expect(lintScript('const s = "unterminated')).toEqual([]);
	});
	it('passes the proposal snippets (§4.3 (d)) clean', () => {
		expect(lintScript('return { allow: dist(inputs.hand, inputs.piece.position) <= inputs.reach };')).toEqual([]);
		expect(lintScript('return { count: Math.min(10, inputs.sizeStart + inputs.sizeStep * (inputs.wave - 1)) };')).toEqual([]);
	});
});
