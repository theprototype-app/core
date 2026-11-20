// 100-int — PHONES, TABLETS AND HEADSETS DOWNLOAD NOTHING NEW for the Cinematic view (roadmap 100 C1 gate
// "phones / Quest download nothing new (network log)"). The boot path asks a pure pre-check (cinematicOffer's
// worthProbing: a desktop browser with WebGPU, not a headset) before it imports the offer probe; only a desktop
// goes on to the probe chunk, and only an offered desktop to the switch.
//
// The network log is the page's own resource timing (buffer raised before the first request, so a dev server's
// hundreds of modules do not push the late probe import out of it). All three pages run in one browser with
// WebGPU exposed, so navigator.gpu is there on every one: the device check is what keeps the phone and the
// headset out. The desktop page is the positive control (it does fetch the probe).
// The pages are opened WITHOUT h.setupPage: its `debugStores` turns on the test hooks, which import every lazy
// module (cinematicState included) and would hide the very request this suite looks for.
//
//   APP_URL=https://theprototype.app:7036/ e2e-slot --dev $PWD 7036 -- node tests/e2e/cinematic-offer-net.test.cjs
const h = require('./helpers.cjs');

const QUEST_UA =
	'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/38.0.0.0 SamsungBrowser/4.0 Chrome/132.0.0.0 VR Safari/537.36';

/**
 * every resource the page asked for that belongs to the Cinematic view's lazy half. Dev server: source paths (the
 * page's own resource timing). A built app hashes its chunk names, so a built chunk is recognised by CONTENT, read
 * from the response the page already got (bare() records it; no second download): the probe (cinematicState) is the
 * only chunk with the 'debugCinematicSoftware' key, the switch the only one with its 'Cinematic view quality' label.
 */
async function cinematicFetches(/** @type {any} */ page) {
	const dev = await page.evaluate(() =>
		performance
			.getEntriesByType('resource')
			.map((e) => e.name)
			.filter((n) => /\/cinematic\/|three\.webgpu|CinematicSwitch/i.test(n) && !/cinematicOffer|cinematicStore/.test(n))
	);
	await Promise.all(page.__cinePending ?? []);
	return [...dev, ...(page.__cineBuilt ?? [])];
}
const hasGpu = (/** @type {any} */ page) => page.evaluate(() => !!(/** @type {any} */ (navigator).gpu));

/** a page as a user gets it: no test hooks, the welcome and disclaimer already seen */
async function bare(/** @type {any} */ browser, /** @type {any} */ context) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...context });
	await ctx.addInitScript(() => {
		performance.setResourceTimingBufferSize(100000);
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
	});
	const page = await ctx.newPage();
	/** @type {string[]} */
	const built = [];
	/** @type {Promise<void>[]} */
	const pending = [];
	page.on('response', (/** @type {any} */ r) => {
		const u = r.url();
		if (!/\/_app\/immutable\/.*\.js(\?|$)/.test(u)) return;
		pending.push(
			r.text().then(
				(/** @type {string} */ t) => {
					if (/debugCinematicSoftware/.test(t)) built.push(u + ' (cinematicState)');
					else if (/Cinematic view quality/.test(t)) built.push(u + ' (CinematicSwitch)');
				},
				() => {}
			)
		);
	});
	/** @type {any} */ (page).__cineBuilt = built;
	/** @type {any} */ (page).__cinePending = pending;
	await page.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
	// the 3D view's own canvas (a hidden minimap canvas comes first in the DOM)
	await page.waitForSelector('#viewport canvas', { state: 'attached', timeout: 120000 });
	return page;
}

h.run(async () => {
	const browser = await h.launch({ args: ['--enable-unsafe-webgpu'] });
	const P = await bare(browser, { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: h.N6_UA });
	const Q = await bare(browser, { viewport: { width: 1280, height: 720 }, userAgent: QUEST_UA });
	const D = await bare(browser, { viewport: { width: 1280, height: 720 } });
	// the probe is asked 4 s after the app's start code runs, which on a cold dev server is well after the canvas:
	// wait for the DESKTOP page to ask it (the control), then give the earlier-started phone and Quest pages 8 s more
	const dGpuEarly = await hasGpu(D);
	const t0 = Date.now();
	while (dGpuEarly && Date.now() - t0 < 120000 && !(await cinematicFetches(D)).some((n) => /cinematicState/.test(n))) await D.waitForTimeout(2000);
	console.log(`[net] the desktop asked the probe after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
	await D.waitForTimeout(8000);

	const pGpu = await hasGpu(P);
	const dGpu = await hasGpu(D);
	h.check(pGpu, `premise: the phone page has navigator.gpu (so only the device check keeps it out)`);
	const pc = await P.evaluate(() => matchMedia('(pointer: coarse)').matches);
	h.check(pc, 'premise: the phone page has a coarse pointer');
	const hooks = await P.evaluate(() => !!(/** @type {any} */ (window).__tp?.test));
	h.check(!hooks, 'premise: no test hooks on the pages (they would import every lazy module)');

	const p = await cinematicFetches(P);
	const q = await cinematicFetches(Q);
	const d = await cinematicFetches(D);
	h.check(p.length === 0, `the phone downloaded nothing of the Cinematic view (${p.join(', ') || 'none'})`);
	h.check(q.length === 0, `the Quest browser downloaded nothing of the Cinematic view (${q.join(', ') || 'none'})`);
	// positive control: a desktop with WebGPU asks the probe (else the filter above would pass on anything)
	if (dGpu) h.check(d.some((n) => /cinematicState/.test(n)), `control: the desktop page fetched the offer probe (${d.join(', ') || 'none'})`);
	else h.check(true, 'control skipped: this browser has no navigator.gpu on the desktop page');

	await h.finish(browser);
});
