// 48 F3 — THE THIRD-PARTY LICENCE NOTICES PAGE, generated, never hand-kept.
//
// The app bundles libheif-js (the HEIC/HEIF decoder, LGPL-3.0) and well over a hundred other open-source
// packages; every one of them asks for its notice to travel with the program. A hand-kept list goes stale on
// the next dependency bump, so the page is GENERATED from what is actually there:
//
//   · the lockfile's PRODUCTION closure (every package-lock entry not marked dev), plus
//   · every package src/ imports (Svelte convention keeps svelte, the kit runtime, flowbite… in
//     devDependencies although they ship in the bundle) and its own production dependency closure, plus
//   · the files vendored into static/ (the Draco and Basis decoders, the two fonts, the bundled HDRIs).
//
// Over-inclusion is harmless on a notices page; a missing library is the failure, so vite.config.ts's
// `thirdPartyNotices` plugin ALSO adds every package a client bundle chunk really contains (a build can
// never ship a library this list does not name). The text of each licence comes from the package's own
// LICENSE / LICENCE / COPYING / NOTICE files; a package without one shows its declared licence id.
//
//   node scripts/third-party-notices.cjs [outDir]     (default ./static) — writes third-party-notices.{html,json}
//
// Tests: tests/unit/thirdPartyNotices.test.js (libheif-js + three + every runtime dependency are listed).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

/** @typedef {{name: string, version: string, license: string, url: string, text: string, source: string}} Notice */

/** files vendored into static/ that are not npm packages @type {{name: string, version: string, license: string, url: string, file?: string, text?: string, source: string}[]} */
const VENDORED = [
	{ name: 'Draco 3D decoder', version: 'static/draco', license: 'Apache-2.0', url: 'https://github.com/google/draco', source: 'static/draco (from three.js examples)' },
	{ name: 'Basis Universal transcoder', version: 'static/basis', license: 'Apache-2.0', url: 'https://github.com/BinomialLLC/basis_universal', source: 'static/basis (from three.js examples)' },
	{ name: 'IBM Plex Sans / Mono', version: 'static/fonts', license: 'OFL-1.1', url: 'https://github.com/IBM/plex', file: 'static/fonts/LICENSE-ibm-plex.txt', source: 'static/fonts' },
	{ name: 'Press Start 2P', version: 'static/fonts', license: 'OFL-1.1', url: 'https://fonts.google.com/specimen/Press+Start+2P', file: 'static/fonts/LICENSE-press-start-2p.txt', source: 'static/fonts' },
	{ name: 'Noto Sans subsets (3D label fonts)', version: 'static/fonts/unicode-font-resolver', license: 'OFL-1.1', url: 'https://github.com/notofonts', file: 'static/fonts/unicode-font-resolver/LICENSE-noto.txt', source: 'static/fonts/unicode-font-resolver (scripts/fetch-troika-fonts.cjs)' },
	{ name: 'unicode-font-resolver data', version: 'v1.0.1', license: 'MIT', url: 'https://github.com/lojjic/unicode-font-resolver', file: 'static/fonts/unicode-font-resolver/LICENSE-unicode-font-resolver.txt', source: 'static/fonts/unicode-font-resolver (scripts/fetch-troika-fonts.cjs)' },
	{ name: 'ShaderGradient shaders (Gradient lab port)', version: '68bdd74', license: 'MIT', url: 'https://github.com/ruucm/shadergradient', file: 'src/lib/LICENSE-shadergradient.txt', source: 'src/lib/gradientLab.js (GLSL ported; includes glsl-noise classic noise, MIT)' },
	{ name: 'Poly Haven HDRIs', version: 'static/hdri', license: 'CC0-1.0', url: 'https://polyhaven.com/license', file: 'static/hdri/CREDITS.md', source: 'static/hdri' }
];

/** always in the bundle though nothing imports them by name (the compiler and the kit emit the imports) */
const ALWAYS = ['svelte', '@sveltejs/kit'];

/** @param {string} file */
function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

/** the package name a bare import specifier names @param {string} spec @returns {string|null} */
function packageOf(spec) {
	if (!spec || /^[./$~]|^virtual:|^node:|^data:|^https?:/.test(spec)) return null;
	const parts = spec.split('/');
	return spec.startsWith('@') ? (parts.length > 1 ? parts[0] + '/' + parts[1] : null) : parts[0];
}

/** every bare specifier src/ imports (static, dynamic, side-effect, and the CSS import / plugin rules) @param {string} root */
function importedPackages(root) {
	const out = new Set();
	const walk = (/** @type {string} */ dir) => {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) walk(p);
			else if (/\.(js|ts|svelte|css|mjs|cjs)$/.test(ent.name)) {
				const src = fs.readFileSync(p, 'utf8');
				const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|@import\s+|@plugin\s+|new URL\(\s*)['"]([^'"\n]+)['"]/g;
				let m;
				while ((m = re.exec(src))) {
					const name = packageOf(m[1]);
					if (name) out.add(name);
				}
			}
		}
	};
	walk(path.join(root, 'src'));
	return out;
}

/** npm's resolution of `dep` as seen from the lock path `from` @param {Record<string, any>} pkgs @param {string} from @param {string} dep */
function resolveIn(pkgs, from, dep) {
	let base = from;
	for (;;) {
		const cand = (base ? base + '/' : '') + 'node_modules/' + dep;
		if (pkgs[cand]) return cand;
		if (!base) return null;
		const at = base.lastIndexOf('/node_modules/');
		base = at < 0 ? '' : base.slice(0, at);
	}
}

/**
 * The lock paths of every package to list.
 * @param {string} root @param {Iterable<string>} [extra] package names a bundle really holds
 * @returns {string[]}
 */
function noticePaths(root, extra = []) {
	const lock = readJson(path.join(root, 'package-lock.json'));
	/** @type {Record<string, any>} */
	const pkgs = lock?.packages ?? {};
	const want = new Set();
	// 1. the production closure, as npm computed it
	// (a platform binary — an `os` / `cpu` entry such as sharp's libvips builds — is a Node.js add-on: it can never
	// be in a browser bundle)
	for (const [k, v] of Object.entries(pkgs)) if (k && !v.dev && !v.devOptional && !v.link && !v.os && !v.cpu) want.add(k);
	// 2. what src/ imports (+ ALWAYS + a bundle's own list), with each one's production dependencies
	const queue = [];
	for (const name of [...importedPackages(root), ...ALWAYS, ...extra]) {
		const at = resolveIn(pkgs, '', name);
		if (at) queue.push(at);
	}
	const walked = new Set();
	while (queue.length) {
		const at = /** @type {string} */ (queue.pop());
		if (walked.has(at)) continue;
		walked.add(at);
		if (pkgs[at]?.os || pkgs[at]?.cpu) continue;
		want.add(at);
		const deps = { ...(pkgs[at]?.dependencies ?? {}), ...(pkgs[at]?.optionalDependencies ?? {}) };
		for (const dep of Object.keys(deps)) {
			const d = resolveIn(pkgs, at, dep);
			if (d && !walked.has(d)) queue.push(d);
		}
	}
	return [...want].filter((k) => fs.existsSync(path.join(root, k, 'package.json')));
}

/** a package's licence id, whatever shape its package.json used @param {any} pj */
function licenceId(pj) {
	const l = pj?.license ?? pj?.licenses;
	if (typeof l === 'string') return l;
	if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean).join(' OR ');
	if (l && typeof l === 'object' && typeof l.type === 'string') return l.type;
	return 'UNKNOWN';
}

/** @param {any} pj */
function repoUrl(pj) {
	const r = typeof pj?.repository === 'string' ? pj.repository : pj?.repository?.url;
	const raw = r || pj?.homepage || '';
	const gh = /^github:(.+)$/.exec(raw) || /^([\w.-]+\/[\w.-]+)$/.exec(raw);
	if (gh) return 'https://github.com/' + gh[1];
	return String(raw)
		.replace(/^git\+/, '')
		.replace(/^git:\/\//, 'https://')
		.replace(/^ssh:\/\/git@/, 'https://')
		.replace(/\.git$/, '');
}

/** the concatenated licence files of a package folder @param {string} dir */
function licenceText(dir) {
	let files = [];
	try {
		files = fs.readdirSync(dir).filter((f) => LICENCE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile());
	} catch {
		return '';
	}
	files.sort();
	return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim()).join('\n\n');
}

/**
 * Every notice, sorted by name.
 * @param {{root?: string, extra?: Iterable<string>}} [opts]
 * @returns {Notice[]}
 */
function collectNotices(opts = {}) {
	const root = opts.root ?? ROOT;
	/** @type {Map<string, Notice>} */
	const byId = new Map();
	for (const at of noticePaths(root, opts.extra)) {
		const dir = path.join(root, at);
		const pj = readJson(path.join(dir, 'package.json'));
		if (!pj?.name) continue;
		const id = pj.name + '@' + pj.version;
		if (byId.has(id)) continue;
		byId.set(id, { name: pj.name, version: String(pj.version ?? ''), license: licenceId(pj), url: repoUrl(pj), text: licenceText(dir), source: 'npm' });
	}
	const out = [...byId.values()];
	for (const v of VENDORED) {
		let text = v.text ?? '';
		if (v.file) {
			try {
				text = fs.readFileSync(path.join(root, v.file), 'utf8').trim();
			} catch {
				/* the folder is gone from this checkout: keep the entry, no text */
			}
		}
		out.push({ name: v.name, version: v.version, license: v.license, url: v.url, text, source: v.source });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** @param {string} s */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/**
 * The standalone page (no app chrome: it opens in a new tab, and inside an exported game).
 * @param {Notice[]} list @param {{version?: string}} [opts]
 */
function renderHtml(list, opts = {}) {
	const counts = new Map();
	for (const n of list) counts.set(n.license, (counts.get(n.license) ?? 0) + 1);
	const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l, c]) => `<li><b>${esc(l)}</b> — ${c}</li>`).join('');
	const heif = list.find((n) => n.name === 'libheif-js');
	const rows = list
		.map((n) => {
			const id = 'lib-' + n.name.replace(/[^a-z0-9]+/gi, '-') + '-' + n.version.replace(/[^a-z0-9]+/gi, '-');
			const link = n.url ? `<a href="${esc(n.url)}" rel="noopener noreferrer">${esc(n.url)}</a>` : '';
			const body = n.text ? `<details><summary>Licence text</summary><pre>${esc(n.text)}</pre></details>` : `<p class="none">No licence file ships in this package; its declared licence is ${esc(n.license)}.</p>`;
			return `<section id="${esc(id)}" data-name="${esc(n.name)}" data-license="${esc(n.license)}"><h2>${esc(n.name)} <span class="v">${esc(n.version)}</span></h2><p class="meta"><span class="lic">${esc(n.license)}</span> ${link}</p>${body}</section>`;
		})
		.join('\n');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Third-party licences — theprototype.app${opts.version ? ' ' + esc(opts.version) : ''}</title>
<style>
:root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
body { margin: 0 auto; padding: 24px 16px 64px; max-width: 880px; background: Canvas; color: CanvasText; }
h1 { font-size: 1.5rem; margin: 0 0 8px; }
h2 { font-size: 1rem; margin: 0; }
.v, .meta { color: GrayText; font-weight: 400; }
.meta { margin: 2px 0 6px; overflow-wrap: anywhere; }
.lic { font-weight: 600; color: CanvasText; margin-right: 8px; }
section { padding: 12px 0; border-top: 1px solid GrayText; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; max-height: 420px; overflow: auto; }
.note { padding: 12px 14px; border: 1px solid GrayText; border-radius: 8px; }
.none { color: GrayText; margin: 0; }
ul.sum { columns: 2; padding-left: 18px; }
</style>
</head>
<body>
<h1>Third-party licences</h1>
<p>theprototype.app${opts.version ? ' ' + esc(opts.version) : ''} is built with the open-source software below. Each entry names its licence and links to its source; the full licence text is under each one. This page is generated from the packages the app is built from, so it changes with them.</p>
${heif ? `<p class="note" id="lgpl-note"><b>libheif-js ${esc(heif.version)} (LGPL-3.0)</b> decodes HEIC / HEIF photos. It ships unmodified as its own file, loaded only when such a photo is opened, so it can be replaced with another build of the same library. Its source code: <a href="${esc(heif.url || 'https://github.com/catdad-experiments/libheif-js')}" rel="noopener noreferrer">${esc(heif.url || 'https://github.com/catdad-experiments/libheif-js')}</a> (libheif itself: <a href="https://github.com/strukturag/libheif" rel="noopener noreferrer">github.com/strukturag/libheif</a>).</p>` : ''}
<p>${list.length} components, by licence:</p>
<ul class="sum">${summary}</ul>
${rows}
</body>
</html>
`;
}

/**
 * Write both files. @param {string} outDir @param {{root?: string, extra?: Iterable<string>, version?: string}} [opts]
 * @returns {Notice[]}
 */
function writeNotices(outDir, opts = {}) {
	const list = collectNotices(opts);
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, 'third-party-notices.html'), renderHtml(list, opts));
	fs.writeFileSync(path.join(outDir, 'third-party-notices.json'), JSON.stringify(list.map(({ text, ...rest }) => ({ ...rest, hasText: !!text }))));
	return list;
}

module.exports = { collectNotices, renderHtml, writeNotices, packageOf, importedPackages, VENDORED, ALWAYS };

if (require.main === module) {
	const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'static'));
	const pkg = readJson(path.join(ROOT, 'package.json'));
	const list = writeNotices(out, { version: pkg?.version });
	console.log(`third-party notices: ${list.length} components -> ${out}/third-party-notices.html`);
}
