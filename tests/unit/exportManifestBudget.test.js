// @ts-nocheck -- fixture test over a node CLI module
// fix-export-files: the build's file budget (scripts/export-manifest.cjs) is what stops the runtime
// file count creeping back over itch.io's limit unnoticed — 1.74.0 listed 1,056 files and every
// export failed its own check.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { ITCH_LIMITS } from '../../src/lib/export/exportValidate.js';

const require = createRequire(import.meta.url);
const { MAX_RUNTIME_FILES, MAX_BUILD_FILES, overBudget, exportCarried, excluded } = require('../../scripts/export-manifest.cjs');

const files = (n) => Array.from({ length: n }, (_, i) => ({ path: `_app/immutable/chunks/c${i}.js`, bytes: 1 }));

describe('export-manifest budget', () => {
	it('leaves at least 150 files of room under the itch.io limit for the game itself', () => {
		expect(MAX_RUNTIME_FILES).toBeLessThanOrEqual(ITCH_LIMITS.maxFiles - 150);
	});
	it('passes at the budget and fails one file over, naming the biggest folder', () => {
		expect(overBudget(files(MAX_RUNTIME_FILES))).toBeNull();
		const msg = overBudget(files(MAX_RUNTIME_FILES + 1));
		expect(msg).toMatch(/over the export budget/);
		expect(msg).toContain('_app/immutable/chunks ' + (MAX_RUNTIME_FILES + 1));
	});
	it('counts what a slim export carries: no entry pages, no editor-only files (64-int-rel, card export-file-budget-850)', () => {
		const list = [...files(3), { path: 'index.html', bytes: 1 }, { path: 'play.html', bytes: 1 }, { path: 'kit.html', bytes: 1 }, { path: '_app/e.js', bytes: 1, editorOnly: true }];
		expect(exportCarried(list).map((f) => f.path)).toEqual(files(3).map((f) => f.path));
		// an older (non-slim) build: no play.html, so the editor-only files travel too
		const old = [...files(2), { path: 'index.html', bytes: 1 }, { path: '_app/e.js', bytes: 1, editorOnly: true }];
		expect(exportCarried(old).length).toBe(3);
	});
	it('keeps the full build under its own ceiling, above the 850 and never instead of it', () => {
		expect(MAX_RUNTIME_FILES).toBe(850);
		expect(MAX_BUILD_FILES).toBe(900);
		expect(overBudget(files(MAX_BUILD_FILES), MAX_BUILD_FILES, 'full build ceiling')).toBeNull();
		expect(overBudget(files(MAX_BUILD_FILES + 1), MAX_BUILD_FILES, 'full build ceiling')).toMatch(/over the full build ceiling of 900/);
	});
	it('still leaves the hosted-only files out of the list', () => {
		for (const rel of ['sw.js', 'version.json', '404.html', '_headers', 'llms.txt', 'export-manifest.json', 'hdri/x.hdr']) expect(excluded(rel)).toBe(true);
		expect(excluded('index.html')).toBe(false);
	});
});
