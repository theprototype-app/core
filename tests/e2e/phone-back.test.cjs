// phone-polish item 1 — ANDROID BACK CLOSES THE TOP SURFACE (it used to leave the app from every
// panel, menu and modal: the HONOR touch audit, 2026-11-05).
//
// Back is the browser's history back. On a phone the hardware button and `history.back()` are
// the same thing to the page — a popstate — so the checks drive `page.goBack()` (a shallow
// entry: same URL, no navigation) and read the result from the DOM and the app's own stack
// (`__stores.backStack.backStackState()`), never from a flag the test sets.
//
// Two sizes: a folded phone (390x844, the phone shell) and the HONOR unfolded (718x587).
const h = require('./helpers.cjs');

const SIZES = [
	{ name: 'folded', viewport: { width: 390, height: 844 } },
	{ name: 'unfolded', viewport: { width: 718, height: 587 } }
];
const ctxFor = (s) => ({ hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, viewport: s.viewport });

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const stack = (page) => page.evaluate(() => window.__stores.backStack.backStackState());
const set = (page, name, v) => page.evaluate(([n, v]) => window.__stores[n].set(v), [name, v]);
const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
/** Back, as the hardware button does it: one history step, no navigation expected */
/** Explorer up, whatever posture: on a phone a Back MINIMIZES the dock (the bar tap's rule), so
 *  re-opening there means un-minimizing too */
const openExplorer = (page) =>
	page.evaluate(() => {
		window.__stores.explorerClose.set(false);
		window.__stores.bottomDock.dockMinimized.set(false);
	});
const back = async (page) => {
	await page.evaluate(() => history.back());
	await nap(500);
};

async function surface(page, label, open, sel) {
	await open();
	await h.eventually(() => visible(page, sel), (v) => v, `${label}: opens`);
	await h.eventually(() => stack(page), (v) => v.open.length > 0 && v.onTop, `${label}: joins the Back stack`);
	const url = page.url();
	await back(page);
	h.check(!(await visible(page, sel)), `${label}: Back closes it`);
	h.check(page.url() === url, `${label}: and stays in the app (${page.url()})`);
	await h.eventually(() => stack(page), (v) => v.open.length === 0 && !v.marker && !v.onTop, `${label}: the marker is spent`);
}

h.run(async () => {
	const browser = await h.launch();
	for (const size of SIZES) {
		const P = await h.setupPage(browser, size.name, { context: ctxFor(size) });
		const page = P.page;
		const tag = (t) => `[${size.name}] ${t}`;

		// the premise: nothing open at boot = no marker, so Back still leaves as it always did
		const boot = await stack(page);
		h.check(boot.open.length === 0 && !boot.marker, tag(`nothing registered at boot (open=${JSON.stringify(boot.open)})`));

		await surface(page, tag('command palette'), () => set(page, 'commandPaletteOpen', true), '#command-palette');
		await surface(page, tag("What's new"), () => page.evaluate(() => window.__stores.whatsNew.openWhatsNew()), '#whats-new-window');
		await surface(page, tag('main menu'), () => set(page, 'closeMenu', false), '#sidebar70');
		await surface(page, tag('Explorer'), () => openExplorer(page), '#explorer-list');
		await surface(page, tag('Chat (mounted while hidden)'), () => set(page, 'chatHidden', ''), '#chat-window');

		// a context menu, opened by a tap the way a thumb does
		const addBtn = (await visible(page, '#mobile-add-button')) ? '#mobile-add-button' : null;
		if (addBtn) await surface(page, tag('Add menu (tap +)'), () => page.locator(addBtn).tap(), '[role=menu].ctx-scroll');

		// TWO surfaces: Back closes only the top one, the next Back the other
		await openExplorer(page);
		await h.eventually(() => visible(page, '#explorer-list'), (v) => v, tag('Explorer re-opened'));
		await set(page, 'commandPaletteOpen', true);
		await h.eventually(() => stack(page), (v) => v.open.length >= 2, tag('two on the stack'));
		await back(page);
		h.check(!(await visible(page, '#command-palette')) && (await visible(page, '#explorer-list')), tag('Back closes the palette and leaves Explorer open'));
		await h.eventually(() => stack(page), (v) => v.onTop, tag('the marker is back for Explorer'));
		const one = await stack(page);
		h.check(one.open.length >= 1, tag(`Explorer still registered (${JSON.stringify(one.open)})`));
		await back(page);
		h.check(!(await visible(page, '#explorer-list')), tag('the second Back closes Explorer'));

		// closed by its own ✕: the marker comes back off, so the next Back is the user's
		await openExplorer(page);
		await h.eventually(() => stack(page), (v) => v.onTop, tag('Explorer: marker up'));
		await set(page, 'explorerClose', true);
		await h.eventually(() => stack(page), (v) => !v.marker && !v.onTop && !v.spending, tag('closed another way: the marker is spent'));

		// PLAY keeps its own Back: open Explorer, play, Back exits play, Back closes Explorer
		if (size.name === 'unfolded') {
			await openExplorer(page);
			await h.eventually(() => stack(page), (v) => v.onTop, tag('Explorer up before play'));
			await page.evaluate(() => window.__stores.playMode.requestPlay());
			await h.eventually(() => page.evaluate(() => window.__stores.playMode.playBackMarker()), (v) => v, tag('play pushed its own marker'));
			await back(page);
			await h.eventually(() => page.evaluate(() => new Promise((r) => window.__stores.isLocked.subscribe((v) => r(v))())), (v) => v !== true, tag('Back exits play first'));
			await nap(600);
			const mid = await stack(page);
			h.check(mid.onTop && mid.open.length >= 1, tag(`after play, Explorer's marker is the top entry again (${JSON.stringify(mid)})`));
			await back(page);
			h.check(!(await visible(page, '#explorer-list')), tag('then Back closes Explorer'));
		}
		await h.closePeer(P);
	}
	await h.finish(browser);
});
