#!/usr/bin/env node
// 36-export (E1) — CHECK AN EXPORTED GAME: structure, relative paths, the itch.io limits.
//
//   node scripts/check-export.cjs <game.zip | unzipped-folder> [--preset itch|crazygames|static] [--json]
//
// The rules are src/lib/export/exportChecks.js (63: the preset rules, over exportValidate.js) — the SAME rules the in-app exporter runs
// before it offers the download, so a zip the app produced and a zip somebody edited by hand
// are judged alike. Prints a summary (files, size, the largest file, every error and warning)
// and exits 1 on any error. The limits and their source are in that file's header.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const TEXT_LIMIT = 4e6; // read text for index.html, play.js and runtime chunks under 4 MB

/** @param {string} rel */
function wantsText(rel) {
	return rel === 'index.html' || rel === 'play.js' || (rel.startsWith('_app/') && /\.m?js$/.test(rel));
}

/** @param {string} dir @param {string} prefix @param {{path: string, bytes: number, text?: string}[]} out */
function walk(dir, prefix, out) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? prefix + '/' + entry.name : entry.name;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(abs, rel, out);
		else if (entry.isFile()) {
			const bytes = fs.statSync(abs).size;
			out.push({ path: rel, bytes, text: wantsText(rel) && bytes < TEXT_LIMIT ? fs.readFileSync(abs, 'utf8') : undefined });
		}
	}
	return out;
}

/** @param {string} zipPath */
function readZip(zipPath) {
	const { unzipSync, strFromU8 } = require('fflate');
	const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
	/** @type {{path: string, bytes: number, text?: string}[]} */
	const out = [];
	for (const [rel, data] of Object.entries(entries)) {
		if (rel.endsWith('/')) continue;
		out.push({ path: rel, bytes: data.byteLength, text: wantsText(rel) && data.byteLength < TEXT_LIMIT ? strFromU8(data) : undefined });
	}
	return out;
}

/** @param {number} n */
function mb(n) {
	return (n / 1048576).toFixed(2) + ' MB';
}

async function main() {
	const args = process.argv.slice(2);
	const target = args.find((a) => !a.startsWith('--'));
	const presetArg = args.indexOf('--preset');
	const preset = presetArg >= 0 ? args[presetArg + 1] : '';
	const asJson = args.includes('--json');
	if (!target) {
		console.error('usage: node scripts/check-export.cjs <game.zip | folder> [--preset itch|crazygames|static] [--json]');
		process.exit(2);
	}
	const abs = path.resolve(target);
	if (!fs.existsSync(abs)) {
		console.error('check-export: no such file or folder: ' + abs);
		process.exit(2);
	}
	const files = fs.statSync(abs).isDirectory() ? walk(abs, '', []) : readZip(abs);
	/** @type {any} */
	const lib = await import(pathToFileURL(path.join(ROOT, 'src/lib/export/exportValidate.js')).href);
	/** @type {any} */
	const rules = await import(pathToFileURL(path.join(ROOT, 'src/lib/export/exportChecks.js')).href);
	/** @type {any} */
	const core = await import(pathToFileURL(path.join(ROOT, 'src/lib/export/checkCore.js')).href);
	/** @type {any} */
	const ecore = await import(pathToFileURL(path.join(ROOT, 'src/lib/export/exportCore.js')).href);
	// 63: the preset — the flag, else the one play.js names, else itch.io (the strictest file limits)
	const configured = lib.parsePlayJs(files.find((f) => f.path === 'play.js')?.text || '')?.preset;
	const preset2 = preset || (rules.PRESET_LIMITS[configured] ? configured : "itch");
	const report = lib.validateExport(files, { preset: preset2, allowHosts: ecore.EXPORT_ALLOWED_HOSTS[preset2] || [] });
	// the same rows the in-app exporter ran before it offered the download (exportChecks.js)
	const rows = await core.runChecks(rules.EXPORT_RULES, { target: preset2, stage: 'built', files });
	const sum = core.summarize(rows, preset2);
	if (asJson) {
		console.log(JSON.stringify({ ...report, target: preset2, rows, summary: sum, ok: sum.blocking === 0 }, null, 2));
	} else {
		const L = rules.PRESET_LIMITS[preset2];
		const name = preset2 === 'crazygames' ? 'CrazyGames' : preset2 === 'static' ? 'static host' : 'itch.io';
		console.log(`check-export: ${path.relative(process.cwd(), abs) || abs}   (preset ${preset2})`);
		console.log(`  files    ${report.stats.files} / ${L.maxFiles} (${name})   runtime files ${report.stats.runtimeFiles}`);
		console.log(`  size     ${mb(report.stats.bytes)} extracted / ${L.maxTotalBytes / 1048576} MB`);
		if (L.maxInitialBytes) console.log(`  initial  ~${mb(rules.initialDownloadBytes(files))} before play (upper estimate) / ${L.maxInitialBytes / 1048576} MB`);
		if (report.stats.largest) console.log(`  largest  ${report.stats.largest.path} ${mb(report.stats.largest.bytes)} / ${L.maxFileBytes / 1048576} MB`);
		if (report.config) console.log(`  config   id=${report.config.id} preset=${report.config.preset} scene=${report.config.scene} packs=${report.config.packsBase || '(none/CDN)'} modules=${(report.config.modules || []).length}`);
		for (const r of rows) console.log(`  ${r.severity === 'error' ? 'ERROR  ' : r.severity === 'warn' ? 'warning' : 'note   '}  ${r.title}${r.detail ? ' — ' + r.detail : ''}`);
		console.log(sum.blocking === 0 ? '  OK' : `  FAILED (${sum.blocking} error${sum.blocking === 1 ? '' : 's'})`);
	}
	process.exit(sum.blocking === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
