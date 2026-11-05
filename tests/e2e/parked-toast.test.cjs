// phone-polish item 5 + device-lab 2026-11-05 — THE AUTO-QUALITY CARD ON A TOUCH SCREEN. It arrives seconds after
// boot; top-centre it covered window headers, the menu and (device-lab, 718 x 587) Film's motion sheet. On a coarse
// pointer it is PARKED: at the bottom, at chrome level (every sheet, menu and window covers it), and hidden while
// Film is open (it would sit under the viewfinder's stick and record button). Desktop keeps the top-centre card.
const h = require('./helpers.cjs');
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const card = (page) =>
	page.evaluate(() => {
		const t = [...document.querySelectorAll('.tp-toast, [class*=toast]')].filter((e) => /Lowered/.test(e.textContent || '')).pop();
		if (!t) return null;
		const r = t.getBoundingClientRect();
		const parked = t.closest('.toasts-parked');
		return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, parked: !!parked, z: parked ? getComputedStyle(parked).zIndex : null, shown: getComputedStyle(parked || t).display !== 'none' };
	});
const raise = (page) => page.evaluate(() => window.__stores.showToastById('auto-quality', 'Lowered particles to keep it smooth', [{ label: 'Keep full quality', action: () => {} }]));

h.run(async () => {
	const browser = await h.launch();
	const D = await h.setupPage(browser, 'desk');
	await raise(D.page);
	await nap(500);
	const d = await card(D.page);
	h.check(!!d && !d.parked && d.top < d.vh / 2, `desktop: the card stays top-centre (${JSON.stringify(d)})`);
	await h.closePeer(D);

	const P = await h.setupPage(browser, 'touch', { context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, viewport: { width: 718, height: 587 } } });
	const page = P.page;
	await raise(page);
	await nap(500);
	const a = await card(page);
	h.check(!!a && a.parked && a.top > a.vh / 2, `touch: the card is parked at the bottom (${JSON.stringify(a)})`);
	const z = await page.evaluate(() => {
		const css = getComputedStyle(document.documentElement);
		return { chrome: parseFloat(css.getPropertyValue('--z-chrome')), sheet: parseFloat(css.getPropertyValue('--z-sheet')), popover: parseFloat(css.getPropertyValue('--z-popover')) };
	});
	h.check(!!a && Number(a.z) === z.chrome && z.chrome < z.sheet && z.chrome < z.popover, `touch: at chrome level, under sheets and menus (${a?.z} vs sheet ${z.sheet}, popover ${z.popover})`);
	// Film open → stands down
	await page.evaluate(() => document.documentElement.classList.add('film-mode'));
	await nap(200);
	const f = await card(page);
	h.check(!!f && !f.shown, `Film open: the parked card is hidden (${JSON.stringify(f)})`);
	await page.evaluate(() => document.documentElement.classList.remove('film-mode'));
	await nap(200);
	const g = await card(page);
	h.check(!!g && g.shown, 'Film closed: it is back');
	await h.closePeer(P);
	await h.finish(browser);
});
