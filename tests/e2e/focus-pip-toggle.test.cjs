// 44 M15 — "Window Focus mode: 'Exit Focus' button should also have nearby open/close viewport preview button (so
// when I close it I can reopen without exiting focus mode), also it should remember the state next time I enter
// focus mode (now it each time shows preview even if closed, also it should be enabled by default as now)".
//   1  a fresh profile: maximize -> the PiP is up (default open) and a "Viewport" toggle sits beside "Exit focus"
//      (same row, left of it, a few px apart), pressed
//   2  the toggle hides the PiP and back, focus mode never left; the PiP's own x leaves the toggle reading OFF
//   3  remembered: closed, Esc, maximize again -> still closed (toggle OFF); open, Esc, maximize -> open
//   4  the toggle shows only while the PiP COULD show: a maximized dock resized down (real viewport on screen)
//      hides it, back to full brings it back
//   5  unfolded N6 (real taps): the tab menu's Maximize, the toggle in reach, a tap hides / shows the PiP
// Counterfactual: on origin/feat/43-int there is no toggle (1 red) and a closed PiP reopens on the next
// maximize (3 red).
const h = require('./helpers.cjs');
const THEME = process.env.THEME || 'dark';
const OUT = process.env.OUT || null;
const S = (page, fn, arg) => page.evaluate(fn, arg);

const look = (page) =>
	S(page, () => {
		const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) } : null; };
		const t = document.getElementById('focus-pip-toggle');
		const exit = [...document.querySelectorAll('#focus-exit button')].find((b) => /Exit focus/.test(b.textContent || ''));
		return {
			focus: document.documentElement.getAttribute('data-focus'),
			pip: !!document.getElementById('viewport-pip'),
			toggle: box(t),
			pressed: t ? t.getAttribute('aria-pressed') : null,
			exit: box(exit),
			stored: localStorage.getItem('viewportPip:closed')
		};
	});

async function maximize(page) {
	const d = await S(page, () => {
		const el = [...document.querySelectorAll('.tp-dock-panel')].find((x) => !x.classList.contains('hidden') && x.getBoundingClientRect().height > 0);
		const r = el && el.getBoundingClientRect();
		return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
	});
	if (!d) return false;
	await page.mouse.move(d.x, d.y);
	await page.keyboard.press('Control+Space');
	await page.waitForTimeout(1100);
	return true;
}

async function dockCode(page) {
	await S(page, async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		await new Promise((r) => setTimeout(r, 400));
		s.objectActions.deselectObject();
		s.timelineClose.set(false);
		await new Promise((r) => setTimeout(r, 700));
		s.bottomDock.activateDock('timeline');
	});
	await page.waitForTimeout(1200);
}

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'D', {
		context: { viewport: { width: 1440, height: 900 } },
		storage: { timelineDocked: 'true', flowDockHeight: '300', theme: THEME }
	});
	const page = P.page;
	await dockCode(page);

	// ---- 1. default open, the toggle beside "Exit focus" -------------------------------------------
	h.check((await look(page)).stored === null, '1.0 premise: a fresh profile has no stored preview state');
	h.check(await maximize(page), '1.1 premise: the docked Code window is there to maximize');
	let st = await look(page);
	if (OUT) await page.screenshot({ path: `${OUT}/m15-focus-toggle-on-${THEME}.png` });
	h.check(st.focus === 'dock' && st.pip, `1.2 maximized: the viewport preview is up by default (${st.focus}, pip ${st.pip})`);
	h.check(!!st.toggle && st.pressed === 'true', `1.3 a "Viewport" toggle is there, pressed (${JSON.stringify(st.toggle)}, aria-pressed ${st.pressed})`);
	const beside = st.toggle && st.exit && Math.abs((st.toggle.t + st.toggle.b) / 2 - (st.exit.t + st.exit.b) / 2) <= 2 && st.toggle.r <= st.exit.l && st.exit.l - st.toggle.r <= 12;
	h.check(!!beside, `1.4 …beside "Exit focus": same row, just left of it (toggle ${JSON.stringify(st.toggle)}, exit ${JSON.stringify(st.exit)})`);

	// ---- 2. hide / show without leaving focus mode -------------------------------------------------
	await page.click('#focus-pip-toggle');
	await page.waitForTimeout(400);
	st = await look(page);
	if (OUT) await page.screenshot({ path: `${OUT}/m15-focus-toggle-off-${THEME}.png` });
	h.check(st.focus === 'dock' && !st.pip && st.pressed === 'false', `2.1 a click hides the preview, focus mode stays (${st.focus}, pip ${st.pip}, pressed ${st.pressed})`);
	await page.click('#focus-pip-toggle');
	await page.waitForTimeout(400);
	st = await look(page);
	h.check(st.focus === 'dock' && st.pip && st.pressed === 'true', `2.2 …and a second click brings it back (pip ${st.pip}, pressed ${st.pressed})`);
	await page.click('#viewport-pip .pip-close');
	await page.waitForTimeout(400);
	st = await look(page);
	h.check(!st.pip && st.pressed === 'false', `2.3 the preview's own × closes it and the toggle reads OFF (pressed ${st.pressed})`);

	// ---- 3. remembered across focus sessions -------------------------------------------------------
	await page.keyboard.press('Escape');
	await page.waitForTimeout(900);
	st = await look(page);
	h.check(!st.focus && !st.toggle && st.stored === 'true', `3.1 Esc leaves focus mode; the toggle goes with it; "closed" is stored (${st.focus}, ${st.stored})`);
	await maximize(page);
	st = await look(page);
	h.check(st.focus === 'dock' && !st.pip && st.pressed === 'false', `3.2 the next maximize REMEMBERS it closed (pip ${st.pip}, pressed ${st.pressed})`);
	await page.click('#focus-pip-toggle');
	await page.waitForTimeout(400);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(900);
	h.check((await look(page)).stored === null, '3.3 opened again, the stored state goes back to the default (open)');
	await maximize(page);
	st = await look(page);
	h.check(st.focus === 'dock' && st.pip && st.pressed === 'true', `3.4 …and the next maximize shows it (pip ${st.pip})`);

	// ---- 4. the toggle only while the preview COULD show -------------------------------------------
	await S(page, () => window.__stores.bottomDock.dockHeight.set(420));
	await page.waitForTimeout(500);
	st = await look(page);
	h.check(st.focus === 'dock' && !st.pip && !st.toggle, `4.1 resized DOWN (the real viewport on screen): no preview and no toggle (${JSON.stringify(st.toggle)})`);
	await S(page, () => window.__stores.bottomDock.dockHeight.set(window.__stores.focusMode.fullDockHeight()));
	await page.waitForTimeout(500);
	st = await look(page);
	h.check(st.pip && !!st.toggle, `4.2 back to full: the preview and its toggle are back (${st.pip})`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(700);
	h.check(h.pageErrors(P).length === 0, `no page errors (${h.pageErrors(P).join(' / ')})`);
	await P.ctx.close();

	// ---- 5. unfolded N6, real taps -----------------------------------------------------------------
	const U = await h.setupPage(browser, 'U', {
		context: { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
		storage: { timelineDocked: 'true', flowDockHeight: '300', theme: THEME, toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const up = U.page;
	await dockCode(up);
	await S(up, () => window.__stores.focusMode.maximizeDockTab('timeline'));
	await up.waitForTimeout(1200);
	st = await look(up);
	h.check(st.focus === 'dock' && st.pip && !!st.toggle, `5.1 unfolded: Maximize shows the preview and the toggle (${JSON.stringify(st.toggle)})`);
	await up.locator('#focus-pip-toggle').tap();
	await up.waitForTimeout(400);
	st = await look(up);
	if (OUT) await up.screenshot({ path: `${OUT}/m15-unfolded-toggle-off-${THEME}.png` });
	h.check(!st.pip && st.pressed === 'false', `5.2 a tap hides it (pip ${st.pip})`);
	await up.locator('#focus-pip-toggle').tap();
	await up.waitForTimeout(400);
	st = await look(up);
	h.check(st.pip && st.pressed === 'true', `5.3 a second tap shows it (pip ${st.pip})`);
	h.check(h.pageErrors(U).length === 0, `5.4 no page errors (${h.pageErrors(U).join(' / ')})`);
	await h.finish(browser);
});
