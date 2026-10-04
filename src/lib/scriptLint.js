// 34 D3 — THE SCRIPT LINT: what a Script node v2 (and a behaviour, D5) may not say.
//
// A script runs on EVERY peer and must be a pure function of what it is handed, or the
// peers drift apart with no error anywhere — the value-node rule (moduleNodeIO's header).
// So the lint refuses the four ways a snippet escapes that:
//   dom              the page (document, window, fetch, eval…) — a script reaches the scene
//                    through its arguments, never through the tab it happens to run in
//   nondeterministic Math.random / Date.now / new Date() / performance.now / crypto — a
//                    value one peer rolls is a value no other peer rolled; wire a Random
//                    node (seeded by node id) or read `time` (the synced clock) instead
//   storage          localStorage / sessionStorage / indexedDB — this device's state
//   timers           setTimeout & co — a callback that lands between two ticks on one peer
//   unbounded-loop   while (true) / for (;;) / do … while (true) with no break, return or
//                    throw in the body. loopGuard still stops a runaway at run time; this
//                    says so before the first frame instead of after a million iterations
//
// A LEAF importing only the loopGuard leaf: the scanner there is the one place that tells
// code from a string or a comment (`// Math.random()` must not be reported), so the lint
// reads its mask instead of growing a second scanner. Static and textual on purpose — a
// determined author can always reach `globalThis` through a string; this is a guard for the
// ACCIDENT, the same scope as loopGuard (scriptRuntime's header: not a sandbox).

import { codeMask } from './loopGuard.js';

/** @typedef {{ rule: string, message: string, line: number, col: number }} LintIssue */

/** identifiers that mean "the page", matched as whole words not after a `.` */
const DOM_WORDS = [
	'document', 'window', 'navigator', 'globalThis', 'fetch', 'XMLHttpRequest',
	'WebSocket', 'alert', 'confirm', 'prompt', 'eval', 'importScripts', 'require'
];
const STORAGE_WORDS = ['localStorage', 'sessionStorage', 'indexedDB'];
const TIMER_WORDS = ['setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask'];

/** dotted or call-shaped patterns, each with its rule and message */
const PATTERNS = [
	{ re: /\bMath\s*\.\s*random\b/g, rule: 'nondeterministic', message: 'Math.random differs per peer — wire a Random node into an input' },
	{ re: /\bDate\s*\.\s*now\b/g, rule: 'nondeterministic', message: 'Date.now differs per peer — use `time` (the synced clock)' },
	{ re: /\bnew\s+Date\b/g, rule: 'nondeterministic', message: 'new Date() differs per peer — use `time` (the synced clock)' },
	{ re: /(?<![.\w$])(?<!new\s+)Date\s*\(/g, rule: 'nondeterministic', message: 'Date() differs per peer — use `time` (the synced clock)' },
	{ re: /\bperformance\s*\.\s*now\b/g, rule: 'nondeterministic', message: 'performance.now differs per peer — use `time` (the synced clock)' },
	{ re: /\bcrypto\s*\.\s*(getRandomValues|randomUUID)\b/g, rule: 'nondeterministic', message: 'crypto randomness differs per peer' },
	{ re: /\bnew\s+Function\b/g, rule: 'dom', message: 'new Function compiles code at run time — not allowed in a script' },
	{ re: /(?<![.\w$])import\s*\(/g, rule: 'dom', message: 'import() loads code at run time — not allowed in a script' }
];

/** @param {string} masked @param {number} index */
function lineCol(masked, index) {
	let line = 1;
	let last = -1;
	for (let i = 0; i < index; i++)
		if (masked[i] === '\n') {
			line++;
			last = i;
		}
	return { line, col: index - last };
}

/** @param {string} masked @param {string[]} words @param {string} rule @param {(w: string) => string} message @param {LintIssue[]} out */
function scanWords(masked, words, rule, message, out) {
	const re = new RegExp('(?<![.\\w$])(' + words.join('|') + ')(?![\\w$])', 'g');
	for (const m of masked.matchAll(re)) {
		// a property KEY (`{ window: 3 }`) or a declaration's own name is not a reference to
		// the page — skip `word:` that is not part of a `?:` ternary
		const after = masked.slice((m.index ?? 0) + m[0].length).match(/^\s*:/);
		const before = masked.slice(0, m.index).match(/[?]\s*$/);
		if (after && !before) continue;
		out.push({ rule, message: message(m[1]), ...lineCol(masked, m.index ?? 0) });
	}
}

/** Index of the bracket closing the one at `open` in MASKED code (strings are blank). @param {string} masked @param {number} open */
function closeOf(masked, open) {
	const pairs = /** @type {Record<string, string>} */ ({ '(': ')', '{': '}', '[': ']' });
	const want = pairs[masked[open]];
	let depth = 0;
	for (let i = open; i < masked.length; i++) {
		if (masked[i] === masked[open]) depth++;
		else if (masked[i] === want && --depth === 0) return i;
	}
	return -1;
}

/** the loop body text starting at `from` (a braced block, or one statement) @param {string} masked @param {number} from */
function bodyAt(masked, from) {
	let i = from;
	while (i < masked.length && /\s/.test(masked[i])) i++;
	if (masked[i] === '{') {
		const end = closeOf(masked, i);
		return end === -1 ? masked.slice(i) : masked.slice(i, end + 1);
	}
	const semi = masked.indexOf(';', i);
	return masked.slice(i, semi === -1 ? undefined : semi + 1);
}

const EXITS = /(?<![\w$])(break|return|throw)(?![\w$])/;
const ALWAYS_TRUE = /^\s*(true|1|!0|!false)\s*$/;

/** @param {string} masked @param {LintIssue[]} out */
function scanLoops(masked, out) {
	const report = (/** @type {number} */ at) =>
		out.push({
			rule: 'unbounded-loop',
			message: 'this loop has no exit (no break, return or throw) — it would run until the loop guard stops it',
			...lineCol(masked, at)
		});
	for (const m of masked.matchAll(/(?<![.\w$])(while|for)\s*\(/g)) {
		const open = (m.index ?? 0) + m[0].length - 1;
		const close = closeOf(masked, open);
		if (close === -1) continue;
		const head = masked.slice(open + 1, close);
		const forever =
			m[1] === 'while'
				? ALWAYS_TRUE.test(head)
				: head.split(';').length === 3 && head.split(';')[1].trim() === '';
		if (!forever) continue;
		// the `while (true)` closing a do-loop: its body is the block BEFORE it
		if (m[1] === 'while' && /\}\s*$/.test(masked.slice(0, m.index))) {
			const bodyEnd = masked.slice(0, m.index).lastIndexOf('}');
			let depth = 0;
			let start = -1;
			for (let i = bodyEnd; i >= 0; i--) {
				if (masked[i] === '}') depth++;
				else if (masked[i] === '{' && --depth === 0) {
					start = i;
					break;
				}
			}
			if (start !== -1 && /(?<![\w$])do\s*$/.test(masked.slice(0, start))) {
				if (!EXITS.test(masked.slice(start, bodyEnd + 1))) report(m.index ?? 0);
				continue;
			}
		}
		if (!EXITS.test(bodyAt(masked, close + 1))) report(m.index ?? 0);
	}
}

/**
 * Lint a script's source. Returns every issue, in source order; an empty list means clean.
 * Source the scanner cannot read (an unterminated string or comment) returns no issues —
 * the compile reports the real syntax error, and a lint guessing at broken code would only
 * add a second, wrong message.
 * @param {string} code
 * @returns {LintIssue[]}
 */
export function lintScript(code) {
	const masked = codeMask(code);
	if (masked === null) return [];
	/** @type {LintIssue[]} */
	const out = [];
	scanWords(masked, DOM_WORDS, 'dom', (w) => '`' + w + '` reaches the page — a script reads the scene through its inputs', out);
	scanWords(masked, STORAGE_WORDS, 'storage', (w) => '`' + w + '` is this device only — peers would disagree', out);
	scanWords(masked, TIMER_WORDS, 'timers', (w) => '`' + w + '` fires between ticks on one peer — use `time` or a Delay node', out);
	for (const p of PATTERNS)
		for (const m of masked.matchAll(p.re)) out.push({ rule: p.rule, message: p.message, ...lineCol(masked, m.index ?? 0) });
	scanLoops(masked, out);
	return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

/** One line per issue, for a badge or a tool result. @param {LintIssue[]} issues */
export function formatLint(issues) {
	return issues.map((i) => 'line ' + i.line + ': ' + i.message).join('\n');
}
