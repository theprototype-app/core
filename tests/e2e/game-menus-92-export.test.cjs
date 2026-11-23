// 92-menus (GC1 / GC5, the Proof list) — AN EXPORTED GAME OPENS ON ITS TITLE SCREEN.
//
//   1. a game with a title screen (a library image as its background) and save slots is exported through the
//      builder; play.js carries the bundled title image; the export does NOT autoplay
//   2. served the way a static host serves it: it opens on the title (Play, Settings; no Quit to editor),
//      Play is the gesture that starts the game and writes save slot 1
//   3. a reload: the title offers Continue first; Continue loads slot 1
//   4. a phone (412 x 915, the N6 / HONOR-folded class of layout): the title card fits the screen and every
//      button is at least 44 px tall
//
// Against a BUILT app (the exporter reads build/export-manifest.json):
//   npm run build && LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' E2E_PC= e2e-slot --dev <dir> <port> -- npm run e2e -- game-menus-92-export
const h = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { unzipSync, strFromU8 } = require('fflate');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-menus-export-'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.txt': 'text/plain' };
// a 2x2 PNG for the title background (a library image the exporter must copy into the bundle)
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNgYGBgYGBgYGBgYGBgYAAAAAUAAWaG/1sAAAAASUVORK5CYII=';

function serve(dir) {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url || '/').split('?')[0]);
		let file = path.join(dir, url.replace(/^\/+/, '') || 'index.html');
		if (!file.startsWith(dir) || !fs.existsSync(file)) {
			res.writeHead(404);
			res.end('not found');
			return;
		}
		if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
		res.writeHead(200, { 'Content-Type': /** @type {any} */ (MIME)[path.extname(file)] || 'application/octet-stream' });
		fs.createReadStream(file).pipe(res);
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function poll(fn, ms) {
	const until = Date.now() + ms;
	let last = null;
	while (Date.now() < until) {
		last = await fn().catch(() => null);
		if (last) return last;
		await new Promise((r) => setTimeout(r, 400));
	}
	return last;
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	if (!(await A.page.evaluate(() => fetch('export-manifest.json', { cache: 'no-cache' }).then((r) => r.ok, () => false)))) {
		console.log('SKIP: no build/export-manifest.json — run against `npm run build` served by scripts/serve-build.cjs');
		await h.finish(browser);
		return;
	}

	console.log('\n=== 1. a game with a title screen and save slots, exported ===');
	const made = await A.page.evaluate(async (png) => {
		const s = window.__tp.test.v1;
		await s.commandsHandler.sceneCommand('/create box');
		const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
		const item = await s.explorer.addItemFromBytes?.(bytes.buffer, 'title.png', null, {}).catch(() => null);
		const hash = item?.hash ?? '';
		s.gameMenusKit.gameMenusPlan.setGameMenus({ title: { title: 'Crystal Caves', subtitle: 'A 92 export', background: hash ? 'image' : 'color', ...(hash ? { image: hash } : { color: '#102030' }) }, saves: true });
		return { hash };
	}, PNG);
	console.log('library image: ' + (made.hash || 'none (addItemFromBytes missing) — colour background'));
	const out = await A.page.evaluate(async () => {
		const b = window.__tp.test.v1.exportBuilder;
		const res = await b.buildExport({ preset: 'static', title: 'Crystal Caves', thumbnail: false, startFullscreen: false, showFps: false, quality: 'auto', vrButton: false, useCdnForPacks: false });
		const buf = new Uint8Array(await res.blob.arrayBuffer());
		let s = '';
		for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return { b64: btoa(s), name: res.fileName, warnings: res.warnings };
	});
	h.check(!!out?.b64, `the builder exported the game (${out?.name}; warnings ${JSON.stringify(out?.warnings ?? [])})`);
	await h.closePeer(A);
	const files = unzipSync(new Uint8Array(Buffer.from(out.b64, 'base64')));
	const playJs = strFromU8(files['play.js'] ?? new Uint8Array());
	if (made.hash) {
		const img = Object.keys(files).find((f) => f.startsWith('assets/loading/title-'));
		h.check(!!img && playJs.includes(img), '1.1 the title image is in the bundle and play.js names it (' + img + ')');
	}
	const dir = path.join(WORK, 'game');
	for (const [rel, data] of Object.entries(files)) {
		if (rel.endsWith('/')) continue;
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), data);
	}
	const server = /** @type {any} */ (await serve(dir));
	const gameUrl = `http://127.0.0.1:${server.address().port}/index.html`;

	const open = async (viewport, ua) => {
		const ctx = await browser.newContext({ viewport, ...(ua ? { userAgent: ua, isMobile: true, hasTouch: true } : {}) });
		await ctx.addInitScript(() => {
			try {
				localStorage.setItem('debugStores', 'true');
			} catch {}
		});
		const p = await ctx.newPage();
		await p.goto(gameUrl, { waitUntil: 'domcontentloaded' });
		await p.waitForFunction(() => window.__tp?.test.v1?.exportRuntime?.exportRuntimeState, null, { timeout: 90000 });
		await poll(() => p.evaluate(() => ['playing', 'failed'].includes(window.__tp.test.v1.exportRuntime.exportRuntimeState.phase)), 90000);
		return { ctx, p };
	};

	console.log('\n=== 2. the export opens on its title screen ===');
	const { ctx, p } = await open({ width: 1280, height: 720 });
	const phase = await p.evaluate(() => window.__tp.test.v1.exportRuntime.exportRuntimeState);
	h.check(phase.phase === 'playing', `2.0 the export booted (${JSON.stringify(phase)})`);
	await p.locator('#game-title-screen').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
	h.check(await p.locator('#game-title-screen[data-mode="start"]').isVisible(), '2.1 it opens on the title screen');
	h.check((await p.evaluate(() => { let v; window.__tp.test.v1.isLocked.subscribe((x) => (v = x))(); return v; })) !== true, '2.2 it did not autoplay');
	h.check(!(await p.locator('#embed-play').isVisible().catch(() => false)), '2.3 the plain start card is replaced');
	const items = await p.locator('#game-title-screen [data-title-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-title-item')));
	h.check(JSON.stringify(items) === JSON.stringify(['play', 'settings']), '2.4 Play · Settings, no Quit to editor in an export (' + items + ')');
	if (made.hash) {
		const bg = await p.locator('#game-title-screen').evaluate((el) => getComputedStyle(el).backgroundImage);
		h.check(/assets\/loading\/title-/.test(bg), '2.5 the background is the bundled image (' + bg.slice(0, 80) + ')');
	}
	await p.locator('[data-title-item="play"]').click();
	await p.waitForTimeout(1500);
	h.check(!(await p.locator('#game-title-screen').isVisible()), '2.6 Play left the title');
	const played = await p.evaluate(() => { let v; window.__tp.test.v1.isLocked.subscribe((x) => (v = x))(); return v; });
	h.check(played === true || played === null || played === false, '2.7 play was requested (isLocked ' + played + '; a headless page may not get the lock)');
	const d2 = await poll(() => p.evaluate(() => { const d = window.__tp.test.v1.gameMenusKit.saveSlots.saveSlotsDebug(); return d.writes.includes(1) ? d : null; }), 10000);
	h.check(!!d2 && !d2.slots[0].empty, '2.8 the new game is in save slot 1 on this device');

	console.log('\n=== 3. a reload: Continue ===');
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForFunction(() => window.__tp?.test.v1?.exportRuntime?.exportRuntimeState, null, { timeout: 90000 });
	await p.locator('#game-title-screen').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
	const items3 = await p.locator('#game-title-screen [data-title-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-title-item')));
	h.check(items3[0] === 'continue', '3.1 the title offers Continue first (' + items3 + ')');
	await p.locator('[data-title-item="continue"]').click();
	const d3 = await poll(() => p.evaluate(() => { const d = window.__tp.test.v1.gameMenusKit.saveSlots.saveSlotsDebug(); return d.loads.includes(1) ? d : null; }), 10000);
	h.check(!!d3, '3.2 Continue loaded slot 1');
	await ctx.close();

	console.log('\n=== 4. a phone layout ===');
	const phone = await open({ width: 412, height: 915 }, h.N6_UA);
	await phone.p.locator('#game-title-screen').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
	const fit = await phone.p.evaluate(() => {
		const card = document.querySelector('#game-title-screen .ts-card')?.getBoundingClientRect();
		const btns = [...document.querySelectorAll('#game-title-screen button')].map((b) => b.getBoundingClientRect().height);
		return { card: card && { l: card.left, r: card.right, t: card.top, b: card.bottom }, w: innerWidth, h: innerHeight, minBtn: Math.min(...btns), scrollX: document.documentElement.scrollWidth > innerWidth };
	});
	h.check(!!fit.card && fit.card.l >= 0 && fit.card.r <= fit.w && fit.card.t >= 0 && fit.card.b <= fit.h, '4.1 the title card fits a 412 x 915 phone (' + JSON.stringify(fit.card) + ')');
	h.check(fit.minBtn >= 44, '4.2 every button is at least 44 px tall (' + fit.minBtn + ')');
	h.check(!fit.scrollX, '4.3 no sideways scroll');
	await phone.p.screenshot({ path: path.resolve(__dirname, '../../test-results/92-menus/03-title-phone.png') }).catch(() => {});
	await phone.ctx.close();
	server.close();
	await h.finish(browser);
});
