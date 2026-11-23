#!/usr/bin/env node
// 36-export (E1) — THE LIST OF FILES AN EXPORTED GAME IS MADE OF.
//
// The in-app exporter builds an itch.io / static-host zip IN THE BROWSER, from the very build
// the browser is running: the engine runtime is this deployment's own `_app/` chunks plus the
// static files the runtime fetches (draco/basis decoders, fonts, icons). A browser cannot list a
// server's folder, so the build writes the list: `build/export-manifest.json`. `postbuild` runs
// it after every `npm run build` (the cloud deploy's build-site runs exactly that).
//
// Excluded on purpose: everything that only makes sense on theprototype.app itself — the
// service worker and the web-app manifest (exports ship no SW), the update poll's version.json,
// the LLM docs, the plugin example, 404.html, and this file. index.html IS listed: the exporter
// rewrites it (adds ./play.js, the game's title) rather than writing one of its own.
//
// fix-export-files — THE FILE BUDGET. itch.io refuses a zip of more than 1,000 files
// (src/lib/export/exportValidate.js ITCH_LIMITS) and an export is this list plus the game's own
// files (scene, play.js, README, thumbnail, sky, every pack file it places — ~70 for the biggest
// official template). 1.74.0 listed 1,056 and every export failed its own check, found only by a
// suite. So the BUILD fails above MAX_RUNTIME_FILES, leaving that headroom for the game; the fix
// for a red is fewer files (scripts/boot-chunk-groups.cjs is where the chunk count is decided),
// never a higher number.
//
//   node scripts/export-manifest.cjs [buildDir]     (default ./build)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/** the most runtime files a build may list — 1,000 (itch.io) minus room for the game's own files */
const MAX_RUNTIME_FILES = 850;
const BUILD = path.resolve(process.argv[2] || path.join(ROOT, 'build'));

/** paths (relative, forward slashes) an export never carries @param {string} rel */
function excluded(rel) {
	return (
		rel === 'export-manifest.json' ||
		rel === 'sw.js' ||
		rel === 'manifest.webmanifest' ||
		rel === 'version.json' ||
		rel === '404.html' ||
		// 69 T3: the hosted build's response headers — an export's host has its own
		rel === '_headers' ||
		/^llms(-full)?\.txt$/.test(rel) ||
		/^cloud-plugin.*\.js$/.test(rel) ||
		rel.startsWith('templates/') ||
		// 37-hdri: buildExport copies only the sky the scene shows (59 T3: from the CDN — the .hdr
		// files left the bundle; the preview cards stay excluded here as before)
		rel.startsWith('hdri/') ||
		rel.startsWith('.')
	);
}

/**
 * 63 PG1 — WHAT ONLY THE EDITOR REACHES. An exported game boots the play entry (94 SP1,
 * play.html → src/routes/play), so the chunks no import chain from it can reach — the editor's
 * page node and the UI kit page's, and whatever only they import, statically or lazily — never
 * run in a game. Read from Vite's client manifest: the closure (imports + dynamicImports) of the
 * kit client + layout + error + play nodes, against the closure of every entry. app.js's own
 * dynamic imports are its route table (one per page node) and are not followed. Returns the
 * build-relative paths to mark `editorOnly`; an empty set when the manifest or the play node is
 * missing (then nothing is marked and an export carries everything, as before).
 * @param {string} root the repo (holds .svelte-kit/) @returns {Set<string>}
 */
function editorOnlyFiles(root = ROOT) {
	const out = new Set();
	const gen = path.join(root, '.svelte-kit/generated/build/client-optimized');
	const vm = path.join(root, '.svelte-kit/output/client/.vite/manifest.json');
	if (!fs.existsSync(vm) || !fs.existsSync(path.join(gen, 'nodes'))) return out;
	/** @type {Record<string, {file: string, isEntry?: boolean, imports?: string[], dynamicImports?: string[], css?: string[], assets?: string[]}>} */
	const m = JSON.parse(fs.readFileSync(vm, 'utf8'));
	const genKey = (/** @type {string} */ rel) => '.svelte-kit/generated/build/client-optimized/' + rel;
	const app = genKey('app.js');
	/** @type {string[]} */
	const playNodes = [];
	for (const name of fs.readdirSync(path.join(gen, 'nodes'))) {
		const src = fs.readFileSync(path.join(gen, 'nodes', name), 'utf8');
		// the layout + error nodes (no route page) and the play route's page node
		if (!/src\/routes\/[^"']*\+page\.svelte/.test(src) || /src\/routes\/play\/\+page\.svelte/.test(src)) playNodes.push(genKey('nodes/' + name));
	}
	if (!playNodes.some((k) => /src\/routes\/play\//.test(fs.readFileSync(path.join(root, k), 'utf8')))) return out;
	/** @param {string[]} starts */
	const closure = (starts) => {
		const seen = new Set();
		const stack = [...starts];
		while (stack.length) {
			const k = /** @type {string} */ (stack.pop());
			if (seen.has(k) || !m[k]) continue;
			seen.add(k);
			for (const i of m[k].imports || []) stack.push(i);
			if (k !== app) for (const i of m[k].dynamicImports || []) stack.push(i);
		}
		return seen;
	};
	/** @param {Set<string>} keys */
	const filesOf = (keys) => {
		const f = new Set();
		for (const k of keys) for (const p of [m[k].file, ...(m[k].css || []), ...(m[k].assets || [])]) if (p) f.add(p);
		return f;
	};
	const entries = Object.keys(m).filter((k) => m[k].isEntry && !/client-optimized\/nodes\//.test(k));
	const play = filesOf(closure([...entries, ...playNodes]));
	const every = filesOf(new Set(Object.keys(m)));
	for (const f of every) if (!play.has(f)) out.add(f);
	return out;
}

/** @param {string} dir @param {string} prefix @param {{path: string, bytes: number}[]} out */
function walk(dir, prefix, out) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? prefix + '/' + entry.name : entry.name;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(abs, rel, out);
		else if (entry.isFile() && !excluded(rel)) out.push({ path: rel, bytes: fs.statSync(abs).size });
	}
	return out;
}

function main() {
	if (!fs.existsSync(path.join(BUILD, 'index.html'))) {
		console.error('export-manifest: no build at ' + BUILD + ' (run vite build first)');
		process.exit(1);
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	/** @type {{path: string, bytes: number, editorOnly?: boolean}[]} */
	const files = walk(BUILD, '', []).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const editorOnly = editorOnlyFiles();
	for (const f of files) if (editorOnly.has(f.path)) f.editorOnly = true;
	const bytes = files.reduce((n, f) => n + f.bytes, 0);
	const manifest = { format: 1, version: String(pkg.version), files, bytes };
	fs.writeFileSync(path.join(BUILD, 'export-manifest.json'), JSON.stringify(manifest));
	const cut = files.filter((f) => f.editorOnly);
	console.log(`export-manifest: ${files.length} files (budget ${MAX_RUNTIME_FILES}), ${(bytes / 1048576).toFixed(1)} MB -> ${path.relative(ROOT, BUILD)}/export-manifest.json`);
	console.log(`export-manifest: ${cut.length} files (${(cut.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(1)} MB) only the editor / kit page reach — an exported game leaves them out`);
	const over = overBudget(files);
	if (over) {
		console.error('export-manifest: ' + over);
		process.exit(1);
	}
}

/** null when the list fits, else the reason (with the biggest folders, so the red says where) @param {{path: string}[]} files */
function overBudget(files, max = MAX_RUNTIME_FILES) {
	if (files.length <= max) return null;
	/** @type {Map<string, number>} */
	const by = new Map();
	for (const f of files) {
		const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
		by.set(dir, (by.get(dir) || 0) + 1);
	}
	const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([d, n]) => `${d} ${n}`).join(', ');
	return `${files.length} files is over the export budget of ${max} — an exported game would pass itch.io's 1,000-file limit (biggest folders: ${top}). Cut files (scripts/boot-chunk-groups.cjs decides the chunk count); do not raise the budget.`;
}

if (require.main === module) main();

module.exports = { MAX_RUNTIME_FILES, overBudget, excluded, editorOnlyFiles };
