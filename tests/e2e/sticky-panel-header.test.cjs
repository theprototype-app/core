// uir-polish phase E (owner feedback on 1.65.0, 2026-11-11) — the Configure Scene / Properties panels.
//   E1  no lock/unlock and no pin/unpin button anywhere (the sidebar strip, the phone grip row, the phone tab menu)
//   E2  the filter row ALWAYS sticks; Properties' placeholder is the object's name alone
//   E3  a deselect keeps Properties on the PREVIOUS object (wide posture); the kept object leaving the scene closes it
//   E4  another tab in front of the column stays in front on later selections; a double-click / "Properties" brings
//       Properties forward
//   E6  the minimal scrollbar runs BELOW the sticky filter row instead of sliding under it
// This file replaces 42 I1's lock suite (the lock is gone: E1/E2). Desktop 1440x900, folded N6 390x896, unfolded 770x850.
// Counterfactual (v1.65.0): the lock/pin exist (E1 red), the placeholder reads "Filter properties of …" (E2 red), a
// deselect closes Properties (E3 red), the thumb starts at the scroller's top under the filter row (E6 red).
// OUT=<dir> writes screenshots (dark + light).
const h = require('./helpers.cjs');
const path = require('path');

const OUT = process.env.OUT || '';
const DEVICES = [
	{ name: 'desktop', context: { viewport: { width: 1440, height: 900 } }, touch: false },
	{ name: 'folded', context: { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }, touch: true },
	{ name: 'unfolded', context: { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }, touch: true }
];

/** the header's place against its scroller, plus the thumb; scrolls the scroller to `to` first @param {any} page @param {string|null} to */
const measure = (page, to) =>
	page.evaluate((where) => {
		const head = /** @type {HTMLElement|null} */ (document.querySelector('#drawer-label'));
		if (!head) return null;
		/** @type {HTMLElement|null} */
		let sc = head.parentElement;
		while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight + 4)) sc = sc.parentElement;
		if (!sc) return { scroller: false, sticky: head.dataset.sticky };
		if (where === 'top') sc.scrollTop = 0;
		if (where === 'bottom') sc.scrollTop = sc.scrollHeight;
		sc.dispatchEvent(new Event('scroll'));
		const s = sc.getBoundingClientRect();
		const r = head.getBoundingClientRect();
		const thumb = /** @type {HTMLElement|null} */ (sc.querySelector(':scope > .tp-scroll-thumb'));
		const t = thumb && thumb.style.display !== 'none' ? thumb.getBoundingClientRect() : null;
		return {
			scroller: true,
			sticky: head.dataset.sticky,
			position: getComputedStyle(head).position,
			scrollTop: Math.round(sc.scrollTop),
			range: Math.round(sc.scrollHeight - sc.clientHeight),
			headTop: Math.round(r.top - s.top),
			headBottom: Math.round(r.bottom - s.top),
			thumbTop: t ? Math.round(t.top - s.top) : null,
			thumbBottom: t ? Math.round(t.bottom - s.top) : null,
			viewH: Math.round(sc.clientHeight)
		};
	}, to);

/** a scene with enough rows to scroll, the box selected and its Properties open @param {any} page */
async function openProperties(page) {
	await page.evaluate(() => {
		const w = /** @type {any} */ (window).__stores;
		w.commandsHandler.sceneCommand('/create box');
	});
	await page.waitForTimeout(900);
	const uuid = await page.evaluate(() => {
		const w = /** @type {any} */ (window).__stores;
		let g;
		w.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		const o = g.children[g.children.length - 1];
		o.name = 'Crate 7';
		w.objectActions.selectObject(o.uuid, true);
		return o.uuid;
	});
	await page.waitForSelector('#inspector-search', { state: 'visible', timeout: 10000 }).catch(() => {});
	await page.waitForTimeout(900);
	return uuid;
}

/** @param {any} page @param {string} name */
async function shots(page, name) {
	if (!OUT) return;
	for (const t of ['dark', 'light']) {
		await page.evaluate((th) => window.__stores.themes.theme.set(th), t);
		await page.waitForTimeout(350);
		await page.screenshot({ path: path.join(OUT, `e-${name}-${t}.png`) });
	}
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
}

/** @param {any} page @param {string} name */
const store = (page, name) =>
	page.evaluate((n) => {
		let v;
		window.__stores[n].subscribe((/** @type {any} */ x) => (v = x))();
		return v;
	}, name);

h.run(async () => {
	const browser = await h.launch();
	for (const dev of DEVICES) {
		const P = await h.setupPage(browser, dev.name, { context: dev.context });
		const page = P.page;
		const tag = dev.name;
		const uuid = await openProperties(page);

		// E1 — no lock, no pin
		const chrome = await page.evaluate(() => ({
			lock: document.querySelectorAll('#inspector-sticky-head').length,
			pin: document.querySelectorAll('#inspector-pin, [data-testid="inspector-pin"]').length
		}));
		h.check(chrome.lock === 0 && chrome.pin === 0, `${tag} E1: no header lock and no pin (${JSON.stringify(chrome)})`);

		// E2 — the placeholder is the name; the row sticks
		const ph = await page.evaluate(() => document.querySelector('#inspector-search')?.getAttribute('placeholder'));
		h.check(ph === 'Crate 7', `${tag} E2: the Properties filter placeholder is the object's name alone ("${ph}")`);
		let m = await measure(page, 'bottom');
		h.check(!!m?.scroller && (m?.range ?? 0) > 40, `${tag}: (premise) the Properties panel scrolls (${JSON.stringify(m)})`);
		h.check(m?.sticky === 'true' && m.position === 'sticky' && m.scrollTop > 0 && m.headTop >= -1 && m.headTop <= 2, `${tag} E2: scrolled ${m?.scrollTop}px, the filter row is still on top (top ${m?.headTop})`);
		// E6 — the thumb runs below the filter row, at both ends of the scroll
		h.check(m?.thumbTop !== null && (m?.thumbTop ?? 0) >= (m?.headBottom ?? 0) && (m?.thumbBottom ?? 0) <= (m?.viewH ?? 0) + 1, `${tag} E6: at the end the thumb sits below the filter row (${JSON.stringify(m)})`);
		m = await measure(page, 'top');
		h.check(m?.thumbTop !== null && (m?.thumbTop ?? 0) >= (m?.headBottom ?? 0), `${tag} E6: at the top the thumb starts below the filter row (${m?.thumbTop} >= ${m?.headBottom})`);
		await shots(page, `${tag}-properties`);
		// Configure Scene: the same sticky row and its own placeholder
		await page.evaluate(() => window.__stores.showSidebar('scene'));
		await page.waitForTimeout(900);
		m = await measure(page, 'bottom');
		const sph = await page.evaluate(() => document.querySelector('#inspector-search')?.getAttribute('placeholder'));
		h.check(m?.sticky === 'true' && m.headTop >= -1 && m.headTop <= 2 && sph === 'Filter scene settings', `${tag} E2: Configure Scene's filter row sticks too (top ${m?.headTop}, "${sph}")`);
		h.check(m?.thumbTop !== null && (m?.thumbTop ?? 0) >= (m?.headBottom ?? 0), `${tag} E6: Configure Scene's thumb runs below its filter row (${m?.thumbTop} >= ${m?.headBottom})`);
		await shots(page, `${tag}-scene`);

		if (dev.name === 'desktop') {
			// E3 — a deselect keeps Properties on the last object
			await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), uuid);
			await page.waitForTimeout(600);
			await page.evaluate(() => window.__stores.objectActions.deselectObject());
			await page.waitForTimeout(600);
			const kept = await page.evaluate(() => ({
				search: document.querySelector('#inspector-search')?.getAttribute('placeholder') ?? null,
				shown: !!document.querySelector('#inspector')
			}));
			h.check((await store(page, 'inspectorClose')) === false && (await store(page, 'inspectorKind')) === 'selection' && kept.search === 'Crate 7', `E3: after a deselect Properties still shows the last object (${JSON.stringify(kept)})`);
			h.check(((await store(page, 'selectedObjects')) ?? []).length === 0, 'E3: (premise) nothing is selected');
			// the kept object is still editable: a Name edit lands on it
			await page.fill('#inspector input[aria-label="Name"], #inspector #object-name', 'Crate 8').catch(() => {});
			await page.keyboard.press('Enter').catch(() => {});
			await page.waitForTimeout(300);
			// it leaves the scene (a peer's delete arrives as commandsHandler.deleteObject): the panel closes
			await page.evaluate((u) => window.__stores.commandsHandler.deleteObject(u), uuid);
			await page.waitForTimeout(700);
			h.check((await store(page, 'inspectorClose')) === true || (await store(page, 'inspectorKind')) !== 'selection', 'E3: when the kept object is deleted, Properties closes');

			// E5 — Configure Scene moves to the other sidebar ALONE
			const e5 = await openProperties(page);
			await page.evaluate(() => window.__stores.showSidebar('scene'));
			await page.waitForTimeout(700);
			const sides0 = await page.evaluate(() => {
				let v;
				window.__stores.sidebars.sidebarTabs.subscribe((x) => (v = x))();
				return v;
			});
			const home = sides0.right.includes('inspector') ? 'right' : 'left';
			const away = home === 'right' ? 'left' : 'right';
			h.check(sides0[home].includes('inspector') && sides0[home].includes('scene'), `E5: (premise) Properties and Configure Scene share the ${home} column (${JSON.stringify(sides0)})`);
			await page.evaluate((s) => window.__stores.sidebars.moveSidebarTab('scene', s), away);
			await page.waitForTimeout(900);
			const dual = await page.evaluate(() => {
				let t;
				window.__stores.sidebars.sidebarTabs.subscribe((x) => (t = x))();
				const vis = (/** @type {Element|null} */ e) => !!e && e.getClientRects().length > 0 && !e.hasAttribute('data-sidebar-hidden');
				const main = document.querySelector('#inspector');
				const scene = document.querySelector('#inspector-scene');
				return {
					tabs: t,
					main: vis(main) ? main.getAttribute('data-sidebar-side') : null,
					mainPh: main?.querySelector('#inspector-search')?.getAttribute('placeholder') ?? null,
					scene: vis(scene) ? scene.getAttribute('data-sidebar-side') : null,
					scenePh: scene?.querySelector('#inspector-search')?.getAttribute('placeholder') ?? null
				};
			});
			h.check(dual.tabs[away].includes('scene') && !dual.tabs[away].includes('inspector') && dual.tabs[home].includes('inspector'), `E5: only Configure Scene moved to the ${away} column (${JSON.stringify(dual.tabs)})`);
			h.check(dual.main === home && dual.mainPh === 'Crate 7', `E5: Properties stays on the ${home} side showing the object (${dual.main}, "${dual.mainPh}")`);
			h.check(dual.scene === away && dual.scenePh === 'Filter scene settings', `E5: Configure Scene shows in the ${away} column at the same time (${dual.scene}, "${dual.scenePh}")`);
			await shots(page, 'e5-dual');
			// the burger's Configure Scene keeps working in the dual state (it brings its tab forward, Properties stays)
			await page.evaluate(() => window.__stores.showSidebar('scene'));
			await page.waitForTimeout(500);
			h.check((await store(page, 'inspectorKind')) !== 'scene' && !!(await page.$('#inspector-scene')), 'E5: asking for Configure Scene in the dual state keeps Properties in its element');
			// back together: one element again
			await page.evaluate((s) => window.__stores.sidebars.moveSidebarTab('scene', s), home);
			await page.waitForTimeout(900);
			const one = await page.evaluate(() => ({ second: !!document.querySelector('#inspector-scene') }));
			h.check(!one.second, 'E5: moved back beside Properties, the second instance is gone');
			await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), e5);
			await page.waitForTimeout(400);

			// E4 — another tab in front stays in front on later selections
			const b2 = await openProperties(page);
			await page.evaluate(() => window.__stores.objectListClose?.set?.(false));
			await page.waitForTimeout(300);
			const tabs = await page.evaluate(() => {
				let v;
				window.__stores.sidebars.sidebarTabs.subscribe((x) => (v = x))();
				return v;
			});
			const side = tabs.left.includes('inspector') ? 'left' : 'right';
			const other = tabs[side].find((/** @type {string} */ k) => k !== 'inspector' && k !== 'scene') ?? null;
			if (!other) {
				// put the Explorer into the Properties column so a second tab exists
				// open it first (a closed panel is no tab to move), then move it beside Properties
				await page.evaluate(() => window.__stores.explorerClose?.set?.(false));
				await page.waitForTimeout(600);
				await page.evaluate((s) => window.__stores.sidebars.moveSidebarTab?.('explorer', s), side);
				await page.waitForTimeout(600);
			}
			const tabs2 = await page.evaluate(() => {
				let v;
				window.__stores.sidebars.sidebarTabs.subscribe((x) => (v = x))();
				return v;
			});
			const front = tabs2[side].find((/** @type {string} */ k) => k !== 'inspector' && k !== 'scene') ?? null;
			h.check(!!front, `E4: (premise) a second tab shares the Properties column (${JSON.stringify(tabs2)})`);
			if (front) {
				await page.evaluate((k) => window.__stores.sidebars.activateSidebarTab(k), front);
				await page.waitForTimeout(400);
				await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create sphere'));
				await page.waitForTimeout(800);
				const s2 = await page.evaluate(() => {
					const w = /** @type {any} */ (window).__stores;
					let g;
					w.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
					return g.children[g.children.length - 1].uuid;
				});
				for (const u of [s2, b2]) {
					await page.evaluate((x) => window.__stores.objectActions.selectObject(x), u);
					await page.waitForTimeout(400);
				}
				let shown = await page.evaluate((s) => {
					let v;
					window.__stores.sidebars.sidebarShown.subscribe((x) => (v = x))();
					return v[s];
				}, side);
				h.check(shown === front, `E4: plain selections leave "${front}" in front (${shown})`);
				// the context menu's "Properties" (selectObject(.., true)) brings Properties forward
				await page.evaluate((x) => window.__stores.objectActions.selectObject(x, true), s2);
				await page.waitForTimeout(500);
				shown = await page.evaluate((s) => {
					let v;
					window.__stores.sidebars.sidebarShown.subscribe((x) => (v = x))();
					return v[s];
				}, side);
				h.check(shown === 'inspector', `E4: an explicit "Properties" brings the Properties tab forward (${shown})`);
			}
		}
		h.check(h.pageErrors(P).length === 0, `${tag}: no page errors (${JSON.stringify(h.pageErrors(P)).slice(0, 200)})`);
		await P.ctx.close();
	}
	await h.finish(browser);
});
