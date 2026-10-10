// 40 F1 + F2 — EVERY PHONE SHEET IS ONE SHEET. On a 390x844 touch phone, driven by REAL touch
// events (CDP Input.dispatchTouchEvent: the browser turns them into pointer events with
// pointerType "touch", the path a finger takes):
//
//   F1  every drawer (main menu, notifications, Configure Scene, Add — also with an object
//       selected —, Inspector, Objects, Explorer (the dock), More, profile menu, notes, Customize
//       character) RESIZES from its grab bar and CLOSES when swiped down to the end;
//       the grab bar is STICKY (scrolling the Inspector never takes it away);
//       a sheet's height is REMEMBERED across close/reopen;
//       NO sheet covers Play or the selection strip (cover-play-and-handle), and the strip
//       never goes under the top bar;
//   F2  Customize character and Profile settings open from a TAP in the profile menu (the menu
//       inherited `pointer-events: none` from the corner chrome — counterfactual below).
// Then a DESKTOP page (1440x900, mouse) proves no phone grab bar leaks there.
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;

/** @param {import('playwright').Page} page */
async function touchApi(page) {
	const cdp = await page.context().newCDPSession(page);
	const drag = async (/** @type {number} */ x, /** @type {number} */ y0, /** @type {number} */ y1, steps = 12, stepMs = 16) => {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }] });
		for (let i = 1; i <= steps; i++) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / steps, id: 1 }] });
			await new Promise((r) => setTimeout(r, stepMs));
		}
		await new Promise((r) => setTimeout(r, 120)); // a slow release, not a flick
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	};
	const tap = async (/** @type {number} */ x, /** @type {number} */ y) => {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	};
	return { drag, tap };
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'phone', {
		context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const P = A.page;
	const touch = await touchApi(P);
	const read = (expr) => P.evaluate(expr);
	const rect = (sel) => P.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width || r.height ? { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom } : null; }, sel);
	const rest = async () => {
		await P.evaluate(() => {
			const s = window.__stores;
			s.phoneShell.phoneSheet.set(null);
			s.viewportMenu.set(null);
			s.objectListClose.set(true);
			s.notificationCenterOpen.set(false);
			s.notesDrawerOpen.set(false);
			s.inspectorClose.set(true);
			s.closeMenu.set(true);
			s.explorerClose.set(true);
			s.characterModalOpen.set(false);
			s.profileSettingsOpen.set(false);
			s.selectedObjects.set([]);
			// a toast (the phone quality notice) sits over the top of a tall sheet: not what is tested
			s.toastStore.set([]);
		});
		await P.waitForTimeout(500);
	};
	await P.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await P.waitForTimeout(800);
	const select = async () => {
		await P.evaluate(() => {
			const s = window.__stores;
			let g; s.objectsGroup.subscribe((v) => (g = v))();
			s.objectActions.applySelectionSet([g.children[0].uuid]);
		});
		await P.waitForTimeout(500);
	};
	const shell = await read(() => document.documentElement.classList.contains('phone-shell'));
	h.check(shell, 'the phone shell is mounted at 390x844');

	/** what a finger at the top of the raised Play circle hits — never a sheet */
	const playClear = () =>
		P.evaluate(() => {
			const live = document.querySelector('#ps-play .ps-live');
			if (!live) return 'no play';
			const r = live.getBoundingClientRect();
			const at = document.elementFromPoint(r.left + r.width / 2, r.top + 4);
			return at && document.getElementById('ps-play')?.contains(at) ? 'ok' : (at?.id || at?.className || 'nothing').toString().slice(0, 60);
		});
	/** the selection strip is fully below the top bar and nothing covers its centre */
	const stripClear = () =>
		P.evaluate(() => {
			const s = document.getElementById('ps-strip');
			if (!s) return 'no strip';
			const r = s.getBoundingClientRect();
			if (r.top < 56) return 'under the top bar (top ' + Math.round(r.top) + ')';
			const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			return at && s.contains(at) ? 'ok' : 'covered by ' + (at?.id || at?.className || 'nothing').toString().slice(0, 60);
		});

	// ---- the sheets ------------------------------------------------------------------
	/** [name, open(), sheet selector (height), grip selector, isOpen expr] */
	const SHEETS = [
		['main menu', async () => touch.tap(34, 34), '#sidebar70', '#sidebar70 [data-sheet-grip]', `!!document.querySelector('#sidebar70')`],
		['notifications', async () => P.evaluate(() => window.__stores.notificationCenterOpen.set(true)), '.ps-sheet', '#ps-sheet-handle', store('notificationCenterOpen')],
		['Configure Scene', async () => P.evaluate(() => window.__stores.showSidebar('scene')), '#inspector', '#inspector [data-sheet-grip]', `!${store('inspectorClose')}`],
		['Add', async () => { const b = await rect('#ps-add'); await touch.tap(b.x + b.w / 2, b.y + b.h / 2); }, '.ctx-scroll[role=menu]', '.ctx-scroll[role=menu] [data-sheet-grip]', `!!document.querySelector('.ctx-scroll[role=menu]')`],
		['Add with an object selected', async () => { await select(); const b = await rect('#ps-add'); await touch.tap(b.x + b.w / 2, b.y + b.h / 2); }, '.ctx-scroll[role=menu]', '.ctx-scroll[role=menu] [data-sheet-grip]', `!!document.querySelector('.ctx-scroll[role=menu]')`, true],
		['Inspector', async () => { await select(); const b = await rect('#ps-inspect'); await touch.tap(b.x + b.w / 2, b.y + b.h / 2); }, '#inspector', '#inspector [data-sheet-grip]', `!${store('inspectorClose')}`, true],
		['Objects', async () => { await select(); await P.evaluate(() => window.__stores.objectListClose.set(false)); }, '.ps-sheet', '#ps-sheet-handle', `!${store('objectListClose')}`, true],
		['Explorer (the dock)', async () => { const b = await rect('#ps-explorer'); await touch.tap(b.x + b.w / 2, b.y + b.h / 2); }, '#explorer-list', '#ps-dock-grip [data-sheet-grip]', `!(${store('bottomDock.dockMinimized')}) && !(${store('explorerClose')})`],
		['More', async () => { const b = await rect('#ps-more'); await touch.tap(b.x + b.w / 2, b.y + b.h / 2); }, '.ps-sheet', '#ps-sheet-handle', `${store('phoneShell.phoneSheet')} === 'more'`],
		['profile menu', async () => P.locator('#avatar-trigger').dispatchEvent('mousedown'), '#avatar-dropdown', '#avatar-dropdown [data-sheet-grip]', `!!document.querySelector('#avatar-dropdown')`],
		['scene notes', async () => P.evaluate(() => window.__stores.notesDrawerOpen.set(true)), '#notes-drawer', '#notes-drawer [data-sheet-grip]', store('notesDrawerOpen')],
		['Customize character', async () => P.evaluate(() => window.__stores.characterModalOpen.set(true)), '.cp', '#character-resize', store('characterModalOpen')]
	];

	for (const [name, open, sheetSel, gripSel, isOpen, withSel] of SHEETS) {
		await rest();
		await open();
		await P.waitForTimeout(900);
		h.check(await read(isOpen), `${name}: opens`);
		const g = await rect(gripSel);
		const s0 = await rect(sheetSel);
		h.check(!!g && !!s0, `${name}: has a grab bar (${JSON.stringify(g)})`);
		if (!g || !s0) continue;
		h.check(Math.abs(g.top - s0.top) < 30, `${name}: the grab bar sits at the sheet's top edge (grip ${Math.round(g.top)}, sheet ${Math.round(s0.top)})`);
		h.check((await playClear()) === 'ok', `${name}: Play is not covered (${await playClear()})`);
		if (withSel) h.check((await stripClear()) === 'ok', `${name}: the selection strip rides above it, under no top bar and no sheet (${await stripClear()})`);
		// RESIZE: drag the bar up 120 px (or down, when it already sits at its max)
		const gx = g.x + g.w / 2;
		const gy = g.y + g.h / 2;
		const atTop = s0.top < 160;
		await touch.drag(gx, gy, gy + (atTop ? 140 : -220)); // far enough to reach the next detent of a detent sheet
		await P.waitForTimeout(500);
		const s1 = await rect(sheetSel);
		const grew = s1 ? s1.h - s0.h : 0;
		h.check(!!s1 && (atTop ? grew < -40 : grew > 40), `${name}: resizes from its grab bar (${Math.round(s0.h)} -> ${Math.round(s1?.h ?? 0)})`);
		if (withSel) h.check((await stripClear()) === 'ok', `${name}: after resizing, the strip is still clear (${await stripClear()})`);
		h.check((await playClear()) === 'ok', `${name}: after resizing, Play is still clear`);
		// CLOSE: swipe the bar down to the end
		const g2 = await rect(gripSel);
		if (!g2) { h.check(false, `${name}: grab bar still there after resizing`); continue; }
		await touch.drag(g2.x + g2.w / 2, g2.y + g2.h / 2, 838, 16);
		await P.waitForTimeout(700);
		h.check(!(await read(isOpen)), `${name}: closes when swiped down to the end`);
	}

	// ---- the grab bar is STICKY: scrolling the Inspector never takes it away ---------------
	await rest();
	await P.evaluate(() => window.__stores.showSidebar('scene'));
	await P.waitForTimeout(900);
	const sticky = await P.evaluate(async () => {
		const ins = document.getElementById('inspector');
		const grip = ins?.querySelector('[data-sheet-grip]');
		if (!ins || !grip) return null;
		ins.scrollTop = 600;
		await new Promise((r) => setTimeout(r, 200));
		const ir = ins.getBoundingClientRect();
		const gr = grip.getBoundingClientRect();
		const at = document.elementFromPoint(gr.left + gr.width / 2, gr.top + gr.height / 2);
		return { scrolled: ins.scrollTop, gripTop: gr.top, insTop: ir.top, hit: !!at && grip.contains(at) };
	});
	h.check(!!sticky && sticky.scrolled > 100, `premise: Configure Scene scrolls (${JSON.stringify(sticky)})`);
	h.check(!!sticky && Math.abs(sticky.gripTop - sticky.insTop) < 4 && sticky.hit, `the grab bar stays at the top of a scrolled sheet and takes the finger (${JSON.stringify(sticky)})`);

	// ---- a sheet's height is REMEMBERED --------------------------------------------------
	const g0 = await rect('#inspector [data-sheet-grip]');
	await touch.drag(g0.x + g0.w / 2, g0.y + g0.h / 2, g0.y + g0.h / 2 + 90);
	await P.waitForTimeout(500);
	const hBefore = (await rect('#inspector')).h;
	await rest();
	await P.evaluate(() => window.__stores.showSidebar('scene'));
	await P.waitForTimeout(900);
	const hAfter = (await rect('#inspector')).h;
	h.check(Math.abs(hAfter - hBefore) < 3, `Configure Scene reopens at the height it was left at (${Math.round(hBefore)} -> ${Math.round(hAfter)})`);
	const saved = await read(() => localStorage.getItem('inspectorSheetH'));
	h.check(Math.abs(Number(saved) - hBefore) < 3, `...under its own storage key (inspectorSheetH=${saved})`);

	// ---- the max leaves the strip clear (the reported cover-play-and-handle) -------------
	await rest();
	await select();
	const add = await rect('#ps-add');
	await touch.tap(add.x + add.w / 2, add.y + add.h / 2);
	await P.waitForTimeout(800);
	const ga = await rect('.ctx-scroll[role=menu] [data-sheet-grip]');
	await touch.drag(ga.x + ga.w / 2, ga.y + ga.h / 2, 60); // all the way up
	await P.waitForTimeout(500);
	const top = await rect('.ctx-scroll[role=menu]');
	h.check((await stripClear()) === 'ok', `Add dragged all the way up: the strip stays below the top bar and uncovered (${await stripClear()}; sheet top ${Math.round(top?.top ?? 0)})`);
	h.check((await playClear()) === 'ok', 'Add dragged all the way up: Play is not covered');

	// ---- F2: the profile menu's rows answer a tap -----------------------------------------
	for (const [label, st] of [['Customize character', 'characterModalOpen'], ['Profile settings', 'profileSettingsOpen']]) {
		await rest();
		await P.locator('#avatar-trigger').dispatchEvent('mousedown');
		await P.waitForTimeout(600);
		const r = await P.locator('#avatar-dropdown').getByText(label).first().boundingBox();
		const hit = await P.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#avatar-dropdown'), [r.x + r.width / 2, r.y + r.height / 2]);
		h.check(hit, `F2: a finger on "${label}" lands on the profile menu, not the canvas`);
		await touch.tap(r.x + r.width / 2, r.y + r.height / 2);
		await P.waitForTimeout(900);
		h.check(await read(store(st)), `F2: tapping "${label}" opens it`);
	}
	// counterfactual: the inherited pointer-events the fix overrides IS what ate the taps
	await rest();
	await P.locator('#avatar-trigger').dispatchEvent('mousedown');
	await P.waitForTimeout(600);
	const cf = await P.evaluate(() => {
		const d = document.getElementById('avatar-dropdown');
		if (!d) return null;
		d.style.setProperty('pointer-events', 'inherit', 'important');
		const row = [...d.querySelectorAll('button, [role=button]')].find((b) => /Customize/.test(b.textContent || ''));
		const r = row?.getBoundingClientRect();
		const at = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
		d.style.removeProperty('pointer-events');
		return at ? !d.contains(at) : null;
	});
	h.check(cf === true, `counterfactual: with the corner's inherited pointer-events the row is NOT hit (${cf})`);
	await rest();

	// ---- desktop: no phone grab bar leaks -------------------------------------------------
	const D = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 1440, height: 900 } } });
	await D.page.evaluate(() => window.__stores.showSidebar('scene'));
	await D.page.waitForTimeout(900);
	const desk = await D.page.evaluate(() => ({
		insGrip: (() => { const g = document.querySelector('#inspector .ins-resize'); return g ? getComputedStyle(g).display : 'none'; })(),
		shell: document.documentElement.classList.contains('phone-shell')
	}));
	h.check(!desk.shell && desk.insGrip === 'none', `desktop: no phone shell, the Inspector side drawer shows no grab bar (${JSON.stringify(desk)})`);
	await D.page.locator('#logo-menu').click();
	await D.page.waitForTimeout(500);
	h.check((await D.page.locator('#sidebar70 [data-sheet-grip]').count()) === 0, 'desktop: the main menu stays a dropdown (no grab bar)');

	await h.finish(browser);
});
