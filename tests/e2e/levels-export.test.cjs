// 93 LP2 / LP3 / LP5 — LEVELS AND PROGRESS IN AN EXPORTED GAME (roadmap 93's export proofs):
//
//   1. a one-scene game with a Levels table (start-object levels), a keep list, a checkpoint and the author's
//      loading screen is exported through the builder; play.js carries the loading screen as data and the
//      screen has no "Made with" line (an exported game boots on its author's screen)
//   2. the export is served the way a static host serves it and PLAYED: stepping on the checkpoint saves this
//      player's progress on the device (one versioned key per game)
//   3. a RELOAD resumes there: the checkpoint, the respawn point and the kept variable come back
//   4. an OLD save (the v0 draft shape) naming a level the author has since removed loads the first level,
//      drops what the game no longer keeps, and the game still boots into play
//
// Against a BUILT app (the exporter reads build/export-manifest.json):
//   npm run build && LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' E2E_PC= e2e-slot --dev <dir> <port> -- npm run e2e -- levels-export
const h = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { unzipSync, strFromU8 } = require('fflate');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-levels-export-'));
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

/** a static server for one folder @param {string} dir */
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

const tool = (page, name, args) => page.evaluate(([n, a]) => window.__stores.aiTools.executeAiTool(n, a), [name, args]);
const near = (a, b, tol) => !!a && !!b && Math.hypot(a[0] - b[0], a[2] - b[2]) <= tol;

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	if (!(await A.page.evaluate(() => fetch('export-manifest.json', { cache: 'no-cache' }).then((r) => r.ok, () => false)))) {
		console.log('SKIP: no build/export-manifest.json — run against `npm run build` served by scripts/serve-build.cjs');
		await h.finish(browser);
		return;
	}

	// =====================================================================
	// 1. author + export
	// =====================================================================
	console.log('\n=== 1. a one-scene game with levels, a checkpoint and a loading screen, exported ===');
	for (const [args, what] of [
		[{ position: [0, 0, 0], name: 'Start pad' }, 'Start pad'],
		[{ position: [6, 0, -6], name: 'Ledge pad' }, 'Ledge pad'],
		[{ position: [10, 0, 10], name: 'Mid', label: 'Halfway' }, 'Mid checkpoint']
	]) {
		const r = await tool(A.page, 'set_checkpoint', args);
		h.check(!r.error, `premise: ${what} (${r.error || 'ok'})`);
	}
	const floor = await tool(A.page, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [40, 0.2, 40], position: [0, -0.1, 0], name: 'Floor' }] });
	h.check(!floor.error, 'premise: a floor to stand on');
	const set = await tool(A.page, 'set_levels', { levels: [{ name: 'Start', spawn: 'Start pad' }, { name: 'Ledge', spawn: 'Ledge pad' }], keep: ['var:coins'] });
	h.check(!set.error, 'premise: the Levels table (' + (set.error || set.note) + ')');
	const load = await tool(A.page, 'set_loading', { preset: 'logo', title: 'Crystal Caves', tips: ['Coins carry between levels'], background: '#101820' });
	h.check(!load.error, 'premise: the author\'s loading screen (' + (load.error || load.note) + ')');
	await A.page.evaluate(() => window.__stores.gameState.setGameVar('coins', 0));
	const out = await A.page.evaluate(async () => {
		const b = window.__stores.exportBuilder;
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
	h.check(/"loading"/.test(playJs) && playJs.includes('Crystal Caves') && playJs.includes('Coins carry between levels'), 'play.js carries the author\'s loading screen as data (preset, title, tip)');
	const loadingBlock = (playJs.match(/"loading":\s*\{[\s\S]*?\n\t\}/) ?? [''])[0];
	h.check(!/made with|theprototype/i.test(loadingBlock), 'the loading screen names nobody but the game (no "Made with" line)');
	const dir = path.join(WORK, 'game');
	for (const [rel, data] of Object.entries(files)) {
		if (rel.endsWith('/')) continue;
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), data);
	}
	const server = /** @type {any} */ (await serve(dir));
	const gameUrl = `http://127.0.0.1:${server.address().port}/index.html`;

	// =====================================================================
	// 2. play it: a checkpoint saves on the device
	// =====================================================================
	console.log('\n=== 2. the exported game: a checkpoint saves ===');
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
	await ctx.addInitScript(() => {
		try {
			localStorage.setItem('debugStores', 'true');
		} catch {}
	});
	const p = await ctx.newPage();
	/** @type {string[]} */
	const logs = [];
	p.on('console', (m) => logs.push(m.text()));
	const boot = async (label) => {
		await p.goto(gameUrl, { waitUntil: 'domcontentloaded' });
		await p.waitForFunction(() => window.__stores?.exportRuntime?.exportRuntimeState, null, { timeout: 90000 });
		await h.eventually(() => p.evaluate(() => window.__stores.exportRuntime.exportRuntimeState.phase), (v) => v === 'playing' || v === 'failed', label, 90000);
		const st = await p.evaluate(() => ({ phase: window.__stores.exportRuntime.exportRuntimeState.phase, error: window.__stores.exportRuntime.exportRuntimeState.error }));
		h.check(st.phase === 'playing', `…and it is playing (${JSON.stringify(st)})`);
		// a headless page may not get pointer lock: Interact is the same game on the player's own view
		await p.evaluate(() => {
			let locked;
			window.__stores.isLocked.subscribe((v) => (locked = v))();
			if (locked !== true) window.__stores.objectActions.setEditorMode('interact');
		});
	};
	await boot('the export boots into play');
	const key = await p.evaluate(() => window.__stores.levelsCheckpoints.checkpointsForTest().key);
	h.check(/^tp:levels-save:[\w.-]+$/.test(key) && (await p.evaluate(() => window.__stores.levelsCheckpoints.checkpointsForTest().persisting)), `an export persists progress under one key per game (${key})`);
	await p.evaluate(() => window.__stores.gameState.setGameVar('coins', 5));
	await p.waitForTimeout(700);
	await p.evaluate(() => {
		let cam;
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		cam.position.set(10, 1.6, 10);
		cam.updateMatrixWorld(true);
	});
	await h.eventually(() => p.evaluate(() => window.__stores.levelsCheckpoints.checkpointsForTest().point?.name ?? ''), (n) => n === 'Mid', 'stepping on Mid made it this player\'s checkpoint', 10000);
	const saved = await p.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);
	h.check(saved?.v === 1 && saved?.point?.name === 'Mid' && saved?.kept?.vars?.coins === 5, `the save is on the device: v1, Mid, coins 5 (${JSON.stringify(saved)?.slice(0, 200)})`);

	// =====================================================================
	// 3. reload: resumed at the checkpoint with the kept state
	// =====================================================================
	console.log('\n=== 3. reload ===');
	await boot('the reloaded export boots into play');
	const resumed = await p.evaluate(() => {
		let sp;
		let g;
		window.__stores.playSettings.runtimeSpawn.subscribe((v) => (sp = v))();
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return { point: window.__stores.levelsCheckpoints.checkpointsForTest().point, spawn: sp?.position ?? null, coins: g?.vars?.coins };
	});
	h.check(resumed.point?.name === 'Mid', `the checkpoint survived the reload (${JSON.stringify(resumed.point)})`);
	h.check(near(resumed.spawn, [10, 0, 10], 0.5), `this player respawns at Mid (${JSON.stringify(resumed.spawn)})`);
	h.check(resumed.coins === 5, `the kept variable came back (coins ${resumed.coins})`);
	await p.evaluate(() => window.__stores.kit.kit.runNodeAction('kit-levels-respawn', {}, { rid: 'node:e2e-respawn:2' }));
	await h.eventually(
		() => p.evaluate(() => {
			let cam;
			window.__stores.globalCamera.subscribe((v) => (cam = v))();
			return cam.position.toArray();
		}),
		(pos) => near(pos, [10, 0, 10], 3),
		'Back to checkpoint after the reload puts the player at Mid',
		10000
	);

	// =====================================================================
	// 4. an old save naming a removed level
	// =====================================================================
	console.log('\n=== 4. an old save with a removed level ===');
	await p.evaluate((k) => localStorage.setItem(k, JSON.stringify({ v: 0, level: 'lava', checkpoint: { name: 'Lava gate', spawn: { position: [40, 0, 40], yaw: 0 } }, vars: { coins: 7, gold: 99 } })), key);
	logs.length = 0;
	await boot('an old save (v0, level "lava" since removed) still boots into play');
	const after = await p.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return { level: window.__stores.kit.kit.impls.levels?.current?.() ?? null, point: window.__stores.levelsCheckpoints.checkpointsForTest().point, vars: { ...(g?.vars ?? {}) } };
	});
	h.check(after.level === 'start', `it starts the FIRST level (${after.level})`);
	// the player now spawns ON the Start pad, which makes it the checkpoint; what must be gone is the removed level's
	h.check(!after.point || (after.point.name !== 'Lava gate' && !near(after.point.spawn?.position, [40, 0, 40], 1)), `the removed level's checkpoint is dropped (${JSON.stringify(after.point)})`);
	h.check(after.vars.coins === 7 && !('gold' in after.vars), `kept coins (${after.vars.coins}), dropped what the game no longer keeps (${JSON.stringify(after.vars)})`);
	const note = logs.find((l) => l.includes('saved progress'));
	h.check(!!note && note.includes('lava') && note.includes('gold'), `the console says what changed (${note})`);

	server.close();
	await ctx.close();
	await h.finish(browser);
});
