// phone-polish item 3 — TOUCH SIZE. Auto = the large chrome on a coarse pointer at ANY width (the HONOR
// unfolded is 718 px, above the 640 px phone tokens); the desktop stays byte-identical; the setting and
// the `?density=` switch flip it. Measured on real elements: a window's ✕, the dock strip, a menu row.
const h = require('./helpers.cjs');
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const on = (page) => page.evaluate(() => document.documentElement.hasAttribute('data-touch-ui'));
const closeBtn = (page) =>
	page.evaluate(() => {
		const b = document.querySelector('#object-list .wc-close, #object-list [aria-label^="Close"]');
		const r = b?.getBoundingClientRect();
		return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
	});

h.run(async () => {
	const browser = await h.launch();
	const TOUCH = { hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, viewport: { width: 718, height: 587 } };

	// 1. a desktop window: off, and the window ✕ keeps its old size
	const D = await h.setupPage(browser, 'desk');
	h.check(!(await on(D.page)), 'desktop: no data-touch-ui');
	await D.page.evaluate(() => window.__stores.objectListClose.set(false));
	await nap(800);
	const deskBtn = await closeBtn(D.page);
	h.check(!!deskBtn && deskBtn.h < 40, `desktop: the Objects ✕ is unchanged (${JSON.stringify(deskBtn)})`);
	await h.closePeer(D);

	// 2. the unfolded phone: Auto = on
	const T = await h.setupPage(browser, 'touch', { context: TOUCH });
	h.check(await on(T.page), 'touch 718 px: Auto turns the large chrome on');
	await T.page.evaluate(() => window.__stores.objectListClose.set(false));
	await nap(800);
	const tb = await closeBtn(T.page);
	h.check(!!tb && tb.w >= 40 && tb.h >= 40, `touch: the Objects ✕ is a 40 px target (${JSON.stringify(tb)})`);
	await T.page.evaluate(() => window.__stores.objectListClose.set(true));
	// the dock strip: 40 px tall, and the Controls bar clears it
	await T.page.evaluate(() => { window.__stores.explorerClose.set(false); window.__stores.bottomDock.dockMinimized.set(false); });
	await nap(1200);
	const strip = await T.page.evaluate(() => {
		const s = document.querySelector('.dt-bar.tp-dtabs-slim');
		const pill = document.querySelector('#controls-pill');
		const a = s?.getBoundingClientRect();
		const p = pill?.getBoundingClientRect();
		// the strip's own controls (tabs, +, the right-hand buttons) must not sit under the bar: the bar has always
		// overlapped the strip's empty band by a few px (16 px above the panel, the strip 24 px tall)
		const hits = [...document.querySelectorAll('.dt-row button, .dt-chrome button')].filter((b) => {
			const r = b.getBoundingClientRect();
			return p && r.width && r.right > p.left && r.left < p.right && r.bottom > p.top && r.top < p.bottom;
		}).map((b) => b.getAttribute('aria-label') || b.textContent.trim().slice(0, 20));
		return a ? { h: Math.round(a.height), top: Math.round(a.top), pillBottom: p ? Math.round(p.bottom) : null, hits } : null;
	});
	h.check(!!strip && strip.h >= 40, `touch: the dock strip is 40 px (${JSON.stringify(strip)})`);
	h.check(!!strip && strip.hits.length === 0, `touch: no strip control sits under the Controls bar (${JSON.stringify(strip?.hits)})`);
	h.check(!!strip && (strip.pillBottom == null || strip.pillBottom <= strip.top + 8), 'touch: the bar overlaps the taller strip no more than the standard one (8 px)');
	await T.page.evaluate(() => window.__stores.explorerClose.set(true));

	// 3. the setting: Standard turns it off, Auto back on
	await T.page.evaluate(() => window.__stores.touchDensity.touchSize.set('standard'));
	await nap(300);
	h.check(!(await on(T.page)), 'Settings ▸ Touch size ▸ Standard: off on the phone too');
	await T.page.evaluate(() => window.__stores.touchDensity.touchSize.set('auto'));
	await nap(300);
	h.check(await on(T.page), 'Auto: on again');
	await h.closePeer(T);

	// 4. the URL switch sets it on this device (and survives a reload)
	const U = await h.setupPage(browser, 'url', { context: TOUCH });
	await U.page.goto(h.URL + '?density=compact', { waitUntil: 'domcontentloaded' });
	await U.page.waitForFunction(() => !!window.__stores?.touchDensity, null, { timeout: 120000 });
	h.check(!(await on(U.page)), '?density=compact: off');
	await U.page.goto(h.URL, { waitUntil: 'domcontentloaded' });
	await U.page.waitForFunction(() => !!window.__stores?.touchDensity, null, { timeout: 120000 });
	h.check(!(await on(U.page)), 'and it is remembered on this device');
	await U.page.goto(h.URL + '?density=touch', { waitUntil: 'domcontentloaded' });
	await U.page.waitForFunction(() => !!window.__stores?.touchDensity, null, { timeout: 120000 });
	h.check(await on(U.page), '?density=touch: on');
	await h.closePeer(U);
	await h.finish(browser);
});
