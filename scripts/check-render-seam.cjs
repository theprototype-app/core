#!/usr/bin/env node
// 101 F3: every renderer and render target the app makes comes from the renderer seam
// (src/lib/render/). A `new WebGLRenderer` / `new WebGLRenderTarget(` anywhere else in src/ fails.
// Use createMainRenderer / createRenderTarget / renderOffscreen / acquireOffscreen instead.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const SEAM = path.join(ROOT, 'lib', 'render') + path.sep;
const PATTERN = /new (THREE\.)?WebGLRenderer\b|new (THREE\.)?WebGLRenderTarget\(/;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
	/** @type {string[]} */
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else if (/\.(js|ts|svelte|mjs|cjs)$/.test(e.name)) out.push(p);
	}
	return out;
}

/** @returns {string[]} offending `file:line: text` rows */
function scan() {
	/** @type {string[]} */
	const bad = [];
	for (const file of walk(ROOT)) {
		if (file.startsWith(SEAM)) continue;
		fs.readFileSync(file, 'utf8')
			.split('\n')
			.forEach((line, i) => {
				if (PATTERN.test(line)) bad.push(`${path.relative(path.join(ROOT, '..'), file)}:${i + 1}: ${line.trim()}`);
			});
	}
	return bad;
}

if (require.main === module) {
	const bad = scan();
	if (bad.length) {
		console.error(`renderer seam: ${bad.length} renderer / render target(s) made outside src/lib/render/:\n  ${bad.join('\n  ')}`);
		console.error('Use createMainRenderer / createRenderTarget / renderOffscreen / acquireOffscreen (src/lib/render/).');
		process.exit(1);
	}
	console.log('renderer seam: every renderer and render target comes from src/lib/render/');
}
module.exports = { scan, PATTERN };
