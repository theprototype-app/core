#!/usr/bin/env node
// "FILES FROM THE WILD" — fetch the import-wild fixtures into a cache, never into the repo.
//
//   node scripts/fetch-wild-assets.cjs [--cache <dir>] [--only <id,id>] [--offline] [--check]
//
// The fixtures are AI-generated models from the Scenario 3D Collection (CC BY 4.0, "Scenario" —
// tests/fixtures/wild/ATTRIBUTION.md). They are NOT committed: tests/fixtures/wild/manifest.json
// names each one (dataset path + sha256 + Hugging Face URL + why it is in the set) and this script
// puts the bytes in the cache (default ~/.cache/tp-wild/assets: three levels under HOME, so an e2e-slot pc run
// mirrors it when E2E_PC_INPUTS names it; or $WILD_ASSETS_DIR), keeping the
// dataset's own relative paths. A local copy of the dataset is used first (hard link, else copy:
// ~/.local/share/datasets/scenario-3d-collection/repo or $WILD_DATASET_DIR); otherwise the file is
// downloaded from Hugging Face. Every file is checked against its sha256 — a mismatch is deleted.
// --offline never downloads; --check only reports what the cache holds.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'tests', 'fixtures', 'wild', 'manifest.json');
const HF = 'https://huggingface.co/datasets/scenario-labs/3d-collection/resolve/main/';

/** where the fixtures live (the suite reads the same answer) */
function cacheDir() {
	return process.env.WILD_ASSETS_DIR || path.join(os.homedir(), '.cache', 'tp-wild', 'assets');
}
/** a local dataset checkout, if there is one */
function datasetDir() {
	const cands = [process.env.WILD_DATASET_DIR, path.join(os.homedir(), '.local', 'share', 'datasets', 'scenario-3d-collection', 'repo')];
	return cands.find((d) => d && fs.existsSync(path.join(d, 'assets'))) ?? null;
}
/** @returns {{fixtures: any[], pairs?: any[]}} */
function readManifest() {
	return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}
/** @param {string} file */
function sha256(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
/** every file the manifest names (fixtures, then the replace pairs' sides), once each */
function wanted() {
	const m = readManifest();
	/** @type {Map<string, {path: string, sha256: string, url: string}>} */
	const out = new Map();
	for (const f of m.fixtures ?? []) out.set(f.path, f);
	for (const p of m.pairs ?? []) for (const side of [p.a, p.b]) if (side?.path) out.set(side.path, side);
	return [...out.values()];
}
/** is this fixture in the cache with the right bytes? @param {{path: string, sha256: string}} f @param {string} dir */
function cached(f, dir) {
	const file = path.join(dir, f.path);
	return fs.existsSync(file) && sha256(file) === f.sha256;
}

/** @param {string} url @param {string} to */
async function download(url, to) {
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
	const tmp = to + '.part';
	await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
	fs.renameSync(tmp, to);
}

async function main() {
	const argv = process.argv.slice(2);
	const val = (/** @type {string} */ n) => (argv.includes('--' + n) ? argv[argv.indexOf('--' + n) + 1] : null);
	const dir = val('cache') ?? cacheDir();
	const only = val('only')?.split(',') ?? null;
	const offline = argv.includes('--offline');
	const check = argv.includes('--check');
	const local = datasetDir();
	const list = wanted().filter((f) => !only || only.some((o) => f.path.includes(o)));
	let have = 0;
	let got = 0;
	const failed = [];
	for (const f of list) {
		if (cached(f, dir)) {
			have++;
			continue;
		}
		if (check) {
			failed.push(f.path + ' (not cached)');
			continue;
		}
		const to = path.join(dir, f.path);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		try {
			fs.rmSync(to, { force: true });
			const src = local ? path.join(local, f.path) : null;
			if (src && fs.existsSync(src)) {
				try {
					fs.linkSync(src, to);
				} catch {
					fs.copyFileSync(src, to);
				}
			} else if (!offline) await download(f.url || HF + f.path, to);
			else throw new Error('not in the local dataset (offline)');
			if (sha256(to) !== f.sha256) {
				fs.rmSync(to, { force: true });
				throw new Error('sha256 mismatch');
			}
			got++;
		} catch (error) {
			failed.push(f.path + ' — ' + String(/** @type {any} */ (error)?.message ?? error));
		}
	}
	console.log(`wild assets: ${have + got} of ${list.length} in ${dir} (${got} fetched now${local ? ', local dataset ' + local : ''})`);
	for (const line of failed) console.log('  missing ' + line);
	if (failed.length && !check) process.exitCode = 1;
}

if (require.main === module) void main();

module.exports = { cacheDir, datasetDir, readManifest, cached, wanted, MANIFEST };
