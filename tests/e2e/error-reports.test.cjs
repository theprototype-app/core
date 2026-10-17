// 48 O1 — anonymous error + crash reports (client), against a MOCK endpoint.
//
//   A. no endpoint (a dev server, an OSS build): nothing is sent, the Privacy row says so
//   B. an endpoint: the Privacy switch is ON by default; an uncaught error goes out as ONE
//      text/plain JSON beacon with exactly the agreed fields and a SCRUBBED message (no quoted
//      name, no URL), our own frames only; the same error again is not re-sent; a rejection,
//      a WebGL context loss and an out-of-memory error each carry their kind; the per-session
//      cap holds at five
//   C. the switch OFF (through the real Settings toggle): nothing is sent
//   D. a tab that died while visible (its unload never cleared the alive flag) reports `crash` on its next load
//
// Counterfactual: on v1.38.0 the module does not exist — A..D have nothing to observe, and
// `window.__stores.errorReports` is undefined (checked first, so the suite fails there).
// The mock: `errors.mock.test` routed by Playwright (sendBeacon is intercepted); the URL is the
// debug-hook-gated override `errorReports:url`, since a build-time env cannot be swapped.
//
// Run: APP_URL=https://theprototype.app:5485/ npm run e2e -- error-reports
const h = require('./helpers.cjs');

const MOCK = 'https://errors.mock.test/community/api/errors';
const FIELDS = ['area', 'browser', 'build', 'device', 'env', 'frames', 'gpu', 'kind', 'msg', 'os', 'release', 'sig', 'v'];

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	/** @type {{type: string, contentType: string, body: any, at: number}[]} */
	let requests = [];
	/** @param {any} ctx */
	const mock = (ctx) =>
		ctx.route(/errors\.mock\.test/, async (route) => {
			const req = route.request();
			let body = null;
			try {
				body = JSON.parse(req.postData() || 'null');
			} catch {
				body = req.postData();
			}
			requests.push({ type: req.resourceType(), contentType: req.headers()['content-type'] || '', body, at: Date.now() });
			await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' });
		});
	/** @param {any} page */
	const dbg = (page) => page.evaluate(() => {
		const d = window.__stores.errorReports?.errorReportsDebug;
		return d ? { caught: d.caught, sent: d.sent, skipped: { ...d.skipped } } : null;
	});
	/** @param {any} page @param {number} n */
	const waitRequests = async (page, n, ms = 4000) => {
		const t0 = Date.now();
		while (requests.length < n && Date.now() - t0 < ms) await page.waitForTimeout(100);
		return requests.length;
	};
	/** throw OUT of a store callback, so the stack holds the app's own (svelte store) frames @param {any} page @param {string} message */
	const throwUncaught = (page, message) =>
		page.evaluate((m) => {
			setTimeout(() => {
				// a subscriber that throws stays subscribed, so it throws only on its first call
				let fired = false;
				window.__stores.errorReports.errorReportsAvailable.subscribe(() => {
					if (fired) return;
					fired = true;
					throw new Error(m);
				});
			}, 0);
		}, message);
	/** @param {any} page @param {string} key */
	const openSettings = async (page, key) => {
		await page.evaluate((k) => {
			window.__stores.settingsSection.set(k);
			window.__stores.settingsOpen.set(true);
		}, key);
		await page.waitForTimeout(700);
	};

	// ================================================================ A. no endpoint
	{
		const A = await h.setupPage(browser, 'A');
		const page = A.page;
		await mock(A.ctx);
		const exists = await page.evaluate(() => !!window.__stores.errorReports);
		h.check(exists, 'A0 the error-report module is in this build (absent on v1.38.0)');
		if (!exists) {
			await h.finish(browser);
			return;
		}
		h.check((await page.evaluate(() => window.__stores.errorReports.errorReportsUrl())) === null, 'A1 a dev server with no override has no endpoint');
		await throwUncaught(page, 'e2e no-endpoint boom');
		await page.waitForTimeout(800);
		const d = await dbg(page);
		h.check(requests.length === 0 && (d?.skipped['no-endpoint'] ?? 0) >= 1, `A2 an uncaught error sends nothing (${requests.length} requests, skipped ${JSON.stringify(d?.skipped)})`);
		await openSettings(page, 'privacy');
		const row = page.locator('#row-error-reports');
		h.check((await row.count()) === 1 && (await page.locator('#send-error-reports').count()) === 0, 'A3 Settings ▸ Privacy has the row, with no switch to flip');
		h.check(/sends no error reports/.test((await row.textContent()) || ''), 'A4 ...and says nothing leaves this device');
		await h.closePeer(A);
	}

	// ================================================================ B. an endpoint
	{
		requests = [];
		const B = await h.setupPage(browser, 'B', { storage: { 'errorReports:url': MOCK } });
		const page = B.page;
		await mock(B.ctx);
		await openSettings(page, 'privacy');
		const toggle = page.locator('#send-error-reports');
		h.check((await toggle.count()) === 1 && (await toggle.getAttribute('aria-pressed')) === 'true', 'B1 the Privacy switch exists and is ON by default');
		h.check((await page.locator('#row-error-reports a[href="/privacy"]').count()) === 1, 'B1b the row links the privacy page');
		await page.evaluate(() => window.__stores.settingsOpen.set(false));

		await throwUncaught(page, 'Scene "My secret house" failed to load https://cdn.theprototype.app/pbc_1/abc/castle.glb for peer 3f2504e0-4f89-11d3-9a0c-0305e82c3301');
		await waitRequests(page, 1);
		const first = requests[0];
		h.check(requests.length === 1, `B2 an uncaught error sends ONE report (${requests.length})`);
		h.check(!!first && first.type === 'ping' && /text\/plain/.test(first.contentType), `B3 ...as a sendBeacon with a text/plain body (${first?.type}, ${first?.contentType})`);
		const r = first?.body ?? {};
		h.check(JSON.stringify(Object.keys(r).sort()) === JSON.stringify(FIELDS), 'B4 exactly the agreed fields: ' + Object.keys(r).sort().join(','));
		h.check(r.kind === 'error' && r.v === 1 && /^[0-9a-f]{8}$/.test(r.sig), `B5 kind error, v1, an 8-hex signature (${r.kind} ${r.sig})`);
		const raw = JSON.stringify(r);
		h.check(!/secret|house|cdn\.theprototype|castle|3f2504e0/.test(raw), 'B6 no quoted name, no URL, no peer id anywhere in the report: ' + r.msg);
		h.check(/<url>/.test(r.msg) && /<id>/.test(r.msg) && /"…"/.test(r.msg), 'B7 ...the message keeps its shape with tokens');
		h.check(Array.isArray(r.frames) && r.frames.length >= 1 && r.frames.every((f) => /^([\w$.<>]+@)?\/[^:]+:\d+:\d+$/.test(f)), `B8 our own frames, origin stripped (${(r.frames || []).slice(0, 2).join(' | ')})`);
		h.check(['desktop', 'phone', 'tablet', 'headset'].includes(r.device) && /\d/.test(r.browser) && r.release && r.build, `B9 device class, browser + major, release and build (${r.device}, ${r.browser}, ${r.release} ${r.build})`);
		h.check(['webgl2', 'webgl1', 'webgpu', 'none', 'unknown'].includes(r.gpu) && r.area === 'edit', `B10 graphics API and app area (${r.gpu}, ${r.area})`);
		h.check(r.env === 'prod', `B11 theprototype.app counts as production (${r.env})`);

		await throwUncaught(page, 'Scene "My secret house" failed to load https://cdn.theprototype.app/pbc_1/abc/castle.glb for peer 3f2504e0-4f89-11d3-9a0c-0305e82c3301');
		await page.waitForTimeout(1000);
		h.check(requests.length === 1 && ((await dbg(page))?.skipped.duplicate ?? 0) >= 1, `B12 the same error again is not re-sent (${requests.length})`);

		await page.evaluate(() => {
			setTimeout(() => void Promise.reject(new Error('e2e rejected after 123456 ms')), 0);
		});
		await waitRequests(page, 2);
		const rej = requests[1]?.body ?? {};
		h.check(rej.kind === 'rejection' && rej.msg === 'e2e rejected after <n> ms', `B13 an unhandled rejection: kind rejection, long numbers folded (${rej.kind}: ${rej.msg})`);

		await page.evaluate(() => {
			window.__stores.contextLost.set(true);
			window.__stores.contextLost.set(false);
		});
		await waitRequests(page, 3);
		h.check(requests[2]?.body?.kind === 'webgl', `B14 the main renderer losing its WebGL context: kind webgl (${requests[2]?.body?.kind})`);

		await page.evaluate(() => {
			setTimeout(() => {
				throw new RangeError('Array buffer allocation failed');
			}, 0);
		});
		await waitRequests(page, 4);
		h.check(requests[3]?.body?.kind === 'oom', `B15 an allocation failure: kind oom (${requests[3]?.body?.kind})`);

		for (let i = 0; i < 3; i++) await throwUncaught(page, 'e2e distinct failure number ' + i);
		await waitRequests(page, 6, 2500);
		const d = await dbg(page);
		h.check(requests.length === 5 && (d?.skipped.cap ?? 0) >= 2, `B16 the per-session cap holds at five (${requests.length} sent, skipped ${JSON.stringify(d?.skipped)})`);
		h.check(new Set(requests.map((x) => x.body.sig)).size === 5, 'B17 five different signatures');
		await h.closePeer(B);
	}

	// ================================================================ C. the switch OFF
	{
		requests = [];
		const C = await h.setupPage(browser, 'C', { storage: { 'errorReports:url': MOCK } });
		const page = C.page;
		await mock(C.ctx);
		await openSettings(page, 'privacy');
		await page.locator('#send-error-reports').evaluate((el) => /** @type {HTMLElement} */ (el).click());
		await page.waitForTimeout(300);
		h.check((await page.locator('#send-error-reports').getAttribute('aria-pressed')) === 'false', 'C1 the real toggle switches reports off');
		h.check((await page.evaluate(() => localStorage.getItem('errorReports:send'))) === 'false', 'C2 ...and remembers it on this device');
		await page.evaluate(() => window.__stores.settingsOpen.set(false));
		await throwUncaught(page, 'e2e off boom');
		await page.waitForTimeout(1200);
		const d = await dbg(page);
		h.check(requests.length === 0 && (d?.skipped.off ?? 0) >= 1, `C3 off = nothing is sent (${requests.length} requests)`);
		await h.closePeer(C);
	}

	// ================================================================ D. a tab that died while visible
	{
		requests = [];
		const D = await h.setupPage(browser, 'D', { storage: { 'errorReports:url': MOCK } });
		const page = D.page;
		await mock(D.ctx);
		const alive = await page.evaluate(() => sessionStorage.getItem('tp.errorReports.alive'));
		h.check(!!alive && JSON.parse(alive).area === 'edit', `D1 a visible tab carries the alive flag (${alive})`);
		// A real renderer crash (CDP Page.crash) leaves Playwright's page unusable, so the death is
		// SIMULATED where it matters: what tells a crash from a clean unload is only that the unload's
		// flag-clear never ran. Make that clear a no-op, then reload — exactly the state a killed
		// renderer leaves behind in the tab's sessionStorage.
		await page.evaluate(() => {
			const real = Storage.prototype.removeItem;
			Storage.prototype.removeItem = function (k) {
				if (k === 'tp.errorReports.alive') return;
				return real.call(this, k);
			};
		});
		await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
		await page.waitForFunction(() => window.__stores && !!window.__stores.errorReports, null, { timeout: 90000 });
		await waitRequests(page, 1, 8000);
		const crash = requests.find((x) => x.body?.kind === 'crash');
		h.check(!!crash && crash.body.area === 'edit' && crash.body.frames.length === 0, `D2 the next load reports kind crash with the area it died in (${JSON.stringify(crash?.body ?? requests.map((x) => x.body?.kind))})`);
		await page.waitForTimeout(500);
		await page.evaluate(() => {
			// a clean unload clears the flag, so a plain reload is NOT a crash
			window.dispatchEvent(new PageTransitionEvent('pagehide'));
		});
		h.check((await page.evaluate(() => sessionStorage.getItem('tp.errorReports.alive'))) === null, 'D3 a clean unload (pagehide) clears the flag');
		await h.closePeer(D);
	}

	await h.finish(browser);
});
