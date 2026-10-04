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
import { APP_VERSION } from '../version.js';
import { slugify, rewriteIndexHtml, stripHostInjected, makePlayJs, embedSnippet, collectPackRefs, fmtBytes } from './exportCore.js';

export { slugify, rewriteIndexHtml, stripHostInjected, makePlayJs, embedSnippet, collectPackRefs, fmtBytes };

export const EXPORT_PRESETS = Object.freeze({
	itch: { id: 'itch', label: 'itch.io', zip: true },
	static: { id: 'static', label: 'Static host', zip: true },
	embed: { id: 'embed', label: 'Embed', zip: false }
});

/** where the bundle keeps the pack files (and what play.js's packsBase says) */
export const PACKS_DIR = 'assets/packs';
export const MODULES_DIR = 'assets/modules';

/** text kinds worth deflating; everything else (images, zips, audio) is stored */
const DEFLATE = /\.(m?js|css|html?|json|svg|txt|wasm|glb|gltf|bin|map|xml)$/i;

/**
 * @typedef {{
 *   preset: 'itch' | 'static' | 'embed',
 *   title: string,
 *   thumbnail: boolean,
 *   startFullscreen: boolean,
 *   showFps: boolean,
 *   quality: string,
 *   vrButton: boolean,
 *   useCdnForPacks: boolean,
 *   viewport?: {w: number, h: number}
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

/** @returns {Promise<{format: number, version: string, files: {path: string, bytes: number}[], bytes: number}>} */
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
 */
async function fetchAll(urls, onFile, concurrency = 6) {
	let next = 0;
	const worker = async () => {
		while (next < urls.length) {
			const i = next++;
			const res = await fetch(urls[i]);
			if (!res.ok) throw new Error(`${urls[i]} — HTTP ${res.status}`);
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

/** the README every zip carries @param {{title: string, preset: string, id: string, cdn: boolean}} o */
function readmeText({ title, preset, id, cdn }) {
	return [
		`${title || 'Game'} — made with ThePrototype (https://theprototype.app)`,
		'',
		'This folder is a complete, static web game: open index.html from any web server.',
		'It needs no install and no server code. It does NOT run from file:// (browsers refuse',
		'module scripts there) — for a quick local look: `npx serve .` or `python3 -m http.server`.',
		'',
		preset === 'itch'
			? 'itch.io: upload the ZIP as-is, set "Kind of project" to HTML and tick "This file will be played in the browser". Leave "SharedArrayBuffer support" OFF — the game does not need it.'
			: 'Static hosts (Netlify, Cloudflare Pages, GitHub Pages): publish this folder as the site root or any subfolder; all paths are relative. The .nojekyll file keeps GitHub Pages from hiding _app/.',
		cdn ? 'Packs load from the jsDelivr CDN at runtime (the "Use CDN for packs" option), so the game needs internet.' : 'Everything the game loads is inside this folder.',
		'',
		'The "Made with ThePrototype" badge is drawn by the engine and has no off switch. You own',
		'this file and can edit it — the badge is a request, not DRM. Please keep it.',
		'',
		`Export id: ${id} · engine ${APP_VERSION}`
	].join('\n');
}

/**
 * Build the export. Resolves to the zip (preset itch/static) plus what went in it, after
 * validating it with the same rules `scripts/check-export.cjs` applies.
 * @param {ExportOptions} opts
 * @param {(p: ExportProgress) => void} [onProgress]
 * @returns {Promise<{blob: Blob, fileName: string, id: string, report: import('./exportValidate.js').ExportReport,
 *   breakdown: {runtime: number, scene: number, packs: number, modules: number}, warnings: string[]}>}
 */
export async function buildExport(opts, onProgress = () => {}) {
	if (opts.preset === 'embed') throw new Error('The Embed preset makes a snippet, not a zip.');
	const id = newExportId();
	const title = String(opts.title || '').trim() || 'Game';
	/** @type {string[]} */
	const warnings = [];
	/** strip what the web host injected into a page it served; every removal is reported @param {string} path @param {string} html */
	const fromHost = (path, html) => {
		const r = stripHostInjected(html);
		for (const url of r.removed) warnings.push(`Removed ${url} from ${path}: the web host added it to the page it served, and an export loads nothing from the internet.`);
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
	const payload = buildSessionPayload(title);
	if (!payload?.objects?.length) throw new Error('The scene is empty — add something to play first.');
	const scene = await exportSessionZip(payload, { assets: true, flow: true, packs: false });
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
			const extra = await packIndexFor(base, list);
			for (const [path, bytes] of Object.entries(extra)) {
				out[`${PACKS_DIR}/${path}`] = bytes;
				breakdown.packs += bytes.byteLength;
			}
		} catch {
			warnings.push('The packs index could not be read — pieces fall back to automatic LOD in the export.');
		}
	}

	// 4. the engine runtime, straight from this deployment
	const runtime = manifest.files.filter((f) => f.path !== 'index.html');
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
	const indexRes = await fetch(pageUrl('index.html'));
	if (!indexRes.ok) throw new Error('index.html — HTTP ' + indexRes.status);
	const indexHtml = rewriteIndexHtml(fromHost('index.html', await indexRes.text()), { title });
	out['index.html'] = enc.encode(indexHtml);

	// 5. the config, the cover, the readme
	const config = {
		version: 1,
		id,
		title,
		scene: 'scene.tpscene',
		packsBase,
		modules: moduleRows,
		startFullscreen: !!opts.startFullscreen,
		showFps: !!opts.showFps,
		quality: opts.quality || 'auto',
		vrButton: opts.vrButton !== false,
		preset: opts.preset,
		builtWith: APP_VERSION
	};
	const playJs = makePlayJs(config);
	out['play.js'] = enc.encode(playJs);
	if (opts.thumbnail) {
		const cover = await captureCover();
		if (cover) out['thumbnail.png'] = cover;
	}
	out['README.txt'] = enc.encode(readmeText({ title, preset: opts.preset, id, cdn: !!(paths.size && opts.useCdnForPacks) }));
	if (opts.preset === 'static') out['.nojekyll'] = new Uint8Array(0);

	// 6. validate with the proof's own rules, then zip
	onProgress({ phase: 'Checking', done: 0, total: 1 });
	const dec = new TextDecoder();
	const report = validateExport(
		Object.entries(out).map(([path, bytes]) => ({
			path,
			bytes: bytes.byteLength,
			text: path === 'index.html' ? indexHtml : path === 'play.js' ? playJs : /\.m?js$/.test(path) && path.startsWith('_app/') && bytes.byteLength < 4e6 ? dec.decode(bytes) : undefined
		})),
		{ preset: opts.preset, limits: ITCH_LIMITS }
	);
	if (!report.ok) throw new Error('The export failed its own check: ' + report.errors.slice(0, 3).join(' · '));
	warnings.push(...report.warnings);

	onProgress({ phase: 'Zipping', done: 0, total: 1 });
	/** @type {Record<string, [Uint8Array, {level: 0 | 6}]>} */
	const zipInput = {};
	for (const [path, bytes] of Object.entries(out)) zipInput[path] = [bytes, { level: DEFLATE.test(path) ? 6 : 0 }];
	const zipped = await zipAsync(zipInput);
	onProgress({ phase: 'Done', done: 1, total: 1 });
	const blob = new Blob([/** @type {BlobPart} */ (zipped)], { type: 'application/zip' });
	return { blob, fileName: `${slugify(title)}-${opts.preset === 'itch' ? 'itch' : 'web'}.zip`, id, report, breakdown, warnings };
}

/**
 * The trimmed packs index for the files an export carries: `index.json` keeping only the packs
 * used (their `value` pointing at a trimmed list beside it) and each list keeping only the item
 * folders used. Returns `{relativePath: bytes}` under the packs dir.
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
	if (!used.size) return {};
	const indexRes = await fetch(base + '/index.json', { cache: 'no-cache' });
	if (!indexRes.ok) throw new Error('index ' + indexRes.status);
	const index = await indexRes.json();
	/** @type {Record<string, Uint8Array>} */
	const files = {};
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
	}
	files['index.json'] = enc.encode(JSON.stringify(rows));
	return files;
}

/**
 * The size a zip is likely to be BEFORE building it: the runtime from the manifest (JS deflates
 * to roughly a third) + the scene bundle as Save would write it. Packs are unknown until fetched.
 * @returns {Promise<{runtime: number, estimateZip: number, files: number}>}
 */
export async function estimateExport() {
	const manifest = await loadExportManifest();
	let raw = 0;
	let zipped = 0;
	for (const f of manifest.files) {
		raw += f.bytes;
		zipped += DEFLATE.test(f.path) ? f.bytes * 0.32 : f.bytes;
	}
	return { runtime: raw, estimateZip: Math.round(zipped), files: manifest.files.length };
}
