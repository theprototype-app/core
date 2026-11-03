#!/usr/bin/env node
// @ts-nocheck -- a node CLI over JSON the build writes; svelte-check has no node types here
// 94 SP1/SP3 — WHAT A PAGE MAKES THE BROWSER FETCH BEFORE IT RUNS. For each prerendered page
// (build/index.html = the editor, build/play.html = the play entry) this walks what the page
// itself names (its modulepreload links, its inline `import("…")` boot, its stylesheets) and
// then the STATIC import closure of every one of those chunks through vite's manifest
// (.svelte-kit/output/client/.vite/manifest.json). Dynamic imports are NOT followed: a lazy
// chunk is paid when it is used, never by the boot. The total is gzip -9 bytes of JS (+ CSS on
// its own line), the number a slow phone pays before the first frame.
//
//   node scripts/boot-size.cjs                     # the table for every page in perf/boot-budget.json
//   node scripts/boot-size.cjs --check             # + the gate: exit 1 when a page is over its budget
//   node scripts/boot-size.cjs --json out.json     # the measurement as JSON (CI artifact / a baseline)
//   node scripts/boot-size.cjs --diff base.json    # + per-chunk growth against a saved measurement
//   node scripts/boot-size.cjs --page play         # one page
//
// Needs a finished `npm run build`. Exit 0 green, 1 over budget, 2 could not measure.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const MANIFEST = path.join(ROOT, '.svelte-kit/output/client/.vite/manifest.json');
const BUDGET = path.join(ROOT, 'perf/boot-budget.json');

function arg(name) {
	const i = process.argv.indexOf(name);
	return i < 0 ? null : process.argv[i + 1] ?? '';
}
const has = (name) => process.argv.includes(name);

/** the chunk files (relative to build/, e.g. `_app/immutable/chunks/x.js`) a page names itself */
function pageRoots(html) {
	const js = new Set();
	const css = new Set();
	for (const m of html.matchAll(/<link\b[^>]*>/g)) {
		const tag = m[0];
		const href = /href="([^"]+)"/.exec(tag)?.[1];
		if (!href) continue;
		if (/rel="modulepreload"/.test(tag)) js.add(norm(href));
		else if (/rel="stylesheet"/.test(tag) && href.includes('_app/')) css.add(norm(href));
	}
	for (const m of html.matchAll(/import\("([^"]+\.js)"\)/g)) js.add(norm(m[1]));
	return { js, css };
}
function norm(href) {
	return href.replace(/^(\.\/|\/)+/, '').replace(/^(\.\.\/)+/, '');
}

/** file -> manifest record, plus the client output dir the files live in */
function loadManifest() {
	const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
	const byFile = new Map();
	for (const [key, rec] of Object.entries(m)) byFile.set(rec.file, { key, ...rec });
	return { m, byFile };
}

/** the static closure of `roots` through the manifest: JS files + the CSS they pull in */
function closure(roots, { m, byFile }) {
	const js = new Set();
	const css = new Set(roots.css);
	const stack = [...roots.js];
	while (stack.length) {
		const f = stack.pop();
		if (js.has(f)) continue;
		js.add(f);
		const rec = byFile.get(f);
		if (!rec) continue;
		for (const c of rec.css ?? []) css.add(c);
		for (const k of rec.imports ?? []) {
			const dep = m[k];
			if (dep && !js.has(dep.file)) stack.push(dep.file);
		}
	}
	return { js, css };
}

const gzCache = new Map();
function gz(file) {
	if (gzCache.has(file)) return gzCache.get(file);
	const p = path.join(BUILD, file);
	let out = { raw: 0, gz: 0, missing: true };
	if (fs.existsSync(p)) {
		const buf = fs.readFileSync(p);
		out = { raw: buf.length, gz: zlib.gzipSync(buf, { level: 9 }).length, missing: false };
	}
	gzCache.set(file, out);
	return out;
}

/** a readable name for a chunk: its manifest source key when it has one */
function label(file, byFile) {
	const rec = byFile.get(file);
	const key = rec?.key ?? '';
	if (rec?.name && key.startsWith('_')) return `${file} (${rec.name})`;
	return key && !key.startsWith('_') ? `${file} (${key.replace(/^.*node_modules\//, '')})` : file;
}

/** a chunk's name that survives a rebuild (file names are content hashes): its manifest name for a
 * shared chunk, its source key for an entry, else the file */
function stableName(file, byFile) {
	const rec = byFile.get(file);
	const key = rec?.key ?? '';
	if (rec?.name && key.startsWith('_')) return rec.name;
	return key && !key.startsWith('_') ? key.replace(/^.*node_modules\//, '') : file;
}

function measurePage(htmlFile, man) {
	const p = path.join(BUILD, htmlFile);
	if (!fs.existsSync(p)) return null;
	const roots = pageRoots(fs.readFileSync(p, 'utf8'));
	const { js, css } = closure(roots, man);
	const chunks = {};
	const names = {};
	let jsGz = 0;
	let jsRaw = 0;
	let cssGz = 0;
	const missing = [];
	for (const f of js) {
		const s = gz(f);
		if (s.missing) missing.push(f);
		chunks[f] = s.gz;
		names[f] = stableName(f, man.byFile);
		jsGz += s.gz;
		jsRaw += s.raw;
	}
	for (const f of css) {
		const s = gz(f);
		if (s.missing) missing.push(f);
		cssGz += s.gz;
	}
	return { html: htmlFile, jsChunks: js.size, jsGz, jsRaw, cssGz, chunks, names, missing };
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';

/** raw generated bytes per source path across `files`, or null when the build has no sourcemaps */
function sourcesOf(files) {
	let SourceMapConsumer;
	try {
		({ SourceMapConsumer } = require('source-map-js'));
	} catch {
		return null;
	}
	const per = new Map();
	let any = false;
	for (const f of files) {
		const mapFile = path.join(BUILD, f + '.map');
		if (!fs.existsSync(mapFile)) continue;
		any = true;
		const code = fs.readFileSync(path.join(BUILD, f), 'utf8');
		const lines = code.split('\n');
		const c = new SourceMapConsumer(JSON.parse(fs.readFileSync(mapFile, 'utf8')));
		let last = null;
		c.eachMapping((m) => {
			if (last) {
				const len = m.generatedLine === last.line ? m.generatedColumn - last.col : lines[last.line - 1].length - last.col;
				const key = (last.src || '(generated)').replace(/^(\.\.\/)+/, '').replace(/^.*node_modules\//, 'npm:');
				per.set(key, (per.get(key) ?? 0) + Math.max(0, len));
			}
			last = { line: m.generatedLine, col: m.generatedColumn, src: m.source };
		});
	}
	return any ? per : null;
}

function main() {
	if (!fs.existsSync(MANIFEST) || !fs.existsSync(BUILD)) {
		console.error('boot-size: no build — run `npm run build` first');
		process.exit(2);
	}
	const budget = JSON.parse(fs.readFileSync(BUDGET, 'utf8'));
	const only = arg('--page');
	const man = loadManifest();
	const result = { version: 1, pages: {} };
	let red = false;
	const lines = ['| page | html | JS chunks | initial JS gz | budget | CSS gz | verdict |', '|---|---|---:|---:|---:|---:|---|'];
	for (const [name, page] of Object.entries(budget.pages)) {
		if (only && only !== name) continue;
		const r = measurePage(page.html, man);
		if (!r) {
			console.error(`boot-size: ${page.html} is missing from build/ (page "${name}")`);
			process.exit(2);
		}
		if (r.missing.length) {
			console.error(`boot-size: ${name} names ${r.missing.length} file(s) that are not in build/: ${r.missing.slice(0, 3).join(', ')}`);
			process.exit(2);
		}
		result.pages[name] = r;
		const over = r.jsGz > page.maxJsGzBytes;
		red ||= over;
		lines.push(
			`| ${name} | ${page.html} | ${r.jsChunks} | ${kb(r.jsGz)} | ${kb(page.maxJsGzBytes)} | ${kb(r.cssGz)} | ${over ? `**OVER by ${kb(r.jsGz - page.maxJsGzBytes)}**` : 'ok'} |`
		);
	}
	const out = [lines.join('\n')];

	// the biggest chunks of each page, so a red says WHAT grew without a second tool
	for (const [name, r] of Object.entries(result.pages)) {
		const top = Object.entries(r.chunks)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([f, n]) => `  ${kb(n).padStart(9)}  ${label(f, man.byFile)}`);
		out.push(`\n${name} — largest initial chunks:\n${top.join('\n')}`);
	}

	// `--sources <page>` (needs `TP_SOURCEMAP=1 npm run build`): the page's boot bytes per SOURCE
	// module, through each chunk's sourcemap — raw bytes of generated code, gzip is not per-module
	const srcPage = arg('--sources');
	if (srcPage && result.pages[srcPage]) {
		const per = sourcesOf(Object.keys(result.pages[srcPage].chunks));
		if (!per) out.push('\n--sources: no .map files — build with TP_SOURCEMAP=1');
		else {
			const n = Number(arg('--top') || 60);
			const rows = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
			out.push(`\n${srcPage} — boot bytes by source (raw, top ${n}):\n` + rows.map(([k, v]) => `  ${kb(v).padStart(9)}  ${k}`).join('\n'));
		}
	}

	const diffFile = arg('--diff');
	if (diffFile) {
		const base = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
		for (const [name, r] of Object.entries(result.pages)) {
			const b = base.pages?.[name];
			if (!b) continue;
			const delta = r.jsGz - b.jsGz;
			// file names are content hashes, so compare by the stable name each JSON carries (`names`)
			const before = new Map();
			for (const [f, n] of Object.entries(b.chunks)) {
				const k = b.names?.[f] ?? f;
				before.set(k, (before.get(k) ?? 0) + n);
			}
			const after = new Map();
			for (const [f, n] of Object.entries(r.chunks)) {
				const k = r.names?.[f] ?? stableName(f, man.byFile);
				after.set(k, (after.get(k) ?? 0) + n);
			}
			const rows = [];
			for (const k of new Set([...before.keys(), ...after.keys()])) {
				const d = (after.get(k) ?? 0) - (before.get(k) ?? 0);
				if (Math.abs(d) >= 1024) rows.push([d, k]);
			}
			rows.sort((x, y) => Math.abs(y[0]) - Math.abs(x[0]));
			out.push(
				`\n${name} vs ${path.basename(diffFile)}: ${delta >= 0 ? '+' : ''}${kb(delta)}` +
					(rows.length ? '\n' + rows.slice(0, 15).map(([d, k]) => `  ${(d >= 0 ? '+' : '') + kb(d)}  ${k}`).join('\n') : '')
			);
		}
	}

	console.log(out.join('\n'));
	const jsonOut = arg('--json');
	if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 1));
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Boot size\n\n' + out.join('\n').replace(/\n {2}/g, '\n    ') + '\n');
	if (has('--check') && red) {
		console.error('\nboot-size: OVER BUDGET (perf/boot-budget.json). Make the new code a lazy chunk, or raise the line in the same PR with a reason.');
		process.exit(1);
	}
}

if (require.main === module) main();
module.exports = { pageRoots, closure, norm, sourcesOf, measurePage, loadManifest };
