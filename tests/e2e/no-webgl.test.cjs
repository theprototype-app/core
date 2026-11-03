// 54i (fix-batch-3 c) — a browser that gives the page NO WebGL context.
//
//   1. getContext('webgl2'/'webgl'/'experimental-webgl') returns null (an init script, before any
//      app code): the friendly no-WebGL screen shows (what to try + a Help link + Reload), focus is
//      in it, and nothing else broke the page
//   2. EXACTLY ONE error report goes out, kind `webgl` (before: an error AND a rejection)
//   3. the same failure caught again by another seam (three's own message as a window error and as
//      a rejection) files under the same signature, so it is not sent again
//
// Counterfactual: on the 54-int base the page stays blank (no #no-webgl-screen) and the boot sends
// two reports (kind error + kind rejection, "THREE.WebGLRenderer: Error creating WebGL context.").
//
// Run: APP_URL=https://localhost:5485/ node tests/e2e/no-webgl.test.cjs
const h = require('./helpers.cjs');

const MOCK = 'https://errors.mock.test/community/api/errors';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
	await ctx.addInitScript((mock) => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
		localStorage.setItem('errorReports:url', mock);
		const real = HTMLCanvasElement.prototype.getContext;
		/** @this {HTMLCanvasElement} @param {string} kind @param {any[]} rest */
		HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
			if (/webgl/i.test(String(kind))) return null;
			return /** @type {any} */ (real).call(this, kind, ...rest);
		};
	}, MOCK);
	/** @type {any[]} */
	const requests = [];
	await ctx.route(/errors\.mock\.test/, async (route) => {
		let body = null;
		try {
			body = JSON.parse(route.request().postData() || 'null');
		} catch {
			body = route.request().postData();
		}
		requests.push(body);
		await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' });
	});
	const page = await ctx.newPage();
	/** @type {string[]} */
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
	await page.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

	// ---- 1. the screen -----------------------------------------------------------------------
	const screen = page.locator('#no-webgl-screen');
	await screen.waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});
	h.check(await screen.isVisible().catch(() => false), '1a the no-WebGL screen shows (base: a blank page)');
	const text = (await screen.textContent().catch(() => '')) || '';
	h.check(/hardware acceleration/i.test(text) && /update your browser/i.test(text) && /another browser/i.test(text), '1b it says what to try: hardware acceleration, update, another browser');
	const help = screen.getByRole('link', { name: /help/i });
	const href = (await help.getAttribute('href').catch(() => '')) || '';
	h.check(/^https:\/\/docs\.theprototype\.app\//.test(href), `1c a Help link to the docs (${href})`);
	h.check((await screen.getByRole('button', { name: 'Reload' }).count()) === 1, '1d a Reload button');
	h.check((await page.getByRole('alertdialog', { name: /can't show the 3D view/ }).count()) === 1, '1e an alertdialog with an accessible name');
	const focusIn = await page.evaluate(() => !!document.activeElement?.closest('#no-webgl-screen'));
	h.check(focusIn, '1f focus is in the dialog');
	await page.keyboard.press('Tab');
	const tabbed = await page.evaluate(() => document.activeElement?.textContent?.trim() || '');
	h.check(/Help|Reload/.test(tabbed), `1g Tab reaches its actions (${tabbed})`);
	h.check((await page.locator('#viewport canvas').count()) === 0, '1h no 3D canvas was mounted');

	// ---- 2. one report -------------------------------------------------------------------------
	await page.waitForFunction(() => !!window.__stores?.errorReports, null, { timeout: 60000 }).catch(() => {});
	await page.waitForTimeout(4000);
	const kinds = requests.map((r) => (r && typeof r === 'object' ? r.kind + ': ' + r.msg : String(r)));
	h.check(requests.length === 1 && requests[0]?.kind === 'webgl', `2a exactly one report, kind webgl (${JSON.stringify(kinds)})`);
	h.check(errors.length === 0, `2b no uncaught page errors (${JSON.stringify(errors.slice(0, 3))})`);

	// ---- 3. another seam catching the same failure dedupes -----------------------------------
	await page.evaluate(() => {
		setTimeout(() => {
			throw new Error('THREE.WebGLRenderer: Error creating WebGL context.');
		}, 0);
		void Promise.reject(new Error('THREE.WebGLRenderer: Error creating WebGL context.'));
	});
	await page.waitForTimeout(1500);
	const d = await page.evaluate(() => {
		const x = window.__stores.errorReports?.errorReportsDebug;
		return x ? { sent: x.sent, skipped: { ...x.skipped } } : null;
	});
	h.check(requests.length === 1 && (d?.skipped?.duplicate ?? 0) >= 2, `3a three's own message as an error and a rejection is the same report (${requests.length} sent, skipped ${JSON.stringify(d?.skipped)})`);

	await ctx.close();
	await h.finish(browser);
});
