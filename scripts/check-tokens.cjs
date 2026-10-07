#!/usr/bin/env node
// 38 R2 — `npm run check:tokens`: colours in components come from the redesign tokens only
// (cloud docs/design/redesign/SPEC.md §1; the tokens live in src/styles/tokens.css and app.css).
//
// What counts as a raw colour in src/components/**:
//   - a hex literal            #fff  #1b212d  #1b212dcc      (also inside a var() fallback)
//   - an rgb()/rgba()/hsl()/hsla() literal
//   - a Tailwind PALETTE utility   bg-gray-800  text-red-400  hover:border-blue-500/50
//     bg-white  text-black …       (token utilities — bg-surface-2, text-text-muted — are fine)
// Comments are stripped first, so a note that NAMES a colour is not a violation.
//
// MODES. The redesign migrates the app area by area (R4-R10), so this starts as a WARNING:
//   node scripts/check-tokens.cjs            report per file, exit 0
//   node scripts/check-tokens.cjs --strict   exit 1 on any violation (R11 flips CI to this)
//   node scripts/check-tokens.cjs --json     machine-readable { total, files: {rel: n} }
//   node scripts/check-tokens.cjs <files…>   only these files (a lane checking its own diff)
// …except CLEAN: files already built from tokens fail even in warning mode. A lane that
// migrates a component adds it here — that is the ratchet, and why it is a list.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMPONENTS = path.join(ROOT, 'src', 'components');

/** files that must stay token-clean (relative to the repo root, forward slashes) */
const CLEAN = [
	// 38 R7 (38-modals)
	'src/components/menu/CharacterPanel.svelte',
	'src/components/menu/ConfirmModal.svelte',
	'src/components/menu/checkpoints/CheckpointSaveDialog.svelte',
	'src/components/menu/checkpoints/CheckpointTimeline.svelte',
	'src/components/menu/ExportPanel.svelte',
	'src/components/menu/ImportDuplicatesModal.svelte',
	'src/components/menu/ModulesManager.svelte',
	'src/components/menu/PublishExportModal.svelte',
	'src/components/menu/SessionsManager.svelte',
	'src/components/menu/StorageModal.svelte',
	'src/components/menu/TemplatesModal.svelte',
	'src/components/ui/ModalDialog.svelte',
	'src/components/ui/Badge.svelte',
	'src/components/ui/Button.svelte',
	'src/components/ui/Checkbox.svelte',
	'src/components/ui/Chips.svelte',
	'src/components/ui/EmptyState.svelte',
	'src/components/ui/Menu.svelte',
	'src/components/ui/NavRow.svelte',
	'src/components/ui/PropRow.svelte',
	'src/components/ui/SearchField.svelte',
	'src/components/ui/Segmented.svelte',
	'src/components/ui/SettingRow.svelte',
	'src/components/ui/Sheet.svelte',
	'src/components/ui/Slider.svelte',
	'src/components/ui/Tabs.svelte',
	'src/components/ui/Toast.svelte',
	'src/components/ui/Toggle.svelte',
	'src/components/ui/WindowChrome.svelte',
	'src/components/ui/kit/KitPage.svelte'
];

const PALETTE =
	'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|primary';
const UTIL =
	'bg|text|border|border-[trblxy]|ring|ring-offset|outline|divide|from|via|to|fill|stroke|placeholder|caret|accent|decoration|shadow';
const RULES = [
	{ kind: 'hex', re: /(?<![\w&$/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g },
	{ kind: 'rgb/hsl', re: /\b(?:rgba?|hsla?)\(\s*[\d.]/g },
	{
		kind: 'palette',
		re: new RegExp(`(?<![\\w-])(?:${UTIL})-(?:(?:${PALETTE})-\\d{2,3}|white|black)(?:\\/\\d{1,3})?(?![\\w-])`, 'g')
	}
];

/**
 * Blank out comments, keeping line numbers (newlines survive): HTML <!-- -->, CSS/JS block
 * comments, and // line comments (only after start-of-line or whitespace, so `https://`
 * and a `//` inside a string literal of a URL survive).
 * @param {string} text @returns {string}
 */
function stripComments(text) {
	const blank = (/** @type {string} */ m) => m.replace(/[^\n]/g, ' ');
	return text
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[\s;{}])\/\/[^\n]*/g, (m, lead) => lead + blank(m.slice(lead.length)));
}

/**
 * Every raw colour in one file's text.
 * @param {string} text
 * @returns {{line: number, kind: string, match: string}[]}
 */
function scanText(text) {
	/** @type {{line: number, kind: string, match: string}[]} */
	const out = [];
	const lines = stripComments(text).split('\n');
	lines.forEach((line, i) => {
		for (const { kind, re } of RULES) {
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(line))) out.push({ line: i + 1, kind, match: m[0] });
		}
	});
	return out;
}

/** @param {string} dir @param {string[]} out @returns {string[]} */
function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.(svelte|css|js|ts)$/.test(entry.name)) out.push(full);
	}
	return out;
}

/** @param {string} file */
const relOf = (file) => path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');

function main() {
	const args = process.argv.slice(2);
	const strict = args.includes('--strict');
	const json = args.includes('--json');
	const only = args.filter((a) => !a.startsWith('--'));
	const files = only.length ? only.map((f) => path.resolve(ROOT, f)) : walk(COMPONENTS);

	/** @type {Record<string, number>} */
	const perFile = {};
	/** @type {string[]} */
	const cleanBroken = [];
	let total = 0;
	for (const file of files) {
		if (!fs.existsSync(file)) continue;
		const rel = relOf(file);
		const hits = scanText(fs.readFileSync(file, 'utf8'));
		if (!hits.length) continue;
		perFile[rel] = hits.length;
		total += hits.length;
		if (CLEAN.includes(rel))
			for (const h of hits) cleanBroken.push(`  ${rel}:${h.line}  ${h.kind}  ${h.match}`);
	}

	if (json) {
		console.log(JSON.stringify({ total, files: perFile, cleanBroken: cleanBroken.length }, null, 2));
	} else {
		const ranked = Object.entries(perFile).sort((a, b) => b[1] - a[1]);
		console.log(
			`check:tokens — ${total} raw colour(s) in ${ranked.length} file(s)` +
				(strict ? '' : ' (WARNING mode: R11 makes this a hard fail)')
		);
		for (const [rel, n] of ranked.slice(0, only.length ? ranked.length : 25)) console.log(`  ${String(n).padStart(4)}  ${rel}`);
		if (!only.length && ranked.length > 25) console.log(`  … and ${ranked.length - 25} more (--json for all)`);
		if (cleanBroken.length) {
			console.error(`\ncheck:tokens — ${cleanBroken.length} raw colour(s) in a token-CLEAN file:`);
			for (const l of cleanBroken) console.error(l);
			console.error('\nUse the tokens (src/styles/tokens.css; Tailwind: bg-surface-2, text-text-muted …).');
		}
	}
	process.exit(cleanBroken.length || (strict && total) ? 1 : 0);
}

if (require.main === module) main();

module.exports = { scanText, stripComments, CLEAN };
