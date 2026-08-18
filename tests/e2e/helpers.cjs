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
	// Page errors were LOGGED and nothing more, so a suite could sail past a
	// component that had crashed on mount: a duplicate each-key threw inside the
	// Animation window, the pane stopped opening for real users, and every check
	// that read a store still passed. They are collected now — `finish` fails the
	// run on anything that looks like a svelte/render crash, and `pageErrors(peer)`
	// lets a suite assert on them directly.
	/** @type {string[]} */
	page.__errors = [];
	page.on('pageerror', (err) => {
		page.__errors.push(err.message ?? String(err));
		console.log(`[${name} pageerror] ` + err.stack);
	});
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
	await step(from, 'fill the peer id', () =>
		from.page.locator('input[placeholder="Enter peer ID to connect"]').fill(to.id)
	);
	await step(from, 'press Connect', () =>
		from.page.getByRole('button', { name: 'Connect', exact: true }).click()
	);
	await step(to, 'approve the request', () =>
		to.page.getByRole('button', { name: 'Approve' }).click({ timeout: 30000 })
	);
	await from.page.waitForTimeout(settleMs);
}

/**
 * Run one connect action and, if it fails, say WHY before rethrowing.
 *
 * A bare `locator.click: Timeout` here is the least informative failure in the
 * suite: every two-peer test funnels through this helper, so a page that crashed
 * on mount (or a dev server serving a stale half-transformed module — the
 * documented long-lived-server trap) surfaces as "prefabs is red" with nothing
 * pointing at the cause. This does NOT swallow anything: the original error is
 * rethrown unchanged, with the page's collected errors and whether the connect
 * chrome rendered at all attached to it.
 */
async function step(peer, what, run) {
	try {
		return await run();
	} catch (error) {
		let chrome = 'unreadable';
		try {
			chrome = JSON.stringify(
				await peer.page.evaluate(() => ({
					input: !!document.querySelector('input[placeholder="Enter peer ID to connect"]'),
					buttons: [...document.querySelectorAll('button')]
						.map((b) => (b.textContent || '').trim())
						.filter(Boolean)
						.slice(0, 20),
					booted: !!window.__stores
				}))
			);
		} catch {}
		const errors = peer.page.__errors?.length ? peer.page.__errors.join(' | ') : 'none';
		error.message = `connect: could not ${what} on ${peer.id}\n  page errors: ${errors}\n  chrome: ${chrome}\n${error.message}`;
		throw error;
	}
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

/** Everything the page threw, for a suite that wants to assert on it.
 * @param {any} peer @returns {string[]} */
function pageErrors(peer) {
	return peer?.page?.__errors ?? [];
}

// ---- reading real composited PIXELS ---------------------------------------
//
// The only way this repo has to observe what the renderer actually PUT ON SCREEN
// (post-processing, outlines, AO) is: screenshot in node -> push the PNG back
// INTO the page -> decode it on a 2D canvas -> read getImageData. The detour
// exists because node here has no PNG decoder and the page has a real one.
//
// The comparison itself runs IN THE PAGE and only the metrics cross the CDP
// bridge: a 1280x720 frame is 3.7M numbers, which is not something to serialise
// once, let alone per assertion.

/** The in-page decoder, injected as source into every pixel evaluate. */
const DECODE_FN = `async (b64) => {
	const img = new Image();
	await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
	const canvas = document.createElement('canvas');
	canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	ctx.drawImage(img, 0, 0);
	return ctx.getImageData(0, 0, canvas.width, canvas.height);
}`;

/**
 * Screenshot the WebGL canvas, or an explicit sub-rect of the page.
 *
 * With no clip it derives the rect from the RENDERER's own `domElement` rather
 * than a `canvas` locator: `<DungeonMinimap />` renders a hidden canvas BEFORE
 * threlte's in App.svelte, so `locator('canvas').first()` waits 30s on an
 * invisible element (the same trap as never `waitForSelector('canvas')`).
 *
 * Pass a clip for any COLOUR measurement: DOM chrome (Connect bar, HUD, windows)
 * is composited over the canvas and lands in an element screenshot too, so a
 * "how many pixels are not X" metric has to look at a chrome-free region.
 * @param {any} peer @param {any} [clip] {x, y, width, height}
 */
async function grabFrame(peer, clip) {
	const rect =
		clip ??
		(await peer.page.evaluate(
			() =>
				new Promise((resolve) => {
					window.__stores.globalRenderer.subscribe((renderer) => {
						const element = renderer?.domElement;
						if (!element) return resolve(null);
						const box = element.getBoundingClientRect();
						resolve({ x: box.x, y: box.y, width: box.width, height: box.height });
					})();
				})
		));
	return rect ? peer.page.screenshot({ clip: rect }) : peer.page.screenshot();
}

/** A chrome-free square of the viewport centred on a world point, for colour
 * metrics. @param {any} peer @param {number[]} world @param {number} [size] */
async function centeredClip(peer, world, size = 360) {
	const point = await projectPoint(peer.page, world);
	const view = await peer.page.viewportSize();
	const half = size / 2;
	return {
		x: Math.max(0, Math.min(view.width - size, Math.round(point.x - half))),
		y: Math.max(0, Math.min(view.height - size, Math.round(point.y - half))),
		width: size,
		height: size
	};
}

/**
 * How much two frames differ.
 *
 * `changed` — the PIXEL COUNT over `threshold` — is the metric to assert on, not
 * `mean`: a mean is blind to a thin edge (a one-pixel outline over a 1280x720
 * frame moves the mean by ~0.1 and is the whole point of the check). Keep `mean`
 * and `max` for the opposite case, a small contact band with a large delta,
 * where the count alone reads as failure.
 *
 * @param {any} page @param {Buffer} before @param {Buffer} after @param {number} [threshold]
 * @returns {Promise<{changed: number, total: number, fraction: number, mean: number, max: number, width: number, height: number, error?: string}>}
 */
async function frameDelta(page, before, after, threshold = 6) {
	return page.evaluate(
		async ({ a, b, threshold, decodeSource }) => {
			const decode = eval(decodeSource);
			const A = await decode(a);
			const B = await decode(b);
			if (A.width !== B.width || A.height !== B.height)
				return { error: 'size mismatch ' + A.width + 'x' + A.height + ' vs ' + B.width + 'x' + B.height };
			let changed = 0;
			let sum = 0;
			let max = 0;
			for (let i = 0; i < A.data.length; i += 4) {
				const delta =
					Math.abs(A.data[i] - B.data[i]) +
					Math.abs(A.data[i + 1] - B.data[i + 1]) +
					Math.abs(A.data[i + 2] - B.data[i + 2]);
				if (delta > threshold) changed++;
				sum += delta;
				if (delta > max) max = delta;
			}
			const total = A.data.length / 4;
			return {
				changed,
				total,
				fraction: changed / total,
				mean: sum / total,
				max,
				width: A.width,
				height: A.height
			};
		},
		{ a: before.toString('base64'), b: after.toString('base64'), threshold, decodeSource: DECODE_FN }
	);
}

/**
 * How many pixels of a frame are NOT within `tolerance` of `rgb`.
 *
 * Written as the negative on purpose: it is how "the outline survived a
 * full-frame effect" is measured. A flat-fill effect makes every scene pixel one
 * colour, so anything left over is what was composited AFTER it — zero means the
 * effect ran last and painted over the outline.
 *
 * @param {any} page @param {Buffer} frame @param {number[]} rgb @param {number} [tolerance]
 * @returns {Promise<{off: number, total: number, fraction: number}>}
 */
async function framePixelsOffColor(page, frame, rgb, tolerance = 24) {
	return page.evaluate(
		async ({ a, rgb, tolerance, decodeSource }) => {
			const decode = eval(decodeSource);
			const image = await decode(a);
			let off = 0;
			for (let i = 0; i < image.data.length; i += 4) {
				if (
					Math.abs(image.data[i] - rgb[0]) > tolerance ||
					Math.abs(image.data[i + 1] - rgb[1]) > tolerance ||
					Math.abs(image.data[i + 2] - rgb[2]) > tolerance
				)
					off++;
			}
			const total = image.data.length / 4;
			return { off, total, fraction: off / total };
		},
		{ a: frame.toString('base64'), rgb, tolerance, decodeSource: DECODE_FN }
	);
}

/** A RENDER crash is never acceptable, whatever the checks said: a component that
 * threw on mount is not there for the user at all. Anything else (a network hiccup,
 * a module's own console noise) still only prints. */
const FATAL_ERROR = /each_key_duplicate|effect_update_depth_exceeded|store\.set is not a function|is not a function.*svelte|Cannot read properties of undefined \(reading 'call'\)|derived_references_self|state_unsafe_mutation/;

/** Close up and exit with the right code. */
async function finish(browser) {
	// collect before the browser goes away
	/** @type {string[]} */
	const fatal = [];
	for (const ctx of browser.contexts?.() ?? []) {
		for (const page of ctx.pages?.() ?? []) {
			for (const message of page.__errors ?? []) {
				if (FATAL_ERROR.test(message)) fatal.push(message);
			}
		}
	}
	await browser.close();
	for (const message of fatal) check(false, 'the page threw a render error: ' + message.split('\n')[0]);
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

module.exports = { URL, GPU_ARGS, check, launch, setupPage, connect, eventually, projectPoint, freshReload, finish, run, installModule, moduleZipPath, pageErrors, grabFrame, centeredClip, frameDelta, framePixelsOffColor };
