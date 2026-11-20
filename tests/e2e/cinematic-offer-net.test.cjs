// 100-int — PHONES, TABLETS AND HEADSETS DOWNLOAD NOTHING NEW for the Cinematic view (roadmap 100 C1 gate
// "phones / Quest download nothing new (network log)"). The boot path asks a pure pre-check (cinematicOffer's
// worthProbing: a desktop browser with WebGPU, not a headset) before it imports the offer probe; only a desktop
// goes on to the probe chunk, and only an offered desktop to the switch.
//
// The network log is the page's own resource timing (buffer raised before the first request, so a dev server's
// hundreds of modules do not push the late probe import out of it). All three pages run in one browser with
// WebGPU exposed, so navigator.gpu is there on every one: the device check is what keeps the phone and the
// headset out. The desktop page is the positive control (it does fetch the probe).
//
//   APP_URL=https://theprototype.app:7036/ e2e-slot --dev $PWD 7036 -- node tests/e2e/cinematic-offer-net.test.cjs
const h = require('./helpers.cjs');

const QUEST_UA =
	'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/38.0.0.0 SamsungBrowser/4.0 Chrome/132.0.0.0 VR Safari/537.36';
const BIG_BUFFER = () => performance.setResourceTimingBufferSize(100000);

/** every resource the page asked for that belongs to the Cinematic view (dev: source paths; build: none expected) */
const cinematicFetches = (/** @type {any} */ page) =>
	page.evaluate(() =>
		performance
			.getEntriesByType('resource')
			.map((e) => e.name)
			.filter((n) => /\/cinematic\/|three\.webgpu|CinematicSwitch/i.test(n) && !/cinematicOffer|cinematicStore/.test(n))
	);
const hasGpu = (/** @type {any} */ page) => page.evaluate(() => !!(/** @type {any} */ (navigator).gpu));

h.run(async () => {
	const browser = await h.launch({ args: ['--enable-unsafe-webgpu'] });
	const P = await h.setupPage(browser, 'phone', {
		init: BIG_BUFFER,
		context: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: h.N6_UA }
	});
	const Q = await h.setupPage(browser, 'quest', { init: BIG_BUFFER, context: { viewport: { width: 1280, height: 720 }, userAgent: QUEST_UA } });
	const D = await h.setupPage(browser, 'desk', { init: BIG_BUFFER, context: { viewport: { width: 1280, height: 720 } } });
	// the probe is asked 4 s after the app starts; give every page well past that
	await D.page.waitForTimeout(9000);

	const pGpu = await hasGpu(P.page);
	const dGpu = await hasGpu(D.page);
	h.check(pGpu, `premise: the phone page has navigator.gpu (so only the device check keeps it out)`);
	const pc = await P.page.evaluate(() => matchMedia('(pointer: coarse)').matches);
	h.check(pc, 'premise: the phone page has a coarse pointer');

	const p = await cinematicFetches(P.page);
	const q = await cinematicFetches(Q.page);
	const d = await cinematicFetches(D.page);
	h.check(p.length === 0, `the phone downloaded nothing of the Cinematic view (${p.join(', ') || 'none'})`);
	h.check(q.length === 0, `the Quest browser downloaded nothing of the Cinematic view (${q.join(', ') || 'none'})`);
	// positive control: a desktop with WebGPU asks the probe (else the filter above would pass on anything)
	if (dGpu) h.check(d.some((n) => /cinematicState/.test(n)), `control: the desktop page fetched the offer probe (${d.join(', ') || 'none'})`);
	else h.check(true, 'control skipped: this browser has no navigator.gpu on the desktop page');

	await h.finish(browser);
});
