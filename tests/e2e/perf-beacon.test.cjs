// 34 R1 — the performance beacon (client), against a MOCK perf_reports endpoint.
//
//   A. no VITE_PERF_REPORTS_URL: the feature does not exist — no Settings row, no offer
//   B. production host + an endpoint: the switch is OFF by default, nothing is offered,
//      nothing is sent (11 s of real time, counted at the network); turned on through the
//      real Settings toggle: the reporting dot, then the REAL 10-s cut / 30-s batch sends
//      one multipart request per window, shaped per T1 (kind, session, data = a light
//      window, validated by the same module in node), windows do not overlap, a stall
//      window goes as kind `stall`; a failed send is DROPPED (never retried) and the dot
//      turns amber; hiding the page and an XR session end go out through sendBeacon
//   C. a PREVIEW host: the one-time offer; accepting turns reports on; never offered twice
//
// The mock: `perf.mock.test` routed by Playwright (fetch AND sendBeacon are intercepted);
// the URL is the debug-hook-gated override `perfReports:url` (a build-time env cannot be
// swapped per suite). The preview host resolves to this dev server through
// --host-resolver-rules, one browser for the whole suite.
//
// Run: APP_URL=https://theprototype.app:5292/ npm run e2e -- perf-beacon
const h = require('./helpers.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOCK = 'https://perf.mock.test/api/collections/perf_reports/records?fields=id';
const PREVIEW_HOST = 'preview-1-20.theprototype.pages.dev';

/** naive multipart parser: {field: string} (the screenshot part is kept as its byte length) @param {Buffer} buf @param {string} type */
function parseMultipart(buf, type) {
	const boundary = /boundary=([^;]+)/.exec(type || '')?.[1];
	/** @type {Record<string, any>} */
	const out = {};
	if (!boundary) return out;
	const text = buf.toString('latin1');
	for (const part of text.split('--' + boundary)) {
		const m = /name="([^"]+)"(?:; filename="([^"]*)")?[\s\S]*?\r\n\r\n([\s\S]*)\r\n$/.exec(part);
		if (!m) continue;
		out[m[1]] = m[2] !== undefined ? { file: m[2], bytes: Buffer.from(m[3], 'latin1').length } : Buffer.from(m[3], 'latin1').toString('utf8');
	}
	return out;
}

h.run(async () => {
	const tp = await import(pathToFileURL(path.join(__dirname, '../../src/lib/perf/tpprof.js')).href);
	const port = new URL(h.URL).port;
	// the preview host maps to `localhost` (the dev server may bind ::1 or 127.0.0.1); a public-
	// looking origin on loopback also needs the local-network-access checks off
	const browser = await h.launch({
		args: [
			...h.GPU_ARGS,
			`--host-resolver-rules=MAP ${PREVIEW_HOST} localhost`,
			'--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults'
		]
	});

	/** @type {{url: string, type: string, fields: Record<string, any>, at: number}[]} */
	let requests = [];
	let failNext = 0;
	/** @param {any} ctx */
	const mock = (ctx) =>
		ctx.route(/perf\.mock\.test/, async (route) => {
			const req = route.request();
			requests.push({ url: req.url(), type: req.resourceType(), fields: parseMultipart(req.postDataBuffer() ?? Buffer.alloc(0), req.headers()['content-type']), at: Date.now() });
			const fail = failNext > 0;
			if (fail) failNext--;
			await route.fulfill({ status: fail ? 500 : 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fail ? '{"message":"boom"}' : '{"id":"mock"}' });
		});
	const toastIds = (page) => page.evaluate(() => {
		let list = [];
		window.__stores.toastStore.subscribe((x) => (list = x))();
		return list.filter((t) => t && t.id).map((t) => t.id);
	});
	const openInterface = async (page) => {
		await page.evaluate(() => {
			window.__stores.settingsSection.set('interface');
			window.__stores.settingsOpen.set(true);
		});
		await page.waitForTimeout(600);
	};

	// ================================================================ A. no endpoint
	{
		const A = await h.setupPage(browser, 'A', { storage: { 'perfStats:show': 'true' } });
		const page = A.page;
		await mock(A.ctx);
		const dbg = await page.evaluate(() => window.__stores.perfBeacon.beaconDebug());
		h.check(dbg.url === null && dbg.running === false, 'A1 no VITE_PERF_REPORTS_URL: no endpoint, not running');
		await openInterface(page);
		h.check((await page.locator('#show-perf-stats').count()) === 1 && (await page.locator('#send-perf-reports').count()) === 0, 'A2 the Settings row does not exist without an endpoint');
		h.check(!(await toastIds(page)).includes('perf-reports-offer'), 'A3 nothing is offered');
		h.check((await page.locator('#perf-report-dot').count()) === 0, 'A4 no reporting dot');
		await A.ctx.close();
	}

	// ================================================================ B. production host + endpoint
	{
		requests = [];
		const B = await h.setupPage(browser, 'B', { storage: { 'perfStats:show': 'true', 'perfReports:url': MOCK } });
		const page = B.page;
		await mock(B.ctx);
		h.check(!(await toastIds(page)).includes('perf-reports-offer'), 'B1 production (theprototype.app) is never prompted');
		await openInterface(page);
		const toggle = page.locator('#send-perf-reports');
		h.check((await toggle.count()) === 1 && (await toggle.getAttribute('aria-pressed')) === 'false', 'B2 the row exists and is OFF by default');
		await page.evaluate(() => window.__stores.settingsOpen.set(false));
		await page.waitForTimeout(11000);
		h.check(requests.length === 0, `B3 off = nothing sent in 11 s of real time (${requests.length} requests)`);
		h.check((await page.locator('#perf-report-dot').count()) === 0, 'B4 no dot while off');

		await openInterface(page);
		await toggle.evaluate((el) => el.click());
		await page.waitForTimeout(300);
		await page.evaluate(() => window.__stores.settingsOpen.set(false));
		const on = await page.evaluate(() => window.__stores.perfBeacon.beaconDebug());
		h.check(on.running && on.url === 'https://perf.mock.test/api/collections/perf_reports/records?fields=id', 'B5 the Settings toggle turns reports on');
		h.check((await page.locator('#perf-report-dot').getAttribute('data-state')) === 'idle', 'B6 the reporting dot is on the FPS counter (idle until a send)');
		const strip = await page.evaluate(() => window.__stores.gameKit.vrPerfStrip.perfSegments({ fps: 72, ms: 13.9, calls: 100, tris: 1000, source: 'xr' }));
		h.check(strip[0].text === '●' && strip[1].text === '72 fps', 'B6b the headset FPS strip carries the same dot');
		// a real stall inside the first window
		await page.waitForTimeout(2500);
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => {
			const until = performance.now() + 160;
			while (performance.now() < until) { /* busy */ }
			r(null);
		})));
		// the REAL timers: three 10-s windows, then the 30-s batch
		const t0 = Date.now();
		while (requests.length < 3 && Date.now() - t0 < 40000) await page.waitForTimeout(500);
		const batch = requests.slice(0, 3);
		h.check(batch.length === 3, `B7 the 30-s batch sends one request per 10-s window (${requests.length} after ${Math.round((Date.now() - t0) / 1000)} s)`);
		h.check(batch.every((r) => r.fields.kind && r.fields.session && r.fields.data && !r.fields.screenshot), 'B8 each request is multipart kind + session + data');
		const docs = batch.map((r) => JSON.parse(r.fields.data));
		const sessions = new Set(batch.map((r) => r.fields.session));
		h.check(sessions.size === 1 && /^[a-z0-9]{8,64}$/.test([...sessions][0]), `B9 one random session id per app run (${[...sessions][0]})`);
		const valid = batch.map((r, i) => tp.validateTpprof(docs[i], { report: r.fields.kind }));
		h.check(valid.every((v) => v.ok), 'B10 every window is a valid T1 light report for its kind ' + valid.flatMap((v) => v.errors).slice(0, 2).join('; '));
		h.check(docs.every((d, i) => d.meta.mode === 'light' && d.meta.kind === batch[i].fields.kind && d.meta.session === batch[i].fields.session && !d.captures && d.frames.length > 10), 'B11 meta carries mode/kind/session; no captures; frames inside');
		h.check(docs.every((d) => d.meta.durationMs <= 10500 && d.meta.build && d.meta.version && Object.keys(d.meta.modules).length > 0), 'B12 a window is <= 10 s and names build, version and modules');
		const ordered = [...docs].sort((a, b) => a.meta.startedAt - b.meta.startedAt);
		const overlap = ordered.slice(1).some((d, i) => d.meta.startedAt < ordered[i].meta.startedAt + ordered[i].meta.durationMs - 5);
		h.check(!overlap, 'B13 consecutive windows do not overlap');
		const stallReq = batch.find((r) => r.fields.kind === 'stall');
		h.check(!!stallReq && JSON.parse(stallReq.fields.data).events.some((e) => e.kind === 'stall'), 'B14 the window holding the stall goes as kind "stall"');
		h.check(batch.filter((r) => r.fields.kind === 'sample').length >= 1, 'B15 the others go as "sample"');
		await page.waitForTimeout(300);
		h.check((await page.locator('#perf-report-dot').getAttribute('data-state')) === 'sent', 'B16 the dot turns green after a send');

		// a failure is dropped, never retried
		const failed = await page.evaluate(async () => {
			const b = window.__stores.perfBeacon;
			b.cutWindow();
			return { queued: b.beaconDebug().queued.length };
		});
		failNext = 10;
		const before = requests.length;
		const okCount = await page.evaluate(() => window.__stores.perfBeacon.flushQueue());
		const tried = requests.length - before;
		failNext = 0;
		const after = await page.evaluate(() => window.__stores.perfBeacon.beaconDebug());
		h.check(failed.queued >= 1 && okCount === 0 && tried === failed.queued, `B17 a failing endpoint is tried once per window (${tried})`);
		h.check(after.queued.length === 0 && after.status.state === 'failed' && after.status.failed >= 1, 'B18 ...then dropped, the status says failed');
		await page.waitForTimeout(200);
		h.check((await page.locator('#perf-report-dot').getAttribute('data-state')) === 'failed', 'B19 the dot turns amber');
		const n0 = requests.length;
		await page.evaluate(() => window.__stores.perfBeacon.flushQueue());
		h.check(requests.length === n0, 'B20 nothing is re-sent afterwards');

		// hiding the page: the partial window goes by sendBeacon
		await page.waitForTimeout(1500);
		const n1 = requests.length;
		const beaconed = await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
			document.dispatchEvent(new Event('visibilitychange'));
			return window.__stores.perfBeacon.beaconDebug().queued.length;
		});
		await page.waitForTimeout(1500);
		const hid = requests.slice(n1);
		console.log('beacon request types: ' + hid.map((r) => r.type).join(', '));
		h.check(beaconed === 0 && hid.length >= 1 && hid.every((r) => r.fields.data && tp.validateTpprof(JSON.parse(r.fields.data), { report: r.fields.kind }).ok), `B21 hiding the page beacons the partial window (${hid.length}, ${hid.map((r) => r.type).join('/')})`);
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
			document.dispatchEvent(new Event('visibilitychange'));
		});
		// an XR session ending
		await page.waitForTimeout(1500);
		const n2 = requests.length;
		await page.evaluate(() => {
			let r;
			window.__stores.globalRenderer.subscribe((x) => (r = x))();
			r.xr.dispatchEvent({ type: 'sessionend' });
		});
		await page.waitForTimeout(1500);
		h.check(requests.length > n2, `B22 an XR session end beacons the window (${requests.length - n2})`);
		// off again
		await openInterface(page);
		await toggle.evaluate((el) => el.click());
		await page.waitForTimeout(300);
		const off = await page.evaluate(() => window.__stores.perfBeacon.beaconDebug());
		h.check(!off.running && (await page.locator('#perf-report-dot').count()) === 0, 'B23 off stops it and removes the dot');
		const stripOff = await page.evaluate(() => window.__stores.gameKit.vrPerfStrip.perfSegments({ fps: 72, ms: 13.9, calls: 100, tris: 1000, source: 'xr' }));
		h.check(stripOff[0].text === '72 fps', 'B23b ...and from the headset strip');
		h.check(h.pageErrors(B).length === 0, 'B24 no page errors');
		await B.ctx.close();
	}

	// ================================================================ C. a preview host
	{
		requests = [];
		const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
		await ctx.addInitScript((mockUrl) => {
			localStorage.setItem('debugStores', 'true');
			localStorage.setItem('hasSeenDisclaimer', 'true');
			localStorage.setItem('hasSeenWelcome', 'true');
			localStorage.setItem('perfReports:url', mockUrl);
		}, MOCK);
		await mock(ctx);
		const page = await ctx.newPage();
		page.__errors = [];
		page.on('pageerror', (e) => page.__errors.push(String(e.message)));
		await page.goto(`https://${PREVIEW_HOST}:${port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
		await page.waitForFunction(() => window.__stores?.perfBeacon, null, { timeout: 60000 });
		await page.waitForTimeout(1500);
		h.check((await page.evaluate(() => location.hostname)) === PREVIEW_HOST, 'C0 premise: the page runs on the preview host');
		h.check((await toastIds(page)).includes('perf-reports-offer'), 'C1 a preview build offers reports once');
		h.check(!(await page.evaluate(() => window.__stores.perfBeacon.beaconDebug().running)), 'C2 ...and sends nothing before the answer');
		await page.getByRole('button', { name: 'Send reports' }).first().click();
		await page.waitForTimeout(400);
		const st = await page.evaluate(() => ({ running: window.__stores.perfBeacon.beaconDebug().running, offered: localStorage.getItem('perfReports:offered'), send: localStorage.getItem('perfReports:send') }));
		h.check(st.running && st.offered === 'yes' && st.send === 'true', 'C3 accepting turns reports on and remembers the answer');
		h.check(!(await toastIds(page)).includes('perf-reports-offer'), 'C4 the offer card goes away');
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => window.__stores?.perfBeacon, null, { timeout: 60000 });
		await page.waitForTimeout(1500);
		h.check(!(await toastIds(page)).includes('perf-reports-offer'), 'C5 never offered twice');
		h.check(await page.evaluate(() => window.__stores.perfBeacon.beaconDebug().running), 'C6 the switch survives the reload');
		await ctx.close();
	}

	await h.finish(browser);
});
