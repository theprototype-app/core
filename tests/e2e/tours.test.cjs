// 36 U3b / I5 / A2 — THE FIRST-RUN TOURS, end to end.
//
//  VR (fakeXR — the real per-frame path: updateVRControls runs the tour's frame hook):
//    the first VR entry starts "Welcome to ThePrototype VR mode" ONCE; every step's ACTION
//    advances it (stick → move, trigger off the panel → point, grip → grab, B → the radial,
//    Y → Interact, leaving VR → done) and the panel's own buttons press with the trigger;
//    re-entering (and a reload) shows nothing; Skip persists; an interrupted tour resumes;
//    the radial's System ▸ Welcome tour and Settings ▸ Tours ▸ Reset bring it back.
//  Screen: the editor tour follows the first-visit Welcome card (and NOT under test without
//    the opt-in — the guard that keeps the battery clean), its card never covers its target,
//    Settings / the logo menu start it, "Don't show again" turns auto-start off, the VR
//    welcome previews on a screen without being marked seen, the touch variant on a phone.
//  A2: with a fake headset browser, the page offers immersive-VR (not threlte's AR default)
//    exactly once, follows passthrough, and a decline is remembered across reloads.
//
// TOUR_SHOTS=<dir> writes a screenshot of every step (VR panel canvases + screen cards).
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.TOUR_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PART = process.env.TOURS_PART || 'all'; // vr | screen | offer | all

async function shotCanvas(page, name) {
	if (!SHOTS) return;
	const url = await page.evaluate(() => window.__stores.tourVR.tourVRDebug().canvas.toDataURL('image/png'));
	fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
}
async function shotPage(page, name) {
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
const active = (page) => page.evaluate(() => window.__stores.tours.toursDebug().active);
const stepId = async (page) => (await active(page))?.step.id ?? null;
const vrDebug = (page) =>
	page.evaluate(() => {
		const d = window.__stores.tourVR.tourVRDebug();
		return { ...d, canvas: undefined };
	});
/** open Settings on the Tours rows (the search expands the collapsed sections) */
async function openTourSettings(page) {
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	const search = page.locator('#settings-search');
	await search.waitFor({ state: 'visible', timeout: 5000 });
	// a query left from the last time would not re-run the expansion: clear it first
	await search.fill('');
	await page.waitForTimeout(150);
	await search.fill('tours');
	await page.locator('#setting-tours-reset').waitFor({ state: 'visible', timeout: 5000 }).catch(async (e) => {
		await shotPage(page, 'zz-settings-fail');
		throw e;
	});
}
const setVR = (page, on) => page.evaluate((on) => window.__stores.isVRMode.set(on), on);

/** point a controller from `from` at world point `to` (the controller's ray is its -Z) */
async function aim(page, hand, from, to) {
	await page.evaluate(
		({ hand, from, to }) => {
			const THREE = window.__stores.THREE;
			const c = window.__fakeXR.renderer.xr.getController(hand === 'left' ? 0 : 1);
			const f = new THREE.Vector3(...from);
			const m = new THREE.Matrix4().lookAt(f, new THREE.Vector3(...to), new THREE.Vector3(0, 1, 0));
			c.matrix.compose(f, new THREE.Quaternion().setFromRotationMatrix(m), new THREE.Vector3(1, 1, 1));
			c.matrixWorld.copy(c.matrix);
			c.updateMatrixWorld(true);
		},
		{ hand, from, to }
	);
}
const HAND_AT = { left: [-0.2, 1.3, -0.25], right: [0.2, 1.3, -0.25] };
/** aim away from the panel (behind the user) */
const aimAway = (page, hand) => aim(page, hand, HAND_AT[hand], [HAND_AT[hand][0], 1.3, 3]);
async function click(page, hand, index = 0) {
	await xr.button(page, hand, index, true);
	await page.waitForTimeout(160);
	await xr.button(page, hand, index, false);
	await page.waitForTimeout(160);
}
/** press a panel button with the trigger */
async function pressPanel(page, id, hand = 'right') {
	const point = (await vrDebug(page)).points[id];
	if (!point) return false;
	await aim(page, hand, HAND_AT[hand], point);
	await page.waitForTimeout(120);
	await click(page, hand, 0);
	await aimAway(page, hand);
	return true;
}
async function waitStep(page, want, label, timeout = 4000) {
	return h.eventually(() => stepId(page), (id) => id === want, label, timeout);
}

/** a VR-ready page: fake session, Quest 3 profiles, the head pinned at standing height */
async function vrPage(browser, storage = {}) {
	const peer = await h.setupPage(browser, 'VR', { storage: { toursUnderTest: 'true', ...storage } });
	const page = peer.page;
	await xr.install(page);
	await page.evaluate(() => {
		for (const s of window.__fakeXR.sources) s.profiles = ['meta-quest-touch-plus', 'generic-trigger-squeeze-thumbstick'];
		window.__stores.tourVR.setTourHead({ position: [0, 1.6, 0], yaw: 0 });
	});
	await aimAway(page, 'left');
	await aimAway(page, 'right');
	return peer;
}

async function vrPart(browser) {
	// ---- first VR entry: the welcome, once --------------------------------------------
	const A = await vrPage(browser);
	const page = A.page;
	h.check((await stepId(page)) === null, 'U3b: no tour before the first VR entry');
	await setVR(page, true);
	await waitStep(page, 'welcome', 'U3b: the first VR entry starts "Welcome to ThePrototype VR mode"', 5000);
	let d = await vrDebug(page);
	h.check(d.visible, 'U3b: the welcome panel is in the world');
	h.check(
		Math.abs(d.position[2] + 0.9) < 0.05 && Math.abs(d.position[1] - 1.48) < 0.05,
		'U3b: the panel sits ~0.9 m in front of the head, just below eye level (' + d.position.map((n) => n.toFixed(2)) + ')'
	);
	const title = await active(page);
	h.check(title.step.title === 'Welcome to ThePrototype VR mode' && title.total === 8, 'U3b: step 1 is the welcome, 8 steps');
	await shotCanvas(page, '01-vr-welcome');

	// the panel's Next presses with the trigger
	h.check(await pressPanel(page, 'next'), 'U3b: the Next button has a world point');
	await waitStep(page, 'controllers', 'U3b: trigger on Next → the controller map');
	d = await vrDebug(page);
	h.check(d.presses === 1 && d.lastPress === 'next', 'U3b: one press, on Next');
	h.check(!d.signals.includes('vr-trigger'), 'U3b: a trigger on the panel is the panel’s — not the "point" action');
	await shotCanvas(page, '02-vr-controllers');
	const art = await page.evaluate(() => localStorage.getItem('tourControllerFamily'));
	h.check(art === 'quest3', 'U3b: the Quest 3 / 3S controllers were recognised from the input profiles (' + art + ')');
	await pressPanel(page, 'next');
	await waitStep(page, 'move', 'U3b: → move and turn');
	await shotCanvas(page, '03-vr-move');

	// each step's ACTION advances it
	const pulsesBefore = await xr.pulses(page);
	await xr.stick(page, 'right', 0, -0.9);
	await page.waitForTimeout(200);
	await xr.stick(page, 'right', 0, 0);
	await waitStep(page, 'point', 'U3b: pushing a thumbstick completes "move and turn"');
	const pulsesAfter = await xr.pulses(page);
	h.check(pulsesAfter.right > pulsesBefore.right, 'U3b: a step done by doing it ticks that hand');
	await shotCanvas(page, '04-vr-point');
	await click(page, 'left', 0);
	await waitStep(page, 'grab', 'U3b: a trigger pulled off the panel completes "point and click"');
	await shotCanvas(page, '05-vr-grab');
	await click(page, 'right', 1);
	await waitStep(page, 'menu', 'U3b: squeezing a grip completes "grab"');
	await shotCanvas(page, '06-vr-menu');
	await click(page, 'right', 5); // B on the menu hand opens the radial
	await waitStep(page, 'play', 'U3b: opening the radial (B) completes "your menu"');
	await click(page, 'right', 5); // close it again
	await shotCanvas(page, '07-vr-play');
	await click(page, 'left', 5); // Y = Edit ↔ Interact
	await waitStep(page, 'exit', 'U3b: switching to Interact (Y) completes "play a game"');
	await shotCanvas(page, '08-vr-exit');
	await page.evaluate(() => window.__stores.editorMode.set('edit'));
	await setVR(page, false);
	await h.eventually(() => stepId(page), (id) => id === null, 'U3b: leaving VR completes the last step');
	h.check(await page.evaluate(() => window.__stores.tours.tours.seen('vr-welcome')), 'U3b: the welcome is recorded as seen');

	// ---- once: not again on re-entry, nor after a reload ------------------------------
	await setVR(page, true);
	await page.waitForTimeout(2200);
	h.check((await stepId(page)) === null, 'U3b: entering VR again shows nothing');
	await setVR(page, false);

	// ---- the radial's System ▸ Welcome tour replays it from the top -------------------
	await setVR(page, true);
	const entry = await page.evaluate(() => {
		const s = window.__stores;
		return s.vrRadialMenu.ringEntries('system').map((e) => e.id);
	});
	h.check(entry.includes('tour:vr'), 'U3b: the radial System ring carries "Welcome tour"');
	await page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('tour:vr'));
	await waitStep(page, 'welcome', 'U3b: radial ▸ Welcome tour restarts it in VR');
	// ---- Skip persists ----------------------------------------------------------------
	await pressPanel(page, 'skip');
	await h.eventually(() => stepId(page), (id) => id === null, 'U3b: Skip (trigger on the panel) closes it');
	await setVR(page, false);
	await h.freshReload(A);
	await xr.install(page);
	await page.evaluate(() => window.__stores.tourVR.setTourHead({ position: [0, 1.6, 0], yaw: 0 }));
	await setVR(page, true);
	await page.waitForTimeout(2200);
	h.check((await stepId(page)) === null, 'U3b: after a reload a seen/skipped welcome stays away');
	await setVR(page, false);

	// ---- Settings ▸ Tours ▸ Reset all brings it back; an interrupted tour RESUMES -------
	await openTourSettings(page);
	await page.locator('#setting-tours-reset').click();
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await setVR(page, true);
	await waitStep(page, 'welcome', 'U3b: after Settings ▸ Reset all, the next VR entry shows it again', 5000);
	await pressPanel(page, 'next');
	await pressPanel(page, 'next');
	await waitStep(page, 'move', 'U3b: two Nexts');
	await setVR(page, false); // the headset comes off mid-tour
	await h.eventually(() => stepId(page), (id) => id === null, 'U3b: leaving VR mid-tour pauses it');
	h.check((await page.evaluate(() => window.__stores.tours.tours.status('vr-welcome'))) === 'progress', 'U3b: …and keeps its place');
	await setVR(page, true);
	await waitStep(page, 'move', 'U3b: the next VR entry RESUMES on the step it stopped at', 5000);
	// Don't show again: no tour auto-starts any more
	await pressPanel(page, 'never');
	await h.eventually(() => stepId(page), (id) => id === null, "U3b: Don't show again closes it");
	h.check((await page.evaluate(() => localStorage.getItem('toursAutoStart'))) === 'false', "U3b: Don't show again turns auto-start off");
	await setVR(page, false);
	await A.ctx.close();
}

/** a fresh first-visit page (no hasSeenWelcome) */
async function firstVisit(browser, storage, context) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...(context ?? {}) });
	await ctx.addInitScript((seed) => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		for (const [k, v] of Object.entries(seed)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
	}, storage);
	const page = await ctx.newPage();
	page.__errors = [];
	page.on('pageerror', (e) => page.__errors.push(e.message));
	await page.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForFunction(() => window.__stores && !!window.__stores.tours && !!window.__stores.moduleSDK, { timeout: 30000 });
	await page.waitForTimeout(800);
	return { ctx, page };
}
const rectOf = (page, sel) => page.evaluate((sel) => {
	const r = document.querySelector(sel)?.getBoundingClientRect();
	return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
}, sel);
const overlap = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

async function screenPart(browser) {
	// ---- the guard: under test with no opt-in, closing the Welcome starts nothing -------
	const G = await firstVisit(browser, {});
	await G.page.locator('#welcome-start').click();
	await G.page.waitForTimeout(1500);
	h.check((await G.page.locator('#tour-card').count()) === 0, 'I5: under test without the opt-in no tour starts (the battery stays clean)');
	await G.ctx.close();

	// ---- first visit: Welcome → the editor tour ---------------------------------------
	const B = await firstVisit(browser, { toursUnderTest: 'true' });
	const page = B.page;
	h.check(await page.locator('#welcome-overlay').isVisible(), 'I5: first visit shows the Welcome card first');
	h.check((await page.locator('#tour-card').count()) === 0, 'I5: …and no tour on top of it');
	await page.locator('#welcome-start').click();
	await page.locator('#tour-card').waitFor({ state: 'visible', timeout: 5000 });
	h.check((await page.locator('#tour-card').getAttribute('data-tour-id')) === 'editor', 'I5: closing the Welcome starts the desktop editor tour');
	const STEPS = ['add', 'navigate', 'tools', 'play', 'connect', 'menu'];
	const TARGET = { add: '#mobile-add-button', tools: '#controls-pill', play: '#play-button', connect: '.connect-pill', menu: '#logo-menu' };
	for (let i = 0; i < STEPS.length; i++) {
		const step = STEPS[i];
		await h.eventually(() => page.locator('#tour-card').getAttribute('data-step'), (s) => s === step, 'I5: step ' + (i + 1) + ' is ' + step);
		await page.waitForTimeout(450); // the card settles beside its target
		if (TARGET[step]) {
			const card = await rectOf(page, '#tour-card');
			const target = await rectOf(page, TARGET[step]);
			const spot = await rectOf(page, '#tour-spotlight');
			h.check(!!spot && overlap(spot, target), 'I5: ' + step + ' — the spotlight rings its target');
			h.check(!overlap(card, target), 'I5: ' + step + ' — the card does not cover its target');
		}
		await shotPage(page, String(10 + i).padStart(2, '0') + '-desktop-' + step + '-dark');
		await page.locator('#tour-next').click();
	}
	await page.waitForTimeout(300);
	h.check((await page.locator('#tour-card').count()) === 0, 'I5: Done closes the tour');
	h.check(await page.evaluate(() => window.__stores.tours.tours.seen('editor')), 'I5: …and records it seen');
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => window.__stores && !!window.__stores.tours, { timeout: 30000 });
	await page.waitForTimeout(1500);
	h.check((await page.locator('#tour-card').count()) === 0, 'I5: a returning visit shows no tour');

	// ---- restart from the logo menu, Esc skips, Settings starts it, light theme ---------
	await page.locator('#logo-menu').click();
	await page.locator('#open-tour').click();
	await page.locator('#tour-card').waitFor({ state: 'visible', timeout: 3000 });
	h.check((await page.locator('#tour-card').getAttribute('data-step')) === 'add', 'I5: logo menu ▸ Tours restarts the editor tour from the top');
	await page.locator('#tour-card').press('Escape');
	await page.waitForTimeout(300);
	h.check((await page.locator('#tour-card').count()) === 0, 'I5: Esc skips');
	await openTourSettings(page);
	await page.locator('#setting-tour-editor').click();
	await page.locator('#tour-card').waitFor({ state: 'visible', timeout: 3000 });
	h.check(true, 'I5: Settings ▸ Tours ▸ Start editor tour');
	await page.locator('#tour-next').click();
	await page.locator('#tour-next').click();
	await page.waitForTimeout(400);
	await page.evaluate(() => window.__stores.themes.theme.set('light'));
	await page.waitForTimeout(400);
	await shotPage(page, '16-desktop-tools-light');
	h.check((await page.locator('#tour-back').count()) === 1, 'I5: Back appears after the first step');
	await page.locator('#tour-back').click();
	await h.eventually(() => page.locator('#tour-card').getAttribute('data-step'), (s) => s === 'navigate', 'I5: Back goes one step back');
	await page.locator('#tour-never').click();
	await page.waitForTimeout(300);
	h.check((await page.evaluate(() => localStorage.getItem('toursAutoStart'))) === 'false', "I5: Don't show again turns auto-start off");
	await openTourSettings(page);
	h.check(!(await page.locator('#setting-tours-auto').isChecked()), 'I5: Settings ▸ Show tours automatically reads off');
	await shotPage(page, '21-settings-tours-light');

	// ---- the VR welcome on a screen: armed + previewed, never marked seen ---------------
	await page.evaluate(() => window.__stores.tours.tours.reset('vr-welcome'));
	await page.locator('#setting-tour-vr').click();
	await page.waitForTimeout(400);
	const preview = page.locator('.tp-toast .tp-toast-action', { hasText: 'Preview it here' }).first();
	h.check(await preview.isVisible().catch(() => false), 'U3b: Start VR welcome on a screen offers a preview');
	await preview.click();
	await page.locator('#tour-card').waitFor({ state: 'visible', timeout: 3000 });
	await page.locator('#tour-next').click();
	await page.waitForTimeout(300);
	h.check((await page.locator('#tour-card .tour-art svg').count()) === 1, 'U3b: the preview draws the controller diagram');
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
	await page.waitForTimeout(300);
	await shotPage(page, '17-vr-preview-quest3-dark');
	await page.locator('.tour-family button', { hasText: 'Quest 2' }).click();
	await page.waitForTimeout(300);
	await shotPage(page, '18-vr-preview-quest2-dark');
	for (let i = 0; i < 7; i++) await page.locator('#tour-next').click();
	await page.waitForTimeout(300);
	h.check(!(await page.evaluate(() => window.__stores.tours.tours.seen('vr-welcome'))), 'U3b: a preview on a screen leaves the VR welcome owed');
	await B.ctx.close();

	// ---- the touch variant on a phone (folded Find N6-ish width) -------------------------
	const T = await firstVisit(
		browser,
		{ toursUnderTest: 'true' },
		{ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
	);
	await T.page.locator('#welcome-start').click();
	await T.page.locator('#tour-card').waitFor({ state: 'visible', timeout: 5000 });
	h.check((await T.page.locator('#tour-card').getAttribute('data-tour-id')) === 'editor-touch', 'I5: a touch screen gets the touch tour');
	h.check(/sheet/.test(await T.page.locator('#tour-card').getAttribute('data-side')), 'I5: on a phone the card is a sheet');
	const tcard = await rectOf(T.page, '#tour-card');
	h.check(tcard.x >= 0 && tcard.x + tcard.w <= 412 && tcard.y + tcard.h <= 915, 'I5: the sheet fits the phone');
	await shotPage(T.page, '19-touch-add');
	await T.page.locator('#tour-next').tap();
	await T.page.waitForTimeout(400);
	await shotPage(T.page, '20-touch-navigate');
	await T.ctx.close();
}

/** a fake headset browser: navigator.xr with offerSession, VR + AR supported */
const FAKE_XR = () => {
	const offers = [];
	const fake = {
		isSessionSupported: async (mode) => mode === 'immersive-vr' || mode === 'immersive-ar',
		offerSession(mode, init) {
			return new Promise((resolve, reject) => offers.push({ mode, init, resolve, reject }));
		},
		requestSession: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotSupportedError' })),
		addEventListener() {},
		removeEventListener() {}
	};
	window.__offers = offers;
	Object.defineProperty(Navigator.prototype, 'xr', { get: () => fake, configurable: true });
};

async function offerPart(browser) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	await ctx.addInitScript(FAKE_XR);
	await ctx.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
	});
	const page = await ctx.newPage();
	const boot = async () => {
		await page.waitForFunction(() => window.__stores && !!window.__stores.xrOffer, { timeout: 30000 });
		await page.waitForTimeout(1500);
	};
	await page.goto(h.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await boot();
	const offers = () => page.evaluate(() => window.__offers.map((o) => o.mode));
	h.check(JSON.stringify(await offers()) === '["immersive-vr"]', 'A2: a headset browser is offered immersive-VR, once (got ' + JSON.stringify(await offers()) + ')');
	// decline → remembered → a reload offers nothing
	await page.evaluate(() => window.__offers[0].reject(Object.assign(new Error('declined'), { name: 'NotAllowedError' })));
	await page.waitForTimeout(500);
	h.check((await page.evaluate(() => window.__stores.xrOffer.xrOfferDebug().outcome)) === 'declined', 'A2: the decline is seen');
	await page.reload({ waitUntil: 'domcontentloaded' });
	await boot();
	h.check((await offers()).length === 0, 'A2: after a decline a reload offers nothing');
	// the setting off → on asks again; passthrough on → AR
	await page.evaluate(() => window.__stores.vrPassthrough.set(true));
	await page.evaluate(() => window.__stores.xrOffer.xrOfferEnabled.set(false));
	await page.waitForTimeout(200);
	await page.evaluate(() => window.__stores.xrOffer.xrOfferEnabled.set(true));
	await h.eventually(offers, (list) => list.length === 1, 'A2: switching the setting off and on offers again');
	h.check((await offers())[0] === 'immersive-ar', 'A2: with passthrough on the offer is AR, like Play');
	// a session starting settles the page: no second offer when it ends
	await page.evaluate(() => window.__stores.isVRMode.set(true));
	await page.waitForTimeout(300);
	await page.evaluate(() => window.__stores.isVRMode.set(false));
	await page.waitForTimeout(800);
	h.check((await page.evaluate(() => window.__stores.xrOffer.xrOfferDebug().mode)) === false, 'A2: once per page — after a session nothing is offered again');
	await page.evaluate(() => window.__stores.vrPassthrough.set(false));
	await ctx.close();
}

h.run(async () => {
	const browser = await h.launch();
	if (PART === 'all' || PART === 'vr') await vrPart(browser);
	if (PART === 'all' || PART === 'screen') await screenPart(browser);
	if (PART === 'all' || PART === 'offer') await offerPart(browser);
	await h.finish(browser);
});
