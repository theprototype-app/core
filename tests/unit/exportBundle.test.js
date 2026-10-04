import { describe, it, expect } from 'vitest';
import { normalizeExportConfig, EXPORT_QUALITIES } from '../../src/lib/export/exportBoot.js';
import { badgeHref } from '../../src/lib/export/badge.js';
import { liftAbove } from '../../src/lib/play/hudAvoid.js';
import { rewriteIndexHtml, makePlayJs, embedSnippet, collectPackRefs, slugify } from '../../src/lib/export/exportCore.js';
import { validateExport, parsePlayJs, htmlRefs, ITCH_LIMITS } from '../../src/lib/export/exportValidate.js';
import { coerceExportPrefs, DEFAULT_EXPORT_PREFS } from '../../src/lib/export/exportStores.js';

// 36-export (E1): the export bundle's pure pieces — the config an exported page boots from,
// the badge link (A1), where the badge may sit, the index.html rewrite, and the validator that
// both the in-app exporter and scripts/check-export.cjs run.

const INDEX = `<!doctype html>
<html lang="en" class="dark">
	<head>
		<meta charset="utf-8" />
		<link rel="icon" href="./logo.svg" />
		<link rel="manifest" href="./manifest.webmanifest" />
		<meta name="apple-mobile-web-app-title" content="theprototype" />
		<link href="./_app/immutable/entry/start.X.js" rel="modulepreload">
	</head>
	<body>
		<script>
			{
				Promise.all([import("./_app/immutable/entry/start.X.js"), import("./_app/immutable/entry/app.Y.js")]);
			}
		</script>
	</body>
</html>`;

/** a minimal valid export's file list @param {Record<string, any>} [cfg] */
function bundle(cfg = {}) {
	const config = { version: 1, id: 'xabc', title: 'Mini Golf', scene: 'scene.tpscene', packsBase: '', modules: [], preset: 'itch', ...cfg };
	const html = rewriteIndexHtml(INDEX, { title: 'Mini Golf' });
	return [
		{ path: 'index.html', bytes: html.length, text: html },
		{ path: 'play.js', bytes: 100, text: makePlayJs(config) },
		{ path: 'scene.tpscene', bytes: 5000 },
		{ path: 'logo.svg', bytes: 2000 },
		{ path: '_app/immutable/entry/start.X.js', bytes: 900, text: 'import{a}from"../chunks/Q.js";' },
		{ path: '_app/immutable/entry/app.Y.js', bytes: 900, text: 'import("./x.js")' },
		{ path: '_app/immutable/chunks/Q.js', bytes: 900, text: 'export const a=1' }
	];
}

describe('exportBoot.normalizeExportConfig', () => {
	it('is null on a normal page (no config)', () => {
		expect(normalizeExportConfig(undefined)).toBeNull();
		expect(normalizeExportConfig('x')).toBeNull();
	});
	it('copies KNOWN keys only — no key can hide the badge', () => {
		const c = /** @type {any} */ (normalizeExportConfig({ title: 'T', badge: false, hideBadge: true, showBadge: false, noBadge: 1 }));
		expect(c.title).toBe('T');
		for (const k of ['badge', 'hideBadge', 'showBadge', 'noBadge']) expect(k in c).toBe(false);
		expect(Object.keys(c).some((k) => /badge/i.test(k))).toBe(false);
	});
	it('keeps paths relative (no scheme, no root, no ..)', () => {
		const c = /** @type {any} */ (
			normalizeExportConfig({
				scene: 'https://evil.example/x.tpscene',
				packsBase: '/assets/packs',
				modules: [{ id: 'a', file: '../a.zip' }, { id: 'b', file: 'assets/modules/b.zip' }]
			})
		);
		expect(c.scene).toBe('scene.tpscene');
		expect(c.packsBase).toBe('');
		expect(c.modules).toEqual([{ id: 'b', file: 'assets/modules/b.zip' }]);
	});
	it('types the options', () => {
		const c = /** @type {any} */ (normalizeExportConfig({ quality: 'ultra', vrButton: 0, startFullscreen: 'yes', id: 'a b/c' }));
		expect(EXPORT_QUALITIES).toContain(c.quality);
		expect(c.quality).toBe('auto');
		expect(c.vrButton).toBe(true); // only an explicit false switches it off
		expect(c.startFullscreen).toBe(false);
		expect(c.id).toBe('abc');
	});
});

describe('badge link (A1)', () => {
	it('carries ref=export and the game id', () => {
		const u = new URL(badgeHref('abc123'));
		expect(u.origin).toBe('https://theprototype.app');
		expect(u.searchParams.get('ref')).toBe('export');
		expect(u.searchParams.get('g')).toBe('abc123');
	});
	it('drops an id the Worker would refuse instead of sending it mangled', () => {
		expect(new URL(badgeHref('a/b?c')).searchParams.has('g')).toBe(false);
		expect(new URL(badgeHref('')).searchParams.has('g')).toBe(false);
	});
});

describe('hudAvoid.liftAbove', () => {
	const vh = 800;
	const box = { left: 760, right: 790, top: 758, bottom: 790 }; // 32px tall, bottom 10
	it('stays put with nothing in the way', () => {
		expect(liftAbove(box, [], vh, 10)).toBe(10);
		expect(liftAbove(box, [{ left: 10, right: 100, top: 700, bottom: 790 }], vh, 10)).toBe(10);
	});
	it('lifts above a touch button in its column', () => {
		const jump = { left: 700, right: 790, top: 680, bottom: 780 };
		const b = liftAbove(box, [jump], vh, 10);
		expect(vh - b).toBeLessThanOrEqual(jump.top); // the badge bottom sits above the button
		expect(b).toBe(vh - jump.top + 8);
	});
	it('keeps clearing a STACK of buttons', () => {
		const a = { left: 740, right: 790, top: 700, bottom: 790 };
		const c = { left: 740, right: 790, top: 600, bottom: 690 };
		const b = liftAbove(box, [a, c], vh, 10);
		expect(vh - b).toBeLessThanOrEqual(c.top);
	});
});

describe('exportCore', () => {
	it('rewrites index.html: play.js first, the title, no manifest', () => {
		const out = rewriteIndexHtml(INDEX, { title: 'Sky <Run>' });
		expect(out).toContain('<script src="./play.js"></script>');
		expect(out.indexOf('./play.js')).toBeLessThan(out.indexOf('modulepreload'));
		expect(out).toContain('<title>Sky &lt;Run&gt;</title>');
		expect(out).not.toMatch(/rel="manifest"/);
		expect(out).not.toMatch(/apple-mobile-web-app-title/);
	});
	it('play.js round-trips through the validator parser', () => {
		const cfg = { version: 1, id: 'x1', title: 'A "quoted" title', modules: [] };
		expect(parsePlayJs(makePlayJs(cfg))).toEqual(cfg);
	});
	it('embed snippet escapes and carries the play permissions', () => {
		const s = embedSnippet('https://theprototype.app/p/abc?x=1&y="2"', { w: 640, h: 360, title: 'G' });
		expect(s).toContain('width="640" height="360"');
		expect(s).toContain('&amp;y=&quot;2&quot;');
		expect(s).toMatch(/allow="fullscreen; xr-spatial-tracking; gamepad; pointer-lock; autoplay"/);
	});
	it('collects pack refs (relative kept, base-prefixed stripped, absolute apart, LOD files)', () => {
		const objs = [
			{ userData: { packRef: { path: 'architecture-kit/WallStone/glTF-Binary/WallStone.glb' }, lod: { levels: [{ source: 'pack', ref: 'WallStone.lod1.glb' }, { source: 'self' }] } } },
			{ userData: { animRef: { path: 'https://cdn.example/packs@format-1/props-kit/Door/glTF-Binary/Door.glb' } } },
			{ userData: { packRef: { path: 'https://raw.githubusercontent.com/KhronosGroup/x.glb' } } },
			{ userData: {} }
		];
		const group = { traverse: (/** @type {any} */ fn) => objs.forEach(fn) };
		const { paths, absolute } = collectPackRefs(group, 'https://cdn.example/packs@format-1/');
		expect([...paths].sort()).toEqual([
			'architecture-kit/WallStone/glTF-Binary/WallStone.glb',
			'architecture-kit/WallStone/glTF-Binary/WallStone.lod1.glb',
			'props-kit/Door/glTF-Binary/Door.glb'
		]);
		expect([...absolute]).toEqual(['https://raw.githubusercontent.com/KhronosGroup/x.glb']);
	});
	it('slugifies titles for file names', () => {
		expect(slugify('Sky Run!  (v2)')).toBe('sky-run-v2');
		expect(slugify('')).toBe('game');
	});
});

describe('exportValidate', () => {
	it('passes a well-formed export', () => {
		const r = validateExport(bundle(), { preset: 'itch' });
		expect(r.errors).toEqual([]);
		expect(r.ok).toBe(true);
		expect(r.config.id).toBe('xabc');
		expect(r.stats.runtimeFiles).toBe(3);
	});
	it('refuses a missing index.html / play.js / scene', () => {
		const r = validateExport(bundle().filter((f) => !['index.html', 'play.js', 'scene.tpscene'].includes(f.path)));
		expect(r.ok).toBe(false);
		expect(r.errors.join('\n')).toMatch(/no index.html/);
		expect(r.errors.join('\n')).toMatch(/no play.js/);
	});
	it('refuses root-absolute and absolute URLs in index.html (counterfactual: the original index.html)', () => {
		const files = bundle();
		const html = String(files[0].text).replace('./logo.svg', '/logo.svg').replace('./_app/immutable/entry/app.Y.js', 'https://cdn.example/app.js');
		files[0] = { ...files[0], text: html };
		const r = validateExport(files);
		expect(r.errors.some((e) => /root-absolute path: \/logo.svg/.test(e))).toBe(true);
		expect(r.errors.some((e) => /absolute URL: https:\/\/cdn.example/.test(e))).toBe(true);
		// and an index.html that never loads play.js (the app's own, unrewritten)
		const raw = bundle();
		raw[0] = { ...raw[0], text: INDEX };
		expect(validateExport(raw).errors.some((e) => /does not load \.\/play\.js/.test(e))).toBe(true);
	});
	it('refuses a runtime chunk importing through /_app/', () => {
		const files = bundle();
		files[6] = { ...files[6], text: 'import("/_app/immutable/chunks/Z.js")' };
		expect(validateExport(files).errors.some((e) => /root-absolute \/_app\//.test(e))).toBe(true);
	});
	it('enforces the itch.io limits (files, total, per file, path length, case)', () => {
		const many = bundle();
		for (let i = 0; i < ITCH_LIMITS.maxFiles; i++) many.push({ path: `_app/immutable/assets/f${i}.png`, bytes: 10 });
		expect(validateExport(many).errors.some((e) => /files — the limit is 1000/.test(e))).toBe(true);

		const big = bundle();
		big.push({ path: 'assets/packs/huge.glb', bytes: 201 * 1024 * 1024 });
		big.push({ path: 'assets/packs/huge2.glb', bytes: 200 * 1024 * 1024 });
		big.push({ path: 'assets/packs/huge3.glb', bytes: 150 * 1024 * 1024 });
		const rb = validateExport(big).errors.join('\n');
		expect(rb).toMatch(/file over 200 MB: assets\/packs\/huge.glb/);
		expect(rb).toMatch(/MB extracted — the limit is 500 MB/);

		const long = bundle();
		long.push({ path: 'assets/' + 'a'.repeat(240), bytes: 1 });
		expect(validateExport(long).errors.some((e) => /longer than 240/.test(e))).toBe(true);

		const cased = bundle();
		cased.push({ path: 'Logo.svg', bytes: 1 });
		expect(validateExport(cased).errors.some((e) => /differ only by case/.test(e))).toBe(true);
	});
	it('reports a badge-hiding key as ignored, and a service worker as an error', () => {
		const files = bundle({ hideBadge: true });
		files.push({ path: 'sw.js', bytes: 10 });
		const r = validateExport(files);
		expect(r.warnings.some((w) => /hideBadge.*cannot be turned off/.test(w))).toBe(true);
		expect(r.errors.some((e) => /service worker/.test(e))).toBe(true);
	});
	it('checks the config points at files that exist', () => {
		const r = validateExport(bundle({ modules: [{ id: 'm', file: 'assets/modules/m.zip' }] }));
		expect(r.errors.some((e) => /module m file assets\/modules\/m.zip is missing/.test(e))).toBe(true);
	});
	it('static preset asks for .nojekyll', () => {
		expect(validateExport(bundle(), { preset: 'static' }).warnings.some((w) => /nojekyll/.test(w))).toBe(true);
		const withIt = [...bundle(), { path: '.nojekyll', bytes: 0 }];
		expect(validateExport(withIt, { preset: 'static' }).warnings.some((w) => /nojekyll/.test(w))).toBe(false);
	});
	it('lists the kit boot imports among the refs', () => {
		expect(htmlRefs(INDEX)).toContain('./_app/immutable/entry/app.Y.js');
	});
});

describe('export prefs', () => {
	it('defaults, then coerces garbage', () => {
		expect(coerceExportPrefs(null)).toEqual(DEFAULT_EXPORT_PREFS);
		const c = coerceExportPrefs({ preset: 'zip', quality: 'ultra', viewportW: 99999, viewportH: 'x', vrButton: 'no', embedUrl: 5 });
		expect(c.preset).toBe('itch');
		expect(c.quality).toBe('auto');
		expect(c.viewportW).toBe(4096);
		expect(c.viewportH).toBe(600);
		expect(c.vrButton).toBe(true);
		expect(c.embedUrl).toBe('');
		expect(Object.keys(coerceExportPrefs({ badge: false }))).not.toContain('badge');
	});
});
