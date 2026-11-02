// 54i (fix-batch-3 aa) — a lazy chunk that will not load, on a BUILT app (vite's preload helper is
// build-only, so a dev server cannot show this).
//
//   A. one lazy chunk (the Profiler's) DELETED from the build, as on a tab left open across a
//      redeploy: opening the Profiler fetches it, retries ONCE, then shows ONE sticky
//      "A new version is ready – Reload" toast; opening it again adds no second toast and the page
//      never reloads by itself; at most one error report. With the chunk back, the toast's Reload
//      brings the Profiler up.
//   B. a chunk whose first fetches drop (a phone network: vite's preload link and the import): the
//      retry loads it, the Profiler opens, no toast.
//
// Counterfactual: on the 54-int base the chunk is fetched once, nothing is retried, no toast
// shows (the {#await} swallows the failure) — A1/A2/A3 and B1 fail.
//
// Run (after `npm run build`):
//   LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' e2e-slot --local --dev <tree> 5485 -- \
//     bash -c 'APP_URL=https://localhost:5485/ node tests/e2e/stale-chunk.test.cjs'
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '../..');
const MOCK = 'https://errors.mock.test/community/api/errors';

h.run(async () => {
	// a dev server serves modules unwrapped (no preload helper, no hashed chunks): nothing to test there
	// (node https, not fetch: a lane's server runs on self-signed certs)
	const html = await new Promise((resolve) => {
		const mod = h.URL.startsWith('https:') ? require('https') : require('http');
		mod.get(h.URL, { rejectUnauthorized: false }, (res) => {
			let body = '';
			res.on('data', (c) => (body += c));
			res.on('end', () => resolve(body));
		}).on('error', () => resolve(''));
	});
	const manifestPath = path.join(ROOT, '.svelte-kit/output/client/.vite/manifest.json');
	if (!/_app\/immutable\//.test(html) || /@vite\/client/.test(html) || !fs.existsSync(manifestPath)) {
		console.log('SKIP: not a built app (run `npm run build`, then serve it with scripts/serve-build.cjs)');
		return;
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	const file = manifest['src/components/editors/Profiler.svelte']?.file;
	const onDisk = file && path.join(ROOT, 'build', file);
	h.check(!!onDisk && fs.existsSync(onDisk), `premise: the Profiler is its own lazy chunk in build/ (${file})`);
	if (!onDisk || !fs.existsSync(onDisk)) throw new Error('build first: npm run build');
	const chunkName = path.basename(file);
	const bak = onDisk + '.54i-bak';
	const restore = () => fs.existsSync(bak) && fs.renameSync(bak, onDisk);
	process.on('exit', restore);

	const browser = await h.launch();
	/** @type {any[]} */
	const reports = [];
	/** @param {any} ctx */
	const mockReports = (ctx) =>
		ctx.route(/errors\.mock\.test/, async (/** @type {any} */ route) => {
			try {
				reports.push(JSON.parse(route.request().postData() || 'null'));
			} catch {
				reports.push(null);
			}
			await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' });
		});
	/** @param {any} page */
	const openProfiler = async (page) => {
		await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
		await page.keyboard.press('Control+k');
		await page.waitForSelector('#command-palette-input', { timeout: 10000 });
		await page.fill('#command-palette-input', 'Profiler');
		await page.waitForTimeout(400);
		await page.keyboard.press('Enter');
	};
	/** @param {any} page */
	const dbg = (page) => page.evaluate(() => ({ ...(window.__stores.chunkReload?.chunkReloadDebug ?? {}) }));
	const toastSel = 'text=A new version is ready';

	// ============================================================ A. the chunk is gone
	fs.renameSync(onDisk, bak);
	try {
		const A = await h.setupPage(browser, 'A', { context: { serviceWorkers: 'block' }, storage: { 'errorReports:url': MOCK } });
		const page = A.page;
		await mockReports(A.ctx);
		let fetches = 0;
		page.on('request', (/** @type {any} */ r) => r.url().includes(chunkName) && fetches++);
		let navigations = 0;
		page.on('framenavigated', (/** @type {any} */ f) => f === page.mainFrame() && navigations++);
		await openProfiler(page);
		const toast = page.locator(toastSel).first();
		await toast.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
		const d = await dbg(page);
		// vite also lists the chunk among its own preload links, so "once" is a preload + an import
		h.check(fetches >= 2 && fetches <= 3, `A1 the missing chunk is asked for again by the one retry (${fetches} fetches)`);
		h.check(await toast.isVisible().catch(() => false), 'A2 "A new version is ready – Reload" shows');
		h.check(d.retries === 1 && d.failed === 1 && d.notices === 1, `A3 one retry, one failure, one notice (${JSON.stringify(d)})`);
		h.check((await page.locator('.tp-toast', { hasText: 'A new version is ready' }).getByRole('button', { name: 'Reload' }).count()) >= 1, 'A4 the toast has a Reload button');
		// again: the panel is still "open" in its store, so the palette closes it, then opens it once more
		await openProfiler(page);
		await page.waitForTimeout(300);
		await openProfiler(page);
		await page.waitForTimeout(2500);
		const d2 = await dbg(page);
		const toasts = await page.locator('.tp-toast', { hasText: 'A new version is ready' }).count();
		h.check(d2.notices === 1 && toasts <= 1, `A5 a second failure adds no second toast (${toasts} toasts, ${JSON.stringify(d2)})`);
		h.check(navigations === 0, `A6 the page never reloaded by itself (${navigations} navigations)`);
		const chunkReports = reports.filter((r) => /dynamically imported module/i.test(r?.msg ?? ''));
		h.check(chunkReports.length <= 1, `A7 at most one error report for it (${JSON.stringify(reports.map((r) => r?.kind + ': ' + r?.msg))})`);
		// put the chunk back (the "new version" is there now) and press the toast's Reload
		restore();
		// the toast lives 15 s; its Reload also stays on the notification (keep) — press whichever is there
		const onToast = page.locator('.tp-toast', { hasText: 'A new version is ready' }).getByRole('button', { name: 'Reload' }).first();
		if (await onToast.isVisible().catch(() => false)) await onToast.click({ timeout: 5000 }).catch(() => {});
		else {
			await page.keyboard.press('Control+k');
			await page.fill('#command-palette-input', 'Notifications');
			await page.waitForTimeout(400);
			await page.keyboard.press('Enter');
			await page.locator('.notif-act', { hasText: 'Reload' }).first().click({ timeout: 8000 }).catch(() => {});
		}
		await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, null, { timeout: 60000 });
		await h.answerRestore(A).catch(() => {});
		h.check(navigations >= 1, 'A8 Reload reloads the page');
		await openProfiler(page);
		await page.waitForSelector('#profiler-import', { timeout: 20000 }).catch(() => {});
		h.check(await page.locator('#profiler-import').isVisible().catch(() => false), 'A9 after the reload the Profiler opens');
		await h.closePeer(A);
	} finally {
		restore();
	}

	// ============================================================ B. one dropped fetch
	{
		const B = await h.setupPage(browser, 'B', { context: { serviceWorkers: 'block' } });
		const page = B.page;
		let fetches = 0;
		await B.ctx.route(new RegExp(chunkName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), async (/** @type {any} */ route) => {
			// the first two asks are vite's preload link and the import itself; the third is the retry
			if (++fetches <= 2) return route.abort('failed');
			return route.continue();
		});
		await openProfiler(page);
		await page.waitForSelector('#profiler-import', { timeout: 20000 }).catch(() => {});
		const d = await dbg(page);
		h.check(await page.locator('#profiler-import').isVisible().catch(() => false), `B1 the retry loads it: the Profiler opens (${fetches} fetches, ${JSON.stringify(d)})`);
		const staleToasts = await page.locator('.tp-toast', { hasText: 'A new version is ready' }).count();
		h.check(d.retries === 1 && d.recovered === 1 && d.notices === 0 && staleToasts === 0, `B2 ...by the one retry, with no "new version" toast (${staleToasts} toasts, ${JSON.stringify(d)})`);
		await h.closePeer(B);
	}

	await h.finish(browser);
});
