// 36-export (E1) — THE EXPORT BUILDER. One builder produces a self-contained static game:
//
//   index.html            this deployment's own index.html, rewritten: ./play.js first, the
//                         game's title, no web-app manifest
//   play.js               `window.__TP_EXPORT__ = {…}` — the config exportBoot reads (data only)
//   scene.tpscene         the open scene (Save's own payload + zip writer, assets + flow)
//   assets/packs/<path>   every pack file the scene references (PACKS_BASE-relative paths kept),
//                         plus a trimmed index so LOD lookups resolve — unless "Use CDN for packs"
//   assets/modules/<id>.zip  every INSTALLED (user) module the scene needs; core modules ride
//                         the runtime itself
//   thumbnail.png         a 630×500 still for the itch.io page (optional)
//   _app/…, draco/, basis/, fonts/, …   the engine runtime: the build's own files, listed by
//                         `export-manifest.json` (scripts/export-manifest.cjs, at build time)
//   README.txt            what this is, how to host it, the badge policy
//
// Relative paths only, no service worker, nothing fetched from a CDN at runtime (unless the
// pack option says so). The SAME config + runtime back a published play link (the hosted app
// with `?embed=1` — see EmbedChrome/MadeWithBadge); presets only choose the packaging:
// itch.io zip, static-host zip (+ .nojekyll), or an iframe snippet for a page already hosted.
//
// Runs in the EDITOR (a browser). A dev server has no build, so there is no manifest there:
// the exporter says "needs the built app" instead of producing half a game.
import { get } from 'svelte/store';
import { objectsGroup, globalRenderer, globalScene, globalCamera } from '../../stores/sceneStore';
import { pageUrl } from './exportBoot.js';
import { validateExport, ITCH_LIMITS } from './exportValidate.js';
import { packLodsOf } from '../lodGroupCore.js';
import { APP_VERSION } from '../version.js';
import { slugify, rewriteIndexHtml, stripHostInjected, hostRemovalNotes, makePlayJs, embedSnippet, collectPackRefs, fmtBytes, addPortalSdk, EXPORT_ALLOWED_HOSTS } from './exportCore.js';

export { slugify, rewriteIndexHtml, stripHostInjected, makePlayJs, embedSnippet, collectPackRefs, fmtBytes };

export const EXPORT_PRESETS = Object.freeze({
	itch: { id: 'itch', label: 'itch.io', zip: true },
	// 63 PG3: CrazyGames — their SDK v3 from their URL (the preset's one outside host), the portal
	// adapter (portals/crazygames.js), their size rules (exportChecks.CRAZYGAMES_LIMITS)
	crazygames: { id: 'crazygames', label: 'CrazyGames', zip: true },
	static: { id: 'static', label: 'Static host', zip: true },
	embed: { id: 'embed', label: 'Embed', zip: false }
});

/** the zip's file-name tail per preset */
const ZIP_TAIL = { itch: 'itch', crazygames: 'crazygames', static: 'web' };

/**
 * 63 PG1-PG3: the export was REFUSED by its own checks — `rows` are the checkCore rows (the errors
 * that block, beside the warnings), `assets` the size report so far (biggest first).
 */
export class ExportRefused extends Error {
	/** @param {any[]} rows @param {any[]} assets @param {string} stage */
	constructor(rows, assets, stage) {
		const errors = rows.filter((r) => r.severity === 'error');
		super('The export failed its own check: ' + errors.slice(0, 3).map((r) => r.title + (r.detail && r.id === 'export-structure' ? ' (' + r.detail + ')' : '')).join(' · '));
		this.name = 'ExportRefused';
		this.rows = rows;
		this.assets = assets;
		this.stage = stage;
	}
}

/**
 * 63 PG4 row 7 — WHEN THE GAME CHANGES LATER. The export id and the zip's file name are kept per game
 * and preset on this device, so exporting the same scene again makes the same-named zip with the same
 * id, and a portal upload of it replaces the old build. `reused` says whether this one matched an
 * earlier export. (A NEW id per build is still minted for the cloud plugin's build list: `buildId`.)
 * @param {string} gameId @param {string} preset @param {string} fileName the name this export would get
 * @returns {Promise<{id: string, fileName: string, reused: boolean}>}
 */
export async function stableExportIdentity(gameId, preset, fileName) {
	const { safeStorage } = await import('../safeStorage');
	const KEY = 'tp:export:identities';
	/** @type {Record<string, {id: string, fileName: string, at: number}>} */
	let map = {};
	try {
		map = JSON.parse(safeStorage.getItem(KEY) || '{}') || {};
	} catch {
		map = {};
	}
	const key = (gameId || 'game') + ':' + preset;
	const prev = map[key];
	if (prev && /^x[a-z0-9]{6,}$/.test(prev.id) && typeof prev.fileName === 'string' && /\.zip$/.test(prev.fileName)) {
		map[key] = { ...prev, at: Date.now() };
		safeStorage.setItem(KEY, JSON.stringify(map));
		return { id: prev.id, fileName: prev.fileName, reused: true };
	}
	const id = newExportId();
	map[key] = { id, fileName, at: Date.now() };
	// keep the 50 most recent games' rows
	const keep = Object.entries(map).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 50);
	safeStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keep)));
	return { id, fileName, reused: false };
}

/** where the bundle keeps the pack files (and what play.js's packsBase says) */
export const PACKS_DIR = 'assets/packs';
export const MODULES_DIR = 'assets/modules';

/** text kinds worth deflating; everything else (images, zips, audio) is stored */
const DEFLATE = /\.(m?js|css|html?|json|svg|txt|wasm|glb|gltf|bin|map|xml)$/i;

/**
 * @typedef {{
 *   preset: 'itch' | 'crazygames' | 'static' | 'embed',
 *   title: string,
 *   thumbnail: boolean,
 *   startFullscreen: boolean,
 *   showFps: boolean,
 *   quality: string,
 *   vrButton: boolean,
 *   useCdnForPacks: boolean,
 *   viewport?: {w: number, h: number},
 *   mobile?: boolean
 * }} ExportOptions
 * @typedef {{phase: string, done: number, total: number, note?: string}} ExportProgress
 */

export class ExportUnavailable extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = 'ExportUnavailable';
	}
}

/** @returns {Promise<{format: number, version: string, files: {path: string, bytes: number, editorOnly?: boolean}[], bytes: number}>} */
export async function loadExportManifest() {
	let res;
	try {
		res = await fetch(pageUrl('export-manifest.json'), { cache: 'no-cache' });
	} catch {
		throw new ExportUnavailable('Could not reach this app’s file list.');
	}
	if (!res.ok)
		throw new ExportUnavailable(
			'Export needs the BUILT app (npm run build + a static host). This server has no export-manifest.json — a dev server is not a build.'
		);
	const manifest = await res.json();
	if (!Array.isArray(manifest?.files)) throw new ExportUnavailable('export-manifest.json is malformed.');
	return manifest;
}

/** An id for this export — the A1 counter's `g`, and the folder name a host shows. */
export function newExportId() {
	const a = new Uint8Array(6);
	crypto.getRandomValues(a);
	return 'x' + Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 11);
}

/** A 630×500 still of the current view (itch.io's cover size), or null in VR / before a renderer. */
async function captureCover() {
	const r = /** @type {any} */ (get(globalRenderer));
	const scene = get(globalScene);
	const cam = get(globalCamera);
	if (!r || !scene || !cam || r.xr?.isPresenting) return null;
	try {
		r.render(scene, cam);
		const src = r.domElement;
		const c = document.createElement('canvas');
		c.width = 630;
		c.height = 500;
		const ctx = c.getContext('2d');
		if (!ctx) return null;
		const scale = Math.max(630 / src.width, 500 / src.height);
		const w = src.width * scale;
		const h = src.height * scale;
		ctx.drawImage(src, (630 - w) / 2, (500 - h) / 2, w, h);
		const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
		return blob ? new Uint8Array(await /** @type {Blob} */ (blob).arrayBuffer()) : null;
	} catch {
		return null;
	}
}

/**
 * Fetch many files with a small worker pool. @param {string[]} urls
 * @param {(i: number, bytes: Uint8Array) => void} onFile @param {number} [concurrency]
 * @param {((i: number) => void) | null} [onMissing] 63: report a file that is not there instead of failing the export
 */
async function fetchAll(urls, onFile, concurrency = 6, onMissing = null) {
	let next = 0;
	const worker = async () => {
		while (next < urls.length) {
			const i = next++;
			const res = await fetch(urls[i]).catch((e) => {
				if (onMissing) return null;
				throw e;
			});
			if (!res || !res.ok) {
				if (onMissing) {
					onMissing(i);
					continue;
				}
				throw new Error(`${urls[i]} — HTTP ${res?.status}`);
			}
			onFile(i, new Uint8Array(await res.arrayBuffer()));
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
}

/** @param {any} files fflate input @returns {Promise<Uint8Array>} */
async function zipAsync(files) {
	const { zip } = await import('fflate');
	return new Promise((resolve, reject) => zip(files, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data))));
}

/** the README every zip carries @param {{title: string, preset: string, id: string, fileName?: string, cdn: boolean}} o */
function readmeText({ title, preset, id, fileName, cdn }) {
	return [
		`${title || 'Game'} — made with ThePrototype (https://theprototype.app)`,
		'',
		'This folder is a complete, static web game: open index.html from any web server.',
		'It needs no install and no server code. It does NOT run from file:// (browsers refuse',
		'module scripts there) — for a quick local look: `npx serve .` or `python3 -m http.server`.',
		'',
		preset === 'itch'
			? 'itch.io: upload the ZIP as-is, set "Kind of project" to HTML and tick "This file will be played in the browser". Embed options: "Embed in page" with the viewport size from the Export tab (or "Click to launch in fullscreen"), tick "Mobile friendly" when the game has touch controls, and let itch add its fullscreen button. Leave "SharedArrayBuffer support" OFF — the game does not need it.'
			: preset === 'crazygames'
				? 'CrazyGames: upload the ZIP as an HTML5 game in the developer portal. The game loads the CrazyGames SDK v3 from sdk.crazygames.com (its only outside request) and reports loading and gameplay to it; CrazyGames provides fullscreen, so the game shows no fullscreen button of its own. The Made with ThePrototype badge is drawn without a link here (CrazyGames does not allow links out of a game).'
				: 'Static hosts (Netlify, Cloudflare Pages, GitHub Pages): publish this folder as the site root or any subfolder; all paths are relative. The .nojekyll file keeps GitHub Pages from hiding _app/.',
		cdn ? 'Packs load from the jsDelivr CDN at runtime (the "Use CDN for packs" option), so the game needs internet.' : 'Everything the game loads is inside this folder.',
		'',
		'The "Made with ThePrototype" badge is drawn by the engine and has no off switch. You own',
		'this file and can edit it — the badge is a request, not DRM. Please keep it.',
		'',
		`Export id: ${id} · engine ${APP_VERSION}`,
		'',
		`Updating the game later: export the same scene again with the same preset — the zip keeps this export id${fileName ? ' and its name (' + fileName + ')' : ''}, so uploading it replaces this build.`
	].join('\n');
}

/**
 * Build the export. Resolves to the zip (preset itch/static) plus what went in it, after
 * validating it with the same rules `scripts/check-export.cjs` applies.
 * @param {ExportOptions} opts
 * @param {(p: ExportProgress) => void} [onProgress]
 * @returns {Promise<{blob: Blob, fileName: string, id: string, gameId: string, buildId: string, reused: boolean, report: import('./exportValidate.js').ExportReport,
 *   breakdown: {runtime: number, scene: number, packs: number, modules: number}, warnings: string[], details: string[],
 *   checks: import('./checkCore.js').CheckRow[], assets: import('./exportChecks.js').ExportAsset[], assetCount: number, initialBytes: number}>}
 */
export async function buildExport(opts, onProgress = () => {}) {
	if (opts.preset === 'embed') throw new Error('The Embed preset makes a snippet, not a zip.');
	// 36-community (C4): `gameId` is the game's permanent id (minted on the first export/save, kept
	// by every later one), so re-exports never split a game's visits. 63 row 7: `id` (the export id
	// play.js and the README carry) and the file name are KEPT per game + preset, so a re-export
	// replaces the old upload; `buildId` is this one build (the cloud plugin's list)
	const { ensureGameId, gameIdentity } = await import('../gameIdentity.js');
	const gameId = ensureGameId();
	const title = String(opts.title || '').trim() || 'Game';
	const identity = await stableExportIdentity(gameId, opts.preset, `${slugify(title)}-${ZIP_TAIL[opts.preset] || 'web'}.zip`);
	const id = identity.id;
	const buildId = newExportId();
	const { runChecks, summarize } = await import('./checkCore.js');
	const { EXPORT_RULES, biggestAssets, initialDownloadBytes } = await import('./exportChecks.js');
	/** @type {string[]} */
	const warnings = [];
	/** 36 L3: what the result keeps out of sight (its Details section) @type {string[]} */
	const details = [];
	/** strip what the web host injected into a page it served; every removal is reported — a KNOWN
	 * host script (the Cloudflare beacon) only in the Details, anything else as a warning
	 * @param {string} path @param {string} html */
	const fromHost = (path, html) => {
		const r = stripHostInjected(html);
		const notes = hostRemovalNotes(path, r);
		warnings.push(...notes.warnings);
		details.push(...notes.details);
		return r.html;
	};
	/** @type {Record<string, Uint8Array>} */
	const out = {};
	const enc = new TextEncoder();
	const breakdown = { runtime: 0, scene: 0, packs: 0, modules: 0 };

	onProgress({ phase: 'Reading the app’s file list', done: 0, total: 1 });
	const manifest = await loadExportManifest();

	// 1. the scene — the same payload + zip writer Save uses
	onProgress({ phase: 'Bundling the scene', done: 0, total: 1 });
	const { buildSessionPayload, exportSessionZip } = await import('../sessions');
	// fix-batch-2 (1.45.1): local objects are drafts — an exported game carries what peers see
	const { withoutLocalObjects, noteLocalObjectsExcluded } = await import('../objectPermissions');
	const { result: payload, excluded } = withoutLocalObjects(() => buildSessionPayload(title));
	noteLocalObjectsExcluded(excluded);
	if (!payload?.objects?.length) throw new Error('The scene is empty — add something to play first.');
	// 73 AI9: an exported game carries only the author's own GLSL (written or chosen to run on this device);
	// someone else's is exported switched off (the graph stays), and the warning says how to keep it
	{
		const { foreignShaderCodeOff } = await import('../shaderCodeReach.js');
		const { shaderCodeHash, usesShaderCode } = await import('../shaderCode.js');
		const off = foreignShaderCodeOff(payload.shaderGraphs, shaderCodeHash, usesShaderCode);
		if (off) warnings.push(`${off} custom shader${off === 1 ? '' : 's'} from someone else ${off === 1 ? 'is' : 'are'} left off in the export. To keep one, open it in the shader editor's Your GLSL and press Apply (it becomes yours).`);
	}
	// 46 P3: the export preset (Settings ▸ Export ▸ Optimize for, shared with Save) — For Quest / web
	// bundles resized textures with KTX2 twins and LOD chains (the runtime ships the transcoder)
	const { saveOptions } = await import('../saveOptions');
	const sceneOpts = { assets: true, flow: true, packs: false, preset: get(saveOptions).exportPreset };
	const scene = await exportSessionZip(payload, sceneOpts);
	out['scene.tpscene'] = scene;
	breakdown.scene = scene.byteLength;

	// 2. the user modules the scene needs (core ones are part of the runtime)
	onProgress({ phase: 'Packing modules', done: 0, total: 1 });
	const { moduleRequirements } = await import('../moduleRequirements');
	const { userModules } = await import('../userModules');
	const { coreModules } = await import('../../modules/index.js');
	const { zipSync, strToU8 } = await import('fflate');
	/** @type {{id: string, file: string}[]} */
	const moduleRows = [];
	for (const req of moduleRequirements()) {
		if (coreModules.some((/** @type {any} */ m) => m.id === req.id)) continue;
		const record = get(userModules).find((/** @type {any} */ r) => r.id === req.id);
		if (!record) {
			warnings.push(`The scene uses module "${req.id}", which is not installed here — its nodes will do nothing in the export.`);
			continue;
		}
		/** @type {Record<string, Uint8Array>} */
		const files = { ...record.files };
		files['manifest.json'] = strToU8(
			JSON.stringify({ id: record.id, name: record.name, version: record.version, format: record.format, description: record.description, entry: record.entry, files: Object.keys(record.files) })
		);
		const file = `${MODULES_DIR}/${record.id.replace(/[^\w.-]/g, '_')}.zip`;
		out[file] = zipSync(files, { level: 6 });
		breakdown.modules += out[file].byteLength;
		moduleRows.push({ id: record.id, file });
	}

	// 3. the packs the scene references
	const { PACKS_BASE } = await import('../packs');
	const { paths, absolute } = collectPackRefs(get(objectsGroup), PACKS_BASE);
	if (absolute.size) warnings.push(`${absolute.size} model${absolute.size === 1 ? '' : 's'} load from an absolute URL and stay online (${[...absolute][0]}${absolute.size > 1 ? ', …' : ''}).`);
	let packsBase = '';
	if (paths.size && opts.useCdnForPacks) warnings.push('Packs load from the jsDelivr CDN at runtime — the game needs internet.');
	if (paths.size && !opts.useCdnForPacks) {
		packsBase = PACKS_DIR;
		const list = [...paths];
		const base = String(PACKS_BASE).replace(/\/+$/, '');
		let done = 0;
		onProgress({ phase: 'Copying pack files', done, total: list.length });
		await fetchAll(
			list.map((p) => base + '/' + p),
			(i, bytes) => {
				out[`${PACKS_DIR}/${list[i]}`] = bytes;
				breakdown.packs += bytes.byteLength;
				onProgress({ phase: 'Copying pack files', done: ++done, total: list.length });
			}
		);
		// a trimmed packs index: the pack rows the scene uses, each with only the items it uses,
		// so a piece's implicit LOD lookup (lodGroup.packRowFor) resolves offline too
		try {
			const { files: extra, lodPaths } = await packIndexFor(base, list);
			for (const [path, bytes] of Object.entries(extra)) {
				out[`${PACKS_DIR}/${path}`] = bytes;
				breakdown.packs += bytes.byteLength;
			}
			// 63 PG1: the index above makes each piece's implicit LOD group resolve offline, and that
			// group names the row's `lods` files beside the model — they ride in the zip too (they
			// were 404s in a played export: ~1 per placed pack piece)
			const lods = lodPaths.filter((p) => !out[`${PACKS_DIR}/${p}`]);
			/** @type {string[]} */
			const lost = [];
			await fetchAll(
				lods.map((p) => base + '/' + p),
				(i, bytes) => {
					out[`${PACKS_DIR}/${lods[i]}`] = bytes;
					breakdown.packs += bytes.byteLength;
				},
				6,
				(i) => lost.push(lods[i])
			);
			if (lost.length) details.push(`${lost.length} LOD file${lost.length === 1 ? '' : 's'} could not be copied — those pieces draw at full detail (${lost[0]}${lost.length > 1 ? ', …' : ''}).`);
		} catch {
			warnings.push('The packs index could not be read — pieces fall back to automatic LOD in the export.');
		}
	}

	// 63 PG1: the sky files this scene's environment needs (copied in step 4b) — planned here so the
	// preflight below counts them
	const sky = await planSky();

	// 63 PG2: THE PREFLIGHT — before the engine or a single pack file is fetched, the preset's rules
	// run on the PLANNED file list (sizes known so far; a pack file not fetched yet counts 0): a zip
	// that cannot pass (too many files, a path too long) is refused here, naming what fails
	{
		/** @type {{path: string, bytes: number}[]} */
		const planned = [
			...runtimeFiles(manifest).map((f) => ({ path: f.path, bytes: f.bytes })),
			...Object.entries(out).map(([path, bytes]) => ({ path, bytes: bytes.byteLength })),
			...[...paths].filter(() => packsBase).map((p) => ({ path: `${PACKS_DIR}/${p}`, bytes: 0 })),
			...sky.files.map((f) => ({ path: f, bytes: 0 })),
			...['index.html', 'play.js', 'README.txt', ...(opts.preset === 'static' ? ['.nojekyll'] : [])].map((path) => ({ path, bytes: 0 }))
		];
		// the size report so far (the scene's objects, the modules): a refusal here lists them too
		const planAssets = sizeReport(out, payload, PACKS_BASE, sky, moduleRows);
		const planRows = await runChecks(EXPORT_RULES, { target: opts.preset, stage: 'plan', files: dedupeFiles(planned), assets: planAssets });
		if (summarize(planRows, opts.preset).blocking) throw new ExportRefused(planRows, biggestAssets(planAssets), 'plan');
	}

	// 4. the engine runtime, straight from this deployment. 63 PG1: the game boots the slim PLAY
	// entry (94 SP1, build/play.html) — the editor's page and the files only the editor or the UI kit
	// page can reach (export-manifest.cjs marks them `editorOnly`) stay out of the zip
	const entryPage = playEntryOf(manifest);
	const runtime = runtimeFiles(manifest);
	const runtimeBytes = runtime.reduce((n, f) => n + f.bytes, 0);
	let fetched = 0;
	onProgress({ phase: 'Copying the engine', done: 0, total: runtimeBytes });
	await fetchAll(
		runtime.map((f) => pageUrl(f.path)),
		(i, bytes) => {
			// a page the host served may carry what the host injected (36-int-121) — the same strip as index.html
			out[runtime[i].path] = /\.html?$/i.test(runtime[i].path) ? enc.encode(fromHost(runtime[i].path, new TextDecoder().decode(bytes))) : bytes;
			breakdown.runtime += bytes.byteLength;
			fetched += runtime[i].bytes;
			onProgress({ phase: 'Copying the engine', done: fetched, total: runtimeBytes });
		}
	);
	// 37-hdri / 59 T3 / 72 LK2: the sky the scene shows, every size its Options offer (planSky)
	if (sky.row) {
		const { fetchSky } = await import('../hdri/skyFetch.js');
		/** @type {string[]} */
		const copied = [];
		for (const file of sky.files) {
			// 63: one retry (a 1K tier went missing once with the CDN answering 200), and the reason kept
			for (let attempt = 0; attempt < 2 && !copied.includes(file); attempt++) {
				try {
					const bytes = new Uint8Array(await fetchSky(file));
					out[file] = bytes;
					breakdown.runtime += bytes.byteLength;
					copied.push(file);
				} catch (err) {
					if (attempt) details.push(`sky ${file}: ${String(/** @type {any} */ (err)?.message ?? err).slice(0, 160)}`);
				}
			}
		}
		// the light's file is what matters: without it the .hdr is the sky, and without that, flat
		if (!copied.includes(sky.lightFile)) {
			try {
				const bytes = new Uint8Array(await fetchSky(sky.row.file));
				out[sky.row.file] = bytes;
				breakdown.runtime += bytes.byteLength;
			} catch (err) {
				warnings.push(`The sky image ${sky.row.file} could not be copied (${String(/** @type {any} */ (err)?.message ?? err)}) — the export shows its flat sky.`);
			}
		} else if (copied.length < sky.files.length) {
			warnings.push(`Some sky sizes could not be copied (${sky.files.filter((f) => !copied.includes(f)).join(', ')}) — the game shows the largest one it has.`);
		}
	}
	const indexRes = await fetch(pageUrl(entryPage));
	if (!indexRes.ok) throw new Error(entryPage + ' — HTTP ' + indexRes.status);
	let indexHtml = rewriteIndexHtml(fromHost('index.html', await indexRes.text()), { title });
	// 63 PG3: a portal preset loads its SDK from the portal's own URL, in <head> after play.js
	{
		const { PORTAL_SDK_SCRIPTS } = await import('./portals/index.js');
		const sdk = /** @type {Record<string, string>} */ (PORTAL_SDK_SCRIPTS)[opts.preset];
		if (sdk) indexHtml = addPortalSdk(indexHtml, sdk);
	}
	out['index.html'] = enc.encode(indexHtml);

	// 93 LP2: the game's own loading screen covers the export's first load
	const { exportLoadingScreen } = await import('../gameLevels/exportLoading.js');
	const loading = await exportLoadingScreen(out, payload, warnings);

	// 5. the config, the cover, the readme
	const config = {
		version: 1,
		id,
		gameId,
		title,
		scene: 'scene.tpscene',
		packsBase,
		modules: moduleRows,
		// 63 PG3: CrazyGames provides fullscreen ("custom in-game fullscreen buttons are prohibited")
		startFullscreen: opts.preset === 'crazygames' ? false : !!opts.startFullscreen,
		showFps: !!opts.showFps,
		quality: opts.quality || 'auto',
		vrButton: opts.vrButton !== false,
		preset: opts.preset,
		builtWith: APP_VERSION,
		...(loading ? { loading } : {})
	};
	const playJs = makePlayJs(config);
	out['play.js'] = enc.encode(playJs);
	if (opts.thumbnail) {
		const cover = await captureCover();
		if (cover) out['thumbnail.png'] = cover;
	}
	out['README.txt'] = enc.encode(readmeText({ title, preset: opts.preset, id, fileName: identity.fileName, cdn: !!(paths.size && opts.useCdnForPacks) }));
	// 57 M7: the credits every licensed asset (and applied clip) asks for, beside the readme
	{
		const { creditsFor } = await import('../sceneLicences.js');
		const credits = creditsFor(null);
		if (credits) out['CREDITS.txt'] = enc.encode(credits);
	}
	if (opts.preset === 'static') out['.nojekyll'] = new Uint8Array(0);

	// 6. the size report (row 2) and the preset's checks on every real byte, then zip
	onProgress({ phase: 'Checking', done: 0, total: 1 });
	const dec = new TextDecoder();
	const files = Object.entries(out).map(([path, bytes]) => ({
		path,
		bytes: bytes.byteLength,
		text: path === 'index.html' ? indexHtml : path === 'play.js' ? playJs : /\.m?js$/.test(path) && path.startsWith('_app/') && bytes.byteLength < 4e6 ? dec.decode(bytes) : undefined
	}));
	const assets = sizeReport(out, payload, PACKS_BASE, sky, moduleRows);
	const checks = await runChecks(EXPORT_RULES, {
		target: opts.preset,
		stage: 'built',
		files,
		assets,
		breakdown,
		skyFiles: sky.files,
		skyStart: sky.start,
		cdnPacks: !!(paths.size && opts.useCdnForPacks),
		absoluteModels: absolute.size
	});
	if (summarize(checks, opts.preset).blocking) throw new ExportRefused(checks, biggestAssets(assets), 'built');
	// the validator's own report: its stats feed the result screen (its errors are the rows above)
	const report = validateExport(files, { preset: opts.preset, allowHosts: /** @type {any} */ (EXPORT_ALLOWED_HOSTS)[opts.preset] || [], limits: /** @type {any} */ ({ ...ITCH_LIMITS, maxFiles: Infinity, maxTotalBytes: Infinity, maxFileBytes: Infinity }) });
	const initialBytes = initialDownloadBytes(files, { skyFiles: sky.files, skyStart: sky.start });

	onProgress({ phase: 'Zipping', done: 0, total: 1 });
	/** @type {Record<string, [Uint8Array, {level: 0 | 6}]>} */
	const zipInput = {};
	for (const [path, bytes] of Object.entries(out)) zipInput[path] = [bytes, { level: DEFLATE.test(path) ? 6 : 0 }];
	const zipped = await zipAsync(zipInput);
	onProgress({ phase: 'Done', done: 1, total: 1 });
	const blob = new Blob([/** @type {BlobPart} */ (zipped)], { type: 'application/zip' });
	// 36-community (C4): tell a cloud plugin (it registers signed-in builds); inert without one
	try {
		const { notifyExportBuilt } = await import('../cloudHooks.js');
		const ident = get(gameIdentity);
		notifyExportBuilt({ gameId, buildId, preset: opts.preset, title, template: ident?.template || '', parentGameId: ident?.parentGameId || '', appVersion: APP_VERSION });
	} catch {
		/* a listener's failure never fails an export */
	}
	return { blob, fileName: identity.fileName, id, gameId, buildId, reused: identity.reused, report, breakdown, warnings, details, checks, assets: biggestAssets(assets), assetCount: assets.length, initialBytes };
}

/**
 * 63: the sky this scene's environment shows, as the files an export carries: every size the game's
 * Options offer (the 8K only for a scene set to Max), the light's 1K, and the size the game STARTS
 * on (the largest it carries — an upper estimate for the first download).
 * @returns {Promise<{row: any, files: string[], lightFile: string, start: string, label: string}>}
 */
async function planSky() {
	const { presetPayload } = await import('../environment');
	const { hdriOf } = await import('../hdri/hdriCore.js');
	const { bundledHdri, skyTiers, skyTierFile } = await import('../hdri/catalog.js');
	const hdri = hdriOf(presetPayload());
	const row = bundledHdri(hdri?.src ?? '');
	if (!row) return { row: null, files: [], lightFile: '', start: '', label: '' };
	const files = skyTiers(row)
		.filter((tier) => tier !== '8k' || hdri?.quality === 'max')
		.map((tier) => skyTierFile(row, tier));
	return { row, files, lightFile: skyTierFile(row, '1k'), start: files[files.length - 1] || '', label: row.label || 'Sky' };
}

/** @param {{path: string, bytes: number}[]} files keep the first of each path */
function dedupeFiles(files) {
	const seen = new Set();
	return files.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
}

/**
 * 63 row 2 — THE SIZE REPORT: every asset in the zip with what uses it, for the result screen's
 * list and the size checks. The scene file is opened up into its objects (each top-level object's
 * share of scene.tpscene, uncompressed), pack files name the objects that place them, the sky
 * names its size. The engine is not an asset (the totals show it).
 * @param {Record<string, Uint8Array>} out @param {any} payload @param {string} packsBase the remote PACKS_BASE
 * @param {{files: string[], label: string}} sky @param {{id: string, file: string}[]} modules
 * @returns {import('./exportChecks.js').ExportAsset[]}
 */
function sizeReport(out, payload, packsBase, sky, modules) {
	/** @type {import('./exportChecks.js').ExportAsset[]} */
	const rows = [];
	for (const o of Array.isArray(payload?.objects) ? payload.objects : []) {
		const obj = o?.object;
		if (!obj) continue;
		let bytes = 0;
		try {
			bytes = JSON.stringify(o).length;
		} catch {}
		const label = String(obj.name || obj.type || 'Object').slice(0, 60);
		rows.push({ path: 'scene.tpscene ▸ ' + label, bytes, label, kind: 'object', ...(obj.uuid ? { where: String(obj.uuid) } : {}) });
	}
	// who places each pack file (the piece itself, or its LOD files beside it)
	/** @type {Map<string, {uuid: string, name: string}[]>} */
	const users = new Map();
	get(objectsGroup)?.traverse?.((/** @type {any} */ o) => {
		const p = o?.userData?.packRef?.path;
		if (typeof p !== 'string' || !p) return;
		const base = String(packsBase).replace(/\/+$/, '') + '/';
		const rel = (p.startsWith(base) ? p.slice(base.length) : p).replace(/^\/+/, '');
		const key = rel.slice(0, rel.lastIndexOf('/') + 1);
		if (!users.has(key)) users.set(key, []);
		users.get(key)?.push({ uuid: o.uuid, name: o.name || '' });
	});
	for (const [path, bytes] of Object.entries(out)) {
		if (path.startsWith(PACKS_DIR + '/')) {
			const rel = path.slice(PACKS_DIR.length + 1);
			const who = users.get(rel.slice(0, rel.lastIndexOf('/') + 1)) || [];
			const name = who[0]?.name || rel.split('/')[1] || rel;
			rows.push({ path, bytes: bytes.byteLength, label: who.length > 1 ? `${name} (×${who.length})` : name, kind: 'pack', ...(who[0] ? { where: who[0].uuid } : {}) });
		} else if (sky.files.includes(path) || /^hdri\//.test(path)) {
			const tier = /_(\d+k)\./i.exec(path)?.[1] || '';
			rows.push({ path, bytes: bytes.byteLength, label: `Sky: ${sky.label}${tier ? ' (' + tier.toUpperCase() + ')' : ''}`, kind: 'sky' });
		} else if (path.startsWith(MODULES_DIR + '/')) {
			const m = modules.find((r) => r.file === path);
			rows.push({ path, bytes: bytes.byteLength, label: `Module ${m?.id || path.slice(MODULES_DIR.length + 1)}`, kind: 'module' });
		} else if (path === 'thumbnail.png') rows.push({ path, bytes: bytes.byteLength, label: 'Cover image', kind: 'cover' });
	}
	return rows;
}

/** the pages a build has that an export never carries as such (the play entry BECOMES index.html) */
const ENTRY_PAGES = new Set(['index.html', 'play.html', 'kit.html']);

/**
 * 63 PG1: the page an exported game boots — the slim play entry when the build has one (every build
 * since 1.57), else the editor's index.html (an older deployment exporting).
 * @param {{files: {path: string}[]}} manifest @returns {string}
 */
export function playEntryOf(manifest) {
	return manifest.files.some((f) => f.path === 'play.html') ? 'play.html' : 'index.html';
}

/**
 * 63 PG1: the runtime files an export copies: the manifest minus the entry pages, and — when the
 * game boots the play entry — minus what only the editor / kit page reach (`editorOnly`).
 * @template {{path: string, bytes: number, editorOnly?: boolean}} F
 * @param {{files: F[]}} manifest @returns {F[]}
 */
export function runtimeFiles(manifest) {
	const slim = playEntryOf(manifest) === 'play.html';
	return manifest.files.filter((f) => !ENTRY_PAGES.has(f.path) && !(slim && f.editorOnly));
}

/**
 * The trimmed packs index for the files an export carries: `index.json` keeping only the packs
 * used (their `value` pointing at a trimmed list beside it) and each list keeping only the item
 * folders used. Returns `{files: {relativePath: bytes}, lodPaths}` under the packs dir — 63: `lodPaths`
 * = the kept rows' `lods` files beside the models the scene uses (the runtime asks for them).
 * @param {string} base the remote PACKS_BASE @param {string[]} paths PACKS_BASE-relative files
 */
async function packIndexFor(base, paths) {
	const enc = new TextEncoder();
	/** @type {Map<string, Set<string>>} pack -> item folders */
	const used = new Map();
	for (const p of paths) {
		const [pack, folder] = p.split('/');
		if (!pack || !folder) continue;
		if (!used.has(pack)) used.set(pack, new Set());
		used.get(pack)?.add(folder);
	}
	if (!used.size) return { files: {}, lodPaths: [] };
	const indexRes = await fetch(base + '/index.json', { cache: 'no-cache' });
	if (!indexRes.ok) throw new Error('index ' + indexRes.status);
	const index = await indexRes.json();
	/** @type {Record<string, Uint8Array>} */
	const files = {};
	/** @type {Set<string>} */
	const lodPaths = new Set();
	const rows = [];
	for (const row of Array.isArray(index) ? index : []) {
		if (!row?.name || !used.has(row.name) || !row.value || /^https?:\/\//.test(row.value)) continue;
		const listPath = String(row.value).replace(/^\/+/, '');
		const listRes = await fetch(base + '/' + listPath, { cache: 'no-cache' });
		if (!listRes.ok) continue;
		const list = await listRes.json();
		const keep = Array.isArray(list) ? list.filter((/** @type {any} */ o) => used.get(row.name)?.has(o?.name)) : [];
		files[listPath] = enc.encode(JSON.stringify(keep));
		rows.push(row);
		// each kept row's `lods` sit beside the model file(s) the scene uses from that folder
		for (const item of keep) {
			const lods = packLodsOf(item);
			if (!lods.length) continue;
			for (const p of paths) {
				if (!p.startsWith(row.name + '/' + item.name + '/') || !/\.(glb|gltf)$/i.test(p) || /\.lod\d+\./i.test(p)) continue;
				const dir = p.slice(0, p.lastIndexOf('/') + 1);
				for (const l of lods) lodPaths.add(dir + l.file);
			}
		}
	}
	files['index.json'] = enc.encode(JSON.stringify(rows));
	return { files, lodPaths: [...lodPaths] };
}

/**
 * The size a zip is likely to be BEFORE building it: the runtime from the manifest (JS deflates
 * to roughly a third) + the scene bundle as Save would write it. Packs are unknown until fetched.
 * @returns {Promise<{runtime: number, estimateZip: number, files: number}>}
 */
export async function estimateExport() {
	const manifest = await loadExportManifest();
	const files = runtimeFiles(manifest);
	let raw = 0;
	let zipped = 0;
	for (const f of files) {
		raw += f.bytes;
		zipped += DEFLATE.test(f.path) ? f.bytes * 0.32 : f.bytes;
	}
	return { runtime: raw, estimateZip: Math.round(zipped), files: files.length + 1 };
}
