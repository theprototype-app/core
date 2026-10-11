// 41 G22 — the user's 1.32 preview review: '"+" missing node editor, currently it only can be
// clicked as button' + the clarification: '"+" means the DOCK "+" (add/remove windows in the dock):
// on desktop it has no "Node editor", on mobile it shows.'
//
//   1  the desktop dock "+" lists EVERY window the phone "+" Windows sheet lists (one registry,
//      `dockMenu.DOCK_WINDOWS`) — read from both real surfaces, the phone's in a phone context
//   2  it includes the Node editor and the Image editor (G24)
//   3  it ADDS and REMOVES: a docked row is marked and removes; a closed one opens docked
//      (the Node editor too); a floating one is brought into the dock
//
// Real mouse on desktop, real taps on the phone. Run:
//   APP_URL=http://localhost:5404/ npm run e2e -- dock-add-registry
const h = require('./helpers.cjs');

const PHONE = { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const DESK = { viewport: { width: 1440, height: 900 } };
const STORAGE = { flowDocked: 'true', explorerDocked: 'true', flowCodeDocked: 'false' };

const S = (page, fn, arg) => page.evaluate(fn, arg);

async function openDock(page) {
	await S(page, async () => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		await new Promise((r) => setTimeout(r, 700));
		s.bottomDock.activateDock('flow');
	});
	await page.waitForTimeout(900);
}

/** a REAL click on the visible dock "+" (the id repeats per docked panel), then the menu rows */
async function plusRows(page) {
	const at = await S(page, () => {
		const b = [...document.querySelectorAll('#dock-add-view')].find((x) => x.getBoundingClientRect().width > 0);
		if (!b) return null;
		const r = b.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
	if (!at) return null;
	await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(450);
	return S(page, () =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => ({
			title: el.querySelector('.flex-1')?.textContent.trim() ?? el.textContent.trim(),
			hint: el.querySelector('.ctx-hint')?.textContent.trim() ?? '',
			checked: el.classList.contains('ctx-checked')
		}))
	);
}

async function clickRow(page, title) {
	const pt = await S(page, (title) => {
		const el = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((r) => (r.querySelector('.flex-1')?.textContent.trim() ?? '') === title);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) };
	}, title);
	if (!pt) return false;
	await page.mouse.click(pt.x, pt.y);
	await page.waitForTimeout(1000);
	return true;
}

const dockState = (page) =>
	S(page, () => {
		let o, v;
		window.__stores.bottomDock.dockOccupants.subscribe((x) => (o = x))();
		window.__stores.bottomDock.visibleDockKey.subscribe((x) => (v = x))();
		return { docked: Object.keys(o).filter((k) => o[k]?.present), visible: v };
	});

h.run(async () => {
	const browser = await h.launch();

	// ---- the phone sheet's list (floating windows off = the sheet) ------------------------
	const Ph = await h.setupPage(browser, 'phone', { context: PHONE, storage: STORAGE });
	await openDock(Ph.page);
	await Ph.page.locator('#dock-add-view:visible').first().tap();
	await Ph.page.waitForTimeout(900);
	const sheet = await S(Ph.page, () =>
		[...document.querySelectorAll('#dock-views-sheet [data-dock-view] .dvs-title')].map((el) => el.textContent.trim())
	);
	h.check(sheet.length >= 9, `premise: the phone "+" sheet lists the windows (${JSON.stringify(sheet)})`);
	await Ph.ctx.close();

	// ---- desktop ---------------------------------------------------------------------------
	const D = await h.setupPage(browser, 'desk', { context: DESK, storage: STORAGE });
	const page = D.page;
	await openDock(page);
	let rows = await plusRows(page);
	const titles = (rows ?? []).map((r) => r.title);
	await page.screenshot({ path: (process.env.OUT || '/tmp') + '/g22-desktop-plus-dark.png' });
	h.check(JSON.stringify(titles) === JSON.stringify(sheet), `1.1 the desktop "+" lists exactly the phone sheet's windows, same order (desktop ${JSON.stringify(titles)} vs phone ${JSON.stringify(sheet)})`);
	h.check(titles.includes('Node editor'), `2.1 ...the Node editor among them (${JSON.stringify(titles)})`);
	h.check(titles.includes('Image editor'), `2.2 ...and the Image editor (G24)`);
	const flowRow = (rows ?? []).find((r) => r.title === 'Node editor');
	const exRow = (rows ?? []).find((r) => r.title === 'Explorer');
	const fcRow = (rows ?? []).find((r) => r.title === 'Flow Code');
	h.check(!!flowRow?.checked && flowRow.hint === 'Remove' && !!exRow?.checked, `3.1 docked windows are marked and say Remove (${JSON.stringify([flowRow, exRow])})`);
	h.check(!!fcRow && !fcRow.checked && fcRow.hint === 'Open', `3.2 a closed one says Open (${JSON.stringify(fcRow)})`);

	// remove the Node editor from the dock through its row
	await clickRow(page, 'Node editor');
	let d = await dockState(page);
	h.check(!d.docked.includes('flow') && d.docked.includes('explorer'), `3.3 its row removes the Node editor from the dock (${JSON.stringify(d)})`);
	// ...and bring it back the same way
	rows = await plusRows(page);
	h.check((rows ?? []).find((r) => r.title === 'Node editor')?.hint === 'Open', '3.4 now its row says Open');
	await clickRow(page, 'Node editor');
	d = await dockState(page);
	h.check(d.docked.includes('flow') && d.visible === 'flow', `3.5 ...and opens it docked, in front (${JSON.stringify(d)})`);

	// a floating window: its row docks it
	await S(page, () => window.__stores.flowCodeClose.set(false));
	await page.waitForTimeout(900);
	rows = await plusRows(page);
	h.check((rows ?? []).find((r) => r.title === 'Flow Code')?.hint === 'Dock', `3.6 a floating window's row says Dock (${JSON.stringify((rows ?? []).find((r) => r.title === 'Flow Code'))})`);
	await clickRow(page, 'Flow Code');
	d = await dockState(page);
	h.check(d.docked.includes('flowcode') && !(await page.locator('#flow-code-window').count()), `3.7 ...and brings it into the dock (${JSON.stringify(d)})`);

	// light theme shot of the menu
	await S(page, () => {
		document.documentElement.dataset.theme = 'light';
		document.documentElement.classList.remove('dark');
	});
	await plusRows(page);
	await page.screenshot({ path: (process.env.OUT || '/tmp') + '/g22-desktop-plus-light.png' });
	await page.keyboard.press('Escape');

	h.check((h.pageErrors(D) || []).length === 0, `no page errors (${(h.pageErrors(D) || []).join(' | ')})`);
	await h.finish(browser);
});
