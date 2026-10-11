#!/usr/bin/env node
// 41-modals G3b — `npm run check:zindex`: every PAGE-level z-index comes from the scale in
// src/styles/ui.css (`--z-canvas` … `--z-toast`), never a raw number.
//
// What counts as a violation (src/components, src/routes, src/styles, src/modules, src/lib):
//   - a CSS / inline-style / JS-string `z-index: N`          with N >= 30
//   - a JS `zIndex = 'N'` / `zIndex: N` / `String(N …)`       with N >= 30
//   - a Tailwind utility `z-N` / `z-[N]` (any variant prefix) with N >= 30
// A number BELOW 30 is stacking inside a component's own stacking context (a resize grip over its
// window's tab strip), which the page scale never sees — the lowest page tier (--z-chrome) is 30.
// Comments are stripped first. A value that must stay numeric (code reads it back as a number) says
// so on its line: `// z-ok: <reason>` (the reason is required).
//
//   node scripts/check-zindex.cjs            report per file, exit 1 on any violation
//   node scripts/check-zindex.cjs --json     { total, files: {rel: [{line, match}]} }

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCOPE = ['src/components', 'src/routes', 'src/styles', 'src/modules', 'src/lib'].map((d) => path.join(ROOT, d));
const EXT = /\.(svelte|css|js|ts)$/;
const LOCAL_MAX = 29;

const RULES = [
	/z-index\s*:\s*(-?\d+)/g,
	/zIndex\s*[:=]\s*['"`]?(-?\d+)/g,
	/zIndex\s*=\s*String\(\s*(\d+)/g,
	/(?<![\w-])(?:[a-z0-9-]+:)*-?z-\[?(\d+)\]?(?![\w-])/g
];

/**
 * Blank out comments, keeping line numbers. @param {string} text @returns {string}
 */
function stripComments(text) {
	const blank = (/** @type {string} */ m) => m.replace(/[^\n]/g, ' ');
	return text
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[\s;{}])\/\/[^\n]*/g, (m, lead) => lead + blank(m.slice(lead.length)));
}

const PRAGMA = /z-ok\s*:\s*\S.{2,}/;

/**
 * @param {string} text @returns {{line: number, match: string}[]}
 */
function scanText(text) {
	/** @type {{line: number, match: string}[]} */
	const out = [];
	const raw = text.split('\n');
	stripComments(text)
		.split('\n')
		.forEach((line, i) => {
			if (PRAGMA.test(raw[i])) return;
			for (const re of RULES) {
				re.lastIndex = 0;
				let m;
				while ((m = re.exec(line))) {
					if (Number(m[1]) > LOCAL_MAX) out.push({ line: i + 1, match: m[0].trim() });
				}
			}
		});
	return out;
}

/** @param {string} dir @param {string[]} acc @returns {string[]} */
function walk(dir, acc) {
	if (!fs.existsSync(dir)) return acc;
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) walk(p, acc);
		else if (EXT.test(ent.name)) acc.push(p);
	}
	return acc;
}

if (require.main === module) {
	const json = process.argv.includes('--json');
	/** @type {Record<string, {line: number, match: string}[]>} */
	const files = {};
	let total = 0;
	for (const dir of SCOPE) {
		for (const file of walk(dir, [])) {
			const hits = scanText(fs.readFileSync(file, 'utf8'));
			if (!hits.length) continue;
			files[path.relative(ROOT, file)] = hits;
			total += hits.length;
		}
	}
	if (json) {
		console.log(JSON.stringify({ total, files }, null, 1));
	} else {
		for (const [rel, hits] of Object.entries(files)) for (const h of hits) console.log(`${rel}:${h.line}  ${h.match}`);
		console.log(
			total
				? `\n${total} page-level z-index literal(s). Use a token from the scale in src/styles/ui.css ` +
						'(var(--z-…) / z-(--z-…), or calc(var(--z-…) ± n)); a number the code must read back says why with `z-ok: <reason>`.'
				: 'check:zindex — every page-level z-index is on the scale.'
		);
	}
	process.exit(total ? 1 : 0);
}

module.exports = { scanText, LOCAL_MAX };
