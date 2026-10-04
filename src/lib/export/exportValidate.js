// 36-export (E1) — IS THIS EXPORT A WELL-FORMED, SELF-CONTAINED STATIC GAME? One pure function
// shared by the in-app exporter (it validates before it offers the download) and
// `scripts/check-export.cjs` (the proof, over an unzipped folder or the zip itself). A LEAF.
//
// THE itch.io HTML5 LIMITS (https://itch.io/docs/creators/html5, read 2026-10-04):
//   · "The ZIP file should not contain more than 1,000 individual files after extraction."
//   · "The size of all the extracted content should not be greater than 500MB."
//   · "The size any single extracted file should not be greater than 200MB."
//   · "The maximum length of a file name including path should not be greater than 240
//     characters long."
//   · "The filenames are case sensitive and should be encoded as UTF-8"
//   · an `index.html` is the entry point (we put it at the zip ROOT, no wrapping folder).
// SharedArrayBuffer: itch has an opt-in "SharedArrayBuffer support" frame option (it sends
// COOP/COEP credentialless). The engine does NOT use it (single-threaded rapier, no wasm
// threads), so leave that box UNTICKED — with it on, a "Use CDN for packs" export can have its
// cross-origin pack fetches refused.

const MB = 1024 * 1024;

export const ITCH_LIMITS = Object.freeze({
	maxFiles: 1000,
	maxTotalBytes: 500 * MB,
	maxFileBytes: 200 * MB,
	maxPathLength: 240
});

/** config keys play.js may carry — anything else is reported (and ignored by the runtime) */
export const CONFIG_KEYS = Object.freeze([
	'version',
	'id',
	'title',
	'scene',
	'packsBase',
	'modules',
	'startFullscreen',
	'showFps',
	'quality',
	'vrButton',
	'preset',
	'builtWith'
]);

/**
 * @typedef {{path: string, bytes: number, text?: string}} ExportFile
 * `text` is optional and only consulted for index.html, play.js and the JS chunks' absolute-URL
 * scan (callers pass it for files under a few MB).
 * @typedef {{ok: boolean, errors: string[], warnings: string[], config: any,
 *   stats: {files: number, bytes: number, largest: {path: string, bytes: number} | null, runtimeFiles: number}}} ExportReport
 */

/**
 * Read the config out of play.js's text: `window.__TP_EXPORT__ = {…};`.
 * @param {string} text @returns {any} the object, or null when it is not the shape we write
 */
export function parsePlayJs(text) {
	const m = /window\.__TP_EXPORT__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(String(text || '').trim());
	if (!m) return null;
	try {
		return JSON.parse(m[1]);
	} catch {
		return null;
	}
}

/** the `src`/`href` values of an HTML document, in order @param {string} html */
export function htmlRefs(html) {
	/** @type {string[]} */
	const out = [];
	const re = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi;
	let m;
	while ((m = re.exec(html))) out.push(m[2]);
	// the kit boot script imports its two entries by string
	const imp = /import\(\s*(["'])(.*?)\1\s*\)/g;
	while ((m = imp.exec(html))) out.push(m[2]);
	return out;
}

/** @param {string} p */
function normalizeRel(p) {
	return p.replace(/^\.\//, '').split('#')[0].split('?')[0];
}

/**
 * Validate an export's file list.
 * @param {ExportFile[]} files
 * @param {{preset?: string, limits?: typeof ITCH_LIMITS}} [opts]
 * @returns {ExportReport}
 */
export function validateExport(files, opts = {}) {
	const limits = opts.limits || ITCH_LIMITS;
	const preset = opts.preset || '';
	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];
	const byPath = new Map(files.map((f) => [f.path, f]));
	let total = 0;
	/** @type {{path: string, bytes: number} | null} */
	let largest = null;
	/** @type {Map<string, string>} */
	const folded = new Map();

	for (const f of files) {
		total += f.bytes;
		if (!largest || f.bytes > largest.bytes) largest = { path: f.path, bytes: f.bytes };
		if (f.path.startsWith('/') || f.path.includes('\\') || f.path.split('/').includes('..'))
			errors.push(`bad path "${f.path}" (relative paths only, forward slashes, no "..")`);
		if (f.path.length > limits.maxPathLength) errors.push(`path longer than ${limits.maxPathLength} characters: ${f.path}`);
		if (f.bytes > limits.maxFileBytes) errors.push(`file over ${limits.maxFileBytes / MB} MB: ${f.path}`);
		const low = f.path.toLowerCase();
		const other = folded.get(low);
		if (other && other !== f.path) errors.push(`two paths differ only by case: ${other} / ${f.path}`);
		folded.set(low, f.path);
		if (/(^|\/)sw\.js$/.test(f.path)) errors.push('a service worker file is in the export (sw.js) — exports ship none');
	}
	if (files.length > limits.maxFiles) errors.push(`${files.length} files — the limit is ${limits.maxFiles}`);
	if (total > limits.maxTotalBytes) errors.push(`${(total / MB).toFixed(1)} MB extracted — the limit is ${limits.maxTotalBytes / MB} MB`);

	// the entry point
	const index = byPath.get('index.html');
	if (!index) errors.push('no index.html at the root of the zip');
	else if (typeof index.text === 'string') {
		const html = index.text;
		for (const ref of htmlRefs(html)) {
			if (/^(data:|mailto:|#)/i.test(ref)) continue;
			if (/^(https?:)?\/\//i.test(ref)) {
				errors.push(`index.html loads an absolute URL: ${ref}`);
				continue;
			}
			if (ref.startsWith('/')) {
				errors.push(`index.html uses a root-absolute path: ${ref}`);
				continue;
			}
			const rel = normalizeRel(ref);
			if (rel && !byPath.has(rel)) errors.push(`index.html references a missing file: ${ref}`);
		}
		if (!/<script[^>]+src=["']\.\/play\.js["']/.test(html)) errors.push('index.html does not load ./play.js before the app');
		if (/serviceWorker\s*\.\s*register/.test(html)) errors.push('index.html registers a service worker');
		if (/rel=["']manifest["']/.test(html)) warnings.push('index.html still links a web app manifest');
	}

	// the config
	let config = null;
	const play = byPath.get('play.js');
	if (!play) errors.push('no play.js at the root');
	else if (typeof play.text === 'string') {
		config = parsePlayJs(play.text);
		if (!config) errors.push('play.js does not hold a window.__TP_EXPORT__ = {…} config');
		else {
			for (const key of Object.keys(config))
				if (!CONFIG_KEYS.includes(key))
					warnings.push(`play.js key "${key}" is not part of the config — the runtime ignores it` + (/badge/i.test(key) ? ' (the badge cannot be turned off)' : ''));
			const scene = normalizeRel(String(config.scene || 'scene.tpscene'));
			if (!byPath.has(scene)) errors.push(`the scene file ${scene} is missing`);
			for (const m of Array.isArray(config.modules) ? config.modules : [])
				if (!byPath.has(normalizeRel(String(m?.file || '')))) errors.push(`module ${m?.id} file ${m?.file} is missing`);
			if (config.packsBase) {
				const dir = normalizeRel(String(config.packsBase)).replace(/\/+$/, '') + '/';
				if (!files.some((f) => f.path.startsWith(dir))) warnings.push(`packsBase ${config.packsBase} holds no files`);
			}
		}
	}

	// the runtime's own chunks must stay relative: one root-absolute import and the game
	// works at a domain root and nowhere else (itch serves from /html/<n>/)
	let runtimeFiles = 0;
	for (const f of files) {
		if (!f.path.startsWith('_app/')) continue;
		runtimeFiles++;
		if (typeof f.text !== 'string') continue;
		if (/(?:from\s*|import\(\s*)["']\/_app\//.test(f.text) || /["']\/_app\/immutable\//.test(f.text))
			errors.push(`${f.path} imports through a root-absolute /_app/ path`);
	}
	if (!runtimeFiles) errors.push('no engine runtime (_app/) in the export');

	if (preset === 'static' && !byPath.has('.nojekyll')) warnings.push('no .nojekyll — GitHub Pages would hide the _app folder');

	return { ok: errors.length === 0, errors, warnings, config, stats: { files: files.length, bytes: total, largest, runtimeFiles } };
}
