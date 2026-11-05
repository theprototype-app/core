// 64-text-int — AN EXPORTED GAME DRAWS ITS 3D TEXT WITH THE RIGHT FONT, OFFLINE (roadmap 64-text:
// "export (and offline) shows the right font").
//
// Against a BUILT app (the exporter reads build/export-manifest.json; a dev server has none, so the
// suite SKIPs there):
//   §1 the editor builds three texts: a SOLID "OPEN" in bundled Noto Serif with a bevel, a FLAT
//      "Welcome in" in bundled Nunito, and a SOLID "MONO" in an UPLOADED font (a Library font asset,
//      the IBM Plex Mono WOFF from static/ added as a user file, so it is a `fontAsset` hash) — and
//      notes what each one built (triangles, glyph layout, the font file it read)
//   §2 the builder API exports it (static preset); scripts/check-export.cjs passes the zip, which
//      carries the two bundled font files those texts read and, inside scene.tpscene, the uploaded
//      font's bytes under its hash
//   §3 the unzipped game is served from a SECOND origin, in a sandboxed iframe on a host page (the
//      export-zip §3 set-up), in a browser that can resolve no other host, every other request
//      aborted and recorded: the game boots into Play, each text is BUILT there with the SAME font
//      (the font file / asset the runtime resolved, the same triangle count, the same glyph layout),
//      the uploaded font comes from the scene (a blob:, never the bundled twin, no "not on this
//      device" fallback notice), and not one request leaves the game's origin (no Google Fonts, no
//      jsDelivr)
//
// Counterfactual: v1.60.0 has no text object (§1 makes nothing); an exporter that dropped the font
// asset from scene.tpscene fails §2's asset row and §3's MONO row (it falls back to Noto Sans).
// Run (after `npm run build`):
//   LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' E2E_PC= e2e-slot --local --dev <tree> 5997 -- \
//     env APP_URL=https://theprototype.app:5997/ TEXT_EXPORT_GAME_PORT=5999 node tests/e2e/text-export.test.cjs
// Evidence: E2E_OUT (default test-results/64-text-int/text-export) gets the zip, the served-file log, a shot.
const h = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { unzipSync, strFromU8 } = require('fflate');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.resolve(ROOT, process.env.E2E_OUT ?? 'test-results/64-text-int/text-export');
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-text-export-'));
const GAME_PORT = Number(process.env.TEXT_EXPORT_GAME_PORT || 0);
const UPLOAD = 'fonts/text/ibm-plex-mono-latin-500-normal.woff'; // the uploaded font's bytes (its bundled twin is unused here)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary' };

/** a static server that logs every path it is asked for @param {Record<string, string>} routes @param {number} port @param {{path: string, status: number}[]} log */
function serve(routes, port, log) {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url || '/').split('?')[0]);
		for (const [prefix, dir] of Object.entries(routes)) {
			if (!url.startsWith(prefix)) continue;
			let file = path.join(dir, url.slice(prefix.length) || 'index.html');
			if (!file.startsWith(dir)) break;
			if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
			if (!fs.existsSync(file)) break;
			log.push({ path: url, status: 200 });
			res.writeHead(200, { 'Content-Type': /** @type {any} */ (MIME)[path.extname(file)] || 'application/octet-stream' });
			fs.createReadStream(file).pipe(res);
			return;
		}
		log.push({ path: url, status: 404 });
		res.writeHead(404);
		res.end('not found');
	});
	return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/** what the text runtime reports, keyed by the text @param {any} target page or frame */
const texts = (target) =>
	target.evaluate(() =>
		Object.fromEntries(
			/** @type {any} */ (window).__stores.textPath.textPathDebug().map((/** @type {any} */ d) => [
				d.text,
				{ mode: d.mode, synced: d.synced, glyphs: d.glyphs, font: d.font, fontUrl: d.fontUrl, solid: d.solid, xs: d.baseline.map((/** @type {number[]} */ p) => p[0]) }
			])
		)
	);
const solidBuilt = (/** @type {any} */ d) => !!d && d.mode === 'extruded' && !!d.solid && !d.solid.building && d.solid.triangles > 0;
const flatBuilt = (/** @type {any} */ d) => !!d && d.mode === 'flat' && d.synced && d.glyphs > 0;
const ready = (/** @type {any} */ t) => solidBuilt(t.OPEN) && flatBuilt(t['Welcome in']) && solidBuilt(t.MONO);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const pa = A.page;
	if (!(await pa.evaluate(() => fetch('export-manifest.json', { cache: 'no-cache' }).then((r) => r.ok, () => false)))) {
		console.log('SKIP: no build/export-manifest.json — run against `npm run build` served by scripts/serve-build.cjs');
		await browser.close();
		return;
	}

	// ---- §1 three texts in the editor ------------------------------------------------------------
	const made = await pa.evaluate(async (upload) => {
		const S = window.__stores;
		const bytes = new Uint8Array(await (await fetch(upload)).arrayBuffer());
		const up = await S.textFonts.addFontBytes(bytes, 'My Mono.woff');
		/** @param {number[]} at @param {any} patch */
		const add = (at, patch) => {
			const o = S.addObjects.spawnAtPoint('/create Text', at);
			return { uuid: o.uuid, ok: !!S.textPathEdit.setTextPathFor(o.uuid, patch) };
		};
		const open = add([-2, 1.5, 0], { text: 'OPEN', mode: 'extruded', font: 'serif', depth: 0.2, bevel: { size: 0.02, thickness: 0.02, segments: 3 } });
		const flat = add([0, 3, 0], { text: 'Welcome in', mode: 'flat', font: 'rounded' });
		const mono = up.ok ? add([2, 1.5, 0], { text: 'MONO', mode: 'extruded', fontAsset: up.font.hash, fontName: up.font.family }) : null;
		return { up: up.ok ? { hash: up.font.hash, family: up.font.family, format: up.font.format } : { error: up.error }, open, flat, mono };
	}, UPLOAD);
	h.check(!!made.up.hash && made.up.format === 'woff', `§1 the WOFF upload is a Library font asset (${JSON.stringify(made.up)})`);
	h.check(made.open.ok && made.flat.ok && !!made.mono?.ok, '§1 three texts made: solid OPEN (serif, bevel), flat "Welcome in" (Nunito), solid MONO (the uploaded font)');
	await h.eventually(() => texts(pa), ready, '§1 the editor builds all three texts', 60000);
	const ed = await texts(pa);
	const fontHash = made.up.hash;
	h.check(ed.OPEN.font === 'serif' && /noto-serif/.test(ed.OPEN.fontUrl) && ed.OPEN.solid.drawn === 4 && ed.OPEN.solid.missing === 0, `§1 OPEN: 4 bevelled serif letters, ${ed.OPEN.solid.triangles} triangles (${ed.OPEN.fontUrl})`);
	h.check(ed['Welcome in'].font === 'rounded' && /nunito/.test(ed['Welcome in'].fontUrl), `§1 "Welcome in": flat, ${ed['Welcome in'].glyphs} Nunito glyphs (${ed['Welcome in'].fontUrl})`);
	h.check(ed.MONO.font === 'asset:' + fontHash && String(ed.MONO.fontUrl).startsWith('blob:') && ed.MONO.solid.missing === 0, `§1 MONO: built from the uploaded font, ${ed.MONO.solid.triangles} triangles`);
	h.check(ed.MONO.solid.triangles !== ed.OPEN.solid.triangles || ed.MONO.solid.drawn !== ed.OPEN.solid.drawn, '§1 premise: the two solid texts are different meshes');
	// the bundled files, as paths inside the app (the editor is served at the origin's root)
	const serifRel = new URL(ed.OPEN.fontUrl).pathname.replace(/^\//, '');
	const nunitoRel = new URL(ed['Welcome in'].fontUrl).pathname.replace(/^\//, '');
	await h.eventually(
		() => pa.evaluate(() => window.__stores.sceneAssets.sceneAssetList().map((/** @type {any} */ a) => a.hash)),
		(list) => list.includes(fontHash),
		'§1 the scene asset list (what a save / export carries) names the uploaded font',
		15000
	);

	// ---- §2 export (static preset) ----------------------------------------------------------------
	const ex = await pa.evaluate(async () => {
		const res = await window.__stores.exportBuilder.buildExport({ preset: 'static', title: 'Text Export', thumbnail: false, startFullscreen: false, showFps: false, quality: 'auto', vrButton: false, useCdnForPacks: false });
		const buf = new Uint8Array(await res.blob.arrayBuffer());
		let s = '';
		for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return { b64: btoa(s), name: res.fileName, warnings: res.warnings };
	});
	await A.ctx.close();
	const zipPath = path.join(OUT, ex.name);
	fs.writeFileSync(zipPath, Buffer.from(ex.b64, 'base64'));
	console.log('[text-export] zip:', zipPath, 'warnings:', JSON.stringify(ex.warnings));
	const check = (() => {
		try {
			return { ok: true, out: execFileSync('node', [path.join(ROOT, 'scripts/check-export.cjs'), zipPath, '--preset', 'static'], { encoding: 'utf8' }) };
		} catch (e) {
			return { ok: false, out: String(/** @type {any} */ (e).stdout || e) };
		}
	})();
	console.log(check.out);
	h.check(check.ok, '§2 scripts/check-export.cjs passes the static-host zip');
	const zip = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
	for (const [label, rel] of [['Noto Serif (solid OPEN)', serifRel], ['Nunito (flat "Welcome in")', nunitoRel]]) {
		const inZip = zip[rel];
		const inBuild = path.join(ROOT, 'build', rel);
		h.check(!!inZip && fs.existsSync(inBuild) && Buffer.compare(Buffer.from(inZip), fs.readFileSync(inBuild)) === 0, `§2 the zip carries ${label}: ${rel} (${inZip ? inZip.byteLength + ' bytes' : 'MISSING — the exporter copies build/ by export-manifest.json (scripts/export-manifest.cjs)'})`);
	}
	const scene = zip['scene.tpscene'] ? unzipSync(zip['scene.tpscene']) : {};
	const index = scene['assets/index.json'] ? JSON.parse(strFromU8(scene['assets/index.json'])) : [];
	const row = index.find((/** @type {any} */ r) => r.hash === fontHash);
	const uploaded = fs.readFileSync(path.join(ROOT, 'static', UPLOAD));
	h.check(!!row && row.kind === 'font' && !!scene[row.file] && Buffer.compare(Buffer.from(scene[row.file]), uploaded) === 0, `§2 scene.tpscene carries the uploaded font under its hash, byte-identical (${row ? row.file + ', ' + (scene[row.file]?.byteLength ?? 0) + ' bytes' : 'MISSING from assets/index.json: ' + JSON.stringify(index.map((/** @type {any} */ r) => r.kind + ':' + r.file))})`);

	// ---- §3 served from a second origin, offline -------------------------------------------------
	const gameDir = path.join(WORK, 'game');
	for (const [rel, data] of Object.entries(zip)) {
		if (rel.endsWith('/')) continue;
		fs.mkdirSync(path.dirname(path.join(gameDir, rel)), { recursive: true });
		fs.writeFileSync(path.join(gameDir, rel), data);
	}
	/** @type {{path: string, status: number}[]} */
	const served = [];
	const game = /** @type {any} */ (await serve({ '/html/6401/': gameDir }, GAME_PORT, served));
	const gameOrigin = `http://127.0.0.1:${game.address().port}`;
	const gameBase = `${gameOrigin}/html/6401/`;
	const hostDir = path.join(WORK, 'host');
	fs.mkdirSync(hostDir);
	fs.writeFileSync(
		path.join(hostDir, 'index.html'),
		`<!doctype html><html><head><meta charset="utf-8"><title>host</title><style>html,body{margin:0;height:100%;background:#222}iframe{position:fixed;left:0;top:0;width:1280px;height:720px;border:0}</style></head><body><iframe id="game_drop" src="${gameBase}index.html" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-forms" allow="autoplay; fullscreen *; xr-spatial-tracking; gamepad" allowfullscreen></iframe></body></html>`
	);
	const host = /** @type {any} */ (await serve({ '/': hostDir }, 0, []));
	const hostOrigin = `http://localhost:${host.address().port}`;
	// a browser with no other host to reach (DNS) and every other request aborted and recorded
	const offline = await h.launch({ args: [...h.GPU_ARGS, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] });
	const ctx = await offline.newContext({ viewport: { width: 1280, height: 720 } });
	await ctx.addInitScript((hash) => {
		try {
			localStorage.setItem('debugStores', 'true');
		} catch {
			/* the host page */
		}
		// evidence for the fallback row: was MONO ever BUILT while its font URL was not the asset's blob
		// (= the Noto Sans fallback), and was the font already in the Library when the notice went up
		const w = /** @type {any} */ (window);
		w.__textExportSeen = { sansBuild: false, notice: null };
		const tick = () => {
			try {
				const S = w.__stores;
				const d = S?.textPath?.textPathDebug?.().find((/** @type {any} */ x) => x.text === 'MONO');
				if (d?.solid?.triangles > 0 && !String(d.fontUrl).startsWith('blob:')) w.__textExportSeen.sansBuild = { triangles: d.solid.triangles, fontUrl: d.fontUrl };
				if (!w.__textExportSeen.notice && S?.notifications) {
					let n = [];
					S.notifications.subscribe((/** @type {any} */ v) => (n = v))();
					const hit = n.find((/** @type {any} */ e) => /not on this device yet/.test(e.text));
					if (hit) w.__textExportSeen.notice = { text: hit.text, inLibrary: !!S.explorer?.itemByHash?.(hash) };
				}
			} catch {
				/* not booted yet */
			}
			if (performance.now() < 120000) setTimeout(tick, 10);
		};
		if (location.pathname.startsWith('/html/')) tick();
	}, fontHash);
	/** @type {string[]} */
	const foreign = [];
	await ctx.route('**/*', (/** @type {any} */ route) => {
		const u = route.request().url();
		if (u.startsWith(gameOrigin + '/') || u.startsWith(hostOrigin + '/')) return route.continue();
		foreign.push(u);
		return route.abort('blockedbyclient');
	});
	ctx.on('request', (/** @type {any} */ req) => {
		const u = req.url();
		if (!/^(blob|data):/.test(u) && !u.startsWith(gameOrigin + '/') && !u.startsWith(hostOrigin + '/') && !foreign.includes(u)) foreign.push(u);
	});
	const p = await ctx.newPage();
	/** @type {string[]} */
	const errors = [];
	p.on('pageerror', (/** @type {any} */ e) => errors.push(e.message));
	await p.goto(`${hostOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
	const frame = await (async () => {
		for (let i = 0; i < 200; i++) {
			const f = p.frames().find((fr) => fr.url().startsWith(gameBase));
			if (f) return f;
			await p.waitForTimeout(100);
		}
		throw new Error('no game frame');
	})();
	await frame.waitForFunction(() => /** @type {any} */ (window).__stores?.exportRuntime?.exportRuntimeState, null, { timeout: 90000 });
	await h.eventually(() => frame.evaluate(() => /** @type {any} */ (window).__stores.exportRuntime.exportRuntimeState.phase), (v) => v === 'playing' || v === 'failed', '§3 the exported game boots', 90000);
	const phase = await frame.evaluate(() => /** @type {any} */ (window).__stores.exportRuntime.exportRuntimeState);
	h.check(phase.phase === 'playing', `§3 the exported game is playing (${phase.phase}${phase.error ? ' — ' + phase.error : ''})`);
	await h.eventually(() => texts(frame), ready, '§3 all three texts are built in the exported game', 60000);
	await p.waitForTimeout(1500); // a late fallback or rebuild would show up here
	const gx = await texts(frame);
	h.check(gx.OPEN.font === 'serif' && gx.OPEN.fontUrl === gameBase + serifRel, `§3 OPEN reads Noto Serif from the game's own folder (${gx.OPEN.fontUrl})`);
	h.check(gx.OPEN.solid.triangles === ed.OPEN.solid.triangles && gx.OPEN.solid.drawn === 4 && gx.OPEN.solid.missing === 0, `§3 OPEN is the same bevelled serif mesh as in the editor (${gx.OPEN.solid.triangles} / ${ed.OPEN.solid.triangles} triangles)`);
	const W = gx['Welcome in'];
	const xsSame = W.xs.length === ed['Welcome in'].xs.length && W.xs.every((/** @type {number} */ x, /** @type {number} */ i) => Math.abs(x - ed['Welcome in'].xs[i]) < 2e-3);
	h.check(W.font === 'rounded' && W.fontUrl === gameBase + nunitoRel, `§3 "Welcome in" reads Nunito from the game's own folder (${W.fontUrl})`);
	h.check(W.glyphs === ed['Welcome in'].glyphs && xsSame, `§3 "Welcome in" lays out the same ${W.glyphs} glyphs at the same places as the editor (Nunito's advances, not a fallback's)`);
	h.check(gx.MONO.font === 'asset:' + fontHash && String(gx.MONO.fontUrl).startsWith('blob:'), `§3 MONO resolves the uploaded font from the scene's own assets (${gx.MONO.font}, ${String(gx.MONO.fontUrl).slice(0, 40)})`);
	h.check(gx.MONO.solid.triangles === ed.MONO.solid.triangles && gx.MONO.solid.missing === 0, `§3 MONO is the same mesh as in the editor (${gx.MONO.solid.triangles} / ${ed.MONO.solid.triangles} triangles)`);
	const notes = await frame.evaluate(() => {
		const S = /** @type {any} */ (window).__stores;
		let n = [];
		let t = [];
		S.notifications.subscribe((/** @type {any} */ v) => (n = v))();
		S.toastStore.subscribe((/** @type {any} */ v) => (t = v))();
		return JSON.stringify([n, t]);
	});
	const seen = await frame.evaluate(() => /** @type {any} */ (window).__textExportSeen);
	console.log('[text-export] MONO before its font resolved:', JSON.stringify(seen));
	// the font IS in the game (scene.tpscene's assets are restored before the scene applies), so a
	// "not on this device" notice / a first build in Noto Sans is the runtime not waiting for its own
	// Library read (textPathRuntime fontUrlFor), not a missing file
	h.check(
		!/not on this device yet/.test(notes) && !seen?.sansBuild,
		`§3 MONO never shows the Noto Sans fallback in the game: no notice, no first build in sans (notice: ${seen?.notice ? JSON.stringify(seen.notice) : 'none'}; sans build: ${JSON.stringify(seen?.sansBuild ?? false)})`
	);
	const servedOk = (/** @type {string} */ rel) => served.some((s) => s.path === '/html/6401/' + rel && s.status === 200);
	h.check(servedOk(serifRel) && servedOk(nunitoRel), `§3 the game's origin served ${serifRel} and ${nunitoRel}`);
	h.check(!served.some((s) => s.path.endsWith('/' + UPLOAD)), `§3 the uploaded font's bundled twin (${UPLOAD}) was never fetched: MONO's bytes came from scene.tpscene`);
	fs.writeFileSync(path.join(OUT, 'served.txt'), served.map((s) => s.status + ' ' + s.path).join('\n') + '\n');
	await p.screenshot({ path: path.join(OUT, 'text-export-game.png') });
	h.check(foreign.length === 0, `§3 not one request left the game's origin (${foreign.length}: ${foreign.slice(0, 4).join(', ') || 'none'})`);
	h.check(!foreign.some((u) => /fonts\.(googleapis|gstatic)\.com|jsdelivr/.test(u)), '§3 in particular nothing to fonts.googleapis.com / fonts.gstatic.com / jsDelivr');
	const missing = served.filter((s) => s.status === 404).map((s) => s.path);
	h.check(missing.length === 0, `§3 the game asked its origin for no file the zip lacks (${missing.slice(0, 4).join(', ') || 'none'})`);
	h.check(errors.length === 0, `§3 no page errors in the exported game (${errors.slice(0, 2).join(' | ') || 'none'})`);
	await offline.close();
	host.close();
	game.close();
	fs.rmSync(WORK, { recursive: true, force: true });
	await h.finish(browser);
});
