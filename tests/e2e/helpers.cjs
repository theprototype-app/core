// Shared helpers for the e2e suite. Tests are plain node scripts (no runner
// framework) driving two/three real browser contexts through the public
// PeerJS cloud — see README.md for the recipe and gotchas.

const { chromium } = require('playwright');

const URL = process.env.APP_URL || 'https://theprototype.app:5173/';

let failures = 0;

/** @param {boolean} ok @param {string} label */
function check(ok, label) {
	console.log((ok ? 'PASS ' : 'FAIL ') + label);
	if (!ok) failures++;
}

function launch() {
	return chromium.launch({ headless: true });
}

/**
 * Fresh context + page with debug stores enabled, waits for hydration.
 * @returns {{ctx: any, page: any, id: string}}
 */
async function setupPage(browser, name, options = {}) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...(options.context ?? {}) });
	await ctx.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
	});
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

/** Close up and exit with the right code. */
async function finish(browser) {
	await browser.close();
	console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
	process.exit(failures === 0 ? 0 : 1);
}

/** Wrap a test body so crashes exit non-zero. */
function run(body) {
	body().catch((error) => {
		console.error('SCRIPT FAILED:', error.message);
		process.exit(1);
	});
}

module.exports = { URL, check, launch, setupPage, connect, eventually, projectPoint, finish, run };
