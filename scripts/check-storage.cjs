#!/usr/bin/env node
// 27-H (hardening audit M4) — THE GUARD THAT KEEPS THE CODEMOD FROM DECAYING.
//
// 507 bare `localStorage` calls across 94 files were routed through `$lib/safeStorage` in
// one pass. Without something failing on the next bare one, that lasts exactly until the
// next feature: nobody grepping for "how do I persist a setting" finds the wrapper, they
// find ninety-three examples of `localStorage.setItem` in the file they are editing.
//
// This is the whole rule. `localStorage.setItem` THROWS in Safari private mode and on a
// full quota, and most of these sit inside `$effect`s and store subscribers, where a
// throw kills the subscriber for the session — the setting stops persisting AND the UI it
// drives stops updating, with nothing pointing at storage.
//
// Exits 1 on a violation; prints the file, the line and what to write instead. Wired into
// ci.yml's `check` job beside the svelte-check ratchet.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// `localStorage.x(` for the four methods, and the one enumeration form the codebase used
const CALL = /\blocalStorage\.(getItem|setItem|removeItem|clear)\s*\(/;
const KEYS = /\bObject\.keys\(\s*localStorage\s*\)/;

/**
 * The only files allowed to touch it directly, each for a stated reason. Adding to this
 * list is a decision, which is the point of it being a list.
 */
const ALLOWED = new Map([
	['src/lib/safeStorage.js', 'it IS the wrapper'],
	[
		'src/app.html',
		'an inline <script> in the document head, applying the saved theme BEFORE first paint — it runs before any module exists to import, and it is already wrapped in try/catch'
	]
]);

/** @param {string} dir @param {string[]} out */
function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.(js|ts|svelte|html)$/.test(entry.name)) out.push(full);
	}
	return out;
}

const violations = [];
for (const file of walk(SRC)) {
	const rel = path.relative(ROOT, file).split(path.sep).join('/');
	if (ALLOWED.has(rel)) continue;
	const lines = fs.readFileSync(file, 'utf8').split('\n');
	lines.forEach((line, i) => {
		if (CALL.test(line) || KEYS.test(line)) violations.push({ rel, line: i + 1, text: line.trim() });
	});
}

if (!violations.length) {
	console.log('check:storage — no bare localStorage calls in src/.');
	process.exit(0);
}

console.error('check:storage — ' + violations.length + ' bare localStorage call(s):\n');
for (const v of violations) console.error('  ' + v.rel + ':' + v.line + '  ' + v.text.slice(0, 100));
console.error(
	"\nUse $lib/safeStorage instead — `import { safeStorage } from '$lib/safeStorage'` and" +
		'\ncall safeStorage.getItem / setItem / removeItem / clear / keys. It never throws, and a' +
		'\nwrite that cannot reach the disk still applies for this session.' +
		'\n\nIf a file genuinely cannot import (an inline script before the bundle exists), add it' +
		'\nto ALLOWED in scripts/check-storage.cjs with the reason.'
);
process.exit(1);
