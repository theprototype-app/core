// Shared helpers for the e2e suite. Tests are plain node scripts (no runner
// framework) driving two/three real browser contexts through the public
// PeerJS cloud — see README.md for the recipe and gotchas.

const { chromium } = require('playwright');

const URL = process.env.APP_URL || 'https://theprototype.app:5173/';

// Optional: seed the peer-server Settings for every test context. Needed when
// the app is served from a hostname the peerHandler treats as LOCAL DEV
// (anything not ending .io/.app — e.g. https://localhost:5175 in a worktree
// lane): default mode then targets a local :9001 signaling server that
// usually isn't running. Example:
//   PEER_CONFIG={"mode":"custom","custom":{"host":"peerjs.theprototype.app","port":443,"path":"/peerjs","secure":true}}
const PEER_CONFIG = process.env.PEER_CONFIG || '';

let failures = 0;

/** @param {boolean} ok @param {string} label */
function check(ok, label) {
	console.log((ok ? 'PASS ' : 'FAIL ') + label);
	if (!ok) failures++;
}

// Headless Chromium renders WebGL through SwiftShader by default, which makes the
// viewport the frame-rate bottleneck (measured: ~4.5 fps at 1280x720 with the AO
// pass on). These flags hand ANGLE the real GPU when there is one — ANGLE falls
// back to SwiftShader on its own where there isn't, so they are safe everywhere.
// Only worth passing when a test actually cares about frame rate (net-stress).
const GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];

/** @param {any=} options e.g. {args: ['--use-fake-device-for-media-stream']} */
function launch(options = {}) {
	// background pages must keep full-rate rAF — synced-clock phase checks
	// (module-sdk wave) read stale frames on a throttled renderer otherwise
	const noThrottle = [
		'--disable-background-timer-throttling',
		'--disable-renderer-backgrounding',
		'--disable-backgrounding-occluded-windows'
	];
	const { args = [], ...rest } = options;
	return chromium.launch({ headless: true, args: [...noThrottle, ...args], ...rest });
}

/**
 * Fresh context + page with debug stores enabled, waits for hydration.
 * `options.context` is spread into newContext (viewport, hasTouch, …);
 * `options.storage` seeds extra localStorage keys BEFORE the app boots, for
 * prefs that must be in place at module-eval time (e.g. `viewMode`).
 * @returns {{ctx: any, page: any, id: string}}
 */
async function setupPage(browser, name, options = {}) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...(options.context ?? {}) });
	await ctx.addInitScript((peerConfig) => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		// RW: a fresh profile is a "first visit", which opens the welcome overlay over
		// the whole UI. The whats-new suite clears this flag to test that path.
		// (With it set and no lastSeenVersion, startWhatsNew marks the version seen
		// silently — so no update badge/toast appears either.)
		localStorage.setItem('hasSeenWelcome', 'true');
		if (peerConfig) localStorage.setItem('peerServerConfig', peerConfig);
	}, PEER_CONFIG);
	// caller overrides last, so a test can replace any of the defaults above
	if (options.storage) {
		await ctx.addInitScript((extra) => {
			for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, String(v));
		}, options.storage);
	}
	const page = await ctx.newPage();
	page.on('pageerror', (err) => console.log(`[${name} pageerror] ` + err.stack));
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForTimeout(4000);
	await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	const id = await page.evaluate(
		() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))())
	);
	console.log(name + ' id: ' + id);
	return { ctx, page, id };
}

/** Connect `from` to `to` (approve on `to`), then let the mesh settle. */
async function connect(from, to, settleMs = 9000) {
	await from.page.locator('input[placeholder="Enter peer ID to connect"]').fill(to.id);
	await from.page.getByRole('button', { name: 'Connect', exact: true }).click();
	await to.page.getByRole('button', { name: 'Approve' }).click({ timeout: 30000 });
	await from.page.waitForTimeout(settleMs);
}

/** Poll `fn` until `predicate` holds; records a PASS/FAIL check. */
async function eventually(fn, predicate, label, timeout = 10000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) return check(true, label);
		await new Promise((r) => setTimeout(r, 400));
	}
	console.log('  last: ' + JSON.stringify(last));
	check(false, label);
}

/** Screen pixel of a world point on that page's camera. @param {number[]} world */
function projectPoint(page, world) {
	return page.evaluate(
		(world) =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					window.__stores.globalCamera.subscribe((camera) => {
						const v = scene.position.clone().set(world[0], world[1], world[2]).project(camera);
						resolve({
							x: (v.x * 0.5 + 0.5) * window.innerWidth,
							y: (-v.y * 0.5 + 0.5) * window.innerHeight
						});
					})();
				})();
			}),
		world
	);
}

/**
 * Reload a page and wait for the debug hook to republish.
 *
 * WHY: the `debugStores` hook reaches singletons via dynamic `import()`. On a dev
 * server churned by HMR, that can bind a SECOND module instance, so a value set
 * through `window.__stores.<mod>` may NOT be the same store a component reads via
 * its static import — the component renders stale (this bit the AI prompt-pill
 * check). A fresh navigation rebuilds one consistent module graph. Store state that
 * persists to localStorage (provider configs, toggles) survives the reload, so seed
 * it first, then `freshReload`, then assert component-rendered UI. Session-only
 * stores must be set AFTER the reload.
 */
async function freshReload(peer) {
	await peer.page.reload({ waitUntil: 'domcontentloaded' });
	await peer.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
}

/** Close up and exit with the right code. */
async function finish(browser) {
	await browser.close();
	console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
	process.exit(failures === 0 ? 0 : 1);
}

/** Wrap a test body so crashes exit non-zero. */
// 17-A: modules that moved OUT of core (dungeon, piano, car, ...) install from
// the sibling theprototype.app-modules checkout's packed zip. Returns false when
// that checkout has no zips, so a suite can SKIP instead of failing on a fresh
// clone (run "npm run pack -- --all" there to build them).
const MODULES_REPO = require('path').resolve(__dirname, '../../../theprototype.app-modules') + '/';
function moduleZipPath(id) {
	return MODULES_REPO + id + '.zip';
}
async function installModule(peer, id) {
	const fs = require('fs');
	const zip = moduleZipPath(id);
	if (!fs.existsSync(zip)) return false;
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(true));
	await peer.page.waitForTimeout(400);
	await peer.page.getByRole('tab', { name: /^User/ }).click();
	await peer.page.waitForTimeout(200);
	await peer.page.locator('#install-module-zip').setInputFiles({
		name: id + '.zip',
		mimeType: 'application/zip',
		buffer: fs.readFileSync(zip)
	});
	await eventually(
		() => peer.page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id)),
		(ids) => ids.includes(id),
		id + ' module installed for the suite',
		20000
	);
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(false));
	await peer.page.waitForTimeout(300);
	return true;
}

function run(body) {
	body().catch((error) => {
		console.error('SCRIPT FAILED:', error.message);
		process.exit(1);
	});
}

module.exports = { URL, GPU_ARGS, check, launch, setupPage, connect, eventually, projectPoint, freshReload, finish, run, installModule, moduleZipPath };
