// 36-fb-code (F7): THE PROBLEMS of an open tab's CURRENT text — what the right sidebar's Problems
// panel lists for every open file, as you type (the error banner only knows the last SAVE).
// Parse errors first, then lint: the Script-node determinism advice (scriptLint) for a script,
// the behaviour analyzer's errors and lint for a behaviour. The runtime half (a node that threw,
// a save that was not applied) is the workspace's — it lives in stores this leaf never imports.
//
// Memoised per text: a tab's problems are recomputed only when its text changes, so a keystroke
// in one tab re-reads one tab.

import { parseCheck } from './codeTabs.js';
import { lintScript } from './scriptLint.js';
import { analyze } from './behaviours/analyze.js';

/**
 * @typedef {{ severity: 'error' | 'warning', message: string, line: number, from: 'parse' | 'lint' | 'runtime' }} Problem
 */

/** what a tab's text is, for checking @param {any} tab @returns {'json' | 'behaviour' | 'script' | null} */
export function checkKindOf(tab) {
	if (!tab || tab.readOnly) return null;
	if (tab.kind === 'graph') return 'json';
	if (tab.kind === 'behaviour') return 'behaviour';
	if (tab.kind === 'node') return 'script';
	if (tab.kind === 'file') return /^\s*export\s+default\b/m.test(String(tab.code ?? '')) ? 'behaviour' : 'script';
	return null;
}

/** @type {Map<string, Problem[]>} */
const memo = new Map();

/**
 * Parse + lint problems of a text. `kind` from checkKindOf; null = nothing to check (a
 * read-only module source is not the user's to fix).
 * @param {string} code @param {'json' | 'behaviour' | 'script' | null} kind @returns {Problem[]}
 */
export function textProblems(code, kind) {
	if (!kind) return [];
	const key = kind + '\u0000' + code;
	const hit = memo.get(key);
	if (hit) return hit;
	/** @type {Problem[]} */
	const out = [];
	if (kind === 'behaviour') {
		const a = analyze(String(code ?? ''));
		for (const e of a.errors ?? []) out.push({ severity: 'error', message: e.message, line: Math.max(1, e.line || 1), from: a.ok === false ? 'parse' : 'lint' });
		for (const l of a.lint ?? []) out.push({ severity: l.level === 'warning' ? 'warning' : 'error', message: l.message, line: Math.max(1, l.line || 1), from: 'lint' });
	} else {
		const err = parseCheck(code, kind);
		if (err) out.push({ severity: 'error', message: err.message, line: err.line, from: 'parse' });
		else if (kind === 'script') for (const l of lintScript(code)) out.push({ severity: 'warning', message: l.message, line: l.line, from: 'lint' });
	}
	out.sort((a, b) => a.line - b.line);
	if (memo.size > 200) memo.clear();
	memo.set(key, out);
	return out;
}
