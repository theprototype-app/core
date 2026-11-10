// 42 I1 — "both mobile and desktop: add additional pin button or implement somehow to stick/unstick/
// lock/unlock sticky header/name/'filter properties' on mobile for 'configure scene'/'object
// properties' drawers, as it takes much space, but I want it to be configurable, enabled by default".
// The panel header (title + "Filter properties") wears a LOCK: locked (the default) = it stays on top
// while the properties scroll; unlocked = it scrolls away with them. Remembered PER PANEL (Configure
// Scene vs Properties), saved on this device; Settings ▸ Interface ▸ "Sticky panel headers" sets both
// (mixed when they differ). One header component, so the desktop sidebar, the folded phone's sheet
// and the unfolded phone all get it — checked on each, the phone with real TAPS.
// Counterfactual (feat/41-int): there is no #inspector-sticky-head and the header always sticks.
// OUT=<dir> writes the screenshots (locked + unlocked, dark + light, per device).
const h = require('./helpers.cjs');
const path = require('path');

const OUT = process.env.OUT || '';
const DEVICES = [
	{ name: 'desktop', context: { viewport: { width: 1440, height: 900 } }, touch: false },
	{ name: 'folded', context: { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }, touch: true },
	{ name: 'unfolded', context: { viewport: { width: 770, height: 850 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true }, touch: true }
];

/** the header's place against its scroller; scrolls the scroller to `to` first ('top'|'bottom'|null) @param {any} page @param {string|null} to */
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
		const s = sc.getBoundingClientRect();
		const r = head.getBoundingClientRect();
		return {
			scroller: true,
			sticky: head.dataset.sticky,
			position: getComputedStyle(head).position,
			scrollTop: Math.round(sc.scrollTop),
			range: Math.round(sc.scrollHeight - sc.clientHeight),
			headTop: Math.round(r.top - s.top),
			headBottom: Math.round(r.bottom - s.top),
			headH: Math.round(r.height)
		};
	}, to);

/** @param {any} page @param {boolean} touch */
async function pressLock(page, touch) {
	const b = page.locator('#inspector-sticky-head');
	await b.waitFor({ state: 'visible', timeout: 8000 });
	if (touch) await b.tap();
	else await b.click();
	await page.waitForTimeout(350);
}

/** a scene with enough rows to scroll, the box selected and its Properties open @param {any} page */
async function openProperties(page) {
	await page.evaluate(() => {
		const w = /** @type {any} */ (window).__stores;
		w.commandsHandler.sceneCommand('/create box');
	});
	await page.waitForTimeout(900);
	await page.evaluate(() => {
		const w = /** @type {any} */ (window).__stores;
		let g;
		w.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		const o = g.children[g.children.length - 1];
		w.objectActions.selectObject(o.uuid, true);
		w.inspectorPinned.set(true);
		w.showSidebar('properties');
	});
	await page.waitForSelector('#inspector-sticky-head', { state: 'visible', timeout: 10000 }).catch(() => {});
	await page.waitForTimeout(900);
}

/** @param {any} page @param {string} name */
async function shots(page, name) {
	if (!OUT) return;
	for (const t of ['dark', 'light']) {
		await page.evaluate((th) => window.__stores.themes.theme.set(th), t);
		await page.waitForTimeout(350);
		await page.screenshot({ path: path.join(OUT, `${name}-${t}.png`) });
	}
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
}

h.run(async () => {
	const browser = await h.launch();
	for (const dev of DEVICES) {
		const P = await h.setupPage(browser, dev.name, { context: dev.context });
		const page = P.page;
		const tag = dev.name;
		await openProperties(page);
		const has = !!(await page.$('#inspector-sticky-head'));
		h.check(has, `${tag}: the Properties header has a lock button`);
		if (!has) {
			await P.ctx.close();
			continue;
		}
		// default: locked (sticky), the header stays at the top of the scrolled panel
		let m = await measure(page, 'bottom');
		h.check(!!m?.scroller && (m?.range ?? 0) > 40, `${tag}: (premise) the Properties panel scrolls (${JSON.stringify(m)})`);
		h.check(m?.sticky === 'true' && m.scrollTop > 0 && m.headTop >= -1 && m.headTop <= 2, `${tag}: by default the header sticks — scrolled ${m?.scrollTop}px it is still on top (top ${m?.headTop})`);
		const pressed = await page.evaluate(() => document.querySelector('#inspector-sticky-head')?.getAttribute('aria-pressed'));
		h.check(pressed === 'true', `${tag}: the lock reads pressed (${pressed})`);
		await measure(page, 'top');
		await shots(page, `i1-${tag}-properties-locked`);
		// unlock: the header scrolls away with the properties
		await pressLock(page, dev.touch);
		m = await measure(page, 'bottom');
		h.check(m?.sticky === 'false' && m.position !== 'sticky' && m.headBottom <= 0, `${tag}: unlocked, scrolling takes the header away (bottom ${m?.headBottom}, ${m?.position})`);
		m = await measure(page, 'top');
		h.check(m?.headTop >= -1 && m.headTop <= 2, `${tag}: …and it is back at the top of the panel (${m?.headTop})`);
		await shots(page, `i1-${tag}-properties-unlocked-top`);
		await measure(page, 'bottom');
		await shots(page, `i1-${tag}-properties-unlocked-scrolled`);
		// per panel: Configure Scene keeps its own (default) setting
		await page.evaluate(() => window.__stores.showSidebar('scene'));
		await page.waitForTimeout(900);
		await page.waitForSelector('#scene-quality-preset, #environment-presets', { state: 'visible', timeout: 10000 }).catch(() => {});
		m = await measure(page, 'bottom');
		h.check(m?.sticky === 'true' && m.headTop >= -1 && m.headTop <= 2, `${tag}: Configure Scene keeps ITS header sticky — remembered per panel (top ${m?.headTop})`);
		const stored = await page.evaluate(() => localStorage.getItem('panels:stickyHeads'));
		h.check(stored === '{"scene":true,"properties":false}', `${tag}: saved on this device (${stored})`);
		if (dev.name === 'desktop') {
			// the deep link lands a section right at the top when the header scrolls away
			await pressLock(page, false);
			// 78-int PL17: the device sections start closed, so open the ones below the target first — a
			// deep link can only land a section at the top when there is a panel's height of content under it
			for (const label of ['Snapping', 'Grid', 'Camera', 'View']) {
				await page.evaluate((l) => window.__stores.openSceneSection(l), label);
				await page.waitForTimeout(500);
			}
			await page.waitForTimeout(400);
			const land = await page.evaluate(() => {
				// the deep link lands the SECTION element (Section.svelte's findTarget)
				const sec = [...document.querySelectorAll('section.sec-panel')].find((e) => /^View\b/.test(e.textContent?.trim() ?? ''));
				const head = document.querySelector('#drawer-label');
				let sc = head?.parentElement ?? null;
				while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight + 4)) sc = sc.parentElement;
				return sec && sc ? Math.round(sec.getBoundingClientRect().top - sc.getBoundingClientRect().top) : null;
			});
			h.check(land !== null && land >= 0 && land <= 40, `${tag}: a deep link with the header unlocked lands the section at the top, not a header's height below (${land})`);
			await pressLock(page, false);
			// Settings ▸ Interface ▸ Sticky panel headers: mixed while they differ, one press sets both
			await page.evaluate(() => {
				const w = /** @type {any} */ (window).__stores;
				w.settingsSection.set('interface');
				w.settingsOpen.set(true);
			});
			await page.waitForSelector('#sticky-panel-heads', { timeout: 10000 });
			const st = await page.evaluate(() => document.querySelector('#sticky-panel-heads')?.getAttribute('aria-pressed'));
			h.check(st === 'mixed', `${tag}: Settings reads mixed while the two panels differ (${st})`);
			await page.click('#sticky-panel-heads');
			await page.waitForTimeout(300);
			let both = await page.evaluate(() => {
				let v;
				window.__stores.panelHeaderPrefs.stickyPanelHeads.subscribe((/** @type {any} */ x) => (v = x))();
				return v;
			});
			h.check(both?.scene === true && both?.properties === true, `${tag}: one press makes both sticky (${JSON.stringify(both)})`);
			await page.click('#sticky-panel-heads');
			await page.waitForTimeout(300);
			both = await page.evaluate(() => {
				let v;
				window.__stores.panelHeaderPrefs.stickyPanelHeads.subscribe((/** @type {any} */ x) => (v = x))();
				return v;
			});
			h.check(both?.scene === false && both?.properties === false, `${tag}: …and another unsticks both (${JSON.stringify(both)})`);
			await page.fill('#settings-search', 'sticky header');
			await page.waitForTimeout(700);
			const found = await page.evaluate(() => {
				const r = document.querySelector('#row-sticky-panel-heads');
				return !!r && /** @type {HTMLElement} */ (r).offsetParent !== null;
			});
			h.check(found, `${tag}: Settings search "sticky header" finds the row`);
			await page.fill('#settings-search', 'filter properties');
			await page.waitForTimeout(700);
			const found2 = await page.evaluate(() => !!document.querySelector('#row-sticky-panel-heads') && /** @type {any} */ (document.querySelector('#row-sticky-panel-heads')).offsetParent !== null);
			h.check(found2, `${tag}: …and "filter properties" too (keywords)`);
			await page.evaluate(() => window.__stores.settingsOpen.set(false));
			// survives a reload (both unstuck now)
			await h.freshReload(P);
			await page.locator('#restore-session-dismiss').click({ timeout: 6000 }).catch(() => {});
			await page.evaluate(() => window.__stores.showSidebar('scene'));
			await page.waitForSelector('#inspector-sticky-head', { state: 'visible', timeout: 10000 });
			await page.waitForTimeout(700);
			m = await measure(page, 'bottom');
			h.check(m?.sticky === 'false' && m.headBottom <= 0, `${tag}: after a reload the choice holds (${m?.sticky}, bottom ${m?.headBottom})`);
			await page.evaluate(() => window.__stores.panelHeaderPrefs.setAllStickyHeads(true));
			await page.waitForTimeout(300);
			h.check((await page.evaluate(() => localStorage.getItem('panels:stickyHeads'))) === null, `${tag}: back to the default stores nothing`);
		} else {
			// put Properties back for the next device, through the header again (a tap)
			await page.evaluate(() => window.__stores.showSidebar('properties'));
			await page.waitForTimeout(900);
			await pressLock(page, dev.touch);
			m = await measure(page, 'bottom');
			h.check(m?.sticky === 'true' && m.headTop >= -1 && m.headTop <= 2, `${tag}: a second tap locks it again (top ${m?.headTop})`);
		}
		h.check(h.pageErrors(P).length === 0, `${tag}: no page errors (${JSON.stringify(h.pageErrors(P)).slice(0, 200)})`);
		await P.ctx.close();
	}
	await h.finish(browser);
});
