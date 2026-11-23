// 103 (H13) — TOUCH FEEDBACK FOR THE EDITOR'S CONTROLS. A tick per slider step, a detent at the default,
// a bump at each end, switches that feel on vs off, long presses — on phones, adjustable in Settings ▸
// Touch controls ▸ Touch feedback (Off · Light · Medium · Strong + four kinds + a Try it slider).
//
// A motor cannot be felt headlessly: `navigator.vibrate` is a RECORDER installed before the app boots
// (the one browser seam hapticPatterns.phoneVibrate drives), and the touches are REAL — CDP touch events
// on a phone-sized touch context, so the input gate sees what a finger makes. What it FEELS like is the
// owed device check (HONOR / N6).
//
// 1 the card: default Light, four kinds, Try it · 2 a touch drag of the Try it slider: ticks, the
// default detent, ONE limit per end, never more than ~25 a second · 3 the levels scale the pulse
// (Strong), a switch feels on vs off · 4 a kind switched off is silent · 5 Interact / Play are
// silent · 6 a MOUSE is silent (desktop) · 7 the old Haptic tick migrates: off -> Off, on -> Light ·
// 8 reduced motion = Off by default · 9 no vibration (iPhone) = the card says why · 10 feature
// unused = zero change: Off, nothing reaches the motor whatever is touched.
const h = require('./helpers.cjs');

const PHONE = { viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.75 };

/** the motor recorder (or no motor at all), from the first frame @param {{none?: boolean}} o */
const motorInit = [
	(/** @type {any} */ o) => {
		const w = /** @type {any} */ (window);
		w.__vib = [];
		if (o?.none) Object.defineProperty(Navigator.prototype, 'vibrate', { configurable: true, value: undefined });
		else
			Object.defineProperty(Navigator.prototype, 'vibrate', {
				configurable: true,
				value: (/** @type {any} */ p) => (w.__vib.push({ p, t: performance.now() }), true)
			});
	},
	{}
];

const vib = (page) => page.evaluate(() => window.__vib.splice(0));
const debug = (page) => page.evaluate(() => window.__stores.uiHaptics.uiHapticsDebug());
const flat = (/** @type {any} */ p) => JSON.stringify(Array.isArray(p) ? p : [p]);

/** Settings ▸ Touch controls, on whatever layout the page has */
async function openTouchSettings(page) {
	await page.evaluate(() => {
		window.__tp.test.v1.settingsSection.set('touch');
		window.__tp.test.v1.settingsOpen.set(true);
	});
	await page.waitForTimeout(800);
	if (!(await page.locator('#row-touch-feedback').isVisible().catch(() => false))) {
		const row = page.locator('#settings-home .sn-row', { hasText: 'Touch controls' }).first();
		if (await row.count()) await row.tap().catch(() => row.click());
		await page.waitForTimeout(600);
	}
	await page.locator('#row-touch-feedback').waitFor({ timeout: 10000 });
}

/** a real finger drag across an element, in `steps` moves over `ms` @param {any} cdp */
async function touchDrag(page, cdp, sel, fromFrac, toFrac, steps, ms) {
	const el = page.locator(sel);
	await el.scrollIntoViewIfNeeded();
	const b = await el.boundingBox();
	const y = b.y + b.height / 2;
	const x = (/** @type {number} */ f) => b.x + 8 + (b.width - 16) * f;
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x(fromFrac), y }] });
	for (let i = 1; i <= steps; i++) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x(fromFrac + ((toFrac - fromFrac) * i) / steps), y }] });
		await page.waitForTimeout(ms / steps);
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await page.waitForTimeout(150);
}

h.run(async () => {
	const browser = await h.launch();

	console.log('\n=== 1. the card ===');
	const P = await h.setupPage(browser, 'P', { context: PHONE, init: motorInit });
	const page = P.page;
	const cdp = await page.context().newCDPSession(page);
	await openTouchSettings(page);
	const card = await page.evaluate(() => ({
		level: window.__stores.uiHaptics.uiHapticsDebug().prefs.level,
		levels: [...document.querySelectorAll('#touch-feedback-level button')].map((b) => b.textContent?.trim()),
		kinds: ['buttons', 'values', 'snap', 'gestures'].map((k) => !!document.querySelector('#touch-feedback-' + k)),
		tryIt: !!document.querySelector('#touch-feedback-try'),
		oldSwitch: !!document.querySelector('#touch-haptics')
	}));
	h.check(card.level === 'light', '1.1 a phone that can vibrate starts at Light (' + card.level + ')');
	h.check(JSON.stringify(card.levels) === JSON.stringify(['Off', 'Light', 'Medium', 'Strong']), '1.2 Off · Light · Medium · Strong (' + card.levels.join(',') + ')');
	h.check(card.kinds.every(Boolean) && card.tryIt, '1.3 the four kind switches and the Try it slider');
	h.check(!card.oldSwitch, '1.4 the old Haptic tick switch is gone (migrated)');

	console.log('\n=== 2. a touch drag of the Try it slider ===');
	await vib(page);
	await page.evaluate(() => window.__stores.uiHaptics.resetUiHapticsDebug());
	// from the middle (5) to past the right end, then all the way past the left end
	await touchDrag(page, cdp, '#touch-feedback-try', 0.5, 1.1, 20, 1000);
	await touchDrag(page, cdp, '#touch-feedback-try', 1, -0.1, 40, 2000);
	const drag = await debug(page);
	const names = drag.calls.map((c) => c.name);
	const pulses = await vib(page);
	const limits = names.filter((n) => n === 'limit').length;
	h.check(names.filter((n) => n === 'tick').length >= 8, '2.1 a tick per step (' + names.join(' ') + ')');
	h.check(names.includes('detent'), '2.2 a firmer detent crossing the default (5)');
	h.check(limits === 2, '2.3 ONE limit bump at each end, not one per move past it (' + limits + ')');
	h.check(pulses.length === drag.calls.length && pulses.every((v, i) => flat(v.p) === flat(drag.calls[i].pattern)), '2.4 every event reached the phone motor (' + pulses.length + ' calls)');
	h.check(flat(drag.calls.find((c) => c.name === 'tick')?.pattern) === '[8]' && flat(drag.calls.find((c) => c.name === 'limit')?.pattern) === '[21]', '2.5 Light lengths: tick 8 ms, limit 21 ms');
	await touchDrag(page, cdp, '#touch-feedback-try', 0, 1.1, 40, 300); // a FLICK end to end
	const fast = await vib(page);
	const span = fast.length > 1 ? fast[fast.length - 1].t - fast[0].t : 0;
	const ticks = (await debug(page)).calls.slice(drag.calls.length).filter((c) => c.name === 'tick');
	h.check(fast.length >= 2 && ticks.every((c, i) => i === 0 || c.t - ticks[i - 1].t >= 39), '2.6 a fast flick: ticks never closer than 40 ms (<= 25 a second), skipped not queued (' + fast.length + ' calls in ' + Math.round(span) + ' ms)');

	console.log('\n=== 3. levels and switches ===');
	await page.locator('#touch-feedback-level-strong').tap();
	await page.waitForTimeout(200);
	await vib(page);
	await page.locator('#touch-feedback-snap').tap(); // on -> off
	await page.waitForTimeout(150);
	await page.locator('#touch-feedback-snap').tap(); // off -> on
	await page.waitForTimeout(150);
	const sw = await vib(page);
	h.check(sw.length === 2 && flat(sw[0].p) === '[12,40,12]' && flat(sw[1].p) === '[24]', '3.1 Strong: off is a light double, on one firm pulse (' + sw.map((v) => flat(v.p)).join(' ') + ')');
	const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ui:touchFeedback') || 'null'));
	h.check(stored?.level === 'strong' && stored?.snap === true, '3.2 stored on this device under ui:touchFeedback (' + JSON.stringify(stored) + ')');

	console.log('\n=== 4. a kind switched off ===');
	await page.locator('#touch-feedback-values').tap();
	await page.waitForTimeout(150);
	await vib(page);
	await touchDrag(page, cdp, '#touch-feedback-try', 0, 1.1, 20, 800);
	const off = await vib(page);
	h.check(off.length === 0, '4.1 Sliders and values off: a slider drag is silent (' + off.length + ')');
	await page.locator('#touch-feedback-values').tap();
	await page.waitForTimeout(150);

	console.log('\n=== 5. never in Interact / Play ===');
	await page.evaluate(() => window.__tp.test.v1.objectActions.setEditorMode('interact'));
	await page.waitForTimeout(300);
	await vib(page);
	await page.locator('#touch-feedback-snap').tap();
	await page.waitForTimeout(150);
	await page.locator('#touch-feedback-snap').tap();
	await page.waitForTimeout(150);
	const inter = await vib(page);
	h.check(inter.length === 0, '5.1 Interact: the editor controls give no feedback (game vibration owns it) (' + inter.length + ')');
	await page.evaluate(() => window.__tp.test.v1.objectActions.setEditorMode('edit'));
	await page.waitForTimeout(300);

	console.log('\n=== 6. a mouse is silent ===');
	const D = await h.setupPage(browser, 'D', { context: { viewport: { width: 1280, height: 800 } }, init: motorInit });
	await openTouchSettings(D.page);
	await vib(D.page);
	await D.page.locator('#touch-feedback-snap').click();
	await D.page.locator('#touch-feedback-snap').click();
	const sl = await D.page.locator('#touch-feedback-try').boundingBox();
	await D.page.mouse.move(sl.x + 4, sl.y + sl.height / 2);
	await D.page.mouse.down();
	await D.page.mouse.move(sl.x + sl.width - 2, sl.y + sl.height / 2, { steps: 20 });
	await D.page.mouse.up();
	const mouse = await vib(D.page);
	const why = (await debug(D.page)).skipped;
	h.check(mouse.length === 0 && (why.input ?? 0) >= 2, '6.1 mouse clicks and a mouse drag reach no motor (skipped as input: ' + JSON.stringify(why) + ')');
	await D.page.context().close();

	console.log('\n=== 7. the old Haptic tick migrates ===');
	const M = await h.setupPage(browser, 'M', { context: PHONE, init: motorInit, storage: { touchControlsPrefs: JSON.stringify({ visibility: 'auto', showInEdit: false, haptics: false, scope: 'game' }) } });
	const mOff = (await debug(M.page)).prefs.level;
	await M.page.context().close();
	const M2 = await h.setupPage(browser, 'M2', { context: PHONE, init: motorInit, storage: { touchControlsPrefs: JSON.stringify({ haptics: true }) } });
	const mOn = (await debug(M2.page)).prefs.level;
	await M2.page.context().close();
	h.check(mOff === 'off' && mOn === 'light', '7.1 Haptic tick off -> Off, on -> Light (' + mOff + ', ' + mOn + ')');

	console.log('\n=== 8. reduced motion ===');
	const R = await h.setupPage(browser, 'R', { context: { ...PHONE, reducedMotion: 'reduce' }, init: motorInit });
	const rLevel = (await debug(R.page)).prefs.level;
	h.check(rLevel === 'off', '8.1 the OS asks for reduced motion: Off by default (' + rLevel + ')');
	await R.page.context().close();

	console.log('\n=== 9. a browser that cannot vibrate ===');
	const I = await h.setupPage(browser, 'I', { context: PHONE, init: [motorInit[0], { none: true }] });
	await openTouchSettings(I.page);
	const ios = await I.page.evaluate(() => ({
		reason: document.querySelector('#row-touch-feedback')?.textContent ?? '',
		controls: !!document.querySelector('#touch-feedback-level')
	}));
	h.check(!ios.controls && /cannot vibrate/.test(ios.reason), '9.1 no controls, one line saying why (' + ios.reason.trim().slice(0, 80) + ')');
	await I.page.context().close();

	console.log('\n=== 10. feature unused = zero change ===');
	await page.locator('#touch-feedback-level-off').tap();
	await page.waitForTimeout(200);
	await vib(page);
	await page.locator('#touch-feedback-level-light').tap(); // a level tap fires at the level it LEAVES: Off = nothing
	await page.waitForTimeout(150);
	await page.locator('#touch-feedback-level-off').tap();
	await page.waitForTimeout(150);
	await touchDrag(page, cdp, '#touch-feedback-try', 0, 1.1, 20, 800);
	const zero = await vib(page);
	h.check(zero.length <= 1, '10.1 Off: a drag reaches no motor; the only pulse is the tap made while it was Light (' + zero.length + ')');
	await page.context().close();
	await browser.close();
});
