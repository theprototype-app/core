// 41 G20 + G3a — NOTHING FLOATS OVER AN OPEN DRAWER, AND A PRESS OUTSIDE CLOSES THE MENU.
//
// G20 (the user): "when clicked on profile button on mobile and if any object selected the toolbar
// which shows move/rotate/scale/inspect shows above the drawer, fix it and also verify it is not
// happening in other cases/drawers/settings, for example same bug is when I click on burger menu".
// On the OPPO N6 FOLDED (390x896, DPR 2.9, touch), with an object SELECTED and the other floating
// chrome switched on (the physics transport of a running simulation, the FPS/draw-call meter, note
// markers in the view):
//   - every MENU (main menu, profile menu, notification centre, Connection, More, an action sheet,
//     the character studio, Settings) HIDES the selection strip while it is open, and it comes back
//     when the menu closes;
//   - every TOOL sheet (Objects, Chat, Inspector, Configure Scene, notes, Add, the docked Explorer)
//     keeps the strip ABOVE its top edge (never on it);
//   - an AUDIT: a grid of elementFromPoint probes over each open drawer finds nothing that is not
//     the drawer — no strip, no transport, no meter, no marker, no other chrome.
// Then UNFOLDED (770x850, touch) and DESKTOP (1440x900, mouse) audit the burger menu and Settings.
//
// G3a (the user): "when burger menu pressed pressing outside it should close menu". On the desktop
// (mouse) and the folded phone (touch): a press outside closes it; a press on the 3D view ONLY
// closes it (no select / deselect); a press on another control closes it AND works (one press);
// a press inside the menu keeps it open.
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOT_DIR || '';

/** @param {import('playwright').Page} page */
async function touchApi(page) {
	const cdp = await page.context().newCDPSession(page);
	return {
		tap: async (x, y) => {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
			await sleep(40);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		}
	};
}

/** in-page: probe a grid over the first visible element of `sels[0]`; every hit must be inside one
 *  of `sels` (the drawer and the window placed into it). Returns the foreign hits. */
const AUDIT = (sels) => {
	const els = sels.flatMap((s) => [...document.querySelectorAll(s)]).filter((e) => e.getBoundingClientRect().height > 0);
	const main = els[0];
	if (!main) return { error: 'no drawer ' + sels[0] };
	const r = main.getBoundingClientRect();
	const foreign = {};
	let probes = 0;
	for (let i = 0; i < 6; i++) {
		for (let j = 0; j < 14; j++) {
			const x = r.left + 6 + ((r.width - 12) * i) / 5;
			const y = r.top + 6 + ((Math.min(r.bottom, innerHeight) - r.top - 12) * j) / 13;
			const at = document.elementFromPoint(x, y);
			probes++;
			if (!at || els.some((e) => e.contains(at))) continue;
			let tag = at;
			while (tag.parentElement && !tag.id) tag = tag.parentElement;
			const name = (tag.id ? '#' + tag.id : tag.tagName) + ' > ' + (at.id || at.className?.toString?.().slice(0, 40) || at.tagName);
			foreign[name] = (foreign[name] || 0) + 1;
		}
	}
	return { probes, foreign, rect: { top: Math.round(r.top), h: Math.round(r.height) } };
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'folded', {
		context: { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}', 'perfStats:show': 'true' }
	});
	const P = A.page;
	const touch = await touchApi(P);
	const read = (expr) => P.evaluate(expr);
	const rect = (sel) =>
		P.evaluate((s) => {
			const e = [...document.querySelectorAll(s)].find((x) => x.getBoundingClientRect().height > 0);
			if (!e) return null;
			const r = e.getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom };
		}, sel);
	h.check(await read(() => document.documentElement.classList.contains('phone-shell')), 'the phone shell is mounted (N6 folded)');

	// a scene with floating chrome: a dynamic box (the simulation's transport shows), a note marker
	await P.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1200));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		s.annotationsHandler.addAnnotation(g.children[1].uuid);
		let cur;
		s.annotationsHandler.activeAnnotation.subscribe((v) => (cur = v))();
		if (cur?.draft) s.annotationsHandler.setAnnotation({ ...cur.draft, name: 'A note in the view', text: 'marker' });
		s.annotationsHandler.activeAnnotation.set(null);
	});
	await P.waitForTimeout(800);
	await P.evaluate(() => window.__stores.physics.toggleSimulation());
	await P.waitForTimeout(1500);
	const chrome = await P.evaluate(() => ({
		sim: !!document.querySelector('#sim-controls'),
		fps: !!document.querySelector('#fps-counter, .fps-counter, [data-perf-stats]'),
		simulating: (() => { let v; window.__stores.simulating?.subscribe?.((x) => (v = x))(); return v; })()
	}));
	h.check(true, `premise — floating chrome on: ${JSON.stringify(chrome)}`);

	const select = async () => {
		await P.evaluate(() => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			s.objectActions.applySelectionSet([g.children[0].uuid]);
		});
		await P.waitForTimeout(400);
	};
	const rest = async () => {
		await P.evaluate(() => {
			const s = window.__stores;
			s.phoneShell.phoneSheet.set(null);
			s.viewportMenu.set(null);
			s.objectListClose.set(true);
			s.chatHidden.set('hidden');
			s.notificationCenterOpen.set(false);
			s.notesDrawerOpen.set(false);
			s.inspectorClose.set(true);
			s.closeMenu.set(true);
			s.explorerClose.set(true);
			s.characterModalOpen.set(false);
			s.settingsOpen.set(false);
			s.toastStore.set([]);
		});
		// the profile menu's open state is Users.svelte's own: its trigger toggles it
		if (await P.evaluate(() => !!document.querySelector('#avatar-dropdown'))) await P.locator('#avatar-trigger').dispatchEvent('mousedown');
		await P.waitForTimeout(500);
	};
	const stripState = () =>
		P.evaluate(() => {
			const s = document.getElementById('ps-strip');
			if (!s) return { shown: false, why: 'not rendered' };
			const r = s.getBoundingClientRect();
			return { shown: getComputedStyle(s).display !== 'none' && r.height > 0, top: Math.round(r.top), bottom: Math.round(r.bottom) };
		});
	const tapSel = async (sel) => {
		const b = await rect(sel);
		if (b) await touch.tap(b.x + b.w / 2, b.y + b.h / 2);
	};
	const shot = async (name) => SHOTS && P.screenshot({ path: `${SHOTS}/${name}.png` });

	// ---- MENUS hide the strip -------------------------------------------------------------
	/** [name, open, drawer selectors (first = the surface), isOpen] */
	const MENUS = [
		['main menu', async () => touch.tap(34, 34), ['#sidebar70'], `!!document.querySelector('#sidebar70')`],
		['profile menu', async () => P.locator('#avatar-trigger').dispatchEvent('mousedown'), ['#avatar-dropdown'], `!!document.querySelector('#avatar-dropdown')`],
		['notification centre', async () => P.evaluate(() => window.__stores.notificationCenterOpen.set(true)), ['.ps-sheet', '[data-ps-host="top"]'], store('notificationCenterOpen')],
		['Connection', async () => tapSel('#ps-connect-chip'), ['.ps-sheet', '[data-ps-host="top"]'], `${store('phoneShell.phoneSheet')} === 'conn'`],
		['More', async () => tapSel('#ps-more'), ['.ps-sheet'], `${store('phoneShell.phoneSheet')} === 'more'`],
		['an action sheet (viewport menu)', async () => P.evaluate(() => { let o; window.__stores.viewportMenuOpener.subscribe((v) => (o = v))(); o?.(195, 300, false); }), ['.ctx-scroll[role=menu]'], `!!document.querySelector('.ctx-scroll[role=menu]')`],
		['Settings', async () => P.evaluate(() => window.__stores.settingsOpen.set(true)), ['dialog[open]'], `!!document.querySelector('dialog[open]')`]
	];
	for (const [name, open, sels, isOpen] of MENUS) {
		await rest();
		await select();
		const before = await stripState();
		h.check(before.shown, `${name}: premise — the strip shows for the selection (${JSON.stringify(before)})`);
		await open();
		await P.waitForTimeout(900);
		if (!(await read(isOpen))) { h.check(false, `${name}: opens`); continue; }
		await shot(`g20-folded-${name.replace(/\W+/g, '-')}`);
		const st = await stripState();
		h.check(!st.shown, `${name}: the selection strip is hidden while it is open (${JSON.stringify(st)})`);
		const audit = await P.evaluate(AUDIT, sels);
		h.check(!audit.error && Object.keys(audit.foreign).length === 0, `${name}: nothing floats over it (${audit.probes} probes; foreign ${JSON.stringify(audit.foreign)})`);
		await rest();
		await select();
		h.check((await stripState()).shown, `${name}: closed, the strip is back for the same selection`);
	}

	// the same, in the LIGHT theme (a visual change is shot in both)
	if (SHOTS) {
		await rest();
		await select();
		await P.evaluate(() => window.__stores.themes.theme.set('light'));
		await P.locator('#avatar-trigger').dispatchEvent('mousedown');
		await P.waitForTimeout(800);
		await shot('g20-folded-profile-menu-light');
		await rest();
		await touch.tap(34, 34);
		await P.waitForTimeout(800);
		await shot('g20-folded-main-menu-light');
		await P.evaluate(() => window.__stores.themes.theme.set('dark'));
	}

	// ---- TOOL sheets: the strip rides ABOVE them ------------------------------------------
	const TOOLS = [
		['Objects', async () => P.evaluate(() => window.__stores.objectListClose.set(false)), ['.ps-sheet', '[data-ps-host="top"]']],
		['Chat', async () => P.evaluate(() => window.__stores.chatHidden.set('')), ['.ps-sheet', '[data-ps-host="top"]']],
		['Inspector', async () => tapSel('#ps-inspect'), ['#inspector']],
		['Configure Scene', async () => P.evaluate(() => window.__stores.showSidebar('scene')), ['#inspector']],
		['scene notes', async () => P.evaluate(() => window.__stores.notesDrawerOpen.set(true)), ['#notes-drawer']],
		['Add', async () => tapSel('#ps-add'), ['.ctx-scroll[role=menu]']],
		['Explorer (dock)', async () => tapSel('#ps-explorer'), ['#explorer-list', '#ps-dock-grip']]
	];
	for (const [name, open, sels] of TOOLS) {
		await rest();
		await select();
		await open();
		await P.waitForTimeout(1000);
		const sheet = await rect(sels[0]);
		if (!sheet) { h.check(false, `${name}: opens`); continue; }
		await shot(`g20-folded-${name.replace(/\W+/g, '-')}`);
		const st = await stripState();
		h.check(st.shown && st.bottom <= sheet.top + 1, `${name}: the strip rides above the sheet's top edge, never on it (strip bottom ${st.bottom}, sheet top ${Math.round(sheet.top)})`);
		const audit = await P.evaluate(AUDIT, sels);
		h.check(!audit.error && Object.keys(audit.foreign).length === 0, `${name}: nothing floats over it (${audit.probes} probes; foreign ${JSON.stringify(audit.foreign)})`);
	}

	// ---- G3a on the phone: a tap outside closes the main menu --------------------------------
	await rest();
	await select();
	await touch.tap(34, 34);
	await P.waitForTimeout(700);
	h.check(await read(`!!document.querySelector('#sidebar70')`), 'G3a phone: the logo opens the main menu');
	const menuR = await rect('#sidebar70');
	// inside (a section label): stays open
	const lbl = await rect('#sidebar70 .side-label');
	await touch.tap(lbl.x + 20, lbl.y + lbl.h / 2);
	await P.waitForTimeout(400);
	h.check(await read(`!!document.querySelector('#sidebar70')`), 'G3a phone: a tap inside the menu keeps it open');
	// outside, on the 3D view above the sheet: closes it and does NOT deselect
	const selN = await read(`${store('selectedObjects')}.length`);
	await touch.tap(195, Math.max(70, menuR.top - 20));
	await P.waitForTimeout(600);
	h.check(!(await read(`!!document.querySelector('#sidebar70')`)), `G3a phone: a tap on the view above the menu closes it (menu top ${Math.round(menuR.top)})`);
	h.check((await read(`${store('selectedObjects')}.length`)) === selN, 'G3a phone: ...and only closes it (the selection is unchanged)');
	// outside, on a bottom-bar tab: closes the menu AND the tab works (one tap)
	await touch.tap(34, 34);
	await P.waitForTimeout(700);
	await tapSel('#ps-objects');
	await P.waitForTimeout(800);
	h.check(!(await read(`!!document.querySelector('#sidebar70')`)) && (await read(`!${store('objectListClose')}`)), 'G3a phone: a tap on the Objects tab closes the menu and opens Objects in one tap');

	await P.evaluate(() => window.__stores.physics.toggleSimulation());

	// ---- DESKTOP (mouse) + UNFOLDED (touch): G3a and the audits ---------------------------------
	for (const [label, ctx] of [
		['desktop', { viewport: { width: 1440, height: 900 } }],
		['unfolded', { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 }]
	]) {
		const B = await h.setupPage(browser, label, { context: ctx, storage: { toursSeen: '{"editor-touch":true,"editor":true}' } });
		const Q = B.page;
		const tq = ctx.hasTouch ? await touchApi(Q) : null;
		const press = async (x, y) => (tq ? tq.tap(x, y) : Q.mouse.click(x, y));
		const menuOpen = () => Q.evaluate(() => !!document.querySelector('#sidebar70'));
		await Q.evaluate(async () => {
			window.__stores.commandsHandler.sceneCommand('/create box');
			await new Promise((r) => setTimeout(r, 1000));
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			window.__stores.objectActions.applySelectionSet([g.children[0].uuid]);
		});
		await Q.waitForTimeout(600);
		const logo = await Q.evaluate(() => { const r = document.getElementById('logo-menu').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
		// a transient toast (the phone quality notice) is not chrome under test
		await Q.evaluate(() => window.__stores.toastStore.set([]));
		await press(logo.x, logo.y);
		await Q.waitForTimeout(600);
		await Q.evaluate(() => window.__stores.toastStore.set([]));
		await Q.waitForTimeout(200);
		h.check(await menuOpen(), `G3a ${label}: the logo opens the burger menu`);
		if (SHOTS) await Q.screenshot({ path: `${SHOTS}/g3a-${label}-menu-open.png` });
		const audit = await Q.evaluate(AUDIT, ['#sidebar70']);
		h.check(!audit.error && Object.keys(audit.foreign).length === 0, `G20 ${label}: nothing floats over the open burger menu (foreign ${JSON.stringify(audit.foreign)})`);
		// inside (a section label): stays open
		const lbl = await Q.evaluate(() => { const r = document.querySelector('#sidebar70 .side-label').getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; });
		await press(lbl.x, lbl.y);
		await Q.waitForTimeout(400);
		h.check(await menuOpen(), `G3a ${label}: a press inside the menu keeps it open`);
		// outside on the view: closes, selection unchanged
		const n0 = await Q.evaluate(`${store('selectedObjects')}.length`);
		await press(Math.round(ctx.viewport.width * 0.62), Math.round(ctx.viewport.height * 0.45));
		await Q.waitForTimeout(500);
		h.check(!(await menuOpen()), `G3a ${label}: a press outside on the 3D view closes the menu`);
		h.check((await Q.evaluate(`${store('selectedObjects')}.length`)) === n0, `G3a ${label}: ...and only closes it (selection ${n0} kept)`);
		// outside on another control (the notification bell): closes the menu and the bell opens in one press
		await press(logo.x, logo.y);
		await Q.waitForTimeout(500);
		const bell = await Q.evaluate(() => { const b = document.getElementById('notif-bell'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
		if (bell) {
			await press(bell.x, bell.y);
			await Q.waitForTimeout(600);
			h.check(!(await menuOpen()) && (await Q.evaluate(store('notificationCenterOpen'))), `G3a ${label}: a press on the bell closes the menu and opens the notification centre in one press`);
			await Q.evaluate(() => window.__stores.notificationCenterOpen.set(false));
		}
		// the logo still toggles (a press on it is not "outside")
		await press(logo.x, logo.y);
		await Q.waitForTimeout(500);
		await press(logo.x, logo.y);
		await Q.waitForTimeout(500);
		h.check(!(await menuOpen()), `G3a ${label}: the logo still toggles the menu shut`);
		// Settings over the selection: nothing floats over it
		await Q.evaluate(() => window.__stores.settingsOpen.set(true));
		await Q.waitForTimeout(900);
		const sa = await Q.evaluate(AUDIT, ['dialog[open]']);
		// the logo over a modal is G3b (41-modals' row: "Settings and every other modal cover the burger/logo
		// button") — reported there, left out of THIS audit so the strip/chrome check stays about G20
		const logoOver = Object.keys(sa.foreign).filter((k) => k.startsWith('#logo-menu'));
		for (const k of logoOver) delete sa.foreign[k];
		h.check(!sa.error && Object.keys(sa.foreign).length === 0, `G20 ${label}: nothing floats over Settings (foreign ${JSON.stringify(sa.foreign)}${logoOver.length ? '; the logo over it is G3b, 41-modals' : ''})`);
		await Q.evaluate(() => window.__stores.settingsOpen.set(false));
	}

	await h.finish(browser);
});
