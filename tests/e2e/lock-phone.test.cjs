// 80a: locks on a phone (390 x 844, touch). H holds the crate on a desktop, P views it on a phone.
// The held banner, its Request control and the Object list chip fit the screen, the controls are
// big enough to press, and nothing scrolls the page sideways.
const h = require('./helpers.cjs');

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const rectOf = (page, sel) =>
	page.evaluate((s) => {
		const el = document.querySelector(s);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height };
	}, sel);
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const P = await h.setupPage(browser, 'P', { context: PHONE });
	// the desktop dials the phone (the phone pill keeps its dial field behind a tap)
	await h.connect(H, P);
	const X = await H.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'Crate';
		s.peers.subscribe((p) => p.send({ type: 'name', uuid: box.uuid, name: 'Crate' }))();
		s.objectActions.selectObject(box.uuid);
		return box.uuid;
	});
	await h.eventually(() => P.page.evaluate((u) => window.__tp.test.v1.lockHeld.holderNow(u), X), (v) => v === H.id, 'P sees H holding the crate');

	// Properties on the phone
	await P.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u, true), X);
	await h.eventually(() => rectOf(P.page, '#held-banner'), (r) => !!r && r.w > 0, 'the held banner shows on the phone');
	const banner = await rectOf(P.page, '#held-banner');
	h.check(banner.l >= 0 && banner.r <= 390 + 0.5, `the banner fits the width (${Math.round(banner.l)}..${Math.round(banner.r)})`);
	const req = await rectOf(P.page, '#held-banner-request');
	h.check(!!req && req.h >= 24 && req.w >= 24, `Request is big enough to press (${req && Math.round(req.w)}x${req && Math.round(req.h)})`);
	h.check(!!req && req.r <= 390 + 0.5, 'and on screen');
	h.check((await sideways(P.page)) <= 1, 'the page does not scroll sideways');
	await P.page.screenshot({ path: `test-results/80a-locks/lock-phone-banner.png` }).catch(() => {});

	// the Object list chip
	await P.page.evaluate(() => window.__tp.test.v1.objectListClose.set(false));
	await h.eventually(() => P.page.evaluate((u) => document.getElementById(u)?.querySelector('.held-chip')?.getAttribute('data-held') ?? null, X), (v) => v === 'other', 'the row carries the chip');
	const fits = await P.page.evaluate((u) => {
		const row = document.getElementById(u);
		const c = row?.querySelector('.held-chip');
		if (!row || !c) return null;
		const a = row.getBoundingClientRect();
		const b = c.getBoundingClientRect();
		return { inRow: b.left >= a.left - 0.5 && b.right <= a.right + 0.5, onScreen: b.right <= window.innerWidth + 0.5, text: c.textContent.trim() };
	}, X);
	h.check(!!fits && fits.inRow && fits.onScreen, `the chip fits its row (${JSON.stringify(fits)})`);
	h.check((await sideways(P.page)) <= 1, 'still no sideways scroll');
	await P.page.screenshot({ path: `test-results/80a-locks/lock-phone-list.png` }).catch(() => {});

	await h.finish(browser);
});
