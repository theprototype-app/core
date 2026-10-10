// 40 F12 — "water refractions switch off/on by themselves on the phone" (the user's 1.31 review,
// refractions-off.jpg / refractions--on.jpg). Through the REAL wiring (qualityGovernor + the
// water runtime + AutoQualityNotice) on an emulated phone (390x844, touch) and a desktop
// (1440x900):
//   1. the phone's lighter start is announced once ("Lowered shadows, resolution and ambient
//      occlusion to keep it smooth");
//   2. Aquarium: a drop to "post off" turns the refraction off and says so ONCE ("Lowered water
//      quality … to keep it smooth · Keep full quality"); the one retry comes back, overloads, and
//      the level is then HELD — no more switching for the rest of a simulated 10 minutes;
//      the counterfactual (the lock cleared after every decision = the 1.31 rule) switches > 8x;
//      a scene load clears the lock;
//   3. a drop in Play is not announced until you leave Play; "Keep full quality" (a TAP) gives
//      full quality and the device stops lowering it; once per session;
//   4. desktop: the same rule for shadows.
// Frames are SYNTHETIC on a clock 1e9 ms ahead (governorForTest), so the page's own frames —
// on a real timeline far behind it — can neither step nor recover the level mid-test.
// OUT=<dir> writes the evidence screenshots (phone + desktop, dark + light).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const OUT = process.env.OUT || '';
const SC = [process.env.FBW_SCENES, path.resolve(__dirname, '../../../scenes-lane-39-int/examples'), path.resolve(__dirname, '../../../scenes/examples')]
	.filter(Boolean)
	.find((d) => fs.existsSync(path.join(/** @type {string} */ (d), 'aquarium', 'scene.tpscene')));
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; PKH110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36' };
const DESKTOP = { viewport: { width: 1440, height: 900 } };

/** @param {any} page @param {string} slug */
async function load(page, slug) {
	const bytes = Array.from(fs.readFileSync(path.join(/** @type {string} */ (SC), slug, 'scene.tpscene')));
	await page.evaluate(async (arr) => {
		const s = /** @type {any} */ (window).__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
}

/** install the synthetic driver and freeze the governor on the synthetic clock @param {any} page @param {number} level */
async function freeze(page, level) {
	await page.evaluate((lv) => {
		const w = /** @type {any} */ (window);
		w.__f12 = { t: 1e9 };
		w.__stores.qualityGovernor.governorForTest.setLevel(lv, w.__f12.t);
		w.__f12.t += 1000;
		/**
		 * frames at `slow` ms on every third frame while the level is below `cheapFrom` (the
		 * screen-space water pass), on time otherwise; a decision every 250 ms like the wiring.
		 * @param {number} dur @param {number} cheapFrom @param {{slow?: number, noLock?: boolean}} [o]
		 */
		w.__f12drive = (dur, cheapFrom, o = {}) => {
			const Q = w.__stores.qualityGovernor;
			const g = Q.governorForTest;
			const slow = o.slow ?? 33.3;
			/** @type {number[]} */ const moves = [];
			const end = w.__f12.t + dur;
			let next = w.__f12.t + 250;
			let i = 0;
			while (w.__f12.t < end) {
				const ms = g.level() >= cheapFrom ? 16.7 : i % 3 === 0 ? slow : 16.7;
				w.__f12.t += ms;
				i++;
				g.frame(ms, w.__f12.t);
				if (w.__f12.t >= next) {
					next = w.__f12.t + 250;
					const d = Q.decideNow(w.__f12.t);
					if (o.noLock) g.clearFlapLock();
					if (d.moved) moves.push(d.level);
				}
			}
			return { moves, level: g.level(), lock: g.flapLock() };
		};
	}, level);
}

/** @param {any} page */
const state = (page) =>
	page.evaluate(() => {
		const S = /** @type {any} */ (window).__stores;
		let q;
		S.qualityGovernor.qualityState.subscribe((/** @type {any} */ v) => (q = v))();
		return {
			level: q?.level,
			held: q?.held,
			reason: q?.reason,
			lock: S.qualityGovernor.qualityFlapLock(),
			water: S.waterRuntime.waterDebug?.()?.tier ?? null,
			toasts: [...document.querySelectorAll('.tp-toast-text')].map((e) => e.textContent?.trim() ?? '')
		};
	});

/** the water tier a level gives on auto (waterRuntime.resolveTier) */
const tierOf = (/** @type {number} */ lv) => (lv >= 6 ? 'quest' : lv >= 3 ? 'medium' : 'high');
/** refraction switches along a list of levels @param {number[]} levels @param {number} start */
function switches(levels, start) {
	let n = 0;
	let off = tierOf(start) === 'quest';
	for (const lv of levels) {
		const now = tierOf(lv) === 'quest';
		if (now !== off) n++;
		off = now;
	}
	return n;
}

/** @param {any} page @param {string} name */
async function shots(page, name) {
	if (!OUT) return;
	for (const t of ['dark', 'light']) {
		await page.evaluate((th) => /** @type {any} */ (window).__stores.themes.theme.set(th), t);
		await page.waitForTimeout(400);
		await page.screenshot({ path: path.join(OUT, `${name}-${t}.png`) });
	}
	await page.evaluate(() => /** @type {any} */ (window).__stores.themes.theme.set('dark'));
}

/** h.eventually, returning the state it accepted (null on timeout)
 * @param {() => Promise<any>} fn @param {(v: any) => boolean} pred @param {string} label @param {number} [timeout] */
async function until(fn, pred, label, timeout = 10000) {
	const t0 = Date.now();
	let last;
	while (Date.now() - t0 < timeout) {
		last = await fn();
		if (pred(last)) {
			h.check(true, label);
			return last;
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	console.log('  last: ' + JSON.stringify(last));
	h.check(false, label);
	return null;
}

/** @param {any} page @param {RegExp} re */
const toastLike = (page, re) => page.evaluate((src) => [...document.querySelectorAll('.tp-toast-text')].some((e) => new RegExp(src).test(e.textContent ?? '')), re.source);

h.run(async () => {
	if (OUT) fs.mkdirSync(OUT, { recursive: true });
	h.check(!!SC, `an Aquarium scene to load (${SC})`);
	const browser = await h.launch({ args: h.GPU_ARGS });

	// ── 1. the phone's lighter start, announced once ─────────────────────────────────────────────
	const A = await h.setupPage(browser, 'f12-phone', { context: PHONE });
	h.check(await A.page.evaluate(() => /** @type {any} */ (window).__stores.qualityGovernor.phoneQuality()), 'the app judges this device a phone');
	await until(() => state(A.page), (s) => s.toasts.some((t) => /^Lowered shadows, resolution and ambient occlusion to keep it smooth$/.test(t)), '1.1 the lighter start is announced: "Lowered shadows, resolution and ambient occlusion to keep it smooth"', 8000);
	h.check(await A.page.evaluate(() => [...document.querySelectorAll('.tp-toast-action')].some((b) => b.textContent?.trim() === 'Keep full quality')), '1.2 …with a "Keep full quality" action');
	h.check((await A.page.$('#simplified-water-notice')) === null, '1.3 the old "Simplified water" strip is gone (one notice for every toggle)');
	await freeze(A.page, 4);
	await A.page.evaluate(() => document.querySelectorAll('.tp-toast-x').forEach((b) => /** @type {HTMLElement} */ (b).click()));

	// ── 2. Aquarium: off, one retry, then held ───────────────────────────────────────────────────
	await load(A.page, 'aquarium');
	await A.page.waitForTimeout(2500);
	await A.page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__stores.qualityGovernor.governorForTest.setLevel(5, w.__f12.t);
		w.__f12.t += 1000;
	});
	await h.eventually(() => state(A.page), (s) => s.water === 'medium', '2.0 (premise) level 5: Aquarium refracts on the half-res screen-space tier', 8000);
	if (OUT) await A.page.screenshot({ path: path.join(OUT, '20-after-phone-aquarium-L5-refraction-on.png') });

	const drop = await A.page.evaluate(() => /** @type {any} */ (window).__f12drive(3000, 6));
	h.check(drop.level === 6 && drop.moves.join() === '6', `2.1 the screen-space pass overloads: 5 -> 6 (${drop.moves.join(',')})`);
	const off1 = await until(() => state(A.page), (s) => s.water === 'quest' && s.toasts.some((t) => /^Lowered water quality/.test(t)), '2.2 refraction OFF, and the toast says so', 8000);
	const waterToast = off1?.toasts.find((/** @type {string} */ t) => /^Lowered water quality/.test(t));
	h.check(waterToast === 'Lowered water quality and the scene look to keep it smooth', `2.3 the words ("${waterToast}")`);
	await shots(A.page, '21-after-phone-water-lowered-toast');

	const retry = await A.page.evaluate(() => /** @type {any} */ (window).__f12drive(10000, 6));
	h.check(retry.moves.join() === '5', `2.4 cheap frames at level 6: ONE retry back to 5 (${retry.moves.join(',')})`);
	await h.eventually(() => state(A.page), (s) => s.water === 'medium', '2.5 the retry brings the refraction back', 8000);
	const again = await A.page.evaluate(() => /** @type {any} */ (window).__f12drive(4000, 6));
	h.check(again.moves.join() === '6' && again.lock === 6, `2.6 the retry overloads again: 5 -> 6 and the level is LOCKED (lock ${again.lock})`);
	const held = await until(() => state(A.page), (s) => s.water === 'quest' && s.held === true, '2.7 refraction off, qualityState.held', 8000);
	h.check(!!held && held.toasts.filter((/** @type {string} */ t) => /^Lowered water quality/.test(t)).length <= 1, '2.8 no second water toast (once per session)');
	const ten = await A.page.evaluate(() => /** @type {any} */ (window).__f12drive(600000, 6));
	h.check(ten.moves.length === 0 && ten.level === 6, `2.9 ten more minutes of steady frames: no switch at all (moves ${ten.moves.join(',') || 'none'})`);
	const all = [...drop.moves, ...retry.moves, ...again.moves, ...ten.moves];
	h.check(switches(all, 5) === 3, `2.10 refraction switched ${switches(all, 5)} times in ~10.3 min: off, the one retry, off (was every 10-80 s)`);
	if (OUT) await A.page.screenshot({ path: path.join(OUT, '22-after-phone-aquarium-held-refraction-off.png') });

	// counterfactual: the 1.31 rule (no lock) on the same page and the same frames
	await A.page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__stores.qualityGovernor.governorForTest.clearFlapLock();
		w.__stores.qualityGovernor.governorForTest.setLevel(5, w.__f12.t);
		w.__f12.t += 1000;
	});
	const old = await A.page.evaluate(() => /** @type {any} */ (window).__f12drive(600000, 6, { noLock: true }));
	h.check(switches(old.moves, 5) > 8, `2.11 COUNTERFACTUAL — without the lock the refraction switches ${switches(old.moves, 5)} times in 10 min`);

	// a new scene clears the lock
	await A.page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__stores.qualityGovernor.governorForTest.setLevel(5, w.__f12.t);
		w.__f12.t += 1000;
	});
	await A.page.evaluate(() => /** @type {any} */ (window).__f12drive(20000, 6));
	h.check((await state(A.page)).lock === 6, '2.12 (premise) locked again');
	await load(A.page, 'aquarium');
	await h.eventually(() => state(A.page), (s) => s.lock === -1 && s.held === false, '2.12 a scene load clears the lock (new scene, new evidence)', 15000);
	await A.ctx.close();

	// ── 3. Play defers the notice; "Keep full quality" (a tap) ───────────────────────────────────
	const B = await h.setupPage(browser, 'f12-phone-keep', { context: PHONE });
	await freeze(B.page, 4);
	await load(B.page, 'aquarium');
	await B.page.waitForTimeout(2500);
	await B.page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__stores.qualityGovernor.governorForTest.setLevel(5, w.__f12.t);
		w.__f12.t += 1000;
		w.__stores.isLocked.set(true);
	});
	await B.page.evaluate(() => /** @type {any} */ (window).__f12drive(3000, 6));
	await B.page.waitForTimeout(1500);
	h.check(!(await toastLike(B.page, /^Lowered water quality/)), '3.1 a drop while playing is not announced in Play');
	await B.page.evaluate(() => /** @type {any} */ (window).__stores.isLocked.set(null));
	await h.eventually(() => toastLike(B.page, /^Lowered water quality/), (v) => v, '3.2 …it is, once you are back in the editor', 8000);
	if (OUT) await B.page.screenshot({ path: path.join(OUT, '23-after-phone-toast-before-tap.png') });
	const keep = B.page.locator('.tp-toast', { hasText: 'Lowered water quality' }).locator('.tp-toast-action', { hasText: 'Keep full quality' });
	await keep.tap();
	const kept = await until(() => state(B.page), (s) => s.level === 0 && s.water === 'high', '3.3 tapping "Keep full quality": full quality, the water refracts at full resolution', 8000);
	h.check(kept?.reason === 'kept full quality', `3.4 …recorded as kept (${kept?.reason})`);
	const after = await B.page.evaluate(() => /** @type {any} */ (window).__f12drive(60000, 99));
	h.check(after.moves.length === 0 && after.level === 0, `3.5 a minute of missed frames afterwards: it stays at full quality (moves ${after.moves.join(',') || 'none'})`);
	if (OUT) await B.page.screenshot({ path: path.join(OUT, '24-after-phone-kept-full-quality.png') });
	h.check((await h.pageErrors(B)).length === 0, '3.6 no page errors');
	await B.ctx.close();

	// ── 4. desktop: the same rule for every toggle (shadows) ─────────────────────────────────────
	const D = await h.setupPage(browser, 'f12-desktop', { context: DESKTOP });
	h.check(!(await D.page.evaluate(() => /** @type {any} */ (window).__stores.qualityGovernor.phoneQuality())), '4.0 (premise) a desktop');
	await freeze(D.page, 0);
	await load(D.page, 'aquarium');
	await D.page.waitForTimeout(2500);
	await D.page.evaluate(() => {
		// a heavy scene for the desktop budget (the governor only acts on one)
		/** @type {any} */ (window).__stores.sceneBudget.qualityBaseline.set({ objects: 0, triangles: 0, calls: 5000 });
	});
	const d1 = await D.page.evaluate(() => /** @type {any} */ (window).__f12drive(2500, 99, { slow: 60 }));
	h.check(d1.moves.join() === '1', `4.1 missed frames on a heavy scene: shadows off (${d1.moves.join(',')})`);
	await h.eventually(() => toastLike(D.page, /^Lowered shadows to keep it smooth$/), (v) => v, '4.2 "Lowered shadows to keep it smooth" · Keep full quality', 8000);
	await shots(D.page, '25-after-desktop-shadows-lowered-toast');
	h.check((await h.pageErrors(D)).length === 0, '4.3 no page errors');
	await h.finish(browser);
});
