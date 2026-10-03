#!/usr/bin/env node
// 34 R1 — THE MODULE VERSIONS THIS BUILD SHIPS WITH. Writes `src/lib/moduleVersions.json`
// ({generated, source, modules: {id: version}}) from the modules repo's `index.json`, so the
// app can tell a player whose installed module is OLDER than the one it was released with
// (the stale-module warning: a Quest kept Waves 2.1.0 across two previews and its old bug
// read as a regression — CLAUDE.md "AN INSTALLED USER MODULE NEVER UPDATES ITSELF").
//
// Run it at release time (the integrator), after the modules for this core are merged:
//   node scripts/module-versions.cjs                      # ../modules, git origin/dev:index.json
//   node scripts/module-versions.cjs --ref origin/main    # another ref of ../modules
//   node scripts/module-versions.cjs --from path/or/https://url/index.json
//   node scripts/module-versions.cjs --check              # exit 1 when the file would change
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'src', 'lib', 'moduleVersions.json');
const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : null;
};

async function readIndex() {
	const from = opt('--from');
	if (from && /^https?:/.test(from)) {
		const res = await fetch(from);
		if (!res.ok) throw new Error(`${from}: HTTP ${res.status}`);
		return { source: from, text: await res.text() };
	}
	if (from) return { source: from, text: fs.readFileSync(from, 'utf8') };
	const repo = process.env.MODULES_REPO || path.join(__dirname, '..', '..', 'modules');
	const ref = opt('--ref') || 'origin/dev';
	const text = execFileSync('git', ['-C', repo, 'show', `${ref}:index.json`], { encoding: 'utf8' });
	const sha = execFileSync('git', ['-C', repo, 'rev-parse', '--short', ref], { encoding: 'utf8' }).trim();
	return { source: `modules@${sha} (${ref})`, text };
}

(async () => {
	const { source, text } = await readIndex();
	const list = JSON.parse(text);
	if (!Array.isArray(list)) throw new Error('index.json is not a list');
	/** @type {Record<string, string>} */
	const modules = {};
	for (const e of list) if (e && e.id && e.version) modules[String(e.id)] = String(e.version);
	const sorted = Object.fromEntries(Object.entries(modules).sort(([a], [b]) => a.localeCompare(b)));
	const before = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
	if (args.includes('--check')) {
		const same = before && JSON.stringify(before.modules) === JSON.stringify(sorted);
		console.log(same ? 'moduleVersions.json is current' : 'moduleVersions.json differs from ' + source);
		process.exit(same ? 0 : 1);
	}
	const doc = { generated: new Date().toISOString().slice(0, 10), source, modules: sorted };
	fs.writeFileSync(OUT, JSON.stringify(doc, null, '\t') + '\n');
	console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${Object.keys(sorted).length} modules from ${source}`);
})().catch((e) => {
	console.error('module-versions: ' + e.message);
	process.exit(1);
});
