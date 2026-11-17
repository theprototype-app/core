// 41b H1 + H2 + H5 — THE PHONE'S CONTENT PANELS ARE DOCK TABS. On a folded OPPO Find N6 (390x844,
// touch, DPR 2.9 — every tap a REAL touch through CDP Input.dispatchTouchEvent):
//
//   H1  Inspect opens the selection's properties as the "Properties" TAB of the bottom dock — the
//       report was "inspect … 'object properties' drawer are behind docked windows" — and with
//       another tab in front, Inspect brings Properties to the front instead of a drawer behind it;
//       Objects, Notes, Configure Scene and Layouts are tabs of the same strip (one height, one
//       grab bar); the one Inspector element shows the kind of the tab in front; a tab's ✕ closes
//       its panel; the dock "+" sheet lists the five; Notes (and a note card) never cover the raised
//       Play circle; a content tab never undocks into a window it does not have;
//       POSTURE ROUND TRIP: folded tabs -> unfolded (770x850) / desktop (1440x900) homes (the
//       Inspector drawer, the floating Objects window, the notes drawer) -> folded again: the same
//       tabs, the same one in front; what you closed on the wide screen stays closed.
//   H2  burger ▸ Configure Scene closes the burger on the phone, and keeps it open on a desktop.
//   H5  a bar tap on the view that is on screen MINIMIZES the dock (tap again: back); with undocking
//       on and the view floating, the tap opens / closes that window.
// Counterfactual: red on feat/41-int (no content tabs: Inspect opens the sheet drawer, the bar's
// second tap CLOSES the Explorer, the burger stays open, the note card covers Play).
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__tp.test.v1.${name}.subscribe((x) => (v = x))(); return v; })()`;

/** @param {import('playwright').Page} page */
async function touchApi(page) {
	const cdp = await page.context().newCDPSession(page);
	const tap = async (/** @type {number} */ x, /** @type {number} */ y) => {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
		await new Promise((r) => setTimeout(r, 40));
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	};
	return { tap };
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'folded', {
		context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const P = A.page;
	const touch = await touchApi(P);
	const read = (/** @type {string|Function} */ expr) => P.evaluate(/** @type {any} */ (expr));
	/** the centre of a visible element, or null */
	const centre = (/** @type {string} */ sel) =>
		P.evaluate((s) => {
			// every docked panel renders its own tab strip (the hidden ones display:none): the VISIBLE one,
			// scrolled into view (a long strip scrolls sideways)
			const e = [...document.querySelectorAll(s)].find((x) => /** @type {HTMLElement} */ (x).getClientRects().length > 0);
			if (!e) return null;
			e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			const r = e.getBoundingClientRect();
			return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
		}, sel);
	const tapOn = async (/** @type {string} */ sel, wait = 650) => {
		const c = await centre(sel);
		if (!c) throw new Error('nothing to tap: ' + sel);
		await touch.tap(c.x, c.y);
		await P.waitForTimeout(wait);
	};
	const dock = () =>
		read(() => {
			const s = window.__tp?.test.v1;
			const g = (/** @type {any} */ x) => {
				let v;
				x.subscribe((/** @type {any} */ y) => (v = y))();
				return v;
			};
			const r = (/** @type {string} */ q) => {
				const e = document.querySelector(q);
				if (!e) return null;
				const b = e.getBoundingClientRect();
				return b.width && b.height ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right } : null;
			};
			return {
				vis: g(s.bottomDock.visibleDockKey),
				min: g(s.bottomDock.dockMinimized),
				tabs: g(s.bottomDock.dockTabs).map((/** @type {any} */ t) => t.key),
				insClosed: g(s.inspectorClose),
				kind: g(s.inspectorKind),
				objClosed: g(s.objectListClose),
				notes: g(s.notesDrawerOpen),
				layouts: g(s.uiLayouts.layoutsMenuOpen),
				inspector: r('#inspector'),
				objectList: r('#object-list'),
				notesDrawer: r('#notes-drawer'),
				frame: r('#phone-dock'),
				bar: r('#ps-bar')
			};
		});
	const quiet = () => read(() => window.__tp.test.v1.toastStore.set([]));

	const shell = await read(() => document.documentElement.classList.contains('phone-shell'));
	h.check(shell, 'folded N6 (390x844): the phone shell is mounted');
	await read(async () => {
		const s = window.__tp?.test.v1;
		s.commandsHandler.sceneCommand('/create box');
		for (let t = 0; t < 60; t++) {
			let g;
			s.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			if (g?.children?.length) {
				s.objectActions.applySelectionSet([g.children[0].uuid]);
				break;
			}
			await new Promise((r) => setTimeout(r, 150));
		}
		s.toastStore.set([]);
	});
	await P.waitForTimeout(700);

	// ---- 1. Inspect = the Properties tab -------------------------------------------------------
	await tapOn('#ps-inspect', 900);
	let d = await dock();
	h.check(d.tabs.includes('properties') && d.vis === 'properties', `Inspect opens the "Properties" dock tab, in front (tabs ${d.tabs.join(',')}, front ${d.vis})`);
	h.check(!d.insClosed && d.kind === 'selection', 'the Inspector shows the selection');
	h.check(!!d.inspector && !!d.frame && !!d.bar && d.inspector.top >= d.frame.top - 1 && Math.abs(d.inspector.bottom - d.bar.top) <= 2, `the properties sit IN the dock frame, ending at the bar (inspector ${JSON.stringify(d.inspector)}, frame top ${d.frame?.top}, bar top ${d.bar?.top})`);
	const tabLabel = await read(() => [...document.querySelectorAll('[data-dock-tab="properties"]')].find((x) => x.getClientRects().length)?.textContent?.trim());
	h.check(tabLabel === 'Properties', `the tab is named "Properties" (${tabLabel})`);
	h.check((await read(() => document.querySelector('#ps-inspect')?.getAttribute('aria-pressed'))) === 'true', 'Inspect reads pressed while Properties is in front');

	// another docked view in front: Inspect FOCUSES the properties (the reported bug: a drawer behind it)
	await tapOn('#ps-explorer', 1200);
	d = await dock();
	h.check(d.vis === 'explorer' && d.tabs.includes('properties'), `the Explorer in front, Properties still a tab (front ${d.vis})`);
	h.check(d.inspector === null, 'the covered Properties tab is hidden (not a drawer behind the dock)');
	h.check((await read(() => document.querySelector('#ps-inspect')?.getAttribute('aria-pressed'))) === 'false', 'Inspect reads unpressed while Properties is covered');
	await tapOn('#ps-inspect', 800);
	d = await dock();
	h.check(d.vis === 'properties' && !d.insClosed && !!d.inspector, `Inspect brings Properties to the front (front ${d.vis})`);
	h.check(d.tabs.includes('explorer'), 'the Explorer stays a tab behind it');

	// ---- 2. Objects / Notes / Configure Scene / Layouts are tabs of the same strip ----------------
	await tapOn('#ps-objects', 900);
	d = await dock();
	h.check(d.vis === 'objects' && !d.objClosed, `the bar's Objects opens the "Objects" tab (front ${d.vis})`);
	h.check(!!d.objectList && !!d.frame && d.objectList.top >= d.frame.top - 1 && Math.abs(d.objectList.bottom - d.bar.top) <= 2, 'the object list sits in the dock frame (not a sheet of its own)');
	h.check((await read(() => document.querySelector('.ps-sheet[data-kind="objects"]'))) === null, 'no framed Objects sheet any more');
	await tapOn('#ps-more', 500);
	await tapOn('#ps-tile-notes', 900);
	d = await dock();
	h.check(d.vis === 'notes' && d.notes && !!d.notesDrawer && d.notesDrawer.top >= d.frame.top - 1, `More ▸ Notes opens the "Notes" tab in the dock (front ${d.vis})`);
	h.check(d.tabs.includes('properties') && d.tabs.includes('objects') && !d.insClosed, 'opening the notes keeps the Properties tab (no more "one sheet at a time")');
	await tapOn('#ps-more', 500);
	await tapOn('#ps-tile-scene', 900);
	d = await dock();
	h.check(d.vis === 'scene' && d.kind === 'scene' && !!d.inspector, `More ▸ Scene opens the "Configure Scene" tab, the Inspector showing the scene (front ${d.vis}, kind ${d.kind})`);
	h.check(d.tabs.includes('properties') && d.tabs.includes('scene'), 'Properties and Configure Scene are TWO tabs');
	await tapOn('[data-dock-tab="properties"]', 700);
	d = await dock();
	h.check(d.vis === 'properties' && d.kind === 'selection', `the Properties tab shows the selection again (kind ${d.kind})`);
	await tapOn('[data-dock-tab="scene"]', 700);
	d = await dock();
	h.check(d.vis === 'scene' && d.kind === 'scene', 'and the Configure Scene tab the scene');
	// Layouts through the dock "+" (the G22 registry's phone rows)
	await tapOn('#dock-add-view', 900);
	const sheetRows = await read(() => [...document.querySelectorAll('#dock-views-sheet [data-dock-view]')].map((e) => /** @type {HTMLElement} */ (e).dataset.dockView));
	h.check(['properties', 'objects', 'notes', 'layouts', 'scene'].every((k) => sheetRows.includes(k)), `the dock "+" sheet lists the five content tabs (${sheetRows.join(',')})`);
	await tapOn('#dock-view-toggle-layouts', 900);
	await read(() => document.querySelector('#dock-views-sheet')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
	await read(() => {
		// close the sheet the way its scrim does
		const scrim = /** @type {HTMLElement|null} */ (document.querySelector('.sh-scrim'));
		scrim?.click();
	});
	await P.waitForTimeout(600);
	d = await dock();
	const layoutsBody = await read(() => !!document.querySelector('#phone-dock-layouts'));
	const layoutsDialog = await read(() => !!document.querySelector('dialog#layouts-menu[open], #layouts-menu[open]'));
	h.check(d.vis === 'layouts' && d.layouts && layoutsBody, `Layouts is a dock tab with the layouts list in it (front ${d.vis})`);
	h.check(!layoutsDialog, 'and the full-screen Layouts dialog does not open on the phone');

	// ---- 3. a tab's ✕ closes its panel; no undock for a content tab ------------------------------
	await tapOn('[data-dock-tab-close="layouts"]', 700);
	d = await dock();
	h.check(!d.layouts && !d.tabs.includes('layouts'), 'the Layouts tab ✕ closes it');
	await tapOn('[data-dock-tab-close="scene"]', 900);
	d = await dock();
	h.check(!d.tabs.includes('scene') && d.tabs.includes('properties') && !d.insClosed, `the Configure Scene ✕ closes that tab only — Properties stays (tabs ${d.tabs.join(',')})`);
	const menuRows = await read(() => window.__tp.test.v1.dockMenu.dockTabItems('properties').map((/** @type {any} */ i) => i.label));
	h.check(!menuRows.some((/** @type {string} */ l) => /undock/i.test(l)), `a content tab's menu offers no Undock (${menuRows.join(' · ')})`);

	// ---- 4. nothing covers the raised Play circle ------------------------------------------------
	await tapOn('[data-dock-tab="notes"]', 700);
	const playHit = () =>
		read(() => {
			const p = document.querySelector('#ps-play .ps-live') ?? document.querySelector('#ps-play');
			if (!p) return 'no play';
			const r = p.getBoundingClientRect();
			const at = document.elementFromPoint(r.left + r.width / 2, r.top + 3);
			return at && at.closest('#ps-play') ? 'play' : (at?.id || at?.className?.toString?.() || 'nothing');
		});
	h.check((await playHit()) === 'play', `the Notes tab leaves the raised Play circle on top (${await playHit()})`);
	const noteId = await read(() => {
		const s = window.__tp?.test.v1;
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		const ah = s.annotationsHandler;
		ah.addAnnotation(g.children[0].uuid, [0, 1.2, 0]);
		let cur;
		ah.activeAnnotation.subscribe((/** @type {any} */ v) => (cur = v))();
		ah.setAnnotation({ ...cur.draft, name: 'Dock note', text: 'over the Play circle?' });
		ah.activeAnnotation.set(null);
		let list;
		ah.annotations.subscribe((/** @type {any} */ v) => (list = v))();
		return list[list.length - 1].id;
	});
	await P.waitForTimeout(400);
	await P.evaluate((id) => window.__tp.test.v1.annotationsHandler.openAnnotation(id, 'view'), noteId);
	await P.waitForTimeout(800);
	const card = await read(() => {
		const c = document.querySelector('.note-card');
		const f = document.querySelector('#phone-dock');
		if (!c || !f) return null;
		const a = c.getBoundingClientRect();
		const b = f.getBoundingClientRect();
		return { top: a.top, bottom: a.bottom, frameTop: b.top };
	});
	h.check(!!card && card.top >= card.frameTop - 1, `a note opened from the Notes tab is a page of it (card top ${card?.top}, frame top ${card?.frameTop})`);
	h.check((await playHit()) === 'play', `…and the note card does not cover the Play circle either (${await playHit()})`);
	await read(() => window.__tp.test.v1.annotationsHandler.activeAnnotation.set(null));
	await P.waitForTimeout(500);
	d = await dock();
	h.check(d.vis === 'notes' && d.tabs.includes('properties'), 'closing the note returns to the Notes tab, Properties still there');

	// ---- 5. H5: the bar tap on the view on screen minimizes ----------------------------------------
	await tapOn('#ps-objects', 700);
	d = await dock();
	h.check(d.vis === 'objects' && !d.min, 'Objects in front');
	await tapOn('#ps-objects', 700);
	d = await dock();
	h.check(d.min && !d.objClosed && d.tabs.includes('objects'), `a second Objects tap MINIMIZES the dock — every tab stays open (min ${d.min}, objects open ${!d.objClosed})`);
	h.check(d.objectList === null && d.inspector === null, 'nothing renders while minimized');
	await tapOn('#ps-objects', 700);
	d = await dock();
	h.check(!d.min && d.vis === 'objects', 'a third tap brings it back');
	await tapOn('#ps-explorer', 900);
	d = await dock();
	h.check(d.vis === 'explorer' && !d.min, 'the bar Explorer brings the docked Explorer to the front');
	await tapOn('#ps-explorer', 700);
	d = await dock();
	const explorerClosed = await read(store('explorerClose'));
	h.check(d.min && !explorerClosed, `a second Explorer tap minimizes the dock instead of closing the Explorer (min ${d.min}, closed ${explorerClosed})`);
	await tapOn('#ps-explorer', 700);
	// undocking on + the Explorer floating: the tap toggles that window
	await read(() => window.__tp.test.v1.mobileUndockAllowed.set(true));
	await read(() => window.__tp.test.v1.bottomDock.armDockMode('explorer', false));
	await P.waitForTimeout(900);
	const floatingUp = () => read(() => !!document.querySelector('#explorer-window') && (() => { let v; window.__tp.test.v1.explorerClose.subscribe((x) => (v = x))(); return !v; })());
	h.check(await floatingUp(), 'undocking on: the Explorer floats');
	await tapOn('#ps-explorer', 700);
	h.check(!(await floatingUp()), 'the bar tap closes the floating Explorer');
	await tapOn('#ps-explorer', 900);
	h.check(await floatingUp(), 'and the next tap opens it again (floating)');
	await read(() => {
		window.__tp.test.v1.bottomDock.armDockMode('explorer', true);
		window.__tp.test.v1.mobileUndockAllowed.set(false);
	});
	await P.waitForTimeout(700);

	// ---- 6. H2: burger ▸ Configure Scene closes the burger on the phone -----------------------------
	await quiet();
	await tapOn('#logo-menu', 800);
	h.check((await read(store('closeMenu'))) === false, 'the burger menu is open');
	const sceneRow = await read(() => {
		const row = [...document.querySelectorAll('#sidebar70 .side-row')].find((b) => /Configure Scene/.test(b.textContent ?? ''));
		row?.setAttribute('data-test', 'cfg-scene');
		return !!row;
	});
	h.check(sceneRow, 'it has Configure Scene');
	await tapOn('[data-test="cfg-scene"]', 900);
	d = await dock();
	h.check((await read(store('closeMenu'))) === true, 'tapping Configure Scene CLOSES the burger on the phone (H2)');
	h.check(d.vis === 'scene' && d.kind === 'scene', `and Configure Scene is the tab in front (front ${d.vis})`);

	// ---- 7. posture round trip ------------------------------------------------------------------
	// folded: Properties, Objects, Configure Scene, Notes (in front)
	await tapOn('[data-dock-tab="notes"]', 700);
	d = await dock();
	const foldedTabs = d.tabs.filter((/** @type {string} */ k) => ['properties', 'objects', 'notes', 'scene'].includes(k));
	h.check(foldedTabs.length === 4 && d.vis === 'notes', `folded: four content tabs, Notes in front (${d.tabs.join(',')})`);
	await P.setViewportSize({ width: 770, height: 850 });
	await P.waitForTimeout(1500);
	d = await dock();
	h.check((await read(() => document.documentElement.classList.contains('phone-shell'))) === false, 'unfolded (770x850): the desktop layout');
	h.check(!d.tabs.some((/** @type {string} */ k) => ['properties', 'objects', 'notes', 'layouts', 'scene'].includes(k)), `no content tab is left in the dock (${d.tabs.join(',')})`);
	h.check(d.notes && !!d.notesDrawer && d.notesDrawer.right >= 769 && d.notesDrawer.left > 300, `Notes (in front on the phone) is the right-hand notes drawer (${JSON.stringify(d.notesDrawer)})`);
	h.check(!d.objClosed && !!d.objectList && d.objectList.bottom < 840, 'Objects is the floating object-list window');
	await P.setViewportSize({ width: 390, height: 844 });
	await P.waitForTimeout(1500);
	d = await dock();
	h.check(['properties', 'objects', 'notes', 'scene'].every((k) => d.tabs.includes(k)) && d.vis === 'notes', `folded again: the same four tabs, Notes in front (${d.tabs.join(',')}, front ${d.vis})`);
	await tapOn('[data-dock-tab="properties"]', 700);
	d = await dock();
	h.check(d.vis === 'properties' && d.kind === 'selection', `folded: Properties tapped to the front (front ${d.vis})`);
	await P.setViewportSize({ width: 1440, height: 900 });
	await P.waitForTimeout(1500);
	d = await dock();
	h.check(!d.insClosed && d.kind === 'selection' && !!d.inspector && d.inspector.right >= 1439, `desktop (1440x900): Properties (in front) is the right Inspector drawer (${JSON.stringify({ closed: d.insClosed, kind: d.kind, ins: d.inspector, notes: d.notes })})`);
	h.check(!d.notes, 'the notes drawer waits (the right column holds one drawer)');
	await read(() => window.__tp.test.v1.objectListClose.set(true));
	await P.waitForTimeout(400);
	await P.setViewportSize({ width: 390, height: 844 });
	await P.waitForTimeout(1500);
	d = await dock();
	h.check(d.vis === 'properties' && d.tabs.includes('notes') && d.tabs.includes('scene'), `folded: Properties in front, Notes + Configure Scene back as tabs (${d.tabs.join(',')})`);
	h.check(!d.tabs.includes('objects') && d.objClosed, 'Objects, closed on the desktop, stays closed');

	// ---- 8. a desktop page: none of it leaks; the burger stays open on Configure Scene (H2) ----------
	const D = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 1440, height: 900 } }, storage: { toursSeen: '{"editor":true}' } });
	const DP = D.page;
	await DP.evaluate(() => window.__tp.test.v1.toastStore.set([]));
	await DP.click('#logo-menu');
	await DP.waitForTimeout(600);
	await DP.evaluate(() => {
		const row = [...document.querySelectorAll('#sidebar70 .side-row')].find((b) => /Configure Scene/.test(b.textContent ?? ''));
		row?.setAttribute('data-test', 'cfg-scene');
	});
	await DP.click('[data-test="cfg-scene"]');
	await DP.waitForTimeout(800);
	const dk = await DP.evaluate(() => {
		const s = window.__tp?.test.v1;
		const g = (/** @type {any} */ x) => {
			let v;
			x.subscribe((/** @type {any} */ y) => (v = y))();
			return v;
		};
		return { menuOpen: !g(s.closeMenu), insOpen: !g(s.inspectorClose), kind: g(s.inspectorKind), tabs: g(s.bottomDock.dockTabs).map((/** @type {any} */ t) => t.key), addRows: s.dockMenu.dockAddItems().map((/** @type {any} */ i) => i.key), frame: !!document.querySelector('#phone-dock') };
	});
	h.check(dk.menuOpen && dk.insOpen && dk.kind === 'scene', 'desktop: Configure Scene opens the drawer and the burger STAYS open (H2 is phone-only)');
	h.check(!dk.frame && !dk.tabs.some((/** @type {string} */ k) => ['properties', 'objects', 'notes', 'layouts', 'scene'].includes(k)), 'desktop: no phone dock frame, no content tab');
	// 42 I6: the Objects list is in the desktop "+" again — as a HOSTED floating window, not a phone tab
	h.check(!dk.addRows.some((/** @type {string} */ k) => ['properties', 'notes', 'layouts', 'scene'].includes(k)), `desktop: the dock "+" menu does not list the phone-only content tabs (${dk.addRows.join(',')})`);

	await h.finish(browser);
});
