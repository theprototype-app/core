import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import pending from '../../scripts/redesign-pending.json' with { type: 'json' };

// 38 R11 (SPEC §2 "Remove Flowbite components area by area as they are replaced"): the app's
// controls come from src/components/ui (Button, Toggle, Checkbox, ModalDialog, Menu, Tabs …),
// so nothing imports flowbite-svelte any more. The only exceptions are the files another branch
// is rewriting (scripts/redesign-pending.json — the Settings window, 37-settings): when that
// list empties, the flowbite + flowbite-svelte packages and app.css's `@plugin 'flowbite/plugin'`
// / `@source` lines go with it (see the R11 handover).

const ROOT = join(import.meta.dirname, '../..');
const PENDING = new Set(pending.files);

/** @param {string} dir @param {string[]} [out] @returns {string[]} */
function walk(dir, out = []) {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.(svelte|js|ts)$/.test(f)) out.push(p);
	}
	return out;
}

/** @param {string} text @returns {number[]} 1-based lines importing flowbite-svelte */
export function flowbiteImports(text) {
	/** @type {number[]} */
	const lines = [];
	text.split('\n').forEach((ln, i) => {
		if (/from\s+['"]flowbite-svelte[^'"]*['"]|import\s*\(\s*['"]flowbite-svelte/.test(ln)) lines.push(i + 1);
	});
	return lines;
}

describe('no flowbite-svelte in the app', () => {
	it('the scanner catches what it is for (counterfactual)', () => {
		expect(flowbiteImports("\timport { Button, Modal } from 'flowbite-svelte';")).toEqual([1]);
		expect(flowbiteImports("import Toggle from 'flowbite-svelte/Toggle.svelte';")).toEqual([1]);
		expect(flowbiteImports('// flowbite-svelte 1.33 behaviour, kept on purpose')).toEqual([]);
	});

	it('no component, route or module imports flowbite-svelte', () => {
		const bad = ['src/components', 'src/routes', 'src/modules', 'src/lib']
			.flatMap((d) => walk(join(ROOT, d)))
			.filter((f) => !PENDING.has(relative(ROOT, f)))
			.flatMap((f) => flowbiteImports(readFileSync(f, 'utf8')).map((l) => `${relative(ROOT, f)}:${l}`));
		expect(bad).toEqual([]);
	});

	it('every pending file still exists (a stale entry would silently exempt nothing)', () => {
		const missing = [...PENDING].filter((f) => {
			try {
				return !statSync(join(ROOT, f)).isFile();
			} catch {
				return true;
			}
		});
		expect(missing).toEqual([]);
	});
});
