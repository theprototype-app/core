// 63 (63-export) — THE EXPORT PRESET CHECKS: the size and portal rules behind Export ▸ itch.io /
// CrazyGames / Static host, as checkCore.js rows (the same list the Publish check renders, through
// CheckList.svelte; the scene rules beside them are 63-publish's sceneChecks.js). A LEAF over three
// leaves (checkCore, exportValidate, exportCore): scripts/check-export.cjs imports this file in node and runs
// the very rules the app ran before it offered the download.
//
// TWO STAGES, one rule list. `ctx.stage`:
//   'plan'  — BEFORE anything is fetched or zipped (63 PG2: "the check runs before the zip is
//             built"): ctx.files is the PLANNED list (the runtime with its manifest sizes, the pack
//             paths the scene references, the modules, the sky) — file count and path rules can
//             already refuse, sizes that are not known yet (a pack file) count as 0;
//   'built' — every byte in hand, just before the zip: the structure check (exportValidate) and
//             the size rules on real numbers.
// An 'error' row blocks the download (checkCore.summarize: blocking = errors for an export
// target); 'warn' and 'info' never do.
//
// THE PORTAL LIMITS, each with its source and the day it was read:
//   itch.io     https://itch.io/docs/creators/html5 (read 2026-11-23, unchanged since 2026-10-04):
//               ≤ 1,000 files after extraction, ≤ 500 MB extracted, ≤ 200 MB per file, ≤ 240
//               characters per path (exportValidate.ITCH_LIMITS holds them).
//   CrazyGames  https://docs.crazygames.com/requirements/technical/ + /requirements/intro/ (read
//               2026-11-23): "initial download size ≤ 50MB" (measured up to the first gameplayStart),
//               "total file size of 250MB" with the SDK, "a file count limit on 1500 files"; the
//               mobile homepage needs an initial download ≤ 20 MB. No per-file or path limit stated
//               (the itch path rule is kept: a 240-character path is a mistake anywhere).
import { validateExport, ITCH_LIMITS } from './exportValidate.js';
import { EXPORT_ALLOWED_HOSTS } from './exportCore.js';

const MB = 1024 * 1024;

/** @typedef {import('./checkCore.js').CheckRow} CheckRow */
/** @typedef {import('./checkCore.js').CheckRule} CheckRule */
/** @typedef {import('./checkCore.js').CheckContext} CheckContext */
/**
 * One line of the size report (row 2): a file in the zip (or a part of scene.tpscene), what it
 * weighs and what uses it. `where` is the object uuid the row selects.
 * @typedef {{path: string, bytes: number, label: string, kind: 'object' | 'pack' | 'sky' | 'module' | 'scene' | 'cover' | 'asset', where?: string}} ExportAsset
 */

export const CRAZYGAMES_LIMITS = Object.freeze({
	maxFiles: 1500,
	maxTotalBytes: 250 * MB,
	maxFileBytes: 250 * MB,
	maxPathLength: 240,
	maxInitialBytes: 50 * MB,
	mobileInitialBytes: 20 * MB
});

/** @typedef {{maxFiles: number, maxTotalBytes: number, maxFileBytes: number, maxPathLength: number, maxInitialBytes?: number, mobileInitialBytes?: number}} PresetLimits */
/** @type {Readonly<Record<string, PresetLimits>>} */
export const PRESET_LIMITS = Object.freeze({
	itch: ITCH_LIMITS,
	// a static host has its own limits (Cloudflare Pages: 25 MiB per file, GitHub Pages: 100 MB); the
	// zip is held to itch.io's, which every one of them accepts
	static: ITCH_LIMITS,
	crazygames: CRAZYGAMES_LIMITS
});

/** a warning starts at this share of a limit */
export const WARN_AT = 0.8;
/** the size list shows this many rows */
export const ASSET_ROWS = 15;

/** @param {number} n */
export function fmtMB(n) {
	return (n / MB).toFixed(n >= 10 * MB ? 0 : 1) + ' MB';
}

/** text kinds a portal serves compressed (gzip / brotli): they cost about a third on the wire */
const TEXTLIKE = /\.(m?js|css|html?|json|svg|txt|wasm|map|xml)$/i;
/** files no player downloads before playing: the readme, credits, cover — and a piece's LOD files,
 * which load only when it is far enough away to swap */
const NOT_LOADED = /^(README\.txt|CREDITS\.txt|thumbnail\.png|\.nojekyll)$|\.lod\d+\.(glb|gltf)$/i;

/**
 * 63 PG3 — what a player downloads BEFORE the game starts, for CrazyGames' "initial download"
 * (they measure it up to the first gameplayStart). An UPPER estimate from the zip's own list: every
 * file the game can load, text at the ~0.32 ratio a portal's compression gives it, except the
 * files nobody loads first (readme, credits, cover, LOD files) and the sky sizes the game does not start on
 * (`skyStart` names the one it does; the others load only when a player picks them in Options).
 * The engine is counted whole although most of it is lazy, so the real first download is smaller.
 * @param {{path: string, bytes: number}[]} files @param {{skyFiles?: string[], skyStart?: string}} [o]
 * @returns {number}
 */
export function initialDownloadBytes(files, o = {}) {
	const skip = new Set((o.skyFiles || []).filter((f) => f !== o.skyStart));
	let n = 0;
	for (const f of files) {
		if (NOT_LOADED.test(f.path) || skip.has(f.path)) continue;
		n += TEXTLIKE.test(f.path) ? Math.round(f.bytes * 0.32) : f.bytes;
	}
	return n;
}

/**
 * The size report's rows (row 2): the `count` biggest assets, biggest first (ties by path).
 * @param {ExportAsset[]} assets @param {number} [count]
 * @returns {ExportAsset[]}
 */
export function biggestAssets(assets, count = ASSET_ROWS) {
	return [...(assets || [])].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, count);
}

/** CheckRow items from the size report @param {CheckContext} ctx @param {number} [count] */
function assetItems(ctx, count = 8) {
	return biggestAssets(ctx.assets || [], count).map((a) => ({ label: a.label + ' · ' + a.path, bytes: a.bytes, ...(a.where ? { where: a.where } : {}) }));
}

/** @param {CheckContext} ctx */
function limitsOf(ctx) {
	return ctx.limits || PRESET_LIMITS[String(ctx.target)] || ITCH_LIMITS;
}

/** @param {string} target */
function portalName(target) {
	return target === 'crazygames' ? 'CrazyGames' : target === 'itch' ? 'itch.io' : 'a static host';
}

const EXPORT_TARGETS = ['itch', 'crazygames', 'static'];

/** @type {CheckRule[]} */
export const EXPORT_RULES = [
	{
		// the zip's own shape (index.html, play.js, relative paths, no service worker …) — the checks
		// exportValidate always ran, as rows. Sizes and counts are the rules below (with their lists).
		id: 'export-structure',
		owner: 'export',
		targets: EXPORT_TARGETS,
		run(ctx) {
			if (ctx.stage !== 'built' || !ctx.files) return [];
			const L = limitsOf(ctx);
			const allowHosts = /** @type {Record<string, readonly string[]>} */ (EXPORT_ALLOWED_HOSTS)[String(ctx.target)] || [];
			const r = validateExport(ctx.files, { preset: String(ctx.target), allowHosts, limits: /** @type {any} */ ({ ...L, maxFiles: Infinity, maxTotalBytes: Infinity, maxFileBytes: Infinity }) });
			return [
				...r.errors.map((e) => /** @type {CheckRow} */ ({ id: 'export-structure', owner: 'export', severity: 'error', title: 'The zip is not a well-formed game', detail: e })),
				...r.warnings.map((w) => /** @type {CheckRow} */ ({ id: 'export-structure-note', owner: 'export', severity: 'warn', title: 'Check this before uploading', detail: w }))
			];
		}
	},
	{
		id: 'export-file-count',
		owner: 'export',
		targets: EXPORT_TARGETS,
		run(ctx) {
			const L = limitsOf(ctx);
			const n = (ctx.files || []).length;
			if (!n || n <= L.maxFiles * 0.9) return [];
			const over = n > L.maxFiles;
			return [
				{
					id: 'export-file-count',
					owner: 'export',
					severity: over ? 'error' : 'warn',
					title: over ? `${n.toLocaleString('en')} files — ${portalName(String(ctx.target))} takes at most ${L.maxFiles.toLocaleString('en')}` : `${n.toLocaleString('en')} files — close to the ${L.maxFiles.toLocaleString('en')}-file limit`,
					detail: 'Most files are the engine; each pack piece and sky size the scene uses adds one or more.'
				}
			];
		}
	},
	{
		id: 'export-path-length',
		owner: 'export',
		targets: EXPORT_TARGETS,
		run(ctx) {
			const L = limitsOf(ctx);
			const long = (ctx.files || []).filter((f) => f.path.length > L.maxPathLength);
			return long.slice(0, 5).map((f) => ({ id: 'export-path-length', owner: 'export', severity: 'error', title: `A file path is longer than ${L.maxPathLength} characters`, file: f.path, detail: f.path }));
		}
	},
	{
		id: 'export-size-file',
		owner: 'export',
		targets: EXPORT_TARGETS,
		run(ctx) {
			const L = limitsOf(ctx);
			const big = (ctx.files || []).filter((f) => f.bytes > L.maxFileBytes);
			return big.slice(0, 5).map((f) => ({ id: 'export-size-file', owner: 'export', severity: 'error', title: `One file is over ${fmtMB(L.maxFileBytes)}`, file: f.path, detail: `${f.path} · ${fmtMB(f.bytes)}` }));
		}
	},
	{
		id: 'export-size-total',
		owner: 'export',
		targets: EXPORT_TARGETS,
		run(ctx) {
			const L = limitsOf(ctx);
			const total = (ctx.files || []).reduce((n, f) => n + f.bytes, 0);
			if (total <= L.maxTotalBytes * WARN_AT) return [];
			const over = total > L.maxTotalBytes;
			return [
				{
					id: 'export-size-total',
					owner: 'export',
					severity: over ? 'error' : 'warn',
					title: over ? `${fmtMB(total)} unzipped — ${portalName(String(ctx.target))} takes at most ${fmtMB(L.maxTotalBytes)}` : `${fmtMB(total)} unzipped — over ${Math.round(WARN_AT * 100)} % of the ${fmtMB(L.maxTotalBytes)} limit`,
					detail: 'The biggest assets:',
					items: assetItems(ctx)
				}
			];
		}
	},
	{
		// CrazyGames: what loads before the game starts (initialDownloadBytes) — refused over 50 MB,
		// a warning above 80 %, a note above the mobile homepage's 20 MB
		id: 'export-initial-download',
		owner: 'export',
		targets: ['crazygames'],
		run(ctx) {
			const L = limitsOf(ctx);
			if (!L.maxInitialBytes || !ctx.files?.length) return [];
			const bytes = typeof ctx.initialBytes === 'number' ? ctx.initialBytes : initialDownloadBytes(ctx.files, { skyFiles: ctx.skyFiles, skyStart: ctx.skyStart });
			/** @type {CheckRow[]} */
			const rows = [];
			if (bytes > L.maxInitialBytes * WARN_AT) {
				const over = bytes > L.maxInitialBytes;
				rows.push({
					id: 'export-initial-download',
					owner: 'export',
					severity: over ? 'error' : 'warn',
					title: over ? `About ${fmtMB(bytes)} loads before the game starts — CrazyGames allows ${fmtMB(L.maxInitialBytes)}` : `About ${fmtMB(bytes)} loads before the game starts — over ${Math.round(WARN_AT * 100)} % of CrazyGames' ${fmtMB(L.maxInitialBytes)}`,
					detail: 'Make the biggest assets smaller or leave some out (an upper estimate: the whole engine is counted).',
					items: assetItems(ctx)
				});
			} else if (L.mobileInitialBytes && bytes > L.mobileInitialBytes)
				rows.push({
					id: 'export-initial-mobile',
					owner: 'export',
					severity: 'info',
					title: `About ${fmtMB(bytes)} loads first — over the ${fmtMB(L.mobileInitialBytes)} CrazyGames asks of games on its mobile homepage`,
					detail: 'The game is still accepted; it is not offered on the mobile homepage.'
				});
			return rows;
		}
	},
	{
		// "Use CDN for packs" is the author's opt-in to the internet: a portal game then needs it
		id: 'export-needs-internet',
		owner: 'export',
		targets: EXPORT_TARGETS,
		run(ctx) {
			const rows = /** @type {CheckRow[]} */ ([]);
			if (ctx.cdnPacks) rows.push({ id: 'export-needs-internet', owner: 'export', severity: 'warn', title: 'Packs load from the internet (Use CDN for packs)', detail: 'The game will not start offline, and a portal may block the outside requests. Turn the option off to carry the packs in the zip.' });
			if (ctx.absoluteModels) rows.push({ id: 'export-absolute-models', owner: 'export', severity: 'warn', title: `${ctx.absoluteModels} model${ctx.absoluteModels === 1 ? ' loads' : 's load'} from an outside URL`, detail: 'They stay online: import the file instead, so the export carries it.' });
			return rows;
		}
	}
];
