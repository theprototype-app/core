// uir-polish phases F + G (owner feedback on 1.65.0, 2026-11-11), desktop 1440x900.
//   F1  a sidebar strip whose tabs outgrow the column shows "..." (#sidebar-more-<side>): it lists EVERY tab and a pick
//       brings that tab forward (and into view); the mouse wheel scrolls the strip
//   F2  sidebar tabs keep their whole name like dock tabs (no shrinking to 72 px, no ellipsis)
//   F3  the sidebar "+" menu: a panel that lives in the dock reads "Move here" while its row is hovered
//   G1  Code docked has no header row (no "Code" title, no pop-out); floating, its header pops out; in a sidebar
//       the header is gone
//   G2  every floating window's header has a Dock button and, when it can pop out, a pop-out button
//   G3  the Dock button is icon-only (no "Dock" text)
//   G4  Objects / Statistics / Chat / Free assets docked in the bottom dock: no header X (the dock tab closes them)
// Counterfactual (v1.65.0): no "..." (F1), tabs shrink to 72 px (F2), the row keeps "In dock" (F3), Code docked has a
// title row with a pop-out (G1), hosted windows have no Dock and only Code a pop-out (G2), "Dock" text (G3), the
// hosted windows keep their X in the dock (G4).
const h = require('./helpers.cjs');

/** @param {any} page @param {string} sel */
const visible = (page, sel) =>
	page.evaluate((s) => [...document.querySelectorAll(s)].some((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'), sel);

/** bring an OPEN window into the bottom dock wherever it is now (a window reopens where it was last) */
async function toDock(page, key) {
	await page.evaluate((k) => {
		const s = window.__stores;
		const w = s.dockMenu.windowWhere(k);
		if (w === 'dock') return;
		if (w === 'floating') s.bottomDock.armDockMode(k, true);
		else s.dockMenu.addWindowItems({ target: 'dock' }).find((/** @type {any} */ r) => r.key === k)?.action?.();
	}, key);
	await page.waitForTimeout(900);
}

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = P.page;
	await page.waitForTimeout(1200);

	// ── F1/F2: many tabs in the right column ─────────────────────────────────────────────────────────────
	console.log('\n=== F1/F2 ===');
	await page.evaluate(() => window.__stores.showSidebar('scene'));
	await page.waitForTimeout(700);
	for (const key of ['explorer', 'timeline', 'profiler', 'objects']) {
		await page.evaluate((k) => {
			const s = window.__stores;
			s.dockMenu.moveToSidebar(k, 'right');
			if (k === 'objects') s.objectListClose.set(false);
			else s.panelToggles.togglePanel(k);
		}, key);
		await page.waitForTimeout(900);
		await page.evaluate((k) => window.__stores.dockMenu.moveToSidebar(k, 'right'), key);
		await page.waitForTimeout(500);
	}
	const strip = await page.evaluate(() => {
		const box = /** @type {HTMLElement} */ (document.querySelector('#sidebar-strip-right .sb-tabs'));
		const tabs = [...document.querySelectorAll('#sidebar-strip-right [data-sidebar-tab-group]')].map((g) => {
			const label = /** @type {HTMLElement} */ (g.querySelector('.sb-tab-label'));
			return { key: g.getAttribute('data-sidebar-tab-group'), w: Math.round(g.getBoundingClientRect().width), cut: label ? label.scrollWidth > label.clientWidth + 1 : null };
		});
		return { over: box ? box.scrollWidth > box.clientWidth + 1 : false, n: tabs.length, tabs };
	});
	console.log(JSON.stringify(strip));
	h.check(strip.n >= 4 && strip.over, `F1: (premise) ${strip.n} tabs outgrow the right column`);
	h.check(strip.tabs.every((t) => t.cut === false), `F2: every tab shows its whole name (${JSON.stringify(strip.tabs)})`);
	h.check(await visible(page, '#sidebar-more-right'), 'F1: the "..." button shows while the tabs overflow');
	// the wheel scrolls the strip sideways
	const sl0 = await page.evaluate(() => document.querySelector('#sidebar-strip-right .sb-tabs').scrollLeft);
	const box = await page.locator('#sidebar-strip-right .sb-tabs').boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, sl0 > 0 ? -240 : 240);
	await page.waitForTimeout(300);
	const sl1 = await page.evaluate(() => document.querySelector('#sidebar-strip-right .sb-tabs').scrollLeft);
	h.check(sl1 !== sl0, `F1: the mouse wheel scrolls the strip (${sl0} -> ${sl1})`);
	// "..." lists every tab; a pick of one scrolled out of view brings it forward and into view
	const hidden = await page.evaluate(() => {
		const b = /** @type {HTMLElement} */ (document.querySelector('#sidebar-strip-right .sb-tabs'));
		const g = [...b.querySelectorAll('[data-sidebar-tab-group]')].find((e) => {
			const r = e.getBoundingClientRect();
			const q = b.getBoundingClientRect();
			return r.right > q.right + 1 || r.left < q.left - 1;
		});
		return g?.getAttribute('data-sidebar-tab-group') ?? null;
	});
	h.check(!!hidden, `F1: (premise) a tab is scrolled out of view (${hidden})`);
	await page.click('#sidebar-more-right');
	await page.waitForTimeout(400);
	const listed = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="sidebar-more-item-"]')].map((e) => e.getAttribute('data-testid').replace('sidebar-more-item-', '')));
	h.check(strip.tabs.every((t) => listed.includes(t.key)), `F1: the menu lists every tab (${listed.join(', ')})`);
	if (hidden) {
		await page.click(`[data-testid="sidebar-more-item-${hidden}"]`);
		await page.waitForTimeout(500);
		const after = await page.evaluate((k) => {
			let v;
			window.__stores.sidebars.sidebarShown.subscribe((x) => (v = x))();
			const b = document.querySelector('#sidebar-strip-right .sb-tabs').getBoundingClientRect();
			const r = document.querySelector(`#sidebar-strip-right [data-sidebar-tab-group="${k}"]`).getBoundingClientRect();
			return { front: v.right, inView: r.left >= b.left - 1 && r.right <= b.right + 1 };
		}, hidden);
		h.check(after.front === hidden && after.inView, `F1: picking "${hidden}" brings it forward and into view (${JSON.stringify(after)})`);
	}

	// ── F3: "+" on the right sidebar, with the Node editor in the bottom dock ──────────────────────────────
	console.log('\n=== F3 ===');
	await page.evaluate(() => window.__stores.panelToggles.togglePanel('flow'));
	await page.waitForTimeout(1200);
	const flowWhere = await page.evaluate(() => window.__stores.dockMenu.windowWhere('flow'));
	h.check(flowWhere === 'dock', `F3: (premise) the Node editor is in the dock (${flowWhere})`);
	await page.click('#sidebar-add-right');
	await page.waitForTimeout(400);
	const row = page.locator('[role="menuitem"]', { hasText: 'Node editor' }).first();
	const rest = await row.evaluate((r) => ({ rest: r.querySelector('.ctx-hint-rest')?.textContent ?? '', hoverShown: !!r.querySelector('[data-ctx-hover-hint]')?.getClientRects().length }));
	h.check(rest.rest === 'In dock' && !rest.hoverShown, `F3: at rest the row says where it is (${JSON.stringify(rest)})`);
	await row.hover();
	await page.waitForTimeout(200);
	const hov = await row.evaluate((r) => {
		const hint = /** @type {HTMLElement|null} */ (r.querySelector('[data-ctx-hover-hint]'));
		return { text: hint?.textContent ?? '', shown: !!hint?.getClientRects().length, restShown: !!r.querySelector('.ctx-hint-rest')?.getClientRects().length };
	});
	h.check(hov.text === 'Move here' && hov.shown && !hov.restShown, `F3: hovered, it reads "Move here" (${JSON.stringify(hov)})`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);

	// ── G1: Code ─────────────────────────────────────────────────────────────────────────────────────
	console.log('\n=== G1 ===');
	await page.evaluate(() => window.__stores.panelToggles.togglePanel('code'));
	await page.waitForTimeout(1500);
	await toDock(page, 'code');
	const codeDocked = await page.evaluate(() => ({
		where: window.__stores.dockMenu.windowWhere('code'),
		title: [...document.querySelectorAll('#code-ws-dock .tp-dock-title, .tp-dock-title')].some((e) => e.textContent.trim() === 'Code' && e.getClientRects().length > 0),
		pop: document.querySelectorAll('#code-ws-popout').length
	}));
	h.check(codeDocked.where === 'dock' && !codeDocked.title && codeDocked.pop === 0, `G1: docked Code has no header row and no pop-out (${JSON.stringify(codeDocked)})`);
	await page.evaluate(() => window.__stores.bottomDock.armDockMode('code', false));
	await page.waitForSelector('#code-ws-window', { timeout: 15000 });
	await page.waitForTimeout(500);
	h.check(await visible(page, '#code-ws-window [data-head-dock="code"]'), 'G2: floating Code has a Dock button');
	h.check(await visible(page, '#code-ws-window #code-ws-popout'), 'G2: floating Code has its pop-out');
	await page.evaluate(() => window.__stores.dockMenu.moveToSidebar('code', 'left'));
	await page.waitForTimeout(900);
	const codeSide = await page.evaluate(() => {
		const head = document.querySelector('#code-ws-window .wc-head');
		return { where: window.__stores.dockMenu.windowWhere('code'), head: !!head && head.getClientRects().length > 0, pop: [...document.querySelectorAll('#code-ws-popout')].some((e) => e.getClientRects().length > 0) };
	});
	h.check(codeSide.where === 'left' && !codeSide.head && !codeSide.pop, `G1: in a sidebar Code has no header at all (${JSON.stringify(codeSide)})`);
	await page.evaluate(() => window.__stores.codeWorkspaceClose.set(true));
	await page.waitForTimeout(500);

	// ── G2/G3: the editors floating ─────────────────────────────────────────────────────────────────────
	console.log('\n=== G2/G3 editors ===');
	for (const key of ['flow', 'timeline', 'explorer', 'profiler']) {
		await page.evaluate((k) => {
			const s = window.__stores;
			if (!s.dockMenu.windowWhere(k)) s.panelToggles.togglePanel(k); // open it only when closed (a toggle closes an open one)
		}, key);
		await page.waitForTimeout(900);
		await toDock(page, key); // F1 left some of these in the right sidebar
		h.check((await page.evaluate((k) => window.__stores.dockMenu.windowWhere(k), key)) === 'dock', `G2 ${key}: (premise) docked before floating`);
		await page.evaluate((k) => window.__stores.bottomDock.armDockMode(k, false), key);
		await page.waitForTimeout(1200);
		const g = await page.evaluate((k) => {
			const d = [...document.querySelectorAll(`[data-head-dock="${k}"]`)].find((e) => e.getClientRects().length > 0);
			const p = [...document.querySelectorAll(`[data-head-popout="${k}"]`)].find((e) => e.getClientRects().length > 0);
			return { where: window.__stores.dockMenu.windowWhere(k), dock: !!d, dockText: d ? d.textContent.trim() : null, pop: !!p };
		}, key);
		h.check(g.dock && g.dockText === '', `G2/G3 ${key}: floating, an icon-only Dock button (${JSON.stringify(g)})`);
		h.check(g.pop, `G2 ${key}: floating, a pop-out button (${JSON.stringify(g)})`);
		// the Dock button docks it
		await page.click(`[data-head-dock="${key}"]`);
		await page.waitForTimeout(900);
		h.check((await page.evaluate((k) => window.__stores.dockMenu.windowWhere(k), key)) === 'dock', `G2 ${key}: the Dock button docks it`);
	}

	// ── G2/G4: the hosted windows ───────────────────────────────────────────────────────────────────────
	console.log('\n=== G2/G4 hosted ===');
	const HOSTED = [
		{ key: 'objects', open: () => window.__stores.objectListClose.set(false), x: '#object-list .wc-close, [data-wc-x]', pop: false },
		{ key: 'stats', open: () => window.__stores.sceneBudget.statsOpen.set(true), x: '#stats-close', pop: false },
		{ key: 'chat', open: () => window.__stores.chatHidden.set(''), x: '.wc-close', pop: true },
		{ key: 'assets', open: () => window.__stores.cc0State.assetBrowserOpen.set(true), x: '#asset-browser-close', pop: false }
	];
	for (const w of HOSTED) {
		// a hosted window opens where it was last: make sure it floats first
		await page.evaluate(w.open);
		await page.waitForTimeout(900);
		if ((await page.evaluate((k) => window.__stores.dockMenu.windowWhere(k), w.key)) !== 'floating') {
			await toDock(page, w.key); // F1 left Objects in the right sidebar: via the dock, then out
			await page.evaluate((k) => window.__stores.dockMenu.undockFromDock?.(k), w.key);
			await page.waitForTimeout(900);
		}
		const where0 = await page.evaluate((k) => window.__stores.dockMenu.windowWhere(k), w.key);
		h.check(where0 === 'floating', `G2 ${w.key}: (premise) it floats (${where0})`);
		// Free assets builds its header after its catalogue loads
		await page.locator(`[data-head-dock="${w.key}"]`).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
		const g = await page.evaluate((k) => {
			const d = [...document.querySelectorAll(`[data-head-dock="${k}"]`)].find((e) => e.getClientRects().length > 0);
			const p = [...document.querySelectorAll(`[data-head-popout="${k}"]`)].find((e) => e.getClientRects().length > 0);
			return { dock: !!d, dockText: d ? d.textContent.trim() : null, pop: !!p };
		}, w.key);
		h.check(g.dock && g.dockText === '', `G2/G3 ${w.key}: floating, an icon-only Dock button (${JSON.stringify(g)})`);
		if (w.pop) h.check(g.pop, `G2 ${w.key}: floating, a pop-out button`);
		await page.click(`[data-head-dock="${w.key}"]`);
		await page.waitForTimeout(1200);
		const docked = await page.evaluate(
			({ k, x }) => {
				const host = document.querySelector(`[data-pd-host]:not([data-pd-host="hidden"])`);
				const xs = host ? [...host.querySelectorAll(x)].filter((e) => e.getClientRects().length > 0).length : -1;
				const chrome = host ? [...host.querySelectorAll('[data-head-dock], [data-head-popout]')].filter((e) => e.getClientRects().length > 0).length : -1;
				return { where: window.__stores.dockMenu.windowWhere(k), xs, chrome };
			},
			{ k: w.key, x: w.x }
		);
		h.check(docked.where === 'dock' && docked.xs === 0 && docked.chrome === 0, `G4 ${w.key}: docked, no header X and no Dock / pop-out (${JSON.stringify(docked)})`);
	}

	h.check(h.pageErrors(P).length === 0, `no page errors (${JSON.stringify(h.pageErrors(P)).slice(0, 200)})`);
	await h.finish(browser);
});
