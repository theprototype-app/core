// 101 F5: the e2e codemod keeps pre-install semantics (threw before -> throws now; undefined
// before -> undefined now) and leaves prose alone.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { transform } = require('../../scripts/e2e-facade-codemod.cjs');

const cases = [
	['window.__stores.history.undo()', 'window.__tp.test.v1.history.undo()'],
	['window.__stores[name]', 'window.__tp.test.v1[name]'],
	['window.__stores?.autosave', 'window.__tp?.test.v1?.autosave'],
	['window.__stores?.[k]', 'window.__tp?.test.v1?.[k]'],
	['window.__stores && !!window.__stores.moduleSDK', 'window.__tp?.test.v1 && !!window.__tp.test.v1.moduleSDK'],
	['const s = window.__stores;', 'const s = window.__tp?.test.v1;'],
	['f(window.__stores)', 'f(window.__tp?.test.v1)'],
	['({ ...window.__stores })', '({ ...window.__tp?.test.v1 })'],
	['(window).__stores.themes', '(window).__tp.test.v1.themes'],
	['w?.__stores.x', 'w?.__tp.test.v1.x'],
	['// the __stores hook', '// the __stores hook']
];

describe('e2e facade codemod (101 F5)', () => {
	test.each(cases)('%s', (from, to) => expect(transform(from).out).toBe(to));
	test('semantics: undefined before the install stays undefined, a throw stays a throw', () => {
		const w = /** @type {any} */ ({});
		const run = (/** @type {string} */ code) => new Function('window', `return (${code});`)(w);
		for (const [from, to] of cases.slice(0, 10)) {
			if (/\bf\(|\bname\b|\bk\b|^\(window\)|^w\?/.test(from)) continue;
			let a, b, ea = null, eb = null;
			try { a = run(from.replace(/;$/, '').replace(/^const s = /, '')); } catch (e) { ea = e; }
			try { b = run(to.replace(/;$/, '').replace(/^const s = /, '')); } catch (e) { eb = e; }
			expect(!!eb, `${from} -> ${to}`).toBe(!!ea);
			if (!ea) expect(b).toEqual(a);
		}
	});
	test('counts', () => expect(transform('a.__stores.b; c?.__stores; __stores').n).toBe(2));
});
