// 63 PG3 (63-export row 4) — THE CRAZYGAMES PRESET. Against a BUILT app (scripts/serve-build.cjs):
//
//   1. the starter game (else Mini Golf) is exported with the CrazyGames preset through the builder;
//      check-export.cjs --preset crazygames passes it; index.html loads the SDK from
//      https://sdk.crazygames.com/crazygames-sdk-v3.js and the page's CSP lets it
//   2. the zip is served from a subpath on a second origin inside an iframe; the SDK host is
//      answered by a MOCK (a script recording every call) and every OTHER outside request is
//      refused: the refused list is empty, the SDK host is the only outside host contacted
//   3. the adapter reports loadingStart → loadingStop on boot, then gameplayStart / gameplayStop
//      through start → pause → resume → game over → next level, each edge exactly once, in order
//      (driven by the game-flow state the HUD reads: gameState, a level change)
//   4. no fullscreen button of the game's own, the badge drawn without a link, no player data
//      passed to the SDK (every recorded call has no arguments)
//   5. a ~64 MB scene is REFUSED through the real Export tab: the initial-download row is an error,
//      the biggest asset (the object holding the bytes) is listed first and selects it in the editor
//
// Evidence: EXPORT_EVIDENCE=<dir> writes crazygames.har, crazygames-calls.json and screenshots.
const h = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { unzipSync, strFromU8 } = require('fflate');
const X = require('./export-helpers.cjs');

const ROOT = path.resolve(__dirname, '../..');
const SIBLINGS = path.resolve(ROOT, '..');
const find = (/** @type {(string | undefined)[]} */ list) => list.filter(Boolean).find((p) => fs.existsSync(/** @type {string} */ (p)));
const scenesDir = find([process.env.SCENES_DIR, path.join(SIBLINGS, 'scenes')]) || '';
const STARTER = find([process.env.STARTER_TPSCENE, scenesDir && path.join(scenesDir, 'games/starter-dash/scene.tpscene'), process.env.MINIGOLF_TPSCENE, scenesDir && path.join(scenesDir, 'games/mini-golf/scene.tpscene')]);
const EVIDENCE = process.env.EXPORT_EVIDENCE || '';
const WORK = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tp-export-cg-'));
const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

/** the mock SDK: the v3 surface the adapter uses, every call recorded with its arguments */
const MOCK_SDK = `(() => {
	const calls = (window.__cgCalls = []);
	const rec = (name) => (...args) => { calls.push({ name, args: args.length, t: Date.now() }); return Promise.resolve(); };
	window.CrazyGames = { SDK: { environment: 'crazygames', init: rec('init'),
		game: { loadingStart: rec('loadingStart'), loadingStop: rec('loadingStop'), gameplayStart: rec('gameplayStart'), gameplayStop: rec('gameplayStop') } } };
})();`;

h.run(async () => {
	if (!STARTER) {
		console.log('SKIP: no starter / mini-golf .tpscene (set STARTER_TPSCENE)');
		return;
	}
	if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const built0 = await page.evaluate(() => fetch(new URL('export-manifest.json', document.baseURI)).then((r) => r.ok).catch(() => false));
	if (!built0) {
		console.log('SKIP: no export-manifest.json — run against the BUILT app (scripts/serve-build.cjs)');
		await browser.close();
		return;
	}

	// ---------------------------------------------------------------- 1. the export
	await X.loadSceneBytes(page, fs.readFileSync(STARTER));
	const built = await X.buildZip(page, { preset: 'crazygames', title: 'Starter CG' });
	const zipPath = path.join(WORK, built.fileName);
	fs.writeFileSync(zipPath, built.bytes);
	h.check(built.fileName === 'starter-cg-crazygames.zip', `the preset names its zip (${built.fileName})`);
	let check = { ok: false, out: '' };
	try {
		check = { ok: true, out: execFileSync('node', [path.join(ROOT, 'scripts/check-export.cjs'), zipPath, '--preset', 'crazygames'], { encoding: 'utf8' }) };
	} catch (e) {
		check = { ok: false, out: String(/** @type {any} */ (e).stdout || e) };
	}
	console.log(check.out);
	h.check(check.ok, 'check-export.cjs --preset crazygames passes the zip');
	const entries = unzipSync(new Uint8Array(built.bytes));
	const html = strFromU8(entries['index.html']);
	h.check(html.includes(`<script src="${SDK_URL}"></script>`) && html.indexOf('./play.js') < html.indexOf(SDK_URL), 'index.html loads the SDK v3 from their URL, after ./play.js');
	h.check(/script-src [^;]*https:\/\/sdk\.crazygames\.com/.test(html), "the page's CSP lets the SDK script in");
	const cfg = JSON.parse(/window\.__TP_EXPORT__ = ([\s\S]*);\s*$/.exec(strFromU8(entries['play.js']))?.[1] || '{}');
	h.check(cfg.preset === 'crazygames' && cfg.startFullscreen === false, `play.js: preset crazygames, never start fullscreen (${cfg.preset}, ${cfg.startFullscreen})`);
	h.check(!Object.keys(entries).some((n) => /crazygames-sdk/.test(n)), 'the SDK is not copied into the zip (it loads from their URL only)');

	// a second export of the same scene keeps the id and the file name (row 7)
	const again = await X.buildZip(page, { preset: 'crazygames', title: 'Starter CG' });
	h.check(again.id === built.id && again.fileName === built.fileName, `exporting again keeps the export id and file name (${built.id} / ${again.id})`);

	// ---------------------------------------------------------------- 2-4. play it framed
	const dir = path.join(WORK, 'game');
	X.unzipTo(new Uint8Array(built.bytes), dir);
	const game = await X.serve({ '/html/6301/': dir });
	const gameOrigin = `http://127.0.0.1:${game.address().port}`;
	const hostDir = path.join(WORK, 'host');
	fs.mkdirSync(hostDir);
	fs.writeFileSync(path.join(hostDir, 'cg.html'), X.hostHtml(`${gameOrigin}/html/6301/index.html`));
	const host = await X.serve({ '/': hostDir });
	const hostOrigin = `http://localhost:${host.address().port}`;
	const har = EVIDENCE ? path.join(EVIDENCE, 'crazygames.har') : '';
	// the SDK URL is answered by the mock; every other outside request is refused
	const G = await X.openFramed(browser, `${hostOrigin}/cg.html`, { allowOrigins: [gameOrigin, hostOrigin], mocks: { [SDK_URL]: { body: MOCK_SDK } }, har });
	await h.eventually(() => X.phaseOf(G.frame), (v) => v.phase === 'playing' || v.phase === 'failed', 'the CrazyGames export boots and asks for Play', 180000);
	await h.eventually(
		() => G.frame.evaluate(() => /** @type {any} */ (window).__tp.test.v1.portalCrazyGames.crazyGamesState.status),
		(v) => v === 'live',
		'the adapter found the SDK, init resolved, environment crazygames: live',
		15000
	);
	const calls = () => G.frame.evaluate(() => /** @type {any} */ (window).__cgCalls.map((/** @type {any} */ c) => c.name));
	await h.eventually(calls, (c) => c.includes('loadingStop'), 'boot: loadingStart then loadingStop', 20000);
	// the game-flow state the HUD reads: start, pause, resume, game over, the next level
	/** @param {string} what */
	const flow = (what) =>
		G.frame.evaluate((/** @type {string} */ w) => {
			const t = /** @type {any} */ (window).__tp.test.v1;
			const gs = t.gameState;
			if (w === 'menu') gs.setGameState('menu');
			if (w === 'start' || w === 'resume' || w === 'nextlevel-done') gs.setGameState('playing');
			if (w === 'pause') gs.setGameState('paused');
			if (w === 'over') gs.setGameState('over');
			// a level change: the cover goes up (a break), the next level's round starts under it, the cover lifts
			if (w === 'nextlevel') t.levelTransition.levelTransition.set({ kind: 'fade', phase: 'out', title: 'Level 2', goal: '' });
			if (w === 'nextlevel-in') t.levelTransition.levelTransition.set({ kind: 'fade', phase: 'idle', title: '', goal: '' });
		}, what);
	const step = async (/** @type {string} */ w) => {
		await flow(w);
		await G.p.waitForTimeout(250);
	};
	await step('menu');
	// from the menu on, the sequence is fixed whatever the boot ended in
	const n0 = (await calls()).length;
	await step('start');
	await step('start'); // a re-publish of the same state: no second call
	await step('pause');
	await step('resume');
	await step('over');
	await step('nextlevel');
	await step('nextlevel-done');
	await step('nextlevel-in');
	const seq = await calls();
	if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, 'crazygames-calls.json'), JSON.stringify(await G.frame.evaluate(() => /** @type {any} */ (window).__cgCalls), null, 2));
	console.log('  SDK calls: ' + seq.join(' → '));
	const want = ['init', 'loadingStart', 'loadingStop'];
	h.check(JSON.stringify(seq.slice(0, 3)) === JSON.stringify(want), `init, loadingStart, loadingStop first (${seq.slice(0, 3).join(', ')})`);
	const tail = seq.slice(n0);
	h.check(
		JSON.stringify(tail) === JSON.stringify(['gameplayStart', 'gameplayStop', 'gameplayStart', 'gameplayStop', 'gameplayStart']),
		`start → pause → resume → game over → next level: Start Stop Start Stop … Start, each edge once (${tail.join(' ')})`
	);
	h.check(seq.every((n, i) => i === 0 || n !== seq[i - 1]), 'no call repeats back to back');
	const args = await G.frame.evaluate(() => /** @type {any} */ (window).__cgCalls.every((/** @type {any} */ c) => c.args === 0));
	h.check(args, 'every SDK call carries no arguments (no player or scene data)');
	h.check(G.refused.length === 0, `no request outside the game's origin except the SDK (${G.refused.length}: ${G.refused.slice(0, 4).join(' | ')})`);
	h.check(G.mocked.length >= 1 && G.mocked.every((u) => u.startsWith(SDK_URL)), `the SDK URL is the one outside host contacted (${G.mocked.length})`);
	const chrome = await G.frame.evaluate(() => {
		const b = /** @type {HTMLAnchorElement | null} */ (document.querySelector('#made-with-tp'));
		return { fullscreen: !!document.querySelector('#embed-fullscreen'), badge: !!b, href: b?.getAttribute('href') ?? null, link: b?.dataset.link };
	});
	h.check(!chrome.fullscreen, 'no fullscreen button of the game’s own (CrazyGames provides it)');
	h.check(chrome.badge && chrome.href === null && chrome.link === 'off', `the badge is drawn, without a link (${JSON.stringify(chrome)})`);
	if (EVIDENCE) await G.p.screenshot({ path: path.join(EVIDENCE, 'crazygames-playing.png') });
	await G.ctx.close();

	// ---------------------------------------------------------------- 5. a 64 MB scene is refused
	await page.evaluate(() => {
		const t = /** @type {any} */ (window).__tp.test.v1;
		let group;
		t.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
		const mesh = new t.THREE.Mesh(new t.THREE.BoxGeometry(1, 1, 1), new t.THREE.MeshStandardMaterial());
		mesh.name = 'Huge statue';
		// incompressible bytes inside the object (what a huge embedded model or texture is)
		const raw = new Uint8Array(48 * 1024 * 1024);
		for (let i = 0; i < raw.length; i += 65536) crypto.getRandomValues(raw.subarray(i, i + 65536));
		let s = '';
		for (let i = 0; i < raw.length; i += 0x8000) s += String.fromCharCode(...raw.subarray(i, i + 0x8000));
		mesh.userData.payload = btoa(s);
		group.add(mesh);
		/** @type {any} */ (window).__hugeUuid = mesh.uuid;
	});
	const hugeUuid = await page.evaluate(() => /** @type {any} */ (window).__hugeUuid);
	await page.locator('#logo-menu').click();
	await page.locator('#open-publish-export').click();
	await page.locator('#publish-export-modal').waitFor({ state: 'visible', timeout: 10000 });
	await page.locator('#publish-export-tab-export').click();
	await page.locator('#export-preset-crazygames').click();
	await page.locator('#export-title').fill('Huge');
	await page.locator('#export-go').click();
	await page.locator('#export-refused').waitFor({ state: 'visible', timeout: 240000 });
	const refusal = await page.evaluate(() => {
		const row = document.querySelector('#export-checks [data-rule="export-initial-download"]');
		const sizes = [...document.querySelectorAll('#export-refused-assets #export-sizes li')].map((li) => ({ text: li.textContent?.trim().slice(0, 80), bytes: Number(li.getAttribute('data-bytes')), kind: li.getAttribute('data-kind') }));
		return { severity: row?.getAttribute('data-severity'), title: row?.textContent?.trim().slice(0, 160), sizes, downloaded: !!document.querySelector('#export-result') };
	});
	console.log('  refusal: ' + JSON.stringify(refusal).slice(0, 400));
	h.check(refusal.severity === 'error' && /CrazyGames allows 50 MB/.test(refusal.title || ''), `the initial-download row refuses the export (${refusal.title})`);
	h.check(!refusal.downloaded, 'nothing was downloaded');
	h.check(refusal.sizes[0]?.kind === 'object' && /Huge statue/.test(refusal.sizes[0]?.text || '') && refusal.sizes[0].bytes > 50 * 1048576, `the biggest asset is listed first: the statue (${refusal.sizes[0]?.text})`);
	if (EVIDENCE) await page.screenshot({ path: path.join(EVIDENCE, 'crazygames-refused.png') });
	await page.locator('#export-refused-assets #export-sizes li button').first().click();
	// the selection lands after a lazy import (objectActions): wait for it
	const readSel = () =>
		page.evaluate(() => {
			let v;
			/** @type {any} */ (window).__tp.test.v1.selectedObjects?.subscribe((/** @type {any} */ x) => (v = x))();
			return Array.isArray(v) ? v.map((/** @type {any} */ o) => o?.uuid || o) : [];
		});
	await h.eventually(readSel, (sel) => sel.includes(hugeUuid), 'the size-list row selects the object in the editor', 8000);

	await browser.close();
	game.close();
	host.close();
});
