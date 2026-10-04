import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEBUG_HOOKS, registerDebugHook } from '../../src/lib/debugHooks.js';

// 34 R4 (A2): the debug hook is ONE table, one row per hook. It replaced App.svelte's three
// positional tails, whose failure mode was silent (a missing binding shifted every later module
// onto its neighbour's name). What can still go wrong with a table is cheap to check without a
// browser: a duplicated name (the later row wins and one module vanishes from __stores), a row
// whose loader points at a file that does not exist (Promise.all rejects and NO hook installs),
// and the old tails creeping back into App.svelte in a merge. The module imports nothing, so it is
// imported here directly; the loaders stay unevaluated.

const LIB = resolve(__dirname, '../../src/lib');
const SRC = readFileSync(resolve(LIB, 'debugHooks.js'), 'utf8');

describe('debug hook registry', () => {
	it('has every row named once (spread rows are "*")', () => {
		const names = DEBUG_HOOKS.map(([name]) => name).filter((name) => name !== '*');
		const dup = names.filter((name, i) => names.indexOf(name) !== i);
		expect(dup).toEqual([]);
		expect(names.length).toBeGreaterThan(200);
		expect(DEBUG_HOOKS.filter(([name]) => name === '*').length).toBe(3);
	});

	it('keeps each hook on ONE line, name beside its loader', () => {
		const rows = SRC.split('\n').filter((l) => /^\t\['/.test(l));
		expect(rows.length).toBe(DEBUG_HOOKS.length);
		for (const row of rows) expect(row).toMatch(/^\t\['[\w*]+', \(\) => import\('[^']+'\)\],?$/);
	});

	it('points every loader at a file that exists', () => {
		const missing = [];
		for (const m of SRC.matchAll(/^\t\['[\w*]+', \(\) => import\('(\.{1,2}\/[^']+)'\)/gm)) {
			const base = resolve(LIB, m[1]);
			if (!['', '.js', '.ts', '.svelte.js'].some((ext) => existsSync(base + ext))) missing.push(m[1]);
		}
		expect(missing).toEqual([]);
	});

	it('leaves no positional tail in App.svelte', () => {
		const app = readFileSync(resolve(__dirname, '../../src/App.svelte'), 'utf8');
		expect(app).not.toMatch(/window\.__stores\s*=\s*\{/);
		expect(app).not.toMatch(/\]\)\.then\(\(\[sceneStore/);
		expect(app).toMatch(/installDebugHooks\(\)/);
	});

	it('takes a runtime registration before the install', () => {
		expect(() => registerDebugHook('unitProbe', { ok: true })).not.toThrow();
	});
});
