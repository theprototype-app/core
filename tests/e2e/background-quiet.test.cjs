// fix-bgquiet — A PHONE THAT MINIMISES THE BROWSER SAYS NOTHING WHEN IT COMES BACK.
//
// The report (1.57.0, a foldable phone, Android Chrome, an empty editor scene): a "Something went
// wrong: ResizeObserver loop completed with undelivered notifications" toast, then — minimise and
// reopen — the WebGL context lost and restored a second later and the signaling socket dropped.
//
// What this suite pins:
//   1. hidden page: the context is lost, the signaling socket drops; the page shows again and the
//      context comes back inside the 3 s grace → NO overlay, NO toast, NO error report, and the
//      Connect dot returns on the same peer id
//   2. a loss on a VISIBLE page held 4 s → the overlay shows (and a `webgl` report goes out),
//      and inside the grace it does not; restoring takes it down
//   3. a REAL ResizeObserver loop (a callback resizing its own target — headless reports it)
//      reaches the diagnostics ring but raises no toast; a real error still toasts (control)
//
// Counterfactual: on v1.57.0 step 1 shows the overlay and sends a `webgl` report, and step 3 toasts.
// The report endpoint is a Playwright route on the debug-hook override `errorReports:url`.
//
// Run: APP_URL=https://theprototype.app:5967/ npm run e2e -- background-quiet
const h = require('./helpers.cjs');

const MOCK = 'https://errors.mock.test/community/api/errors';
// the reported device, unfolded (CSS px); DPR 1 keeps a software renderer quick
const PHONE = {
	viewport: { width: 691, height: 634 },
	isMobile: true,
	hasTouch: true,
	userAgent: 'Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
};

/** @param {any} page @param {boolean} hidden */
const setHidden = (page, hidden) =>
	page.evaluate((hid) => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hid ? 'hidden' : 'visible') });
		Object.defineProperty(document, 'hidden', { configurable: true, get: () => hid });
		document.dispatchEvent(new Event('visibilitychange'));
	}, hidden);

/** @param {any} page */
const dot = (page) =>
	page.evaluate(() => {
		// the phone shell's chip or the desktop pill — whichever this layout drew
		const el = document.querySelector('.cx-status-dot[data-tone]');
		let pc = null;
		window.__stores.peers.subscribe((v) => (pc = v))();
		return { tone: el?.getAttribute('data-tone') ?? null, open: !!pc?.peer?.open, id: pc?.peer?.id ?? '' };
	});

/** start recording: every toast text, and whether the loud context-loss store ever rose @param {any} page */
const record = (page) =>
	page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__bq = { toasts: [], shown: false };
		w.__bqUnsub?.forEach((/** @type {() => void} */ u) => u());
		w.__bqUnsub = [
			w.__stores.toastStore.subscribe((/** @type {any[]} */ list) => {
				for (const t of list) {
					const text = typeof t === 'string' ? t : (t && (t.text || t.message)) || '';
					if (text && !w.__bq.toasts.includes(text)) w.__bq.toasts.push(text);
				}
			}),
			w.__stores.contextLossShown.subscribe((/** @type {boolean} */ v) => {
				if (v) w.__bq.shown = true;
			})
		];
	});
/** @param {any} page */
const recorded = (page) => page.evaluate(() => /** @type {any} */ (window).__bq);
// what this suite is about; an unrelated toast (the auto-quality governor on a software renderer) is not
const ABOUT = /went wrong|3D view|graphics|context|peer server|reconnect|disconnect|signal|offline/i;
/** @param {string[]} toasts */
const ours = (toasts) => toasts.filter((t) => ABOUT.test(t));

h.run(async () => {
	const browser = await h.launch();
	/** @type {any[]} */
	let reports = [];
	const P = await h.setupPage(browser, 'phone', { context: PHONE, storage: { 'errorReports:url': MOCK } });
	const page = P.page;
	await P.ctx.route(/errors\.mock\.test/, async (/** @type {any} */ route) => {
		try {
			reports.push(JSON.parse(route.request().postData() || 'null'));
		} catch {
			reports.push(null);
		}
		await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' });
	});
	await page.waitForFunction(() => !!window.__stores?.contextLossShown && !!window.__stores?.diagnostics, null, { timeout: 30000 });

	// ---- 0. premises ----------------------------------------------------------------------
	const canLose = await page.evaluate(() => {
		let r = null;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		window.__loseCtx = r?.getContext?.()?.getExtension?.('WEBGL_lose_context') ?? null;
		return !!window.__loseCtx;
	});
	h.check(canLose, 'premise: WEBGL_lose_context is available, so a REAL context loss can be driven');
	h.check((await page.evaluate(() => window.__stores.errorReports.errorReportsUrl())) === MOCK, 'premise: error reports go to the mock endpoint');
	await h.eventually(() => dot(page), (d) => d.open && !!d.id, 'premise: the signaling link is open', 30000);
	const before = await dot(page);
	h.check(!!before.tone, `premise: the Connect dot is drawn (${before.tone})`);
	h.check(!(await page.locator('.gl-lost').isVisible().catch(() => false)), 'premise: no overlay while the context is healthy');

	// ---- 1. minimise, lose, reopen, restore inside the grace -------------------------------
	if (canLose) {
		reports = [];
		await record(page);
		await setHidden(page, true);
		await page.evaluate(() => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			pc.peer.disconnect(); // a phone tab switch drops the signaling socket for real
			window.__loseCtx.loseContext();
		});
		await page.waitForTimeout(4000); // longer than the grace: a hidden page's clock does not run
		h.check(!(await page.locator('.gl-lost').isVisible().catch(() => false)), '1a hidden for 4 s with the context lost: no overlay');
		await setHidden(page, false);
		await page.waitForTimeout(1000);
		await page.evaluate(() => window.__loseCtx.restoreContext());
		await h.eventually(() => page.evaluate(() => {
			let v = true;
			window.__stores.contextLost.subscribe((x) => (v = x))();
			return v;
		}), (v) => v === false, '1b the context comes back', 10000);
		await page.waitForTimeout(3500); // past where a visible-clock overlay would have risen
		const r1 = await recorded(page);
		h.check(r1.shown === false && !(await page.locator('.gl-lost').isVisible().catch(() => false)), `1c no overlay at any moment (loud store rose: ${r1.shown})`);
		h.check(!ours(r1.toasts).length, `1d no toast about any of it (${JSON.stringify(r1.toasts)})`);
		h.check(!reports.some((r) => r?.kind === 'webgl'), `1e no webgl error report (${JSON.stringify(reports.map((r) => r?.kind))})`);
		await h.eventually(() => dot(page), (d) => d.open && d.tone === before.tone, `1f the Connect dot returns (${before.tone})`, 30000);
		const back = await dot(page);
		h.check(back.id === before.id, `1g …on the same peer id (${before.id} → ${back?.id})`);
		h.check(!ours((await recorded(page)).toasts).length, '1h and the reconnect said nothing out loud either');
	}

	// ---- 2. a loss on a visible page held 4 s ---------------------------------------------
	if (canLose) {
		reports = [];
		await record(page);
		await page.evaluate(() => window.__loseCtx.loseContext());
		await page.waitForTimeout(1500);
		h.check(!(await page.locator('.gl-lost').isVisible().catch(() => false)), '2a inside the grace the overlay stays down');
		await page.waitForTimeout(2500);
		h.check(await page.locator('.gl-lost').isVisible().catch(() => false), '2b held 4 s on a visible page: the overlay shows');
		await h.eventually(async () => reports.filter((r) => r?.kind === 'webgl').length, (n) => n === 1, '2c …and ONE webgl report goes out', 6000);
		await page.evaluate(() => window.__loseCtx.restoreContext());
		await h.eventually(() => page.locator('.gl-lost').isVisible().catch(() => false), (v) => v === false, '2d restoring takes it down', 20000);
	}

	// ---- 3. a real ResizeObserver loop: logged, not toasted --------------------------------
	{
		reports = [];
		await record(page);
		const looped = await page.evaluate(
			() =>
				new Promise((resolve) => {
					let seen = false;
					const onErr = (/** @type {ErrorEvent} */ e) => {
						if (/ResizeObserver loop/.test(e.message)) seen = true;
					};
					window.addEventListener('error', onErr);
					const el = document.createElement('div');
					el.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;opacity:0;pointer-events:none';
					document.body.appendChild(el);
					let n = 0;
					const ro = new ResizeObserver(() => {
						if (n++ < 20) el.style.height = 10 + n + 'px'; // the classic shape: resize your own target
					});
					ro.observe(el);
					setTimeout(() => {
						ro.disconnect();
						el.remove();
						window.removeEventListener('error', onErr);
						resolve(seen);
					}, 1500);
				})
		);
		h.check(looped, 'positive control: the browser reports the ResizeObserver loop here');
		const inRing = await page.evaluate(() => window.__stores.diagnostics.lines().some((/** @type {any} */ l) => /ResizeObserver loop/.test(JSON.stringify(l))));
		h.check(inRing, '3a the loop line is in the diagnostics ring (Copy diagnostics keeps it)');
		await page.waitForTimeout(500);
		const r3 = await recorded(page);
		h.check(!r3.toasts.some((t) => /Something went wrong/.test(t)), `3b …and no "Something went wrong" toast (${JSON.stringify(r3.toasts)})`);
		await page.evaluate(() => setTimeout(() => window.dispatchEvent(new ErrorEvent('error', { message: 'e2e real failure after a resize' })), 0));
		await h.eventually(() => recorded(page), (r) => r.toasts.some((/** @type {string} */ t) => /Something went wrong: e2e real failure/.test(t)), '3c control: a real error still toasts', 5000);
	}

	await h.closePeer(P);
	await h.finish(browser);
});
