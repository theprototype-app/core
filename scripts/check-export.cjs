#!/usr/bin/env node
// 36-export (E1) — CHECK AN EXPORTED GAME: structure, relative paths, the itch.io limits.
//
//   node scripts/check-export.cjs <game.zip | unzipped-folder> [--preset itch|static] [--json]
//
// The rules are src/lib/export/exportValidate.js — the SAME function the in-app exporter runs
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
		console.error('usage: node scripts/check-export.cjs <game.zip | folder> [--preset itch|static] [--json]');
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
	const report = lib.validateExport(files, { preset: preset || undefined });
	if (asJson) {
		console.log(JSON.stringify({ ...report, config: report.config }, null, 2));
	} else {
		const L = lib.ITCH_LIMITS;
		console.log(`check-export: ${path.relative(process.cwd(), abs) || abs}`);
		console.log(`  files    ${report.stats.files} / ${L.maxFiles} (itch.io)   runtime files ${report.stats.runtimeFiles}`);
		console.log(`  size     ${mb(report.stats.bytes)} extracted / ${L.maxTotalBytes / 1048576} MB`);
		if (report.stats.largest) console.log(`  largest  ${report.stats.largest.path} ${mb(report.stats.largest.bytes)} / ${L.maxFileBytes / 1048576} MB`);
		if (report.config) console.log(`  config   id=${report.config.id} preset=${report.config.preset} scene=${report.config.scene} packs=${report.config.packsBase || '(none/CDN)'} modules=${(report.config.modules || []).length}`);
		for (const e of report.errors) console.log('  ERROR    ' + e);
		for (const w of report.warnings) console.log('  warning  ' + w);
		console.log(report.ok ? '  OK' : `  FAILED (${report.errors.length} error${report.errors.length === 1 ? '' : 's'})`);
	}
	process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
