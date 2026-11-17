#!/usr/bin/env node
// 101 F2: three's generic loaders are reached ONLY through the checked helpers in src/lib/loadGuard.js
// (parseCheckedObject / parseCheckedMaterials), which run the object schema (src/lib/sceneSchema.js)
// first. A new `new THREE.ObjectLoader()`, `.parseMaterials(` or `new MaterialLoader(` anywhere else in
// src/ fails this check. Comment lines are ignored.
//
//   node scripts/check-loaders.cjs   → exit 1 and one line per call outside the helper
//
// Run by CI (.github/workflows/ci.yml) and tests/unit/checkLoaders.test.js.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALLOWED = new Set(['src/lib/loadGuard.js']);
const PATTERN = /\bObjectLoader\s*\(|\.parseMaterials\s*\(|\bMaterialLoader\s*\(/;

/** @param {string} dir @returns {string[]} */
function files(dir) {
	/** @type {string[]} */
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...files(p));
		else if (/\.(js|ts|svelte|mjs)$/.test(e.name) && !/\.(test|spec)\.[jt]s$/.test(e.name)) out.push(p);
	}
	return out;
}

/** @param {string} text @returns {number[]} 1-based lines with a call */
function hitsIn(text) {
	/** @type {number[]} */
	const out = [];
	let inBlock = false;
	text.split('\n').forEach((line, i) => {
		let code = line;
		if (inBlock) {
			const end = code.indexOf('*/');
			if (end < 0) return;
			code = code.slice(end + 2);
			inBlock = false;
		}
		code = code.replace(/\/\*.*?\*\//g, '');
		const open = code.indexOf('/*');
		if (open >= 0) {
			inBlock = true;
			code = code.slice(0, open);
		}
		code = code.replace(/\/\/.*$/, '');
		// a JSDoc continuation line (` * …`) is comment text even where the opening /** was not seen
		if (/^\s*\*/.test(code)) return;
		if (PATTERN.test(code)) out.push(i + 1);
	});
	return out;
}

function main() {
	/** @type {string[]} */
	const bad = [];
	for (const file of files(path.join(ROOT, 'src'))) {
		const rel = path.relative(ROOT, file).split(path.sep).join('/');
		if (ALLOWED.has(rel)) continue;
		for (const line of hitsIn(fs.readFileSync(file, 'utf8'))) bad.push(`${rel}:${line}`);
	}
	if (bad.length) {
		console.log('check-loaders: three generic loader calls outside src/lib/loadGuard.js (use parseCheckedObject / parseCheckedMaterials):');
		for (const b of bad) console.log('  ' + b);
		process.exit(1);
	}
	console.log('check-loaders — clean (every generic loader call goes through src/lib/loadGuard.js)');
}

if (require.main === module) main();
module.exports = { hitsIn };
