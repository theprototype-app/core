// play-stats.test.cjs — roadmap 102 M4: anonymous play statistics from the play entry, against a MOCKED
// endpoint (the cloud plugin's real sender is the Worker suite's + the plugin's business; here a test
// listener on cloudApi.onPlayStats sends the beacon the way the plugin does: sendBeacon, text/plain, to
// /community/ref?ref=play on this origin, which page.route answers or aborts).
//
//   1. A published scene (`/play?scene=…&s=abc123`): Play, then hide → ONE beacon: start + end with the
//      scene id, a device class, a time bucket; nothing else in the body (no id of any kind).
//   2. Back, the game is won, the page is left (pagehide) → the previous end is retracted (w -1) and the
//      new one sent; net one start + one end.
//   3. The endpoint FAILS (route.abort): play does not notice — still playing, no page error.
//   4. Counterfactuals — nothing is sent: Global Privacy Control; Settings ▸ Privacy ▸ Count my visits
//      anonymously off; no plugin listening; a page without `?s=` never even loads the module.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const { check } = h;
const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) => fs.existsSync(p));
const sceneOf = (/** @type {string} */ slug) => {
	const dir = process.env.SHELL_SCENES_DIR;
	const p = dir ? path.join(dir, slug, 'scene.tpscene') : SCENES_REPO && path.join(SCENES_REPO, 'games', slug, 'scene.tpscene');
	return p && fs.existsSync(p) ? p : null;
};
const SLUG = process.env.PLAY_SLUG || 'sky-run';
const SCENE_URL = `/e2e-scenes/${SLUG}.tpscene`;

/**
 * A /play page with the scene served by a route and the play endpoint mocked.
 * @param {any} browser @param {string} name @param {string} query
 * @param {{ endpoint?: 'ok' | 'abort', gpc?: boolean, switchOff?: boolean }} [o]
 */
async function playPage(browser, name, query, o = {}) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	await ctx.addInitScript((opt) => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('playStatsUnderTest', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
		if (opt.switchOff) localStorage.setItem('onboard.funnelConsent', 'off');
		if (opt.gpc) Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true });
	}, { gpc: !!o.gpc, switchOff: !!o.switchOff });
	const file = sceneOf(SLUG);
	if (file) await ctx.route('**/e2e-scenes/*.tpscene', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: fs.readFileSync(file) }));
	/** @type {{ body: any, headers: Record<string, string> }[]} */
	const hits = [];
	await ctx.route(
		(url) => url.pathname === '/community/ref' && url.searchParams.get('ref') === 'play',
		(route) => {
			const req = route.request();
			let body = null;
			try {
				body = JSON.parse(req.postData() || 'null');
			} catch {
				body = req.postData();
			}
			hits.push({ body, headers: req.headers() });
			return o.endpoint === 'abort' ? route.abort('failed') : route.fulfill({ status: 204, body: '' });
		}
	);
	const page = await ctx.newPage();
	/** @type {string[]} */
	const errors = [];
	page.on('pageerror', (e) => {
		errors.push(e.message);
		console.log(`[${name} pageerror] ${e.stack}`);
	});
	await page.goto(h.URL + query, { waitUntil: 'domcontentloaded', timeout: 90000 });
	await page.waitForFunction(() => !!window.tpPlay, null, { timeout: 90000 });
	const loaded = await page.evaluate(() => Promise.race([window.tpPlay.loaded, new Promise((r) => setTimeout(() => r('timeout'), 120000))]));
	await page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.cloudPlugin && !!window.__tp.test.v1.playStats, null, { timeout: 60000 });
	return { ctx, page, hits, errors, loaded };
}

/** what the plugin does: send synchronously, say whether the browser took it */
const listen = (/** @type {any} */ page) =>
	page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__playSent = [];
		w.__tp.test.v1.cloudPlugin.makeCloudApi().onPlayStats((/** @type {any} */ b) => {
			w.__playSent.push(b);
			return navigator.sendBeacon(location.origin + '/community/ref?ref=play', new Blob([JSON.stringify(b)], { type: 'text/plain' }));
		});
	});
const play = (/** @type {any} */ page, /** @type {boolean} */ on) => page.evaluate((v) => /** @type {any} */ (window).__tp.test.v1.isLocked.set(v ? true : null), on);
const hide = (/** @type {any} */ page) =>
	page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	});
const show = (/** @type {any} */ page) =>
	page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	});
const leave = (/** @type {any} */ page) => page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
const tracker = (/** @type {any} */ page) => page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.playStats.playStatsDebug());

h.run(async () => {
	const browser = await h.launch();
	if (!sceneOf(SLUG)) {
		console.log(`SKIP: no ${SLUG} scene (SHELL_SCENES_DIR or a sibling scenes checkout)`);
		check(false, `the ${SLUG} scene is available to the suite`);
		return h.finish(browser);
	}
	const q = `play?scene=${encodeURIComponent(SCENE_URL)}&s=abc123`;

	// ------------------------------------------------------------------ 1 + 2. the happy path
	{
		const P = await playPage(browser, 'P', q);
		check(P.loaded === true, `1. the scene loaded (${P.loaded})`);
		await listen(P.page);
		await play(P.page, true);
		await P.page.waitForTimeout(1500);
		const mid = await tracker(P.page);
		check(mid && mid.started && mid.seconds > 1, `1. the tracker runs while playing (${JSON.stringify(mid)})`);
		await hide(P.page);
		await h.eventually(async () => P.hits.length, (n) => n >= 1, '1. a beacon reached the endpoint', 10000);
		const b1 = P.hits[0]?.body;
		console.log('beacon 1', JSON.stringify(b1));
		check(b1?.v === 1 && b1.s === 'abc123' && ['desktop', 'phone', 'headset'].includes(b1.d), '1. the beacon names the published scene and a device class');
		check(JSON.stringify(Object.keys(b1 || {}).sort()) === '["d","e","s","v"]', '1. the body has only v / s / d / e (no id of the player, tab or device)', Object.keys(b1 || {}));
		check(b1?.e?.[0]?.k === 'start' && b1.e[1]?.k === 'end' && b1.e[1].t === 'lt30s' && b1.e[1].w === 1, '1. start + one end with a time bucket', b1?.e);
		check(P.hits[0]?.headers['content-type']?.startsWith('text/plain'), '1. text/plain (a CORS-simple request, no preflight)', P.hits[0]?.headers['content-type']);

		await show(P.page);
		await P.page.evaluate(() => {
			const m = /** @type {any} */ (window).__tp.test.v1.gameState;
			const g = m.gameState || m; // the facade row is the module
			g.update((/** @type {any} */ s) => ({ ...s, state: 'over', outcome: 'win', changedAt: Date.now() }));
		});
		await leave(P.page);
		await h.eventually(async () => P.hits.length, (n) => n >= 2, '2. pagehide sends the update', 10000);
		const b2 = P.hits[1]?.body;
		console.log('beacon 2', JSON.stringify(b2));
		check(b2?.e?.length === 2 && b2.e[0].k === 'end' && b2.e[0].w === -1 && b2.e[0].g === b1?.e?.[1]?.g && b2.e[1].w === 1 && b2.e[1].g === 'won', '2. the previous end is retracted, the new one says won', b2?.e);
		const all = P.hits.flatMap((x) => x.body?.e || []);
		check(all.filter((e) => e.k === 'start').length === 1 && all.filter((e) => e.k === 'end').reduce((n, e) => n + e.w, 0) === 1, '2. net: one start, one end');
		await leave(P.page);
		await P.page.waitForTimeout(800);
		check(P.hits.length === 2, '2. nothing new = nothing sent', P.hits.length);
		check(P.errors.length === 0, '1-2. no page errors', P.errors);
		await P.ctx.close();
	}

	// ------------------------------------------------------------------ 3. the endpoint fails
	{
		const F = await playPage(browser, 'F', q, { endpoint: 'abort' });
		await listen(F.page);
		await play(F.page, true);
		await F.page.waitForTimeout(800);
		await hide(F.page);
		await h.eventually(async () => F.hits.length, (n) => n >= 1, '3. the beacon was tried (and aborted)', 10000);
		await show(F.page);
		await F.page.waitForTimeout(800);
		const st = await F.page.evaluate(() => {
			const w = /** @type {any} */ (window);
			let locked;
			w.__tp.test.v1.isLocked.subscribe((/** @type {any} */ v) => (locked = v))();
			return { locked, state: w.tpPlay.state };
		});
		check(st.locked === true && st.state !== 'error', `3. play does not notice a failed endpoint (${JSON.stringify(st)})`);
		check(F.errors.length === 0, '3. no page errors', F.errors);
		await F.ctx.close();
	}

	// ------------------------------------------------------------------ 4. counterfactuals
	for (const [label, opt] of /** @type {[string, any][]} */ ([
		['Global Privacy Control', { gpc: true }],
		['Count my visits anonymously off', { switchOff: true }]
	])) {
		const N = await playPage(browser, 'N', q, opt);
		await listen(N.page);
		await play(N.page, true);
		await N.page.waitForTimeout(1200);
		await hide(N.page);
		await leave(N.page);
		await N.page.waitForTimeout(1200);
		const sent = await N.page.evaluate(() => /** @type {any} */ (window).__playSent.length);
		const t = await tracker(N.page);
		check(N.hits.length === 0 && sent === 0, `4. ${label}: nothing sent`, { hits: N.hits.length, sent });
		check(!t?.started, `4. ${label}: nothing even collected`, t);
		await N.ctx.close();
	}
	{
		const L = await playPage(browser, 'L', q);
		await play(L.page, true);
		await L.page.waitForTimeout(800);
		await hide(L.page);
		await L.page.waitForTimeout(800);
		const t = await tracker(L.page);
		check(L.hits.length === 0 && t?.started && !t.startSent, '4. no plugin listening: nothing sent, nothing marked sent', t);
		// a listener arriving later gets the whole play on the next hide
		await listen(L.page);
		await show(L.page);
		await hide(L.page);
		await h.eventually(async () => L.hits.length, (n) => n >= 1, '4. a later listener gets the play', 10000);
		check(L.hits[0]?.body?.e?.[0]?.k === 'start', '4. ...starting with its start');
		await L.ctx.close();
	}
	{
		const Z = await playPage(browser, 'Z', `play?scene=${encodeURIComponent(SCENE_URL)}`);
		await listen(Z.page);
		await play(Z.page, true);
		await Z.page.waitForTimeout(800);
		await hide(Z.page);
		await Z.page.waitForTimeout(800);
		const t = await tracker(Z.page);
		check(Z.hits.length === 0 && t === null, '4. a page without ?s= (not a published scene) never starts counting', t);
		await Z.ctx.close();
	}

	await h.finish(browser);
});
