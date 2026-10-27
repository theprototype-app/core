// 42 I5 — THE PHONE BAR IS ARRANGED FROM MORE (preview-1-32c review). On the folded OPPO N6
// (390x896, touch, DPR 2.9), every gesture a REAL touch (CDP Input.dispatchTouchEvent):
//   - "Edit bar…" is gone (no page, no row, no Play-menu row); More is where the bar is arranged:
//     hold an item in More and drag it onto the bar, hold a bar item and drag it along the bar or
//     up into More to take it off — Play included, which then waits in More ▸ Windows;
//   - with More closed nothing drags: a swipe along the bar does nothing, a long press on a bar
//     item opens More and picks it up in one gesture, Play's long press stays Play's menu (41b H6/H7);
//   - More ▸ Windows starts Add, More, Objects, Statistics; More ▸ Edit holds Inspect, Move, Rotate,
//     Scale (+ Undo, Redo, Select multiple, Interact mode); "Tools & View" is a tile; all placeable,
//     and a placed tool works from the bar;
//   - up to seven items: labelled at five, icons-only at six and seven (each >= 44 px), an eighth is
//     refused, and the last item never leaves;
//   - the helper line sits at More's bottom edge; the three switches at More's bottom hide the
//     selection strip, the dock's tab row, and the grab handle (the invisible edge still resizes,
//     the tap-to-resize goes with the handle);
//   - the 38 R9 / 41b records (phoneBarSlots + phoneBarPlayAt) migrate once into `phoneBar`;
//   - the bar survives a reload and a fold → unfold → fold.
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;
const FOLDED = { width: 390, height: 896 };
const PHONE = (storage = {}) => ({
	context: { viewport: FOLDED, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
	storage: { toursSeen: '{"editor-touch":true,"editor":true}', ...storage }
});

h.run(async () => {
	const browser = await h.launch();

	// ---- the 41b records migrate --------------------------------------------------------------
	{
		const M = await h.setupPage(browser, 'migrate', PHONE({ phoneBarSlots: '["add","objects","chat"]', phoneBarPlayAt: '0' }));
		const got = await M.page.evaluate(() => ({
			bar: [...document.querySelectorAll('#ps-bar [data-bar-item]')].map((b) => b.dataset.barItem),
			stored: localStorage.getItem('phoneBar'),
			slots: localStorage.getItem('phoneBarSlots'),
			at: localStorage.getItem('phoneBarPlayAt')
		}));
		h.check(JSON.stringify(got.bar) === JSON.stringify(['play', 'add', 'objects', 'chat']), `migration: a 41b bar (Add, Objects, Chat; Play moved to the far left) reads as one list (${JSON.stringify(got.bar)})`);
		h.check(got.stored === JSON.stringify(['play', 'add', 'objects', 'chat']) && got.slots === null && got.at === null, `migration: written as the one 'phoneBar' record, the old two removed (${JSON.stringify(got)})`);
		await M.page.context().close();
	}

	const A = await h.setupPage(browser, 'phone', PHONE());
	const P = A.page;
	const cdp = await P.context().newCDPSession(P);
	const read = (expr) => P.evaluate(expr);
	const visible = (sel) => P.locator(sel).first().isVisible().catch(() => false);
	const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
	/** the centre of an element (scrolled into view first, inside its sheet) */
	const at = (sel) =>
		read(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
	const tapAt = async (p, settle = 400) => {
		await touch('touchStart', p.x, p.y);
		await P.waitForTimeout(60);
		await touch('touchEnd');
		await P.waitForTimeout(settle);
	};
	const tap = async (sel, settle = 400) => {
		const p = await at(sel);
		h.check(!!p, `premise: ${sel} is there to tap`);
		if (p) await tapAt(p, settle);
	};
	/** a press held (hold ms), then dragged to `to` in steps, then released */
	const holdDrag = async (from, to, hold = 650) => {
		await quiet();
		const hit = await read(`(() => { const el = document.elementFromPoint(${from.x}, ${from.y}); const it = el && el.closest('[data-bar-item], [data-more-item]'); return it ? (it.dataset.barItem || it.dataset.moreItem) : (el ? el.tagName + '.' + el.className : null); })()`);
		h.check(!!hit && !String(hit).includes('.'), `premise: the press lands on an item (${hit})`);
		await touch('touchStart', from.x, from.y);
		await P.waitForTimeout(hold);
		for (let i = 1; i <= 14; i++) {
			await touch('touchMove', from.x + ((to.x - from.x) * i) / 14, from.y + ((to.y - from.y) * i) / 14);
			await P.waitForTimeout(25);
		}
		await P.waitForTimeout(120);
		await touch('touchEnd');
		await P.waitForTimeout(500);
	};
	const bar = () => read(() => [...document.querySelectorAll('#ps-bar [data-bar-item]')].map((b) => b.dataset.barItem));
	const sheet = () => read(store('phoneShell.phoneSheet'));
	const quiet = () => read(() => window.__stores.toastStore.set([]));
	// More at HALF height: its tiles sit below the top band where the auto-quality toasts stack on a
	// loaded box (a press there lands on a toast — the documented trap)
	const openMore = async (detent = 'half') => {
		if ((await sheet()) !== 'more') await tap('#ps-more', 600);
		await read(`window.__stores.phoneShell.setPhoneDetent('more', '${detent}')`);
		await P.waitForTimeout(400);
	};
	const closeSheets = async () => {
		await read(() => window.__stores.phoneShell.phoneSheet.set(null));
		await P.waitForTimeout(400);
	};
	const setBar = (list) => read(`window.__stores.phoneBar.setBar(${JSON.stringify(list)})`);
	const DEFAULT = ['add', 'objects', 'play', 'explorer', 'more'];
	h.check(await read(() => document.documentElement.classList.contains('phone-shell')), 'premise: the phone shell is mounted on the folded N6 (390x896)');

	// ---- the default bar, and no "Edit bar…" anywhere --------------------------------------------
	h.check(JSON.stringify(await bar()) === JSON.stringify(DEFAULT), `default bar: Add, Objects, Play, Explorer, More (${JSON.stringify(await bar())})`);
	h.check(await read(() => [...document.querySelectorAll('#ps-bar .ps-tab-lbl')].map((s) => s.textContent.trim()).join() === 'Add,Objects,Explorer,More'), 'five items are labelled');
	await openMore();
	h.check((await sheet()) === 'more', 'premise: More is open');
	const moreText = await read(() => document.querySelector('.ps-sheet')?.textContent ?? '');
	h.check(!/Edit bar/.test(moreText) && !(await visible('#ps-edit-bar-open')) && !(await visible('#ps-edit-bar')), 'More has no "Edit bar…" row and no Edit bar page');
	const windows = await read(() => [...document.querySelectorAll('#ps-more-sheet .ps-tiles')][0]?.querySelectorAll('[data-more-item]'));
	const sections = await read(() =>
		[...document.querySelectorAll('#ps-more-sheet .ps-sec')].map((s) => ({ title: s.textContent.trim(), items: [...(s.nextElementSibling?.querySelectorAll('[data-more-item]') ?? [])].map((b) => b.dataset.moreItem) }))
	);
	void windows;
	const sec = (t) => sections.find((s) => s.title.toLowerCase() === t.toLowerCase())?.items ?? [];
	h.check(JSON.stringify(sec('Windows').slice(0, 4)) === JSON.stringify(['add', 'more', 'objects', 'stats']), `More ▸ Windows starts + Add, More, Objects, Statistics (${JSON.stringify(sec('Windows').slice(0, 6))})`);
	h.check(!sec('Windows').includes('play'), 'Play is not in More while it is on the bar');
	h.check(['inspect', 'move', 'rotate', 'scale', 'undo', 'redo', 'multiselect', 'interact'].every((k) => sec('Edit').includes(k)), `More ▸ Edit holds Inspect, Move, Rotate, Scale + Undo, Redo, Select multiple, Interact (${JSON.stringify(sec('Edit'))})`);
	h.check(JSON.stringify(sec('Tools & View')) === JSON.stringify(['tools', 'focus', 'budget', 'ar', 'playhere']) && (await read(() => document.getElementById('ps-viewport-tools')?.textContent?.trim())) === 'Tools & View', 'More ▸ Tools & View: placeable tiles "Tools & View" + (42 I14) "Focus mode" + (46 B1) the scene budget + (50 R1) the AR table + (60 Q1) Play here');
	const foot = await read(() => {
		const body = document.getElementById('ps-more-sheet');
		const hint = document.getElementById('ps-more-hint');
		const sw = ['ps-switch-strip', 'ps-switch-tabs', 'ps-switch-grab'].map((id) => document.getElementById(id));
		const secs = [...body.querySelectorAll('.ps-sec')];
		return {
			hint: hint?.textContent?.trim() ?? '',
			// after every section and switch (minimalScroll adds its own track after it)
			hintLast: !!hint && [...body.querySelectorAll('.ps-sec, .ps-switch, #ps-bar-reset')].every((el) => el.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING),
			switches: sw.every((b) => b && b.getAttribute('aria-pressed') === 'true'),
			showLast: secs[secs.length - 1]?.textContent?.trim()
		};
	});
	h.check(/hold and drag/i.test(foot.hint) && foot.hintLast, `the helper line is at More's bottom ("${foot.hint}")`);
	h.check(foot.switches && foot.showLast === 'Show', `the three switches (Selection toolbar, Dock tab row, Grab handle) are at More's bottom, all on (${JSON.stringify(foot)})`);
	// the hint stays on screen at More's half height too (it rides the sheet's bottom edge)
	await read(() => window.__stores.phoneShell.setPhoneDetent('more', 'half'));
	await P.waitForTimeout(500);
	const hintBox = await read(() => {
		const r = document.getElementById('ps-more-hint').getBoundingClientRect();
		const b = document.getElementById('ps-bar').getBoundingClientRect();
		return { bottom: Math.round(r.bottom), barTop: Math.round(b.top), h: Math.round(r.height) };
	});
	h.check(hintBox.h > 0 && hintBox.bottom <= hintBox.barTop + 1 && hintBox.barTop - hintBox.bottom < 4, `at half height the helper line is still visible, right above the bar (${JSON.stringify(hintBox)})`);
	await read(() => window.__stores.phoneShell.setPhoneDetent('more', 'full'));
	await P.waitForTimeout(400);

	// ---- a tap still runs an item -------------------------------------------------------------
	await tap('#ps-tile-stats', 600);
	h.check((await read(store('sceneBudget.statsOpen'))) === true && (await sheet()) === null, 'a tap on Statistics in More opens the statistics (and closes More)');
	await read(() => window.__stores.sceneBudget.statsOpen.set(false));

	// ---- drag a tool from More onto the bar ------------------------------------------------------
	await openMore();
	{
		const from = await at('#ps-more-move');
		const add = await at('#ps-add');
		const obj = await at('#ps-objects');
		await holdDrag(from, { x: (add.x + obj.x) / 2, y: add.y });
		const b = await bar();
		h.check(JSON.stringify(b) === JSON.stringify(['add', 'move', 'objects', 'play', 'explorer', 'more']), `Move held in More and dropped between Add and Objects lands there (${JSON.stringify(b)})`);
		h.check((await sheet()) === 'more' && (await read(() => document.querySelector('.ps-sheet')?.getAttribute('data-detent'))) === 'half', 'the drag did not pull the More sheet (it is still open, at the height it had)');
		h.check((await read(() => localStorage.getItem('phoneBar'))) === JSON.stringify(b), 'the new bar is saved on this device');
		h.check(await read(() => document.getElementById('ps-more-move')?.hasAttribute('data-on-bar')), 'More marks Move as on the bar');
		h.check(await read(() => !!document.getElementById('ps-bar-move') && document.querySelectorAll('[id="ps-move"]').length <= 1), "Move on the bar has its own id (the strip keeps #ps-move): every id exists once");
	}

	// ---- drag along the bar: Play to the far left ------------------------------------------------
	{
		const pl = await at('#ps-play');
		const first = await at('#ps-add');
		await holdDrag(pl, { x: first.x - first.w / 2 + 4, y: first.y });
		const b = await bar();
		h.check(b[0] === 'play' && b.length === 6, `Play held on the bar and dragged to the left end moves there (${JSON.stringify(b)})`);
	}

	// ---- drag a bar item up into More: off the bar -----------------------------------------------
	{
		const ex = await at('#ps-explorer');
		await holdDrag(ex, { x: ex.x, y: 380 });
		const b = await bar();
		h.check(!b.includes('explorer') && b.length === 5, `Explorer dragged up into More leaves the bar (${JSON.stringify(b)})`);
	}

	// ---- Play out of the bar, into More, and back ------------------------------------------------
	{
		const pl = await at('#ps-play');
		await holdDrag(pl, { x: pl.x, y: 380 });
		const b = await bar();
		h.check(!b.includes('play') && !(await visible('#ps-play')), `Play can leave the bar (${JSON.stringify(b)})`);
		h.check(await visible('#ps-tile-play'), 'Play then waits in More ▸ Windows');
		const tile = await at('#ps-tile-play');
		const more = await at('#ps-more');
		await holdDrag(tile, { x: more.x + more.w / 2 - 2, y: more.y });
		const b2 = await bar();
		h.check(b2[b2.length - 1] === 'play' && !(await read(() => !!document.getElementById('ps-tile-play'))), `Play dragged back from More lands at the bar's right end, and leaves More (${JSON.stringify(b2)})`);
	}

	// ---- seven items, icons-only, an eighth refused ---------------------------------------------
	{
		await setBar(['add', 'objects', 'play', 'explorer', 'more', 'move']);
		await P.waitForTimeout(300);
		const rot = await at('#ps-more-rotate');
		const pl = await at('#ps-play');
		await holdDrag(rot, { x: pl.x + 10, y: pl.y });
		const b = await bar();
		h.check(b.length === 7 && b.includes('rotate'), `a seventh item fits (${JSON.stringify(b)})`);
		const cells = await read(() => ({
			iconsOnly: document.getElementById('ps-bar').hasAttribute('data-icons-only'),
			labels: document.querySelectorAll('#ps-bar .ps-tab-lbl').length,
			widths: [...document.querySelectorAll('#ps-bar [data-bar-item]')].map((el) => Math.round(el.getBoundingClientRect().width)),
			heights: [...document.querySelectorAll('#ps-bar [data-bar-item]')].map((el) => Math.round(el.getBoundingClientRect().height)),
			names: [...document.querySelectorAll('#ps-bar [data-bar-item]:not(#ps-play)')].every((el) => !!el.getAttribute('aria-label') && !!el.getAttribute('title'))
		}));
		h.check(cells.iconsOnly && cells.labels === 0 && cells.names, `seven on the folded phone: icons only, each still named (aria-label + tooltip) (${JSON.stringify(cells)})`);
		h.check(cells.widths.every((w) => w >= 44) && cells.heights.every((x) => x >= 44), `every item stays >= 44 px (${JSON.stringify(cells.widths)})`);
		await quiet();
		const sc = await at('#ps-more-scale');
		const add = await at('#ps-add');
		await holdDrag(sc, add);
		const b2 = await bar();
		const toasts = await read(() => JSON.stringify(window.__stores.toastStore ? (() => { let v; window.__stores.toastStore.subscribe((x) => (v = x))(); return v; })() : []));
		h.check(JSON.stringify(b2) === JSON.stringify(b), `an eighth is refused — the bar is unchanged (${JSON.stringify(b2)})`);
		h.check(/holds 7/.test(toasts), `…and says why ("The bar holds 7 — drag one off first") (${toasts.slice(0, 160)})`);
		// six: still icons-only on the narrow phone; five: labelled again
		await setBar(['add', 'objects', 'play', 'explorer', 'more', 'move']);
		await P.waitForTimeout(300);
		h.check(await read(() => document.getElementById('ps-bar').hasAttribute('data-icons-only')), 'six on the folded phone: icons only');
		await setBar(DEFAULT);
		await P.waitForTimeout(300);
		h.check(await read(() => !document.getElementById('ps-bar').hasAttribute('data-icons-only') && document.querySelectorAll('#ps-bar .ps-tab-lbl').length === 4), 'back to five: labelled');
	}

	// ---- the last item never leaves ---------------------------------------------------------------
	{
		await setBar(['more']);
		await P.waitForTimeout(300);
		await quiet();
		const m = await at('#ps-more');
		await holdDrag(m, { x: m.x, y: 380 });
		h.check(JSON.stringify(await bar()) === JSON.stringify(['more']), 'the last item refuses to leave (the bar never empties)');
		await setBar(DEFAULT);
		await P.waitForTimeout(300);
	}

	// ---- More leaves the bar: the one-time notice (41b H6) -----------------------------------------
	{
		await read(() => localStorage.removeItem('phoneBarMoreHint'));
		const m = await at('#ps-more');
		await holdDrag(m, { x: m.x, y: 380 });
		h.check(!(await bar()).includes('more'), 'More can be dragged off the bar');
		const hint = await read(() => document.getElementById('confirm-more-hint')?.textContent?.replace(/\s+/g, ' ') ?? '');
		h.check(/press and hold any item on the bottom bar/i.test(hint), `a one-time modal says how to get More back ("${hint.slice(0, 80)}")`);
		await P.locator('#confirm-dialog-cancel').click();
		await P.waitForTimeout(400);
		h.check((await bar()).includes('more'), '"Keep More" puts it back');
	}
	await closeSheets();

	// ---- with More closed nothing drags; a long press opens More and picks the item up -------------
	{
		await setBar(DEFAULT);
		await P.waitForTimeout(300);
		const add = await at('#ps-add');
		const ex = await at('#ps-explorer');
		// a quick swipe (no hold) along the bar
		await touch('touchStart', ex.x, ex.y);
		for (let i = 1; i <= 8; i++) {
			await touch('touchMove', ex.x + ((add.x - ex.x) * i) / 8, ex.y);
			await P.waitForTimeout(20);
		}
		await touch('touchEnd');
		await P.waitForTimeout(500);
		h.check(JSON.stringify(await bar()) === JSON.stringify(DEFAULT) && (await sheet()) === null && !(await read(() => !!document.getElementById('ps-drag-ghost'))), 'More closed: a swipe along the bar drags nothing');
		// hold Explorer with More closed: More opens and Explorer is in hand
		await touch('touchStart', ex.x, ex.y);
		await P.waitForTimeout(650);
		const mid = await read(() => ({ ghost: document.getElementById('ps-drag-ghost')?.dataset.key ?? null }));
		h.check((await sheet()) === 'more' && mid.ghost === 'explorer', `More closed: a long press on a bar item opens More with the item in hand (${JSON.stringify(mid)}, sheet ${await sheet()})`);
		for (let i = 1; i <= 10; i++) {
			await touch('touchMove', ex.x + ((add.x - 10 - ex.x) * i) / 10, ex.y);
			await P.waitForTimeout(25);
		}
		await touch('touchEnd');
		await P.waitForTimeout(500);
		h.check((await bar())[0] === 'explorer', `…and the same gesture drops it (Explorer to the left end: ${JSON.stringify(await bar())})`);
		await setBar(DEFAULT);
		await closeSheets();
	}

	// ---- Play's long press (More closed) stays Play's menu — no "Edit bar…" (41b H6/H7) ------------
	{
		const pl = await at('#ps-play');
		await touch('touchStart', pl.x, pl.y);
		await P.waitForTimeout(700);
		await touch('touchEnd');
		await P.waitForTimeout(600);
		const rows = await read(() => [...document.querySelectorAll('[role="menuitem"]')].map((r) => (r.textContent || '').trim()));
		h.check(rows.includes('Move left') && rows.includes('Move right') && rows.includes('Arrange the bar…') && !rows.some((r) => /Edit bar/.test(r)), `a long press on Play opens Play's menu: Move left / right + "Arrange the bar…", no "Edit bar…" (${JSON.stringify(rows)})`);
		h.check((await sheet()) === null && !(await read(() => !!document.getElementById('ps-drag-ghost'))), "…and does not pick Play up while More is closed");
		await P.getByRole('menuitem', { name: 'Move left' }).click();
		await P.waitForTimeout(400);
		h.check(JSON.stringify(await bar()) === JSON.stringify(['add', 'play', 'objects', 'explorer', 'more']), "Play's Move left walks it one place left");
		await P.locator('#ps-play').dispatchEvent('contextmenu');
		await P.waitForTimeout(500);
		await P.getByRole('menuitem', { name: 'Arrange the bar…' }).click();
		await P.waitForTimeout(500);
		h.check((await sheet()) === 'more', '"Arrange the bar…" opens More');
		await setBar(DEFAULT);
		await closeSheets();
	}

	// ---- a placed tool works from the bar --------------------------------------------------------
	await read(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		for (let t = 0; t < 60; t++) {
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			if (g?.children?.length) {
				s.objectActions.applySelectionSet([g.children[0].uuid]);
				break;
			}
			await new Promise((r) => setTimeout(r, 150));
		}
		s.toastStore.set([]);
	});
	await P.waitForTimeout(800);
	{
		await setBar(['add', 'rotate', 'play', 'inspect', 'more']);
		await P.waitForTimeout(300);
		await tap('#ps-bar-rotate');
		h.check((await read(store('transformMode'))) === 'rotate' && (await read(() => document.getElementById('ps-bar-rotate')?.getAttribute('aria-pressed'))) === 'true', 'Rotate on the bar arms the rotate gizmo, and shows pressed');
		await tap('#ps-bar-inspect', 900);
		h.check((await read(store('phoneDock.phoneDockShown'))) === 'properties', 'Inspect on the bar opens the Properties tab');
		await read(() => window.__stores.phoneDock.closePhoneTab('properties'));
		await P.waitForTimeout(500);
	}

	// ---- switch: Selection toolbar --------------------------------------------------------------
	{
		h.check(await visible('#ps-strip'), 'premise: with something selected the selection strip shows');
		await openMore();
		await tap('#ps-switch-strip');
		await closeSheets();
		h.check(!(await read(() => !!document.getElementById('ps-strip'))) && (await read(() => localStorage.getItem('phoneSelectionStrip'))) === '0', 'Selection toolbar off: no floating strip over the selection (saved on this device)');
		await openMore();
		await tap('#ps-switch-strip');
		await closeSheets();
		h.check(await visible('#ps-strip'), 'Selection toolbar on: the strip is back');
	}

	// ---- switch: Dock tab row --------------------------------------------------------------------
	{
		await read(() => {
			window.__stores.objectActions.applySelectionSet([]);
			window.__stores.bottomDock.dockHeight.set(360);
		});
		await setBar(DEFAULT);
		await P.waitForTimeout(300);
		await tap('#ps-explorer', 1200);
		const tabsOn = await read(() => {
			const row = document.querySelector('.tp-dock-panel .dt-row');
			return { row: !!row && getComputedStyle(row).display !== 'none' && row.getBoundingClientRect().height > 0, dock: document.querySelector('.tp-dock-panel:not(.hidden)')?.id ?? null };
		});
		h.check(tabsOn.row, `premise: a docked view shows its tab row (${JSON.stringify(tabsOn)})`);
		await openMore();
		await tap('#ps-switch-tabs');
		await closeSheets();
		const tabsOff = await read(() => {
			const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
			return { row: vis(document.querySelector('.tp-dock-panel .dt-row')), chrome: vis(document.querySelector('.tp-dock-panel .dt-chrome')), cls: document.documentElement.classList.contains('ps-no-dock-tabs') };
		});
		h.check(!tabsOff.row && !tabsOff.chrome && tabsOff.cls, `Dock tab row off: the whole tab row (and its + / minimize chrome) is gone (${JSON.stringify(tabsOff)})`);
		await tap('#ps-explorer', 700);
		h.check((await read(store('bottomDock.dockMinimized'))) === true, 'the bar still switches the docked view (a tap minimizes it, 41b H5)');
		await tap('#ps-explorer', 900);
		h.check((await read(store('bottomDock.dockMinimized'))) === false, '…and brings it back');
		await openMore();
		await tap('#ps-switch-tabs');
		await closeSheets();
	}

	// ---- switch: Grab handle ---------------------------------------------------------------------
	{
		await read(() => window.__stores.bottomDock.dockHeight.set(360));
		await P.waitForTimeout(400);
		const grip = () =>
			read(() => {
				const g = document.getElementById('ps-dock-grip');
				const r = g?.getBoundingClientRect();
				const panel = document.querySelector('.tp-dock-panel:not(.hidden)')?.getBoundingClientRect();
				let hh;
				window.__stores.bottomDock.dockHeight.subscribe((v) => (hh = v))();
				return { bare: g?.hasAttribute('data-bare'), pill: !!g?.querySelector('.sg-grabber'), top: r ? r.top : 0, h: r ? r.height : 0, panelTop: panel ? panel.top : 0, dockH: hh };
			});
		const on = await grip();
		h.check(on.pill && !on.bare, `premise: the dock wears its grab handle (${JSON.stringify(on)})`);
		// with the handle a tap toggles the size (the counterfactual for the tap that goes with it)
		await tapAt({ x: 195, y: on.top + on.h / 2 }, 700);
		const tapped = await grip();
		h.check(tapped.dockH !== on.dockH, `with the handle, a tap on it changes the dock's size (${on.dockH} → ${tapped.dockH})`);
		await read(() => window.__stores.bottomDock.dockHeight.set(360));
		await openMore();
		await tap('#ps-switch-grab');
		h.check((await read(() => document.querySelector('#ps-sheet-handle .ps-grabber'))) === null, "Grab handle off: the open sheet's handle has no pill either");
		await closeSheets();
		await P.waitForTimeout(400);
		const off = await grip();
		h.check(off.bare && !off.pill && off.h <= 14 && Math.abs(off.top - off.panelTop) <= 3, `Grab handle off: no pill; a thin invisible band on the dock's top edge (${JSON.stringify(off)})`);
		await tapAt({ x: 195, y: off.top + off.h / 2 }, 700);
		h.check((await grip()).dockH === off.dockH, 'Grab handle off: a tap on the edge no longer resizes (the tap-to-resize went with the handle)');
		// the invisible edge still drags
		const y0 = off.top + off.h / 2;
		await touch('touchStart', 195, y0);
		for (let i = 1; i <= 10; i++) {
			await touch('touchMove', 195, y0 - 12 * i);
			await P.waitForTimeout(25);
		}
		await touch('touchEnd');
		await P.waitForTimeout(700);
		const dragged = await grip();
		h.check(dragged.dockH > off.dockH + 60, `…and dragging the top edge still resizes the dock (${off.dockH} → ${dragged.dockH})`);
		await openMore();
		await tap('#ps-switch-grab');
		await closeSheets();
		h.check((await grip()).pill, 'Grab handle on: the pill is back');
		await read(() => window.__stores.explorerClose.set(true));
	}

	// ---- the bar survives a reload and a fold → unfold → fold --------------------------------------
	{
		const mine = ['add', 'play', 'move', 'objects', 'more'];
		await setBar(mine);
		await P.waitForTimeout(300);
		await P.setViewportSize({ width: 770, height: 850 });
		await P.waitForTimeout(1500);
		h.check(!(await read(() => document.documentElement.classList.contains('phone-shell'))) && !(await read(() => !!document.getElementById('ps-bar'))), 'unfolded (770x850): the phone shell and its bar stand down (the desktop toolbar takes over)');
		await P.setViewportSize(FOLDED);
		await P.waitForTimeout(1500);
		h.check(JSON.stringify(await bar()) === JSON.stringify(mine), `folded again: the same bar (${JSON.stringify(await bar())})`);
		await h.freshReload(A);
		await P.locator('#restore-session-dismiss').click({ timeout: 6000 }).catch(() => {});
		await P.waitForTimeout(800);
		h.check(JSON.stringify(await bar()) === JSON.stringify(mine), `after a reload: the same bar (${JSON.stringify(await bar())})`);
		await setBar(DEFAULT);
	}

	const errs = h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs.slice(0, 2))})`);
	await h.finish(browser);
});
