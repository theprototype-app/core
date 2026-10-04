// 36-export (U4 + I2 + E1) — AN EXPORTED GAME PLAYS WHERE ITCH.IO WOULD SERVE IT.
//
// Against a BUILT app (the exporter reads build/export-manifest.json; a dev server has none —
// run under `LANE_DEV_CMD='npx vite preview --port $PORT --strictPort' e2e-slot --dev …`):
//   1. the burger's "Publish / Export" opens the three-tab modal; with no cloud plugin the
//      Publish tab explains itself and Export works (OSS); Settings shows the badge row checked
//      AND disabled
//   2. Mini Golf is exported through the REAL UI (itch.io preset → a download), Sky Run through
//      the builder API (static-host preset); both pass scripts/check-export.cjs
//   3. each zip is unzipped and served from a SUBPATH (/html/<n>/) on a SECOND origin, inside a
//      SANDBOXED iframe on a host page (itch.io serves html-classic.itch.zone/html/<n>/ in an
//      iframe): the game boots straight into Play, the editor chrome is absent, the badge is
//      there (bottom-right, ≤ 32 px, ~40% opacity, ref=export&g=<export id>, new tab), and NOT ONE
//      request leaves the game's own origin
//   4. Mini Golf is PLAYED: Tee off, a real-mouse putt counts a stroke. Sky Run: a stage starts
//      and the runner reaches a checkpoint
//   5. the badge cannot be switched off: `hideBadge`/`badge:false` in play.js and `?badge=0` in
//      the URL leave it drawn; it lifts above a `[data-hud-avoid]` control (36-touch's buttons)
//   6. a play link (`?s=<id>&play=1&embed=1`) draws the badge with g=<id>; the editor does not
//
// Scenes: MINIGOLF_TPSCENE / SKY_RUN_TPSCENE (else the sibling scenes checkout). Skip, never
// fail, when neither is found. Evidence: EXPORT_SHOTS=<dir> writes screenshots there; EXPORT_KEEP=<dir>
// keeps the two zips.
const h = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { unzipSync, strFromU8 } = require('fflate');

const ROOT = path.resolve(__dirname, '../..');
const find = (/** @type {(string | undefined)[]} */ list) => list.filter(Boolean).find((p) => fs.existsSync(/** @type {string} */ (p)));
const MINIGOLF = find([process.env.MINIGOLF_TPSCENE, path.resolve(ROOT, '../scenes/games/mini-golf/scene.tpscene')]);
const SKYRUN = find([process.env.SKY_RUN_TPSCENE, path.resolve(ROOT, '../scenes/games/sky-run/scene.tpscene')]);
const SHOTS = process.env.EXPORT_SHOTS || '';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-export-'));

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css',
	'.json': 'application/json',
	'.wasm': 'application/wasm',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.glb': 'model/gltf-binary',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain'
};

/** a static server: `routes` maps a URL prefix to a folder @param {Record<string, string>} routes */
function serve(routes) {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url || '/').split('?')[0]);
		for (const [prefix, dir] of Object.entries(routes)) {
			if (!url.startsWith(prefix)) continue;
			let file = path.join(dir, url.slice(prefix.length) || 'index.html');
			if (!file.startsWith(dir)) break;
			if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
			if (!fs.existsSync(file)) break;
			res.writeHead(200, { 'Content-Type': /** @type {any} */ (MIME)[path.extname(file)] || 'application/octet-stream' });
			fs.createReadStream(file).pipe(res);
			return;
		}
		res.writeHead(404);
		res.end('not found');
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** @param {Uint8Array} zip @param {string} dir */
function unzipTo(zip, dir) {
	for (const [rel, data] of Object.entries(unzipSync(zip))) {
		if (rel.endsWith('/')) continue;
		const out = path.join(dir, rel);
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, data);
	}
}

/** @param {string} zipPath @param {string} preset */
function checkExport(zipPath, preset) {
	try {
		const out = execFileSync('node', [path.join(ROOT, 'scripts/check-export.cjs'), zipPath, '--preset', preset], { encoding: 'utf8' });
		return { ok: true, out };
	} catch (e) {
		return { ok: false, out: String(/** @type {any} */ (e).stdout || e) };
	}
}

/** load a .tpscene into the editor page @param {any} page @param {string} file */
async function loadScene(page, file) {
	const bytes = Array.from(fs.readFileSync(file));
	await page.evaluate(async (/** @type {number[]} */ arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await page.waitForTimeout(2500);
}

/** the host page (origin A) framing the game (origin B) the way itch.io does */
function hostHtml(src) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>host</title>
<style>html,body{margin:0;height:100%;background:#222}iframe{position:fixed;left:0;top:0;width:1280px;height:720px;border:0}</style></head>
<body><iframe id="game_drop" src="${src}" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-forms"
allow="autoplay; fullscreen *; xr-spatial-tracking; gamepad" allowfullscreen></iframe></body></html>`;
}

h.run(async () => {
	if (!MINIGOLF || !SKYRUN) {
		console.log('SKIP: no authored mini-golf / sky-run .tpscene (set MINIGOLF_TPSCENE and SKY_RUN_TPSCENE)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });

	// ------------------------------------------------------------- 1. the modal (OSS)
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 }, acceptDownloads: true } });
	const page = A.page;
	const bare = await page.evaluate(() => ({ badge: !!document.querySelector('#made-with-tp'), start: !!document.querySelector('#embed-start') }));
	h.check(!bare.badge && !bare.start, 'the editor draws no badge and no start card (counterfactual for §3/§6)');
	await loadScene(page, MINIGOLF);

	await page.locator('#logo-menu').click();
	await page.locator('#open-publish-export').click();
	await page.locator('#publish-export-modal').waitFor({ state: 'visible', timeout: 10000 });
	const tabs = await page.locator('#publish-export-modal [role=tab]').allTextContents();
	h.check(JSON.stringify(tabs.map((t) => t.trim())) === JSON.stringify(['Publish', 'Export', 'Settings']), `the burger item opens one modal with Publish | Export | Settings (${tabs})`);
	h.check((await page.locator('#publish-export-modal').getAttribute('data-tab')) === 'export', 'with no cloud plugin it opens on Export');
	await page.locator('#publish-export-tab-publish').click();
	h.check(await page.locator('#publish-oss').isVisible(), 'the OSS Publish tab says where publishing lives');
	await page.locator('#publish-export-tab-settings').click();
	const badgeRow = await page.evaluate(() => {
		const el = /** @type {HTMLInputElement | null} */ (document.querySelector('#export-badge'));
		return el ? { checked: el.checked, disabled: el.disabled } : null;
	});
	h.check(badgeRow?.checked === true && badgeRow?.disabled === true, `Settings: "Show Made with ThePrototype badge" is checked and disabled (${JSON.stringify(badgeRow)})`);
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '01-modal-settings-dark.png') });

	// ---------------------------------------------- 2a. Mini Golf through the real UI
	await page.locator('#publish-export-tab-export').click();
	await page.locator('#export-preset-itch').click();
	await page.locator('#export-title').fill('Mini Golf');
	await h.eventually(() => page.locator('#export-estimate').textContent(), (t) => /Engine .* MB in \d+ files/.test(t || ''), 'the Export tab shows a size estimate from the build', 15000);
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '02-export-tab-dark.png') });
	const download = page.waitForEvent('download', { timeout: 120000 });
	await page.locator('#export-go').click();
	const dl = await download;
	const golfZip = path.join(WORK, 'mini-golf-itch.zip');
	await dl.saveAs(golfZip);
	h.check(/mini-golf-itch\.zip$/.test(dl.suggestedFilename()), `Build & download gives mini-golf-itch.zip (${dl.suggestedFilename()})`);
	await page.locator('#export-result').waitFor({ state: 'visible', timeout: 20000 });
	h.check(/checked OK/.test((await page.locator('#export-result').textContent()) || ''), 'the result says the zip passed its own check');
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '03-export-result-dark.png') });

	// light theme screenshot of the same tab
	if (SHOTS) {
		await page.evaluate(() => {
			document.documentElement.dataset.theme = 'light';
			document.documentElement.classList.remove('dark');
		});
		await page.waitForTimeout(300);
		await page.screenshot({ path: path.join(SHOTS, '04-export-tab-light.png') });
		await page.evaluate(() => {
			document.documentElement.dataset.theme = 'dark';
			document.documentElement.classList.add('dark');
		});
	}
	await page.keyboard.press('Escape');

	// ---------------------------------------------- 2b. Sky Run through the builder API
	await loadScene(page, SKYRUN);
	const skyB64 = await page.evaluate(async () => {
		const b = window.__stores.exportBuilder;
		const out = await b.buildExport({ preset: 'static', title: 'Sky Run', thumbnail: true, startFullscreen: false, showFps: true, quality: 'auto', vrButton: true, useCdnForPacks: false });
		const buf = new Uint8Array(await out.blob.arrayBuffer());
		let s = '';
		for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return { b64: btoa(s), name: out.fileName, warnings: out.warnings };
	});
	const skyZip = path.join(WORK, skyB64.name);
	fs.writeFileSync(skyZip, Buffer.from(skyB64.b64, 'base64'));
	h.check(skyB64.name === 'sky-run-web.zip', `the static-host preset names its zip (${skyB64.name})`);
	await A.ctx.close();

	// EXPORT_KEEP=<dir>: keep both zips (the real butler push uploads the itch.io one)
	if (process.env.EXPORT_KEEP) {
		fs.mkdirSync(process.env.EXPORT_KEEP, { recursive: true });
		fs.copyFileSync(golfZip, path.join(process.env.EXPORT_KEEP, path.basename(golfZip)));
		fs.copyFileSync(skyZip, path.join(process.env.EXPORT_KEEP, path.basename(skyZip)));
	}
	const golfCheck = checkExport(golfZip, 'itch');
	console.log(golfCheck.out);
	h.check(golfCheck.ok, 'scripts/check-export.cjs passes the Mini Golf itch.io zip');
	const skyCheck = checkExport(skyZip, 'static');
	console.log(skyCheck.out);
	h.check(skyCheck.ok, 'scripts/check-export.cjs passes the Sky Run static-host zip');

	// the zip's shape
	const golfEntries = unzipSync(new Uint8Array(fs.readFileSync(golfZip)));
	const names = Object.keys(golfEntries);
	h.check(['index.html', 'play.js', 'scene.tpscene', 'README.txt'].every((n) => names.includes(n)), 'index.html, play.js, scene.tpscene and README.txt sit at the zip ROOT');
	h.check(!names.some((n) => /(^|\/)sw\.js$/.test(n) || n === 'manifest.webmanifest' || /^cloud-plugin/.test(n)), 'no service worker, web-app manifest or cloud plugin in the zip');
	h.check(names.length <= 1000, `≤ 1000 files (${names.length})`);
	const golfCfg = JSON.parse(/window\.__TP_EXPORT__ = ([\s\S]*);\s*$/.exec(strFromU8(golfEntries['play.js']))?.[1] || '{}');
	h.check(/^x[a-z0-9]{6,}/.test(golfCfg.id) && golfCfg.preset === 'itch' && golfCfg.title === 'Mini Golf', `play.js carries the export id + preset + title (${golfCfg.id})`);
	const golfHtml = strFromU8(golfEntries['index.html']);
	h.check(/<script src="\.\/play\.js"><\/script>/.test(golfHtml) && /<title>Mini Golf<\/title>/.test(golfHtml), 'index.html loads ./play.js and is titled');
	h.check(Object.keys(unzipSync(new Uint8Array(fs.readFileSync(skyZip)))).includes('.nojekyll'), 'the static-host zip carries .nojekyll');

	// ---------------------------------------------- 3/4. serve on a second origin, play
	const golfDir = path.join(WORK, 'golf');
	const skyDir = path.join(WORK, 'sky');
	unzipTo(new Uint8Array(fs.readFileSync(golfZip)), golfDir);
	unzipTo(new Uint8Array(fs.readFileSync(skyZip)), skyDir);
	// the tamper copy: play.js asks to hide the badge every way it could
	const tamperDir = path.join(WORK, 'tamper');
	unzipTo(new Uint8Array(fs.readFileSync(golfZip)), tamperDir);
	const tamperJs = fs.readFileSync(path.join(tamperDir, 'play.js'), 'utf8').replace('"title"', '"hideBadge": true,\n\t"badge": false,\n\t"showBadge": false,\n\t"title"');
	fs.writeFileSync(path.join(tamperDir, 'play.js'), tamperJs);

	const game = /** @type {any} */ (await serve({ '/html/4201/': golfDir, '/html/4202/': skyDir, '/html/4203/': tamperDir }));
	const gameOrigin = `http://127.0.0.1:${game.address().port}`;
	const hostDir = path.join(WORK, 'host');
	fs.mkdirSync(hostDir);
	fs.writeFileSync(path.join(hostDir, 'golf.html'), hostHtml(`${gameOrigin}/html/4201/index.html`));
	fs.writeFileSync(path.join(hostDir, 'sky.html'), hostHtml(`${gameOrigin}/html/4202/index.html`));
	fs.writeFileSync(path.join(hostDir, 'tamper.html'), hostHtml(`${gameOrigin}/html/4203/index.html?badge=0&hideBadge=1&embed=0`));
	const host = /** @type {any} */ (await serve({ '/': hostDir }));
	// a DIFFERENT origin from the game's (localhost vs 127.0.0.1), as itch.io's page and CDN are
	const hostOrigin = `http://localhost:${host.address().port}`;

	/** open a host page and return the game frame + every request that left the game's origin
	 * @param {string} file */
	async function openGame(file) {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
		await ctx.addInitScript(() => {
			try {
				localStorage.setItem('debugStores', 'true');
			} catch {
				/* the host page */
			}
		});
		const p = await ctx.newPage();
		/** @type {string[]} */
		const foreign = [];
		/** @type {string[]} */
		const errors = [];
		p.on('request', (req) => {
			const u = req.url();
			if (u.startsWith(gameOrigin) || u.startsWith(hostOrigin) || /^(blob|data):/.test(u)) return;
			foreign.push(u);
		});
		p.on('pageerror', (e) => errors.push(e.message));
		await p.goto(`${hostOrigin}/${file}`, { waitUntil: 'domcontentloaded' });
		const frame = await (async () => {
			for (let i = 0; i < 100; i++) {
				const f = p.frames().find((fr) => fr.url().startsWith(gameOrigin + '/html/'));
				if (f) return f;
				await p.waitForTimeout(100);
			}
			throw new Error('no game frame');
		})();
		await frame.waitForFunction(() => /** @type {any} */ (window).__stores?.exportRuntime?.exportRuntimeState, null, { timeout: 60000 });
		return { ctx, p, frame, foreign, errors };
	}
	const read = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;

	// ---- Mini Golf
	const G = await openGame('golf.html');
	await h.eventually(
		() => G.frame.evaluate(() => /** @type {any} */ (window).__stores.exportRuntime.exportRuntimeState.phase),
		(v) => v === 'playing' || v === 'failed',
		'the exported Mini Golf boots its scene and asks for Play',
		60000
	);
	const gState = await G.frame.evaluate((r) => {
		const s = /** @type {any} */ (window).__stores;
		const rd = eval(r);
		const badge = /** @type {HTMLAnchorElement | null} */ (document.querySelector('#made-with-tp'));
		const rect = badge?.getBoundingClientRect();
		return {
			phase: s.exportRuntime.exportRuntimeState.phase,
			error: s.exportRuntime.exportRuntimeState.error,
			locked: rd(s.isLocked),
			objects: rd(s.objectsGroup).children.length,
			chromeHidden: document.querySelector('#editor-chrome')?.classList.contains('hidden') ?? null,
			openLink: !!document.querySelector('#embed-open-link'),
			fullscreenBtn: !!document.querySelector('#embed-fullscreen'),
			peerOpen: !!rd(s.peers)?.peer?.open,
			badge: badge ? { href: badge.href, target: badge.target, rel: badge.rel, h: rect?.height, right: innerWidth - (rect?.right ?? 0), bottom: innerHeight - (rect?.bottom ?? 0), opacity: getComputedStyle(badge).opacity } : null,
			module: !!(/** @type {any} */ (globalThis).__minigolf),
			path: location.pathname
		};
	}, read);
	h.check(gState.phase === 'playing', `the game is playing (${gState.phase}${gState.error ? ' — ' + gState.error : ''})`);
	h.check(gState.path === '/html/4201/index.html', `served from a SUBPATH (${gState.path})`);
	h.check(gState.locked === true && gState.objects > 10 && gState.module, `autoplay: Play mode, the course loaded, the minigolf module awake (${gState.objects} objects)`);
	h.check(gState.chromeHidden === true && !gState.openLink, 'no editor chrome, no "open in app" link in an export');
	h.check(gState.peerOpen === false, 'the Peer is the offline stub (no signaling)');
	const bh = gState.badge;
	h.check(!!bh, 'the Made with ThePrototype badge is drawn');
	if (bh) {
		const u = new URL(bh.href);
		h.check(u.origin === 'https://theprototype.app' && u.searchParams.get('ref') === 'export' && u.searchParams.get('g') === golfCfg.id, `badge link carries ref=export&g=<export id> (${bh.href})`);
		h.check(bh.target === '_blank' && /noopener/.test(bh.rel), 'the badge opens a new tab with rel=noopener');
		h.check(bh.h <= 32 && bh.right >= 8 && bh.right <= 16 && bh.bottom >= 8 && bh.bottom <= 16, `bottom-right, ≤ 32 px tall (h ${bh.h}, right ${bh.right}, bottom ${bh.bottom})`);
		h.check(Math.abs(Number(bh.opacity) - 0.4) < 0.05, `~40% opacity at rest (${bh.opacity})`);
	}
	// 36-int-121 (user, 1.21.0): the logo's two accent parts (left leg + right triangle) are an OPAQUE
	// dark grey — no scene shows through them; only the T stays currentColor
	const accents = await G.frame.evaluate(() =>
		[...document.querySelectorAll('#made-with-tp .mwt-accent')].map((p) => {
			const cs = getComputedStyle(p);
			return { part: p.getAttribute('data-part'), fill: cs.fill, opacity: cs.opacity, fillOpacity: cs.fillOpacity };
		})
	);
	const greyOk = (/** @type {string} */ f) => {
		const m = f.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
		if (!m) return false;
		const [r, g, b] = [m[1], m[2], m[3]].map(Number);
		const a = m[4] === undefined ? 1 : Number(m[4]);
		return a === 1 && Math.max(r, g, b) - Math.min(r, g, b) <= 8 && Math.max(r, g, b) <= 110;
	};
	h.check(
		accents.length === 2 && accents.map((a) => a.part).sort().join() === 'leg,triangle' &&
			accents.every((a) => greyOk(a.fill) && Number(a.opacity) === 1 && Number(a.fillOpacity) === 1),
		`both logo accent parts are an opaque dark grey (${JSON.stringify(accents)})`
	);
	if (SHOTS) await G.p.screenshot({ path: path.join(SHOTS, '05-itch-iframe-mini-golf-menu.png') });

	// play: Tee off + a real mouse putt
	await G.frame.locator('#hud-layer button', { hasText: 'Tee off' }).click();
	await h.eventually(
		() => G.frame.evaluate(() => /** @type {any} */ (globalThis).__minigolf?.vars?.()?.mgHole ?? null),
		(v) => v === 1,
		'Tee off starts hole 1 inside the exported game',
		10000
	);
	await G.p.waitForTimeout(900);
	const ball = await G.frame.evaluate(() => {
		const s = /** @type {any} */ (window).__stores;
		let cam;
		s.globalCamera.subscribe((/** @type {any} */ v) => (cam = v))();
		let r;
		s.globalRenderer.subscribe((/** @type {any} */ v) => (r = v))();
		const b = /** @type {any} */ (globalThis).__minigolf.ball().pos;
		const v = new s.THREE.Vector3(...b).project(cam);
		const rect = r.domElement.getBoundingClientRect();
		return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
	});
	// the iframe sits at (0,0) on the host page, so frame coordinates are page coordinates
	await G.p.mouse.move(ball.x, ball.y);
	await G.p.mouse.down();
	await G.p.mouse.move(ball.x, ball.y + 40, { steps: 4 });
	await G.p.mouse.move(ball.x, ball.y + 90, { steps: 4 });
	await G.p.mouse.up();
	await h.eventually(
		() => G.frame.evaluate(() => /** @type {any} */ (globalThis).__minigolf?.vars?.()?.mgStrokes ?? null),
		(n) => n === 1,
		'a real-mouse putt in the exported game counts one stroke',
		6000
	);
	await G.p.waitForTimeout(1500);
	if (SHOTS) await G.p.screenshot({ path: path.join(SHOTS, '06-itch-iframe-mini-golf-putt.png') });

	// the badge on hover: the words, 85%
	await G.p.mouse.move(1270 - 12, 720 - 26);
	await G.p.waitForTimeout(400);
	const hover = await G.frame.evaluate(() => {
		const b = /** @type {HTMLElement} */ (document.querySelector('#made-with-tp'));
		return { opacity: getComputedStyle(b).opacity, width: b.getBoundingClientRect().width };
	});
	h.check(Math.abs(Number(hover.opacity) - 0.85) < 0.05 && hover.width > 120, `hover: 85% and the words slide out (${JSON.stringify(hover)})`);
	if (SHOTS) await G.p.screenshot({ path: path.join(SHOTS, '07-badge-hover.png'), clip: { x: 980, y: 640, width: 300, height: 80 } });

	// it lifts above a control that marks itself data-hud-avoid (36-touch's buttons)
	await G.frame.evaluate(() => {
		const d = document.createElement('div');
		d.id = 'fake-touch-button';
		d.setAttribute('data-hud-avoid', '');
		d.style.cssText = 'position:fixed;right:6px;bottom:6px;width:90px;height:90px;background:rgba(255,0,0,.3);z-index:50';
		document.body.appendChild(d);
	});
	await h.eventually(
		() =>
			G.frame.evaluate(() => {
				const b = /** @type {HTMLElement} */ (document.querySelector('#made-with-tp')).getBoundingClientRect();
				const t = /** @type {HTMLElement} */ (document.querySelector('#fake-touch-button')).getBoundingClientRect();
				return b.bottom <= t.top;
			}),
		(v) => v === true,
		'the badge lifts above a [data-hud-avoid] touch button',
		3000
	);
	h.check(G.foreign.length === 0, `no request left the game's origin (${G.foreign.slice(0, 3).join(', ') || 'none'})`);
	h.check(G.errors.length === 0, `no page errors in the exported game (${G.errors.slice(0, 2).join(' | ')})`);
	await G.ctx.close();

	// ---- Sky Run (static preset, FPS on by the export's default)
	const S = await openGame('sky.html');
	await h.eventually(
		() => S.frame.evaluate(() => /** @type {any} */ (window).__stores.exportRuntime.exportRuntimeState.phase),
		(v) => v === 'playing' || v === 'failed',
		'the exported Sky Run boots and asks for Play',
		60000
	);
	const sState = await S.frame.evaluate((r) => {
		const s = /** @type {any} */ (window).__stores;
		const rd = eval(r);
		return {
			locked: rd(s.isLocked),
			fps: !!document.querySelector('#game-fps-counter'),
			sky: !!(/** @type {any} */ (globalThis).__skyrun),
			path: location.pathname,
			gid: rd(s.gameSettings.gameId),
			showFps: rd(s.gameSettings.gameSettingValues).showFps,
			keys: Object.keys(localStorage).filter((k) => /^tp:game/.test(k))
		};
	}, read);
	h.check(sState.locked === true && sState.sky, `Sky Run autoplays with its module awake (${JSON.stringify(sState)})`);
	h.check(sState.fps, 'the export’s "Show FPS" default turns the game’s FPS counter on');
	if (SHOTS) await S.p.screenshot({ path: path.join(SHOTS, '08-static-iframe-sky-run-menu.png') });
	const stageBtn = S.frame.locator('#hud-layer button', { hasText: 'Cloud Steps' }).first();
	await stageBtn.click({ timeout: 10000 });
	await h.eventually(
		() => S.frame.evaluate(() => /** @type {any} */ (globalThis).__skyrun?.phase?.() ?? null),
		(v) => typeof v === 'string' && v !== 'menu' && v !== 'idle',
		'a Sky Run stage starts inside the exported game',
		10000
	);
	await S.frame.evaluate(() => /** @type {any} */ (globalThis).__skyrun.teleportTo('Sky S1 step 1'));
	await S.p.waitForTimeout(1200);
	const run = await S.frame.evaluate(() => /** @type {any} */ (globalThis).__skyrun.run());
	h.check(!!run, `the runner is on the course (${JSON.stringify(run).slice(0, 120)})`);
	if (SHOTS) await S.p.screenshot({ path: path.join(SHOTS, '09-static-iframe-sky-run-playing.png') });
	h.check(S.foreign.length === 0, `Sky Run: no request left the game's origin (${S.foreign.slice(0, 3).join(', ') || 'none'})`);
	h.check(S.errors.length === 0, `Sky Run: no page errors (${S.errors.slice(0, 2).join(' | ')})`);
	await S.ctx.close();

	// ---------------------------------------------- 5. the badge cannot be switched off
	const T = await openGame('tamper.html');
	await h.eventually(
		() => T.frame.evaluate(() => /** @type {any} */ (window).__stores.exportRuntime.exportRuntimeState.phase),
		(v) => v === 'playing' || v === 'failed',
		'the tampered export still boots',
		60000
	);
	const tamper = await T.frame.evaluate(() => {
		const cfg = /** @type {any} */ (window).__stores.exportBoot.exportConfig;
		return {
			badge: !!document.querySelector('#made-with-tp'),
			raw: JSON.stringify(/** @type {any} */ (window).__TP_EXPORT__).includes('hideBadge'),
			keys: Object.keys(cfg).filter((k) => /badge/i.test(k))
		};
	});
	h.check(tamper.raw && tamper.keys.length === 0, `play.js asked to hide the badge; the runtime copied none of it (${tamper.keys})`);
	h.check(tamper.badge, 'with hideBadge/badge:false in play.js AND ?badge=0&hideBadge=1&embed=0 in the URL, the badge is still drawn');
	await T.ctx.close();
	host.close();
	game.close();

	// ---------------------------------------------- 6. a play link draws it too
	const P = await h.setupPage(browser, 'P', { hash: '?s=abc123&play=1&embed=1' });
	const pl = await P.page.evaluate(() => {
		const b = /** @type {HTMLAnchorElement | null} */ (document.querySelector('#made-with-tp'));
		return { href: b?.href ?? null, open: !!document.querySelector('#embed-open-link'), fs: !!document.querySelector('#embed-fullscreen') };
	});
	h.check(!!pl.href && new URL(pl.href).searchParams.get('g') === 'abc123' && new URL(pl.href).searchParams.get('ref') === 'export', `a play link draws the badge with g=<scene id> (${pl.href})`);
	h.check(pl.open, 'a play link keeps its "Open in theprototype.app" link');
	await P.ctx.close();

	fs.rmSync(WORK, { recursive: true, force: true });
	await h.finish(browser);
});
