import { describe, it, expect } from 'vitest';
import { EXPORT_RULES, PRESET_LIMITS, CRAZYGAMES_LIMITS, initialDownloadBytes, biggestAssets, ASSET_ROWS } from '../../src/lib/export/exportChecks.js';
import { runChecks, summarize } from '../../src/lib/export/checkCore.js';
import { ITCH_LIMITS } from '../../src/lib/export/exportValidate.js';
import { EXPORT_ALLOWED_HOSTS } from '../../src/lib/export/exportCore.js';

// 63 (63-export): the export preset checks as checkCore rows — the itch.io / CrazyGames limits, the
// two stages (plan before anything is fetched, built before the zip), what blocks a download.

const MB = 1024 * 1024;
const PLAY = 'window.__TP_EXPORT__ = {"version":1,"id":"x1","title":"T","scene":"scene.tpscene","packsBase":"","modules":[],"preset":"itch","builtWith":"1"};\n';
/** a minimal well-formed export @param {{path: string, bytes: number}[]} [extra] */
function game(extra = []) {
	return [
		{ path: 'index.html', bytes: 900, text: '<html><head><meta charset="utf-8"><script src="./play.js"></script></head><body></body></html>' },
		{ path: 'play.js', bytes: PLAY.length, text: PLAY },
		{ path: 'scene.tpscene', bytes: 2 * MB },
		{ path: '_app/immutable/entry/start.js', bytes: 1000, text: 'export {}' },
		...extra
	];
}
const ids = (/** @type {any[]} */ rows) => rows.map((r) => r.id + ':' + r.severity);

describe('the portal limits', () => {
	it('itch.io: 1,000 files, 500 MB, 200 MB per file, 240-character paths (read 2026-11-23)', () => {
		expect(ITCH_LIMITS).toEqual({ maxFiles: 1000, maxTotalBytes: 500 * MB, maxFileBytes: 200 * MB, maxPathLength: 240 });
		expect(PRESET_LIMITS.itch).toBe(ITCH_LIMITS);
	});
	it('CrazyGames: 1,500 files, 250 MB total, 50 MB initial, 20 MB for the mobile homepage', () => {
		expect(CRAZYGAMES_LIMITS).toMatchObject({ maxFiles: 1500, maxTotalBytes: 250 * MB, maxInitialBytes: 50 * MB, mobileInitialBytes: 20 * MB });
		expect(PRESET_LIMITS.crazygames).toBe(CRAZYGAMES_LIMITS);
	});
	it('an itch.io / static export may call NO outside host; CrazyGames only its SDK host', () => {
		expect(EXPORT_ALLOWED_HOSTS.itch).toEqual([]);
		expect(EXPORT_ALLOWED_HOSTS.static).toEqual([]);
		expect(EXPORT_ALLOWED_HOSTS.crazygames).toEqual(['sdk.crazygames.com']);
	});
});

describe('EXPORT_RULES', () => {
	it('a small well-formed game passes every target with no rows', async () => {
		for (const target of ['itch', 'static', 'crazygames']) {
			const rows = await runChecks(EXPORT_RULES, { target, stage: 'built', files: game(target === 'static' ? [{ path: '.nojekyll', bytes: 0 }] : []) });
			expect(rows.filter((r) => r.severity !== 'info'), target).toEqual([]);
		}
	});
	it('the plan stage refuses on the file count before anything is fetched (structure waits for the build)', async () => {
		const many = Array.from({ length: 1001 }, (_, i) => ({ path: `_app/c${i}.js`, bytes: 0 }));
		const rows = await runChecks(EXPORT_RULES, { target: 'itch', stage: 'plan', files: many });
		expect(ids(rows)).toEqual(['export-file-count:error']);
		expect(rows[0].title).toMatch(/1,001 files — itch\.io takes at most 1,000/);
		expect(summarize(rows, 'itch').blocking).toBe(1);
		// the same list fits CrazyGames' 1,500 (a warning only past 90 %)
		expect(ids(await runChecks(EXPORT_RULES, { target: 'crazygames', stage: 'plan', files: many }))).toEqual([]);
		const near = Array.from({ length: 1400 }, (_, i) => ({ path: `_app/c${i}.js`, bytes: 0 }));
		expect(ids(await runChecks(EXPORT_RULES, { target: 'crazygames', stage: 'plan', files: near }))).toEqual(['export-file-count:warn']);
	});
	it('the structure rule names what is wrong with the zip (built stage)', async () => {
		const files = game().filter((f) => f.path !== 'play.js');
		const rows = await runChecks(EXPORT_RULES, { target: 'itch', stage: 'built', files });
		expect(rows.some((r) => r.id === 'export-structure' && r.severity === 'error' && /play\.js/.test(r.detail || ''))).toBe(true);
	});
	it('a path over 240 characters and a file over the per-file limit are errors naming the file', async () => {
		const long = 'assets/packs/' + 'x'.repeat(240) + '.glb';
		const rows = await runChecks(EXPORT_RULES, { target: 'itch', stage: 'built', files: game([{ path: long, bytes: 1 }, { path: 'assets/big.glb', bytes: 201 * MB }]) });
		expect(rows.find((r) => r.id === 'export-path-length')?.file).toBe(long);
		expect(rows.find((r) => r.id === 'export-size-file')?.file).toBe('assets/big.glb');
	});
	it('total size: a warning above 80 %, an error over the limit, both listing the biggest assets', async () => {
		const assets = [
			{ path: 'scene.tpscene ▸ Castle', bytes: 300 * MB, label: 'Castle', kind: 'object', where: 'u-castle' },
			{ path: 'assets/packs/a.glb', bytes: 2 * MB, label: 'Tree', kind: 'pack', where: 'u-tree' }
		];
		const warn = await runChecks(EXPORT_RULES, { target: 'itch', stage: 'built', files: game([{ path: 'assets/x.bin', bytes: 140 * MB }, { path: 'assets/y.bin', bytes: 140 * MB }, { path: 'assets/z.bin', bytes: 140 * MB }]), assets });
		expect(ids(warn)).toEqual(['export-size-total:warn']);
		const err = await runChecks(EXPORT_RULES, { target: 'itch', stage: 'built', files: game([{ path: 'assets/x.bin', bytes: 199 * MB }, { path: 'assets/y.bin', bytes: 199 * MB }, { path: 'assets/z.bin', bytes: 199 * MB }]), assets });
		const row = err.find((r) => r.id === 'export-size-total');
		expect(row?.severity).toBe('error');
		expect(row?.items?.[0]).toMatchObject({ bytes: 300 * MB, where: 'u-castle' });
	});
	it('CrazyGames initial download: refused over 50 MB with the list, warned above 80 %, a note above 20 MB', async () => {
		const assets = [{ path: 'scene.tpscene ▸ Statue', bytes: 60 * MB, label: 'Statue', kind: 'object', where: 'u-statue' }];
		const at = async (/** @type {number} */ mb) => runChecks(EXPORT_RULES, { target: 'crazygames', stage: 'built', files: game([{ path: 'assets/a.png', bytes: mb * MB }]), assets });
		const refused = await at(60);
		expect(ids(refused)).toEqual(['export-initial-download:error']);
		expect(refused[0].items?.[0]).toMatchObject({ where: 'u-statue', bytes: 60 * MB });
		expect(summarize(refused, 'crazygames').blocking).toBe(1);
		expect(ids(await at(42))).toEqual(['export-initial-download:warn']);
		expect(ids(await at(25))).toEqual(['export-initial-mobile:info']);
		expect(ids(await at(5))).toEqual([]);
		// itch has no initial-download rule: the same 60 MB passes there
		expect((await runChecks(EXPORT_RULES, { target: 'itch', stage: 'built', files: game([{ path: 'assets/a.png', bytes: 60 * MB }]) })).length).toBe(0);
	});
	it('the internet opt-ins are warnings (never block)', async () => {
		const rows = await runChecks(EXPORT_RULES, { target: 'itch', stage: 'built', files: game(), cdnPacks: true, absoluteModels: 2 });
		expect(ids(rows)).toEqual(['export-absolute-models:warn', 'export-needs-internet:warn']);
		expect(summarize(rows, 'itch').blocking).toBe(0);
	});
});

describe('initialDownloadBytes / biggestAssets', () => {
	it('text at a third, the readme / credits / cover / LOD files not at all, only the sky size the game starts on', () => {
		const files = [
			{ path: '_app/a.js', bytes: 1000 },
			{ path: 'scene.tpscene', bytes: 500 },
			{ path: 'README.txt', bytes: 9999 },
			{ path: 'thumbnail.png', bytes: 9999 },
			{ path: 'hdri/meadow_2k.jpg', bytes: 100 },
			{ path: 'hdri/meadow_8k.jpg', bytes: 4000 },
			{ path: 'assets/packs/kit/Tree/glTF-Binary/tree.lod1.glb', bytes: 7777 }
		];
		expect(initialDownloadBytes(files, { skyFiles: ['hdri/meadow_2k.jpg', 'hdri/meadow_8k.jpg'], skyStart: 'hdri/meadow_2k.jpg' })).toBe(320 + 500 + 100);
	});
	it('the size list: biggest first, ties by path, 15 rows', () => {
		const assets = Array.from({ length: 20 }, (_, i) => ({ path: 'p' + String(i).padStart(2, '0'), bytes: i % 3, label: 'L', kind: /** @type {const} */ ('pack') }));
		const top = biggestAssets(assets);
		expect(top.length).toBe(ASSET_ROWS);
		expect(top[0]).toMatchObject({ bytes: 2, path: 'p02' });
		expect(top.map((a) => a.bytes)).toEqual([...top.map((a) => a.bytes)].sort((a, b) => b - a));
	});
});
