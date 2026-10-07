#!/usr/bin/env node
// 38 R2/R11 — `npm run check:tokens`: colours come from the redesign tokens only
// (cloud docs/design/redesign/SPEC.md §1; the tokens live in src/styles/tokens.css and app.css).
//
// What counts as a raw colour (src/components/**, src/routes/**, src/styles/** minus the files
// that DEFINE the tokens, and the core modules' .svelte components):
//   - a hex literal            #fff  #1b212d  #1b212dcc      (also inside a var() fallback)
//   - an rgb()/rgba()/hsl()/hsla() literal
//   - a Tailwind PALETTE utility   bg-gray-800  text-red-400  hover:border-blue-500/50
//     bg-white  text-black …       (token utilities — bg-surface-2, text-text-muted — are fine)
// Comments are stripped first, so a note that NAMES a colour is not a violation.
//
// R11: a HARD FAIL (CI runs it as is). The redesign migrated every component; a colour that is
// DATA, not chrome — a default the user edits in a colour picker, a three.js material, pixels a
// canvas draws for the 3D view or a headset — says so where it stands:
//     const DEFAULT_TINT = '#ffffff'; // tokens-ok: the picker's starting value (user data)
//     /* tokens-ok-begin: node category hues (graph data, same in every theme) */ … /* tokens-ok-end */
// The reason after `tokens-ok:` is required (a bare `tokens-ok` is itself a violation), so
// every exemption reads as a decision in review.
//
//   node scripts/check-tokens.cjs            report per file, exit 1 on any raw colour
//   node scripts/check-tokens.cjs --warn     report only, exit 0
//   node scripts/check-tokens.cjs --json     machine-readable { total, files: {rel: n} }
//   node scripts/check-tokens.cjs <files…>   only these files (a lane checking its own diff)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCOPE = ['src/components', 'src/routes', 'src/styles', 'src/modules'].map((d) => path.join(ROOT, d));
/** the files that DEFINE the tokens (and the legacy palette they derive from) */
const DEFINITIONS = new Set(['src/styles/tokens.css', 'src/styles/theme.css']);
/** files another branch is redesigning (scripts/redesign-pending.json says which and why) */
const PENDING = new Set(require('./redesign-pending.json').files);

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

/** `tokens-ok: <reason>` on a line, or a `tokens-ok-begin: <reason>` … `tokens-ok-end` block */
const PRAGMA = /tokens-ok(?:-begin)?\s*:\s*\S.{2,}/;
const BARE = /tokens-ok(?!-end)(?!-begin\s*:\s*\S)(?!\s*:\s*\S)/;

/**
 * Every raw colour in one file's text, minus the lines an exemption pragma covers. A pragma
 * with no reason is reported as kind `pragma`.
 * @param {string} text
 * @returns {{line: number, kind: string, match: string}[]}
 */
function scanText(text) {
	/** @type {{line: number, kind: string, match: string}[]} */
	const out = [];
	const raw = text.split('\n');
	const lines = stripComments(text).split('\n');
	let block = false;
	lines.forEach((line, i) => {
		const src = raw[i] ?? '';
		if (BARE.test(src)) out.push({ line: i + 1, kind: 'pragma', match: 'tokens-ok without a reason' });
		const opens = /tokens-ok-begin\s*:/.test(src);
		const closes = /tokens-ok-end/.test(src);
		if (opens) block = true;
		const exempt = block || PRAGMA.test(src);
		if (closes) block = false;
		if (exempt) return;
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
		// src/modules: only the components (module.js files build three.js content, whose colours are data)
		else if (/\.(svelte|css|js|ts)$/.test(entry.name) && (entry.name.endsWith('.svelte') || !relOf(full).startsWith('src/modules/'))) out.push(full);
	}
	return out;
}

/** @param {string} file */
const relOf = (file) => path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');

function main() {
	const args = process.argv.slice(2);
	const warn = args.includes('--warn');
	const json = args.includes('--json');
	const only = args.filter((a) => !a.startsWith('--'));
	const files = only.length
		? only.map((f) => path.resolve(ROOT, f))
		: SCOPE.flatMap((d) => walk(d)).filter((f) => !DEFINITIONS.has(relOf(f)) && !PENDING.has(relOf(f)));

	/** @type {Record<string, number>} */
	const perFile = {};
	/** @type {string[]} */
	const lines = [];
	let total = 0;
	for (const file of files) {
		if (!fs.existsSync(file)) continue;
		const rel = relOf(file);
		const hits = scanText(fs.readFileSync(file, 'utf8'));
		if (!hits.length) continue;
		perFile[rel] = hits.length;
		total += hits.length;
		for (const h of hits) lines.push(`  ${rel}:${h.line}  ${h.kind}  ${h.match}`);
	}

	if (json) {
		console.log(JSON.stringify({ total, files: perFile }, null, 2));
	} else if (!total) {
		console.log(`check:tokens — clean (${files.length} files${only.length ? '' : `; ${PENDING.size} pending another branch`})`);
	} else {
		const ranked = Object.entries(perFile).sort((a, b) => b[1] - a[1]);
		console.error(`check:tokens — ${total} raw colour(s) in ${ranked.length} file(s)` + (warn ? ' (--warn: not failing)' : ''));
		for (const l of lines.slice(0, 200)) console.error(l);
		if (lines.length > 200) console.error(`  … and ${lines.length - 200} more (--json for the per-file counts)`);
		console.error(
			'\nUse the tokens (src/styles/tokens.css; Tailwind: bg-surface-2, text-text-muted, text-ink-bad …). A colour that is' +
				'\nDATA (a picker default, a three.js / canvas colour) takes `// tokens-ok: <why>` on its line.'
		);
	}
	process.exit(total && !warn ? 1 : 0);
}

if (require.main === module) main();

module.exports = { scanText, stripComments, DEFINITIONS, PENDING };
