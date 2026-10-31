// 53-scale — A1 UI scale (90-150 %) + A5 reduced motion (Follow system / Reduce / Full).
//   A1: Settings ▸ Accessibility ▸ UI scale, picked through the real select, scales the chrome (the Controls pill,
//       the root font) by exactly the factor; the 3D canvas's drawing buffer does NOT change; the default sidebar
//       column follows (480 px at 150 %), a stored column width is rescaled when the scale changes, the choice
//       survives a reload and is on <html> before the app boots (app.html); nothing it opens leaves the screen on
//       desktop 1280x720 or the Oppo N6 folded (390x896) — the phone shell's bar follows too.
//   A5: data-motion follows the OS by default; "Full" beats a reduced-motion OS (a component's own
//       `@media (prefers-reduced-motion)` rule stands down — the build transform re-keyed it) and "Reduce" works on
//       an OS that is not; CSS motion goes instant and the camera fly-to lands in one frame.
// Counterfactual (v1.39.0): no #ui-scale / #motion rows, no data-motion, a media-query-only reduced motion — red.
//   fix-batch-1 #23: at 150 % on the folded N6 the Settings / Inspector / object list headers are one row.
const h = require('./helpers.cjs');

/** @param {any} page */
const html = (page) =>
	page.evaluate(() => {
		const r = document.documentElement;
		return { scale: r.style.getPropertyValue('--ui-scale'), font: parseFloat(getComputedStyle(r).fontSize), motion: r.dataset.motion };
	});
/** @param {any} page @param {string} sel */
const box = (page, sel) =>
	page.evaluate((s) => {
		const el = [...document.querySelectorAll(s)].find((e) => /** @type {HTMLElement} */ (e).offsetParent || getComputedStyle(e).position === 'fixed');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
	}, sel);
/** @param {any} page @param {string} key */
async function openSettings(page, key) {
	await page.evaluate((k) => {
		const s = /** @type {any} */ (window).__stores;
		s.settingsOpen.set(false);
		s.settingsSection.set(k);
		s.settingsOpen.set(true);
	}, key);
	await page.waitForSelector('dialog.settings-dialog .ss-page', { timeout: 15000 });
	await page.waitForTimeout(300);
}
/** @param {any} page */
const closeAll = (page) =>
	page.evaluate(() => {
		const s = /** @type {any} */ (window).__stores;
		s.settingsOpen.set(false);
		s.inspectorClose.set(true);
	});
/** inside the viewport (1 px of rounding) @param {any} b @param {{width: number, height: number}} vp */
const inside = (b, vp) => !!b && b.x >= -1 && b.y >= -1 && b.right <= vp.width + 1 && b.bottom <= vp.height + 1;

h.run(async () => {
	let browser = await h.launch();
	const VP = { width: 1280, height: 720 };
	const P = await h.setupPage(browser, 'desktop', { context: { viewport: VP, reducedMotion: 'no-preference' } });
	const page = P.page;
	await h.answerRestore(P).catch(() => {});

	// ---- A1: the default is untouched --------------------------------------------------------------------------
	const d0 = await html(page);
	h.check(d0.scale === '' && d0.font === 16, `100 %: no --ui-scale on <html>, a 16 px root (${JSON.stringify(d0)})`);
	const pill0 = await box(page, '#controls-pill');
	const canvas0 = await page.evaluate(() => {
		const el = /** @type {HTMLCanvasElement} */ (document.querySelector('.viewport canvas') || document.querySelector('canvas'));
		return { bw: el.width, bh: el.height, cw: el.clientWidth, ch: el.clientHeight };
	});
	h.check(!!pill0 && pill0.h > 20, `the Controls pill measured at 100 % (${JSON.stringify(pill0)})`);

	// ---- A1: pick 150 % through the real select ----------------------------------------------------------------
	await openSettings(page, 'accessibility');
	h.check((await page.locator('#row-ui-scale').count()) === 1 && (await page.locator('#row-motion').count()) === 1, 'Settings ▸ Accessibility has the UI scale and Motion rows');
	await page.click('#ui-scale');
	await page.getByRole('option', { name: /^150 %/ }).click();
	await page.waitForTimeout(500);
	const d150 = await html(page);
	h.check(d150.scale === '1.5' && Math.abs(d150.font - 24) < 0.01, `150 %: --ui-scale 1.5, a 24 px root (${JSON.stringify(d150)})`);
	h.check((await page.evaluate(() => localStorage.getItem('ui:scale'))) === '150', 'the choice is saved on this device (ui:scale = 150)');
	const dlg = await box(page, 'dialog.settings-dialog');
	h.check(inside(dlg, VP), `150 %: the Settings window stays on the 1280x720 screen (${JSON.stringify(dlg)})`);
	await closeAll(page);
	await page.waitForTimeout(400);
	const pill150 = await box(page, '#controls-pill');
	h.check(!!pill0 && !!pill150 && Math.abs(pill150.h - pill0.h * 1.5) <= 2, `the Controls pill is 1.5x as tall (${pill0?.h} -> ${pill150?.h})`);
	h.check(!!pill150 && inside(pill150, VP), `…and on screen (${JSON.stringify(pill150)})`);
	const canvas150 = await page.evaluate(() => {
		const el = /** @type {HTMLCanvasElement} */ (document.querySelector('.viewport canvas') || document.querySelector('canvas'));
		return { bw: el.width, bh: el.height, cw: el.clientWidth, ch: el.clientHeight };
	});
	h.check(JSON.stringify(canvas150) === JSON.stringify(canvas0), `the 3D canvas is NOT scaled: same drawing buffer and box (${JSON.stringify(canvas0)} / ${JSON.stringify(canvas150)})`);

	// the default sidebar column follows the scale; the Inspector stays on screen with its segmented rows inside it
	await page.evaluate(() => {
		const s = /** @type {any} */ (window).__stores;
		s.inspectorKind?.set?.('scene');
		s.inspectorClose.set(false);
	});
	await page.waitForTimeout(800);
	const colW = await page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--sb-right-w')));
	h.check(Math.abs(colW - 480) <= 1, `150 %: the default sidebar column is 480 px (320 × 1.5) — got ${colW}`);
	const spill = await page.evaluate(() =>
		[...document.querySelectorAll('#inspector .seg, #inspector [role="radiogroup"]')]
			.filter((g) => /** @type {HTMLElement} */ (g).offsetParent)
			.filter((g) => [...g.children].some((c) => c.scrollWidth > c.clientWidth + 1))
			.map((g) => g.textContent?.trim().slice(0, 40))
	);
	h.check(spill.length === 0, `150 %: no segmented option in the Inspector spills its label (${JSON.stringify(spill)})`);
	await closeAll(page);

	// a stored column width is rescaled with the scale (150 -> 100: 600 -> 400)
	await page.evaluate(() => localStorage.setItem('sidebarWidth:right', '600'));
	await openSettings(page, 'accessibility');
	await page.click('#ui-scale');
	await page.getByRole('option', { name: /^100 %/ }).click();
	await closeAll(page);
	await page.waitForTimeout(400);
	const stored = await page.evaluate(() => localStorage.getItem('sidebarWidth:right'));
	const d100 = await html(page);
	h.check(d100.scale === '' && stored === '400', `back to 100 %: the property is gone and a stored 600 px column became 400 (${stored}, ${JSON.stringify(d100)})`);
	const pillBack = await box(page, '#controls-pill');
	h.check(!!pillBack && !!pill0 && Math.abs(pillBack.h - pill0.h) <= 1, `…and the Controls pill is back to its 100 % height (${pillBack?.h})`);

	// 90 %
	await openSettings(page, 'accessibility');
	await page.click('#ui-scale');
	await page.getByRole('option', { name: /^90 %/ }).click();
	await closeAll(page);
	await page.waitForTimeout(400);
	const pill90 = await box(page, '#controls-pill');
	h.check(!!pill90 && !!pill0 && Math.abs(pill90.h - pill0.h * 0.9) <= 2, `90 %: the Controls pill is 0.9x as tall (${pill90?.h})`);

	// the saved scale is on <html> before the app runs (app.html), so a reload never flashes 100 %
	await page.evaluate(() => localStorage.setItem('ui:scale', '130'));
	await page.reload({ waitUntil: 'commit' });
	const early = await page.waitForFunction(() => document.documentElement && document.readyState !== 'loading' && document.documentElement.style.getPropertyValue('--ui-scale'), null, { timeout: 30000 }).then((v) => v.jsonValue(), () => '');
	h.check(early === '1.3', `a reload applies the saved 130 % from app.html (${early})`);
	await page.waitForFunction(() => /** @type {any} */ (window).__stores?.settingsOpen, null, { timeout: 90000 });
	await page.waitForTimeout(1500);
	await h.answerRestore(P).catch(() => {});

	// ---- A5: reduced motion ------------------------------------------------------------------------------------
	/** a probe with a CSS transition + the Toggle knob's own transition (Settings ▸ Interface draws toggles) */
	const motion = () =>
		page.evaluate(() => {
			let p = document.getElementById('a11y-motion-probe');
			if (!p) {
				p = document.createElement('div');
				p.id = 'a11y-motion-probe';
				p.style.cssText = 'position:fixed;left:-50px;top:0;width:10px;height:10px;transition:opacity 300ms ease';
				document.body.appendChild(p);
			}
			const knob = document.querySelector('.tg-knob');
			const k = knob ? getComputedStyle(knob) : null;
			return { attr: document.documentElement.dataset.motion, probe: getComputedStyle(p).transitionDuration, knob: k ? k.transitionProperty + ' ' + k.transitionDuration : null };
		});
	await openSettings(page, 'interface');
	const m0 = await motion();
	h.check(m0.attr === 'full' && m0.probe === '0.3s' && /transform 0\.15s/.test(String(m0.knob)), `Follow system on a full-motion OS: data-motion=full, transitions run (${JSON.stringify(m0)})`);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.waitForTimeout(300);
	const m1 = await motion();
	h.check(m1.attr === 'reduce' && m1.probe === '0s' && /^none/.test(String(m1.knob)), `Follow system on a reduced-motion OS: data-motion=reduce, motion instant, the Toggle's own reduced rule applies (${JSON.stringify(m1)})`);
	await openSettings(page, 'accessibility');
	await page.locator('#motion').getByRole('radio', { name: 'Full' }).click().catch(async () => page.locator('#motion').getByText('Full', { exact: true }).click());
	await openSettings(page, 'interface');
	const m2 = await motion();
	h.check(m2.attr === 'full' && m2.probe === '0.3s' && /transform 0\.15s/.test(String(m2.knob)), `"Full" beats the reduced-motion OS — the component's @media rule stands down too (${JSON.stringify(m2)})`);
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await openSettings(page, 'accessibility');
	await page.locator('#motion').getByRole('radio', { name: 'Reduce' }).click().catch(async () => page.locator('#motion').getByText('Reduce', { exact: true }).click());
	await openSettings(page, 'interface');
	const m3 = await motion();
	h.check(m3.attr === 'reduce' && m3.probe === '0s' && /^none/.test(String(m3.knob)), `"Reduce" works on a full-motion OS (${JSON.stringify(m3)})`);
	h.check((await page.evaluate(() => localStorage.getItem('ui:motion'))) === 'reduce', 'the motion choice is saved on this device');
	await closeAll(page);

	// the camera fly-to: instant under Reduce, a tween under Full
	/** @param {number} waitMs */
	const fly = (waitMs) =>
		page.evaluate(async (ms) => {
			const s = /** @type {any} */ (window).__stores;
			const cam = s.globalCamera && (s.globalCamera.subscribe ? await new Promise((r) => s.globalCamera.subscribe(r)()) : s.globalCamera);
			const start = cam.position.toArray();
			const goal = [start[0] + 6, start[1] + 2, start[2] + 6];
			s.objectActions.flyTo(goal, [0, 0, 0], 3000);
			await new Promise((r) => setTimeout(r, ms));
			const now = cam.position.toArray();
			// the share of the way still to go (1 = has not moved, 0 = arrived)
			return Math.hypot(now[0] - goal[0], now[1] - goal[1], now[2] - goal[2]) / Math.hypot(6, 2, 6);
		}, waitMs);
	const dReduce = await fly(300);
	h.check(dReduce < 0.002, `Reduce: a 3 s flyTo lands at once (${(dReduce * 100).toFixed(1)} % of the way left after 300 ms)`);
	await openSettings(page, 'accessibility');
	await page.locator('#motion').getByRole('radio', { name: 'Follow system' }).click().catch(async () => page.locator('#motion').getByText('Follow system', { exact: true }).click());
	await closeAll(page);
	const dFull = await fly(300);
	h.check(dFull > 0.2, `Follow system (full motion): a 3 s flyTo is still on its way (${(dFull * 100).toFixed(1)} % left after 300 ms)`);
	// ---- A5 captions: the editor's switch draws the caption bus in Edit too ------------------------------------
	/** push a line the way a Timeline audio clip does, then read the overlay */
	const caption = (text) =>
		page.evaluate(async (t) => {
			const c = /** @type {any} */ (window).__stores.gameKit.captions;
			c.showCaption({ text: t, source: 'timeline', seconds: 4 });
			await new Promise((r) => setTimeout(r, 300));
			const el = document.getElementById('game-captions');
			// the overlay is position:fixed — offsetParent is null for it whatever it shows; measure the box
			const r = el?.getBoundingClientRect();
			return { shown: !!r && r.width > 0 && r.height > 0 && getComputedStyle(/** @type {Element} */ (el)).visibility !== 'hidden', text: el?.textContent?.trim() ?? '', src: el?.querySelector('[data-caption-source]')?.getAttribute('data-caption-source') ?? '' };
		}, text);
	const c0 = await caption('[door creaks]');
	h.check(!c0.shown, `captions off: a Timeline line is not drawn in the editor (${JSON.stringify(c0)})`);
	await openSettings(page, 'accessibility');
	await page.locator('#editor-captions').click();
	await closeAll(page);
	const c1 = await caption('[footsteps upstairs]');
	h.check(c1.shown && c1.text.includes('[footsteps upstairs]') && c1.src === 'timeline', `Show captions on: the line is drawn in Edit (${JSON.stringify(c1)})`);
	h.check((await page.evaluate(() => localStorage.getItem('ui:captions'))) === 'true', 'the captions switch is saved on this device');
	await openSettings(page, 'accessibility');
	await page.locator('#editor-captions').click();
	await closeAll(page);
	const c2 = await caption('[wind]');
	h.check(!c2.shown, `switched off again: nothing drawn (${JSON.stringify(c2)})`);

	h.check(h.pageErrors(P).length === 0, `desktop: no page errors (${JSON.stringify(h.pageErrors(P)).slice(0, 200)})`);
	await browser.close().catch(() => {});

	// ---- A1 on the Oppo N6 folded: the phone shell follows -----------------------------------------------------
	browser = await h.launch();
	const FOLD = { width: 390, height: 896 };
	const F = await h.setupPage(browser, 'folded', { context: { viewport: FOLD, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }, storage: { 'ui:scale': '150' } });
	await h.answerRestore(F).catch(() => {});
	const fp = F.page;
	await fp.waitForTimeout(1000);
	const bar = await box(fp, '.ps-bar');
	h.check(!!bar && bar.h >= 76 * 1.5 - 2 && inside(bar, FOLD), `folded 150 %: the phone bar is ${bar?.h} px tall (76 × 1.5) and on screen`);
	await openSettings(fp, 'accessibility');
	const fdlg = await box(fp, 'dialog.settings-dialog');
	const docW = await fp.evaluate(() => document.documentElement.scrollWidth);
	h.check(inside(fdlg, FOLD) && docW <= FOLD.width, `folded 150 %: Settings fits the screen, no sideways overflow (${JSON.stringify(fdlg)}, doc ${docW})`);

	// fix-batch-1 #23 (53-int Q4): the compact header — at 150 % on the folded N6 (a ~260 px layout) the
	// header stays ONE row with the ✕ on it: Settings' close used to sit on a second row, the Inspector's
	// header took three, the object list's two. One row = the header is its 48 px minimum (× 1.5) and the
	// ✕'s vertical centre is inside the title's/label's box. COUNTERFACTUAL (4cd3dafc): 136 px each.
	/** @param {string} root @param {string} titleSel */
	const head = (root, titleSel) =>
		fp.evaluate(
			([r, t]) => {
				const hd = [...document.querySelectorAll(`${r} .wc-head`)].find((e) => e.getBoundingClientRect().width > 0);
				if (!hd) return null;
				const b = hd.getBoundingClientRect();
				const title = hd.querySelector(t)?.getBoundingClientRect();
				const x = hd.querySelector('.wc-close')?.getBoundingClientRect();
				const mid = x ? x.top + x.height / 2 : -1;
				return { h: Math.round(b.height), w: Math.round(b.width), titleW: Math.round(title?.width ?? 0), sameRow: !!title && !!x && mid >= title.top && mid <= title.bottom, closeIn: !!x && x.right <= innerWidth + 1 };
			},
			[root, titleSel]
		);
	/** @param {string} what @param {any} r */
	const oneRow = (what, r) =>
		h.check(!!r && r.h <= 48 * 1.5 + 1 && r.sameRow && r.closeIn && r.titleW >= 40, `folded 150 %: the ${what} header is one row, ✕ beside the title, on screen (${JSON.stringify(r)})`);
	oneRow('Settings', await head('dialog.settings-dialog', '.wc-title'));
	await closeAll(fp);
	await fp.evaluate(() => {
		const s = /** @type {any} */ (window).__stores;
		s.inspectorKind?.set?.('scene');
		s.inspectorClose.set(false);
	});
	await fp.waitForSelector('#inspector', { state: 'visible', timeout: 15000 }).catch(() => {});
	await fp.waitForTimeout(500);
	oneRow('Inspector', await head('#inspector', '.wc-title'));
	await closeAll(fp);
	await fp.evaluate(() => /** @type {any} */ (window).__stores.objectListClose.set(false));
	await fp.waitForTimeout(900);
	oneRow('object list', await head('#object-list', '.wc-label'));
	await fp.evaluate(() => /** @type {any} */ (window).__stores.objectListClose.set(true));
	h.check(h.pageErrors(F).length === 0, `folded: no page errors (${JSON.stringify(h.pageErrors(F)).slice(0, 200)})`);
	await h.finish(browser);
});
