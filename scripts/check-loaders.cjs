#!/usr/bin/env node
// 101 F2: three's generic loaders are reached ONLY through the checked helpers in src/lib/loadGuard.js
// (parseCheckedObject / parseCheckedMaterials), which run the object schema (src/lib/sceneSchema.js)
// first. A new `new THREE.ObjectLoader()`, `.parseMaterials(` or `new MaterialLoader(` anywhere else in
// src/ fails this check. Comment lines are ignored.
//
// Second rule: every glTF parse (a GLTFLoader, or `createGltfLoader`, followed by `.parse(` / `.parseAsync(`)
// has a `checkGltf(` call in the GLTF_WINDOW lines before it, in the same file. GLTF_ALLOWED lists the parses
// that read bytes this app wrote on this device (an autosave of the scene, whose objects were checked when
// they arrived).
//
//   node scripts/check-loaders.cjs   → exit 1 and one line per call outside the helper
//
// Run by CI (.github/workflows/ci.yml) and tests/unit/checkLoaders.test.js.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALLOWED = new Set(['src/lib/loadGuard.js']);
const PATTERN = /\bObjectLoader\s*\(|\.parseMaterials\s*\(|\bMaterialLoader\s*\(/;
const GLTF_CTOR = /\bnew\s+GLTFLoader\s*\(|\bcreateGltfLoader\s*\(/;
const GLTF_WINDOW = 40;
const GLTF_ALLOWED = new Set(['src/lib/autosave.js']);

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

/** @param {string} text @returns {string[]} the file's lines with comments blanked */
function codeLines(text) {
	let inBlock = false;
	return text.split('\n').map((line) => {
		let code = line;
		if (inBlock) {
			const end = code.indexOf('*/');
			if (end < 0) return '';
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
		return /^\s*\*/.test(code) ? '' : code;
	});
}

/**
 * 1-based lines with a glTF parse that has no `checkGltf(` in the GLTF_WINDOW lines before it. A parse is
 * `.parse(`/`.parseAsync(` on a line that builds a glTF loader, or called on a name (or a factory) that
 * was bound to one: a declaration whose line, or the next five, builds one.
 * @param {string} text @returns {number[]}
 */
function gltfHitsIn(text) {
	const lines = codeLines(text);
	/** every declaration, in order: [line index, name, bound to a glTF loader?] @type {[number, string, boolean][]} */
	const decls = [];
	lines.forEach((code, i) => {
		const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(code);
		if (decl) decls.push([i, decl[1], lines.slice(i, i + 6).some((l) => GLTF_CTOR.test(l))]);
	});
	/** is `name` at line `i` bound to a glTF loader (its nearest declaration above says so)? @param {string} name @param {number} i */
	const isGltf = (name, i) => {
		for (let k = decls.length - 1; k >= 0; k--) if (decls[k][0] < i && decls[k][1] === name) return decls[k][2];
		return false;
	};
	/** @type {number[]} */
	const out = [];
	lines.forEach((code, i) => {
		if (!/\.parse(?:Async)?\s*\(/.test(code)) return;
		const direct = GLTF_CTOR.test(code) && /\)\s*\.parse(?:Async)?\s*\(/.test(code);
		const named = [...code.matchAll(/\b([A-Za-z_$][\w$]*)(?:\(\))?\.parse(?:Async)?\s*\(/g)].some((m) => isGltf(m[1], i));
		if (!direct && !named) return;
		if (!lines.slice(Math.max(0, i - GLTF_WINDOW), i + 1).some((l) => /\bcheckGltf\s*\(/.test(l))) out.push(i + 1);
	});
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
	/** @type {string[]} */
	const unchecked = [];
	for (const file of files(path.join(ROOT, 'src'))) {
		const rel = path.relative(ROOT, file).split(path.sep).join('/');
		if (GLTF_ALLOWED.has(rel)) continue;
		for (const line of gltfHitsIn(fs.readFileSync(file, 'utf8'))) unchecked.push(`${rel}:${line}`);
	}
	if (bad.length) {
		console.log('check-loaders: three generic loader calls outside src/lib/loadGuard.js (use parseCheckedObject / parseCheckedMaterials):');
		for (const b of bad) console.log('  ' + b);
	}
	if (unchecked.length) {
		console.log(`check-loaders: glTF parses with no checkGltf( in the ${GLTF_WINDOW} lines before them:`);
		for (const b of unchecked) console.log('  ' + b);
	}
	if (bad.length || unchecked.length) process.exit(1);
	console.log('check-loaders — clean (every generic loader call goes through src/lib/loadGuard.js, every glTF parse is checked)');
}

if (require.main === module) main();
module.exports = { hitsIn, gltfHitsIn };
