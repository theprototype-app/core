// phone-polish item 6 — A LONG MENU ON A SHORT SCREEN SCROLLS, never runs off the bottom.
//
// The profile menu grew tall (account, sign-in methods, community, sponsor …): on a phone in landscape
// it ran off the screen with no way to its last rows. The rule for every menu: its box ends inside the
// visible viewport, and when its content is taller it is a SCROLLER that a wheel and a finger's drag
// both move. Measured on the elements themselves; the drag is a real CDP touch sequence.
const h = require('./helpers.cjs');

const SIZES = [
	{ name: 'landscape-short', viewport: { width: 781, height: 380 } },
	{ name: 'folded-short', viewport: { width: 390, height: 560 } }
];
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/** the surface's box, the visible height and whether it (or its own scroller) can scroll */
const look = (page, sel) =>
	page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const vh = window.visualViewport?.height ?? innerHeight;
		const cands = [el, ...el.querySelectorAll('*')].filter((e) => {
			const o = getComputedStyle(e).overflowY;
			return (o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 2;
		});
		const sc = cands[0] ?? null;
		if (sc) sc.setAttribute('data-pm-scroller', '1');
		return {
			top: Math.round(r.top),
			bottom: Math.round(r.bottom),
			vh: Math.round(vh),
			tall: el.scrollHeight > el.clientHeight + 2 || !!sc,
			scroller: !!sc,
			scrollTop: sc ? sc.scrollTop : 0
		};
	}, sel);
const scrollTop = (page) => page.evaluate(() => document.querySelector('[data-pm-scroller]')?.scrollTop ?? -1);

async function touchDrag(page, cdp, x, y0, y1) {
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }] });
	for (let i = 1; i <= 8; i++) {
		await nap(16);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 8, id: 1 }] });
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await nap(500);
}

h.run(async () => {
	const browser = await h.launch();
	for (const size of SIZES) {
		const P = await h.setupPage(browser, size.name, {
			context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, viewport: size.viewport }
		});
		const page = P.page;
		const cdp = await page.context().newCDPSession(page);
		const tag = (t) => `[${size.name}] ${t}`;
		const menus = [
			{ label: 'profile menu', sel: '#avatar-dropdown', open: () => page.locator('#avatar-trigger').first().tap(), close: () => page.evaluate(() => history.back()) },
			// signed out the profile menu is short; signed in (cloud plugin: account, sign-in methods, community, sponsor …)
			// it is what ran off the HONOR's screen — the same menu with 24 rows added stands in for that
			{ label: 'profile menu, signed-in length', sel: '#avatar-dropdown', pad: 24, open: () => page.locator('#avatar-trigger').first().tap(), close: () => page.evaluate(() => history.back()) },
			{ label: 'logo menu', sel: '#sidebar70', open: () => page.evaluate(() => window.__stores.closeMenu.set(false)), close: () => page.evaluate(() => window.__stores.closeMenu.set(true)) },
			{ label: 'Add menu', sel: '[role=menu].ctx-scroll', open: () => page.locator('#mobile-add-button').first().tap(), close: () => page.evaluate(() => history.back()) }
		];
		for (const m of menus) {
			await m.open();
			await h.eventually(() => page.locator(m.sel).first().isVisible().catch(() => false), (v) => v, tag(`${m.label}: opens`));
			await nap(800);
			if (m.pad)
				await page.evaluate(([sel, n]) => {
					const el = document.querySelector(sel);
					const host = el.querySelector('[role=menu]') || el;
					for (let i = 0; i < n; i++) {
						const b = document.createElement('button');
						b.textContent = 'Row ' + i;
						b.style.cssText = 'display:block;width:100%;height:40px';
						host.appendChild(b);
					}
				}, [m.sel, m.pad]);
			await nap(300);
			const a = await look(page, m.sel);
			if (m.pad) h.check(!!a?.tall, tag(`${m.label}: premise — taller than the screen now`));
			h.check(!!a && a.bottom <= a.vh + 1, tag(`${m.label}: ends inside the visible screen (${JSON.stringify(a)})`));
			h.check(!!a && a.top >= -1, tag(`${m.label}: and starts on it`));
			if (a?.tall) {
				h.check(a.scroller, tag(`${m.label}: taller than the screen → it scrolls`));
				const box = await page.locator('[data-pm-scroller]').first().boundingBox();
				if (box) {
					const x = box.x + box.width / 2;
					const before = await scrollTop(page);
					await touchDrag(page, cdp, x, box.y + box.height * 0.8, box.y + box.height * 0.25);
					const dragged = await scrollTop(page);
					h.check(dragged > before, tag(`${m.label}: a finger's drag scrolls it (${before} → ${dragged})`));
					await page.locator('[data-pm-scroller]').first().evaluate((e) => (e.scrollTop = 0));
					await page.mouse.move(x, box.y + box.height / 2);
					await page.mouse.wheel(0, 300);
					await nap(500);
					const wheeled = await scrollTop(page);
					h.check(wheeled > 0, tag(`${m.label}: and so does a wheel (${wheeled})`));
				}
			} else console.log(tag(`${m.label}: fits without scrolling (${a?.bottom - a?.top}px)`));
			await m.close();
			await nap(600);
		}
		await h.closePeer(P);
	}
	await h.finish(browser);
});
