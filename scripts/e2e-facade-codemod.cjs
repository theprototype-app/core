#!/usr/bin/env node
// 101 F5 — move e2e code from `window.__stores` onto the test facade `window.__tp.test.v1`.
// MECHANICAL ONLY: every `<expr>.__stores` / `<expr>?.__stores` member read becomes the facade,
// with the optional-chaining chosen so a read BEFORE the hook is installed behaves exactly as it
// did (the facade and `__stores` are published in the same synchronous step):
//   X.__stores.y   X.__stores[k]     ->  X.__tp.test.v1.y   X.__tp.test.v1[k]   (threw before, throws now)
//   X.__stores?.y                    ->  X.__tp?.test.v1?.y                       (undefined before, undefined now)
//   X.__stores && …, !!X.__stores, const s = X.__stores;, f(X.__stores), {...X.__stores}
//                                    ->  X.__tp?.test.v1                          (undefined before, undefined now)
// Bare `__stores` words (comments, prose) are left alone.
//
//   node scripts/e2e-facade-codemod.cjs [--write] [--check] <file|dir>...
//     (default: dry run, prints per-file counts)   --check: exit 1 if any member read is left
// Kept in the tree (101-seam rule) so a later lane can rerun it on suites written against __stores.
'use strict';
const fs = require('fs');
const path = require('path');

const MEMBER = /(\?\.|\.)__stores\b(\?\.|\.|\[)?/g;

/** @param {string} src @returns {{ out: string, n: number }} */
function transform(src) {
	let n = 0;
	const out = src.replace(MEMBER, (_m, dot, next) => {
		n++;
		if (next === '.' || next === '[') return `${dot}__tp.test.v1${next}`;
		if (next === '?.') return `${dot}__tp?.test.v1?.`;
		return `${dot}__tp?.test.v1`;
	});
	return { out, n };
}

/** @param {string} p @returns {string[]} */
function files(p) {
	const st = fs.statSync(p);
	if (st.isFile()) return [p];
	/** @type {string[]} */
	const list = [];
	for (const e of fs.readdirSync(p, { withFileTypes: true })) {
		if (e.name === 'node_modules' || e.name === 'test-results' || e.name.startsWith('.')) continue;
		const q = path.join(p, e.name);
		if (e.isDirectory()) list.push(...files(q));
		else if (/\.(c?js|mjs)$/.test(e.name)) list.push(q);
	}
	return list;
}

function main() {
	const args = process.argv.slice(2);
	const write = args.includes('--write');
	const check = args.includes('--check');
	const targets = args.filter((a) => !a.startsWith('--'));
	if (!targets.length) {
		console.error('usage: e2e-facade-codemod.cjs [--write] [--check] <file|dir>...');
		process.exit(2);
	}
	let total = 0;
	let changed = 0;
	for (const f of targets.flatMap(files)) {
		const src = fs.readFileSync(f, 'utf8');
		const { out, n } = transform(src);
		if (!n) continue;
		total += n;
		changed++;
		if (check) console.log(`${f}: ${n} __stores member read(s) left`);
		else if (write) fs.writeFileSync(f, out);
		else console.log(`${f}: ${n}`);
	}
	console.log(`${check ? 'left' : write ? 'rewrote' : 'would rewrite'} ${total} reference(s) in ${changed} file(s)`);
	if (check && total) process.exit(1);
}

if (require.main === module) main();
module.exports = { transform };
