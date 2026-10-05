#!/usr/bin/env node
// 34 B4 — VR-EYE SHOTS OF ANY SCENE, for a lane's evidence: "what does each eye of a headset see
// at the spawn of my game?" without writing a suite. Loads a .tpscene in a real (headless) app
// with the fake XR session, enters a mode, and saves both eyes (tests/e2e/vrEyes.cjs: three's eye
// layer masks, the headset's sRGB target, every render seam) per viewpoint.
//
//   APP_URL=https://theprototype.app:5293/ node scripts/eye-shots.cjs <scene.tpscene>
//        [--mode play|interact|edit] (default play)   [--modules <dir with <id>.zip>]
//        [--at x,y,z --yaw r]   (feet; default the scene's play.spawn, else 0,0,4)
//        [--views <level slug>] (every named viewpoint of scripts/level-views.cjs)
//        [--size 512] [--out <dir>] [--name <prefix>]
//        [--hud]   (36 B12: mid-round — Interact, the game state 'playing', the VR game HUD band
//                   posed from the eye head; writes <name>-<view>-hud.json beside the PNGs)
//
// Run it through e2e-slot like any suite (`e2e-slot --dev . <port> -- node scripts/eye-shots.cjs …`).
// Writes <out>/<name>-<view>-left.png, -right.png and -pair.png (left | right).
const fs = require('fs');
const path = require('path');
const h = require('../tests/e2e/helpers.cjs');
const fx = require('../tests/e2e/fakeXR.cjs');
const eyes = require('../tests/e2e/vrEyes.cjs');
const { settleScene, settleLod } = require('./perfProbe.cjs');
const { sessionOf } = require('./scene-lint.cjs');
const { placeCamera } = require('./perf-levels.cjs');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const FILE = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const MODE = arg('mode', 'play');
const MODULES = arg('modules', null);
const SIZE = Number(arg('size', '512'));
const OUT = arg('out', path.join(process.cwd(), 'eye-shots'));
const HUD = argv.includes('--hud');
const NAME = arg('name', FILE ? path.basename(path.dirname(path.resolve(FILE))) : 'scene');

async function main() {
	if (!FILE || !fs.existsSync(FILE)) {
		console.error('usage: node scripts/eye-shots.cjs <scene.tpscene> [--mode play|interact|edit] [--modules dir] [--at x,y,z --yaw r | --views slug] [--size 512] [--out dir]');
		process.exit(2);
	}
	const bytes = fs.readFileSync(FILE);
	const session = sessionOf(bytes);
	/** @type {[string, number[], number][]} */
	let views;
	if (arg('views', null)) views = require('./level-views.cjs')[arg('views', '')] ?? [];
	else {
		const sp = session.physics?.play?.spawn;
		const at = arg('at', null)?.split(',').map(Number) ?? sp?.position ?? sp?.pos ?? [0, 0, 4];
		views = [['spawn', at, Number(arg('yaw', String(sp?.yaw ?? 0)))]];
	}
	const modules = (session.modules ?? []).map((m) => (typeof m === 'string' ? m : m.id));
	const browser = await h.launch({ args: h.GPU_ARGS });
	const peer = await h.setupPage(browser, 'eyes', { context: { viewport: { width: 1280, height: 720 } } });
	const page = peer.page;
	try {
		// a CORE module (Towers, the 35 games) is already loaded: only user modules need a zip
		const loaded = await page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id));
		for (const id of modules) {
			if (loaded.includes(id)) continue;
			const zip = MODULES ? path.join(MODULES, id + '.zip') : h.moduleZipPath(id);
			if (!fs.existsSync(zip)) throw new Error(`the scene needs module ${id}: no ${zip} (--modules <dir>)`);
			await page.evaluate(() => window.__stores.modulesOpen.set(true));
			await page.waitForTimeout(400);
			await page.getByRole('tab', { name: /^User/ }).click();
			await page.locator('#install-module-zip').setInputFiles({ name: id + '.zip', mimeType: 'application/zip', buffer: fs.readFileSync(zip) });
			await h.eventually(() => page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id)), (ids) => ids.includes(id), 'module ' + id, 30000);
			await page.evaluate(() => window.__stores.modulesOpen.set(false));
		}
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			const payload = await s.sessions.importSessionZip(new Uint8Array(arr).buffer);
			if (payload) await s.sessions.requestLoadSession(payload.id);
		}, Array.from(bytes));
		await page.waitForTimeout(1500);
		await settleScene(page);
		// --hud drives the VR game surfaces with a synthetic head (no fake session: its frame hook
		// would re-pose them from its own head between our frames and the shot)
		if (!HUD) {
			await fx.install(page);
			await fx.pose(page, 'left', [-20, 30, 20], { pitch: 1.4 });
			await fx.pose(page, 'right', [20, 30, 20], { pitch: 1.4 });
		}
		if (HUD)
			await page.evaluate(() => {
				const s = window.__stores;
				s.objectActions.setEditorMode('interact');
				s.gameState.setGameState('playing');
			});
		else if (MODE === 'play') await page.locator('#play-button').click({ timeout: 10000 }).catch(() => page.evaluate(() => window.__stores.isLocked.set(true)));
		else if (MODE === 'interact') await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
		await page.waitForTimeout(1500);
		fs.mkdirSync(OUT, { recursive: true });
		for (const [label, feet, yaw] of views) {
			const head = { position: [feet[0], feet[1] + 1.7, feet[2]], yaw }; // perf-levels.placeCamera's eye height
			// the Play camera stands there too, so what follows the head (panels, the HUD strip) is there
			if (MODE === 'play') await placeCamera(page, feet, yaw);
			await page.waitForTimeout(400);
			await settleLod(page);
			const file = path.join(OUT, `${NAME}-${label.replace(/\W+/g, '-')}`);
			if (HUD) {
				const band = await page.evaluate(async (hd) => {
					const s = window.__stores;
					const THREE = s.THREE;
					const head = { position: new THREE.Vector3(...hd.position), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, hd.yaw, 0, 'YXZ')) };
					for (let i = 0; i < 120; i++) {
						s.gameKit.vrGamePanel.vrGamePanelFrame({ head, hands: [null, null], dt: 1 / 72 });
						if (i % 30 === 29) await new Promise((r) => setTimeout(r, 120)); // let the runtime texts arrive
					}
					const d = s.gameKit.vrHud.vrHudDebug();
					return { visible: d.visible, placement: d.placement, radius: d.radius, halfWidth: d.halfWidth, atlas: d.atlas, triangles: d.triangles, hints: d.hints, groups: d.groups.map((g) => ({ ids: g.ids, f: g.f, k: g.k, texelRatio: +g.texelRatio.toFixed(3), plate: g.plate })) };
				}, head);
				fs.writeFileSync(file + '-hud.json', JSON.stringify(band, null, 1) + '\n');
				console.log(`${label}: band ${band.visible ? 'up' : 'DOWN'}, ${band.groups.length} groups, radius ${Number(band.radius).toFixed(2)} m`);
			}
			const out = await eyes.save(page, file, { size: SIZE, head });
			console.log(`${label}: ${out.pair}`);
		}
	} finally {
		await browser.close();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
