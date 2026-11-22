// @ts-nocheck -- fixture test over a node CLI module
// fix-export-files: the build's file budget (scripts/export-manifest.cjs) is what stops the runtime
// file count creeping back over itch.io's limit unnoticed — 1.74.0 listed 1,056 files and every
// export failed its own check.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { ITCH_LIMITS } from '../../src/lib/export/exportValidate.js';

const require = createRequire(import.meta.url);
const { MAX_RUNTIME_FILES, overBudget, excluded } = require('../../scripts/export-manifest.cjs');

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
	it('still leaves the hosted-only files out of the list', () => {
		for (const rel of ['sw.js', 'version.json', '404.html', '_headers', 'llms.txt', 'export-manifest.json', 'hdri/x.hdr']) expect(excluded(rel)).toBe(true);
		expect(excluded('index.html')).toBe(false);
	});
});
