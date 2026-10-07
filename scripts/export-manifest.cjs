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
//   node scripts/export-manifest.cjs [buildDir]     (default ./build)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.resolve(process.argv[2] || path.join(ROOT, 'build'));

/** paths (relative, forward slashes) an export never carries @param {string} rel */
function excluded(rel) {
	return (
		rel === 'export-manifest.json' ||
		rel === 'sw.js' ||
		rel === 'manifest.webmanifest' ||
		rel === 'version.json' ||
		rel === '404.html' ||
		/^llms(-full)?\.txt$/.test(rel) ||
		/^cloud-plugin.*\.js$/.test(rel) ||
		rel.startsWith('templates/') ||
		// 37-hdri: ~7.5 MB of bundled HDRIs — buildExport copies only the one the scene shows
		rel.startsWith('hdri/') ||
		rel.startsWith('.')
	);
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
	const files = walk(BUILD, '', []).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const bytes = files.reduce((n, f) => n + f.bytes, 0);
	const manifest = { format: 1, version: String(pkg.version), files, bytes };
	fs.writeFileSync(path.join(BUILD, 'export-manifest.json'), JSON.stringify(manifest));
	console.log(`export-manifest: ${files.length} files, ${(bytes / 1048576).toFixed(1)} MB -> ${path.relative(ROOT, BUILD)}/export-manifest.json`);
}

main();
