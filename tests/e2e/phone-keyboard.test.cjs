// phone-polish item 2 — KEYBOARD-AWARE DIALOGS on a touch screen.
//
// Two halves, because headless Chromium has no on-screen keyboard:
//  1. NO UNBIDDEN KEYBOARD: Layouts, Report a problem and the command palette opened by touch focus
//     no text field (a focused field is what raised the keyboard over Save/Close on the HONOR).
//  2. THE INSET: with the keyboard's footprint published the way lib/ui/keyboardInset.js publishes it
//     (--kb-inset/--kb-top + :root.kb-open — the HONOR measured 587 → 251 px visible, 336 px of
//     keyboard), each dialog's box and its buttons end ABOVE the keyboard. The publisher's own
//     arithmetic is the unit test (keyboardInset.test.js); the real keyboard is the HONOR re-run.
const h = require('./helpers.cjs');

const SIZES = [
	{ name: 'folded', viewport: { width: 390, height: 844 }, kb: 360 },
	{ name: 'unfolded', viewport: { width: 718, height: 587 }, kb: 336 }
];
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const focusedText = (page) =>
	page.evaluate(() => {
		const a = document.activeElement;
		if (!a) return null;
		const t = a.tagName;
		const text = t === 'TEXTAREA' || (t === 'INPUT' && !/^(button|checkbox|radio|range|color|file|submit|reset|image|hidden)$/i.test(a.type));
		return text ? a.id || a.className || t : null;
	});
const keyboard = (page, px) =>
	page.evaluate((px) => {
		const r = document.documentElement;
		r.style.setProperty('--kb-inset', px + 'px');
		r.style.setProperty('--kb-top', '0px');
		r.classList.toggle('kb-open', px > 0);
	}, px);
/** the box and the lowest visible button of a surface, in css px */
const measure = (page, sel) =>
	page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const btns = [...el.querySelectorAll('button')].filter((b) => {
			const q = b.getBoundingClientRect();
			return q.width && q.height && getComputedStyle(b).visibility !== 'hidden';
		});
		const lowest = Math.max(0, ...btns.map((b) => b.getBoundingClientRect().bottom));
		return { top: Math.round(r.top), bottom: Math.round(r.bottom), lowest: Math.round(lowest), vh: innerHeight };
	}, sel);

h.run(async () => {
	const browser = await h.launch();
	for (const size of SIZES) {
		const P = await h.setupPage(browser, size.name, {
			context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, viewport: size.viewport }
		});
		const page = P.page;
		const tag = (t) => `[${size.name}] ${t}`;
		const phone = size.viewport.width <= 640;

		const cases = [
			{ label: 'command palette', sel: '#command-palette', open: () => page.evaluate(() => window.__stores.commandPaletteOpen.set(true)), close: () => page.evaluate(() => window.__stores.commandPaletteOpen.set(false)) },
			{ label: 'Report a problem', sel: '#problem-report', open: () => page.evaluate(() => window.__stores.problemReport.openProblemReport()), close: () => page.evaluate(() => window.__stores.problemReport.closeProblemReport(null)) }
		];
		// on a phone the Layouts list is a dock tab, not a dialog
		if (!phone)
			cases.push({ label: 'Layouts', sel: '#layouts-menu', open: () => page.evaluate(() => window.__stores.uiLayouts.layoutsMenuOpen.set(true)), close: () => page.evaluate(() => window.__stores.uiLayouts.layoutsMenuOpen.set(false)) });

		for (const c of cases) {
			await c.open();
			await h.eventually(() => page.locator(c.sel).first().isVisible().catch(() => false), (v) => v, tag(`${c.label}: opens`));
			await nap(400);
			const f = await focusedText(page);
			h.check(f === null, tag(`${c.label}: no text field focused on open (keyboard stays down; focused=${f})`));

			await keyboard(page, size.kb);
			await nap(300);
			const m = await measure(page, c.sel);
			const limit = size.viewport.height - size.kb + 1;
			h.check(!!m && m.bottom <= limit, tag(`${c.label}: the box ends above the keyboard (${JSON.stringify(m)}, limit ${limit})`));
			h.check(!!m && m.top >= 0, tag(`${c.label}: and its top is on screen`));
			await keyboard(page, 0);
			await nap(200);
			const back = await measure(page, c.sel);
			h.check(!!back && back.bottom >= (m?.bottom ?? 0), tag(`${c.label}: keyboard down → its room comes back (${back?.bottom})`));
			await c.close();
			await nap(400);
		}
		await h.closePeer(P);
	}
	await h.finish(browser);
});
