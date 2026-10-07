// 38 R1 — THE PANEL LOCK (SPEC §0: "Panel open/close/pin, dock/float/split/tab behaviour,
// drag-to-dock"). The DEPTH of docking — split edges, tab drag, drag-to-dock, float
// exclusivity, the dock's own chrome — is already covered by the dock-* / flow-dock-* /
// docking / panel-* suites, and those are part of the lock (tests/e2e/lock.json). This suite
// adds the BREADTH a redesign touches everywhere at once:
//
//   1. every surface in lockSurfaces.cjs (windows, drawers, dock views, modals, menus, the
//      Settings sections) opens and shows its content, and closes through its OWN close
//      control and/or Escape — which of those work today is RECORDED and locked;
//   2. the Properties PIN: pinned, the panel follows the selection and falls back to the
//      scene with nothing selected; unpinned, deselecting closes it;
//   3. every toolbar cell (Controls) does what it does today — the side-effect fingerprint
//      of a press (stores, storage, dialogs) is RECORDED and locked, then pressed back;
//   4. every dock view survives float -> dock (dockMode) and a tab switch.
//
//   LOCK_RECORD=1 node tests/e2e/lock-panels.test.cjs   records fixtures/lock/panels.json
const h = require('./helpers.cjs');
const L = require('./lockHelpers.cjs');
const S = require('./lockSurfaces.cjs');

h.run(async () => {
	const browser = await L.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await L.installProbes(page);
	const ctx = await S.seedScene(page);

	const visible = (/** @type {string} */ sel) =>
		page.evaluate((sel) => [...document.querySelectorAll(sel)].some((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'), sel);

	// ---- 1. every surface: open / shown / close ---------------------------------------------
	/** @type {Record<string, any>} */
	const surfaces = {};
	for (const s of S.SURFACES) {
		if (s.name === 'main' || s.name === 'toasts') continue;
		await S.closeAll(page);
		await page.evaluate((u) => window.__stores.objectActions.selectObject(u), ctx.box);
		await s.open(page, ctx);
		await page.waitForTimeout(500);
		const shown = await visible(s.shown);
		const row = { shown, closer: null, escape: null };
		if (shown && s.closer) {
			await page.locator(s.closer).first().click({ timeout: 3000 }).catch(() => {});
			await page.waitForTimeout(350);
			row.closer = !(await visible(s.shown));
			if (!row.closer) await S.closeAll(page);
			await s.open(page, ctx);
			await page.waitForTimeout(400);
		}
		if (shown) {
			// Escape from inside the surface (focus a neutral element in it first)
			await page.evaluate((sel) => {
				const root = /** @type {any} */ ([...document.querySelectorAll(sel)].find((e) => e.getClientRects().length));
				const target = root?.closest('dialog, [role=dialog], [role=menu]') ?? root;
				if (target && !target.hasAttribute('tabindex') && target.tabIndex < 0) target.setAttribute('tabindex', '-1');
				target?.focus?.();
			}, s.shown);
			await page.keyboard.press('Escape');
			await page.waitForTimeout(350);
			row.escape = !(await visible(s.shown));
		}
		surfaces[s.name] = row;
		h.check(shown, `${s.name} opens and shows ${s.shown}`);
	}
	await S.closeAll(page);

	// ---- 2. the Properties pin ----------------------------------------------------------------------
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), ctx.box);
	await page.locator('#inspector-pin').waitFor({ state: 'visible', timeout: 8000 });
	const pinnedAt = async () => (await page.locator('#inspector-pin').getAttribute('aria-pressed')) === 'true';
	if (await pinnedAt()) await page.locator('#inspector-pin').click();
	h.check(!(await pinnedAt()), 'Properties starts unpinned');
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(400);
	h.check((await L.storeValue(page, 'inspectorClose')) === true, 'unpinned, deselecting closes the Properties panel');
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), ctx.box);
	await page.locator('#inspector-pin').click();
	await page.waitForTimeout(200);
	h.check(await pinnedAt(), 'the pin toggles on (aria-pressed)');
	h.check((await L.storeValue(page, 'inspectorPinned')) === true, 'and is the inspectorPinned setting');
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(400);
	h.check((await L.storeValue(page, 'inspectorClose')) === false && (await L.storeValue(page, 'inspectorKind')) === 'scene', 'pinned, deselecting keeps it open on the scene');
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u), ctx.sphere);
	await page.waitForTimeout(400);
	h.check((await L.storeValue(page, 'inspectorClose')) === false && (await L.storeValue(page, 'inspectorKind')) === 'selection', 'pinned, a plain selection shows that object (follows the selection)');
	await page.locator('#inspector-pin').click();
	await page.waitForTimeout(200);
	h.check(!(await pinnedAt()), 'and unpins');
	await S.closeAll(page);

	// ---- 3. the toolbar cells ----------------------------------------------------------------------
	const cells = await page.evaluate(() =>
		[...document.querySelectorAll('#controls-pill [title]')]
			// (not the bar's "…": it opens the Customize toolbar menu — the right-click menu's row —
			// and is no roster cell)
			.filter((e) => e.id !== 'play-button' && e.id !== 'toolbar-customize' && e.getClientRects().length)
			// cells are keyed by their tooltip (most carry no id); the title is also the
			// accessible name the redesign keeps (SPEC §5: icon buttons with tooltips)
			.map((e) => ({ id: e.getAttribute('title') || '', title: e.getAttribute('title') }))
	);
	h.check(cells.length >= 6, `the toolbar has its cells (${cells.map((c) => c.title).join(', ')})`);
	/** @type {Set<string>} */
	const noisy = new Set();
	await L.learnNoise(page, noisy, 800);
	/** @type {Record<string, any>} */
	const toolbar = {};
	// two passes, intersected: an effect that shows up once is noise, not the button
	for (let pass = 0; pass < 2; pass++)
	for (const cell of cells) {
		await page.evaluate((u) => window.__stores.objectActions.selectObject(u), ctx.box);
		await page.waitForTimeout(200);
		await L.learnNoise(page, noisy, 250);
		const before = await L.snap(page);
		await page.locator(`#controls-pill [title="${cell.title}"]`).click();
		await page.waitForTimeout(500);
		const after = await L.snap(page);
		const fx = L.effectsOf(before, after, [], noisy);
		// layout NUMBERS (dock insets, sizes) are the redesign's to change; what opened is not
		for (const k of Object.keys(fx.stores)) if (/inset|height|width|size|rect/i.test(k)) delete fx.stores[k];
		const row = { title: cell.title, stores: fx.stores, storage: Object.keys(fx.storage).sort(), dialogs: fx.dialogs };
		const prev = toolbar[cell.id];
		toolbar[cell.id] = !prev
			? row
			: {
					...row,
					stores: Object.fromEntries(Object.entries(row.stores).filter(([k, v]) => k in prev.stores).map(([k, v]) => [k, JSON.stringify(prev.stores[k]) === JSON.stringify(v) ? v : '<object>'])),
					storage: row.storage.filter((k) => prev.storage.includes(k)),
					dialogs: row.dialogs.filter((d) => prev.dialogs.includes(d))
				};
		// press it back where it is a toggle; otherwise put the world back
		await page.locator(`#controls-pill [title="${cell.title}"]`).click().catch(() => {});
		await page.waitForTimeout(300);
		await S.closeAll(page);
	}

	// ---- 4. every dock view: float -> dock, and a tab switch -----------------------------------------
	const DOCK_VIEWS = [['flow', 'flowGraphClose'], ['animation', 'animationClose'], ['uv', 'uvEditorClose'], ['shader', 'shaderEditorClose'], ['hud', 'hudEditorClose'], ['explorer', 'explorerClose']];
	for (const [key, closeStore] of DOCK_VIEWS) {
		await page.evaluate(({ key, closeStore }) => {
			const s = window.__stores;
			s[closeStore].set(false);
			s.bottomDock.dockMinimized?.set?.(false);
			s.bottomDock.activateDock(key);
		}, { key, closeStore });
		await page.waitForTimeout(400);
		const active = await L.storeValue(page, 'bottomDock.bottomDockActive');
		h.check(active === key, `${key}: opens as the active dock tab (${active})`);
	}
	const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-dock-tab], .dock-tab')].filter((e) => e.getClientRects().length).map((e) => e.getAttribute('data-dock-tab') || e.textContent?.trim()));
	h.check(tabs.length >= DOCK_VIEWS.length, `all ${DOCK_VIEWS.length} views sit in the dock as tabs (${tabs.length}: ${tabs.join(' | ')})`);
	await S.closeAll(page);

	// ---- record / verify ---------------------------------------------------------------------------
	const now = { surfaces, toolbar };
	if (L.RECORD) {
		L.writeFixture('panels', { recordedAt: new Date().toISOString(), ...now });
		return h.finish(browser);
	}
	const fixture = L.readFixture('panels');
	h.check(!!fixture, 'the recorded panel lock exists (tests/e2e/fixtures/lock/panels.json)');
	if (fixture) {
		for (const [name, want] of Object.entries(fixture.surfaces)) {
			const got = surfaces[name];
			L.same(h.check, `${name}: opens / own close control / Escape`, want, got ?? null);
		}
		for (const [id, want] of Object.entries(fixture.toolbar)) {
			const got = toolbar[id];
			if (!got) {
				h.check(false, `toolbar cell "${id}" still exists`);
				continue;
			}
			const lost = Object.entries(want.stores).filter(([k, v]) => !(k in got.stores) || (v !== '<object>' && v !== '<changed>' && JSON.stringify(got.stores[k]) !== JSON.stringify(v)));
			h.check(lost.length === 0, `toolbar "${id}" does what it did` + (lost.length ? `\n      lost ${JSON.stringify(Object.fromEntries(lost))}\n      now ${JSON.stringify(got.stores)}` : ''));
			L.same(h.check, `toolbar "${id}" storage keys`, want.storage, got.storage);
			L.same(h.check, `toolbar "${id}" dialogs`, want.dialogs, got.dialogs);
		}
	}
	await h.finish(browser);
});
