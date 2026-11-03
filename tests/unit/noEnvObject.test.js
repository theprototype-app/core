// 54 X7 guard: source must read VITE_ keys one by one. A bare `import.meta.env` used as a VALUE
// (`import.meta.env ?? {}`, `const env = import.meta.env`, `import.meta.env[key]`) makes vite inline the
// WHOLE env object into that chunk — and exported game zips carried it (1.54.3 preview: funnel.js).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string} dir @param {string[]} [out] @returns {string[]} */
function files(dir, out = []) {
	for (const n of readdirSync(dir)) {
		const p = join(dir, n);
		if (statSync(p).isDirectory()) files(p, out);
		else if (/\.(js|ts|svelte)$/.test(n)) out.push(p);
	}
	return out;
}

describe('no whole import.meta.env object in src/', () => {
	it('every import.meta.env use names a key', () => {
		/** @type {string[]} */
		const bad = [];
		for (const f of files('src')) {
			const lines = readFileSync(f, 'utf8').split('\n');
			lines.forEach((line, i) => {
				const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
				const re = /import\.meta\.env(?![\w$])(?!\s*\??\.\s*[A-Z_$][\w$]*)/g;
				if (re.test(code)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
			});
		}
		expect(bad).toEqual([]);
	});
});
