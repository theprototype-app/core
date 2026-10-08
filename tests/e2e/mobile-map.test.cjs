// 38 R9 — THE PHONE SHELL KEEPS EVERY CONTROL (the design page's "Where every current mobile
// control goes" table, 35 rows). Each row is walked on a real phone-shaped page (390x844,
// touch, isMobile) with REAL TAPS from rest: the control must be reachable in the number of
// taps the table promises ("Visible" = 0, "One tap" = 1, "When relevant" = once its context
// exists) and must do what the old control did — asserted on the STORE the old control
// wrote, never on the new button's own state.
//
// The row numbers below are the table's order. A row that fails names itself, so a later
// change that drops a control from the phone says WHICH one.
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'phone', {
		context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const P = A.page;
	const read = (expr) => P.evaluate(expr);
	const visible = (sel) => P.locator(sel).first().isVisible().catch(() => false);
	const tap = async (sel) => {
		await P.locator(sel).first().tap({ timeout: 8000 });
		await P.waitForTimeout(350);
	};
	/** back to rest: no sheet, no window, no menu */
	const rest = async () => {
		await P.evaluate(() => {
			const s = window.__stores;
			s.phoneShell.phoneSheet.set(null);
			s.viewportMenu.set(null);
			s.objectContextMenu.set(null);
			s.objectListClose.set(true);
			s.chatHidden.set('hidden');
			s.aiAssistantHidden.set('hidden');
			s.notificationCenterOpen.set(false);
			s.notesDrawerOpen.set(false);
			s.inspectorClose.set(true);
			s.closeMenu.set(true);
			s.settingsOpen.set(null);
			s.connectDrawerOpen.set(false);
			s.explorerClose.set(true);
			s.flowGraphClose.set(true);
			s.animationClose.set(true);
		});
		await P.keyboard.press('Escape').catch(() => {});
		await P.waitForTimeout(400);
	};
	const row = (n, ok, what) => h.check(!!ok, `row ${n}: ${what}`);

	// ---- the premise: this IS the phone shell ----------------------------------------
	const shell = await read(() => ({
		cls: document.documentElement.classList.contains('phone-shell'),
		bar: !!document.querySelector('#ps-bar'),
		oldPill: getComputedStyle(document.querySelector('#controls-pill') ?? document.body).display
	}));
	h.check(shell.cls && shell.bar, `the phone shell is mounted at 390x844 (${JSON.stringify(shell)})`);
	h.check(shell.oldPill === 'none', `the desktop toolbar pill stands down on a phone (${shell.oldPill})`);
	const atRest = await read(() =>
		['#logo-menu', '#ps-connect-chip', '#notif-bell', '#avatar-trigger', '#ps-add', '#ps-objects', '#ps-play', '#ps-explorer', '#ps-more']
			.filter((s) => {
				const el = document.querySelector(s);
				if (!el) return true;
				const r = el.getBoundingClientRect();
				return !(r.width > 0 && r.height > 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.top >= -1);
			})
	);
	h.check(atRest.length === 0, `every at-rest control is on screen and inside it (missing: ${JSON.stringify(atRest)})`);
	const small = await read(() =>
		[...document.querySelectorAll('.ps button')]
			.filter((b) => b.offsetParent)
			.map((b) => ({ id: b.id || b.className, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }))
			.filter((b) => b.h < 40 || b.w < 36)
	);
	h.check(small.length === 0, `shell touch targets are thumb-sized (${JSON.stringify(small)})`);

	// ---- row 1: the logo opens the main menu (one sheet) -----------------------------
	await rest();
	await tap('#logo-menu');
	row(1, (await visible('#sidebar70')) && (await read(store('closeMenu'))) === false, 'Logo (main menu) opens the main menu');
	const menuBox = await read(() => document.querySelector('#sidebar70')?.getBoundingClientRect().toJSON());
	h.check(menuBox && Math.abs(menuBox.bottom - 844) < 2 && menuBox.width > 380, `the main menu is a bottom sheet (${JSON.stringify(menuBox)})`);
	const menuBar = await read(() => {
		const el = document.querySelector('#sidebar70');
		if (!el) return -1;
		const cs = getComputedStyle(el);
		return el.offsetWidth - el.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
	});
	h.check(menuBar === 0, `NOTES-38 #1: the main menu shows no scrollbar (gutter ${menuBar}px)`);

	// ---- rows 2-10: the Connect chip and its sheet -----------------------------------
	await rest();
	row(5, await visible('#ps-connect-chip'), 'Status pill: the Connect chip shows the state at rest');
	await tap('#ps-connect-chip');
	row(6, (await read(store('connectDrawerOpen'))) === true, 'Drawer toggle: tapping the chip opens the drawer');
	row(2, await visible('.connect-wrap[data-ps-host] .connect-pill > button:first-child'), 'Copy invite link lives in the Connect sheet');
	row(3, await visible('.connect-wrap[data-ps-host] .cx-input'), 'Peer ID field lives in the Connect sheet');
	row(4, await visible('.connect-wrap[data-ps-host] .cx-connect button'), 'Connect button lives in the Connect sheet');
	const tabs = await read(() => [...document.querySelectorAll('.connect-wrap[data-ps-host] .cxd-tab')].filter((t) => t.offsetParent).map((t) => t.textContent.trim()));
	row(7, tabs.some((t) => t.startsWith('Info')) && tabs.some((t) => t.startsWith('Toasts')), `Info / Toasts tabs are the sheet's tabs (${JSON.stringify(tabs)})`);
	row(8, await visible('.connect-wrap[data-ps-host] .cxd-pin'), 'Pin drawer is in the Connect sheet');
	// a tap on the sheet's own pill must not close its drawer (ConnectInfoDrawer's outside rule)
	await tap('.connect-wrap[data-ps-host] .cx-input');
	h.check((await read(store('connectDrawerOpen'))) === true, 'a tap inside the Connect sheet keeps its drawer open');
	// row 9: the Rooms tab appears when a cloud plugin offers rooms — the drawer's own
	// `hasRooms` decides; the shortcut button stays hidden in the sheet (the tab is the way)
	const roomsWay = await read(() => ({
		tabs: [...document.querySelectorAll('.connect-wrap[data-ps-host] .cxd-tab')].map((t) => t.textContent.trim()),
		btn: !!document.querySelector('#connect-rooms-button')
	}));
	row(9, !roomsWay.btn || roomsWay.tabs.some((t) => t.startsWith('Rooms')), `Browse public rooms: offered through the sheet's Rooms tab when a plugin has rooms (${JSON.stringify(roomsWay)})`);
	// row 10: Cancel request is contextual — stage a pending dial and look for it in the sheet
	await P.evaluate(() => {
		const s = window.__stores;
		s.waitingForApproval.set([['ZZZZZ', 'pending']]);
	});
	await P.waitForTimeout(400);
	const cancel = await visible('.connect-wrap[data-ps-host] #cancel-request-button');
	const chipPending = await read(() => document.querySelector('.ps-chip')?.getAttribute('data-state'));
	await P.evaluate(() => window.__stores.waitingForApproval.set([]));
	row(10, cancel, 'Leave session / Cancel request: the contextual button is in the Connect sheet');
	h.check(chipPending === 'pending', `the chip says the request is pending (${chipPending})`);
	await tap('#ps-sheet-close');
	h.check((await read(store('phoneShell.phoneSheet'))) === null && (await read(store('connectDrawerOpen'))) === false, 'Close on the Connect sheet closes it and its drawer');

	// ---- rows 11-13 + 24 (NOTES-38 #31): nothing selected = no toolbar; More ▸ Edit has them -----
	await rest();
	h.check(!(await visible('#ps-strip')), 'with nothing selected there is no selection toolbar (just looking)');
	await tap('#ps-more');
	row(11, await visible('#ps-more-undo'), 'Undo is in More ▸ Edit');
	row(12, await visible('#ps-more-redo'), 'Redo is in More ▸ Edit');
	row(13, await visible('#ps-more-multiselect'), 'Multi-select is in More ▸ Edit');
	await tap('#ps-more-multiselect');
	h.check((await read(store('multiSelectMode'))) === true, 'Multi-select toggles the same mode the touch cluster did');
	await tap('#ps-more-multiselect');
	row(24, await visible('#ps-more-interact'), 'Interact mode is in More ▸ Edit');
	await tap('#ps-more-interact');
	h.check((await read(store('editorMode'))) === 'interact', 'Interact toggles editorMode');
	await tap('#ps-more-interact');
	h.check((await read(store('editorMode'))) === 'edit', 'and back to Edit');
	await P.evaluate(() => window.__stores.phoneShell?.phoneSheet?.set(null));
	await P.waitForTimeout(300);

	// undo/redo drive the real history
	const before = await P.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		return g.children.length;
	});
	await P.evaluate(() => window.__stores.deselectObject?.());
	await P.waitForTimeout(300);
	await tap('#ps-more');
	await tap('#ps-more-undo');
	const afterUndo = await read(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.length;
	});
	h.check(afterUndo === before - 1, `More ▸ Undo undoes (${before} -> ${afterUndo})`);
	await tap('#ps-more-redo');
	const afterRedo = await read(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.length;
	});
	h.check(afterRedo === before, `and Redo redoes (${afterRedo})`);
	await P.evaluate(() => window.__stores.phoneShell?.phoneSheet?.set(null));
	await P.waitForTimeout(300);

	// ---- rows 21-23 + 32: the strip with something selected --------------------------
	await P.evaluate(() => {
		const w = window.__stores;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		w.commandsHandler.sceneCommand('/select ' + g.children[g.children.length - 1].uuid);
	});
	await P.waitForTimeout(600);
	row(21, await visible('#ps-move'), 'Move appears in the strip once something is selected');
	row(22, await visible('#ps-rotate'), 'Rotate appears in the strip once something is selected');
	row(23, await visible('#ps-scale'), 'Scale appears in the strip once something is selected');
	await tap('#ps-rotate');
	h.check((await read(store('transformMode'))) === 'rotate', 'Rotate sets the gizmo mode');
	await tap('#ps-scale');
	h.check((await read(store('transformMode'))) === 'scale', 'Scale sets the gizmo mode');
	await tap('#ps-move');
	h.check((await read(store('transformMode'))) === 'translate', 'Move sets the gizmo mode');
	await tap('#ps-inspect');
	await P.waitForTimeout(300);
	row(32, (await read(store('inspectorClose'))) === false && (await read(store('inspectorKind'))) === 'selection', 'Inspector: Inspect in the strip opens the Inspector for the selection');
	h.check(await visible('#inspector .ins-resize'), 'the Inspector opens as a sheet with its handle');
	// NOTES-38 #32: the Inspector sheet sits ABOVE the bar (Play stays tappable) and the selection
	// strip rides on top of it
	await P.waitForTimeout(500);
	const layer = await read(() => {
		const play = document.querySelector('#ps-play')?.getBoundingClientRect();
		const bar = document.querySelector('#ps-bar')?.getBoundingClientRect();
		const ins = document.querySelector('#inspector')?.getBoundingClientRect();
		const strip = document.querySelector('#ps-strip')?.getBoundingClientRect();
		const hit = play ? document.elementFromPoint(play.left + play.width / 2, play.top + play.height / 2) : null;
		return { playFree: !!hit?.closest('#ps-play'), insAboveBar: !!(ins && bar && ins.bottom <= bar.top + 2), stripOnTop: !!(strip && ins && strip.bottom <= ins.top + 2) };
	});
	h.check(layer.playFree && layer.insAboveBar, `#32 (a): the Inspector sheet ends at the bar, Play stays tappable (${JSON.stringify(layer)})`);
	h.check(layer.stripOnTop, `#32 (b): the selection strip rides on top of the open sheet (${JSON.stringify(layer)})`);
	await P.evaluate(() => window.__stores.deselectObject?.());

	// ---- rows 14-16: top right + More › Notes ----------------------------------------
	await rest();
	row(15, await visible('#notif-bell'), 'Notifications: the bell is in the top bar at rest');
	await tap('#notif-bell');
	h.check((await read(store('notificationCenterOpen'))) === true && (await visible('#notif-panel')), 'the bell opens the notification centre (as a sheet)');
	await rest();
	row(16, await visible('#avatar-trigger'), 'Profile and peers: the avatar is in the top bar at rest');
	await tap('#avatar-trigger');
	const prof = await read(() => document.querySelector('#avatar-dropdown')?.getBoundingClientRect().toJSON());
	h.check(prof && prof.height > 0 && Math.abs(prof.bottom - 844) < 2, `the avatar opens the profile menu as a bottom sheet (${JSON.stringify(prof)})`);
	await P.keyboard.press('Escape');
	await P.evaluate(() => document.querySelector('#avatar-trigger')?.click());
	await rest();
	await tap('#ps-more');
	await tap('#ps-tile-notes');
	row(14, (await read(store('notesDrawerOpen'))) === true, 'Scene notes: More › Windows › Notes');

	// ---- rows 17-20, 25, 26: the bottom bar ------------------------------------------
	await rest();
	await tap('#ps-add');
	await P.waitForTimeout(300);
	row(17, await visible('.ctx-scroll'), 'Add (+) is the bottom bar Add and opens the add menu');
	// Phase B: the Add tab IS the Add list (rooted, not the whole viewport menu), as a
	// bottom sheet; a category drills in place over it and Back returns
	const addRows = await read(() => [...document.querySelectorAll('[role=menu] > .ctx-row, [role=menu] .ctx-row')].map((r) => r.textContent.trim().split(/\s+/)[0]));
	h.check(addRows[0] === 'Mesh' && !addRows.includes('Undo'), `the Add tab opens the Add list itself (${JSON.stringify(addRows.slice(0, 4))})`);
	const sheet = await read(() => document.querySelector('[role=menu].ctx-scroll').getBoundingClientRect().toJSON());
	// NOTES-38 #32 (a): the Add list is a sheet that ends at the top of the bottom bar
	const barTop = await read(() => document.querySelector('#ps-bar').getBoundingClientRect().top);
	h.check(Math.abs(sheet.bottom - barTop) < 2 && sheet.left === 0 && Math.abs(sheet.width - 390) < 2, `menus are bottom sheets on the phone shell (${JSON.stringify(sheet)})`);
	await tap('[role=menu] .ctx-row:has-text("Mesh")');
	await P.waitForTimeout(400);
	const sub = await read(() => { const n = document.querySelector('.ctx-scroll:not([role])'); return n && { r: n.getBoundingClientRect().toJSON(), back: n.querySelector('.ctx-back')?.textContent.trim(), cube: [...n.querySelectorAll('.ctx-row')].some((r) => r.textContent.trim() === 'Cube') }; });
	h.check(sub && sub.back === 'Mesh' && sub.cube && Math.abs(sub.r.top - sheet.top) < 2 && Math.abs(sub.r.height - sheet.height) < 2, `a submenu drills in place over its parent, with Back (${JSON.stringify(sub)})`);
	await tap('.ctx-back');
	await P.waitForTimeout(300);
	h.check((await read(() => document.querySelectorAll('.ctx-scroll:not([role])').length)) === 0 && (await visible('[role=menu].ctx-scroll')), 'Back returns to the Add list');
	const objsBefore = await read(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.children.length; });
	await tap('[role=menu] .ctx-row:has-text("Mesh")');
	await P.waitForTimeout(400);
	await tap('.ctx-scroll:not([role]) .ctx-row:has(span.flex-1:text-is("Cube"))');
	await h.eventually(() => read(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.children.length; }), (n) => n === objsBefore + 1, 'tapping Cube in the sheet adds a cube and closes the menu', 5000);
	h.check(!(await visible('.ctx-scroll')), 'the sheet closes after adding');
	// leave the scene empty: later rows long-press the empty viewport
	await read(() => window.__stores.history.undo());
	await h.eventually(() => read(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.children.length; }), (n) => n === objsBefore, 'undo takes the added cube back', 5000);
	await P.keyboard.press('Escape');
	await P.mouse.click(5, 420).catch(() => {});
	await rest();
	await tap('#ps-objects');
	row(26, (await read(store('objectListClose'))) === false && (await visible('#object-list')), 'Object list: Bottom bar › Objects');
	const objBox = await read(() => document.querySelector('#object-list')?.getBoundingClientRect().toJSON());
	const barTop2 = await read(() => document.querySelector('#ps-bar').getBoundingClientRect().top);
	h.check(objBox && Math.abs(objBox.bottom - barTop2) < 2 && objBox.width >= 388, `the object list is placed into a bottom sheet above the bar (#32) (${JSON.stringify(objBox)})`);
	// the sheet handle: tap steps a detent, drag down past peek closes
	const d0 = await read(() => { let m; window.__stores.phoneShell.phoneDetents.subscribe((v) => (m = v))(); return m.objects ?? 'half'; });
	await tap('#ps-sheet-handle');
	const d1 = await read(() => { let m; window.__stores.phoneShell.phoneDetents.subscribe((v) => (m = v))(); return m.objects ?? 'half'; });
	h.check(d0 === 'half' && d1 === 'full', `a tap on the handle steps the sheet up (${d0} -> ${d1})`);
	const hb = await read(() => document.querySelector('#ps-sheet-handle').getBoundingClientRect().toJSON());
	await P.mouse.move(195, hb.y + 10);
	await P.mouse.down();
	for (let i = 1; i <= 12; i++) await P.mouse.move(195, hb.y + 10 + i * 60);
	await P.mouse.up();
	await P.waitForTimeout(400);
	h.check((await read(store('objectListClose'))) === true, 'dragging the handle to the bottom closes the sheet (and the window)');
	await rest();
	await tap('#ps-more');
	await tap('#ps-tile-chat');
	row(20, (await read(store('chatHidden'))) === '' && (await visible('#chat-window')), 'Chat: More › Chat (NOTES-38 #7)');
	await rest();
	row(25, await visible('#ps-play'), 'Play: the centre of the bottom bar');
	const playColour = await read(() => getComputedStyle(document.querySelector('#ps-play .ps-live')).backgroundColor);
	h.check(/rgb/.test(playColour), `Play is the live colour (${playColour})`);
	await rest();
	await tap('#ps-more');
	await tap('#ps-tile-ai');
	row(18, (await read(store('aiAssistantHidden'))) === '' || (await read(store('settingsOpen'))) === true, 'AI assistant: More › Windows › AI assistant (or Settings › AI when none is set up)');
	await P.evaluate(() => window.__stores.settingsOpen.set(null));

	// ---- row 19: the mic rides the chip while connected ------------------------------
	await rest();
	await P.evaluate(() => {
		const s = window.__stores;
		let p;
		s.peers.subscribe((v) => (p = v))();
		p.__savedOpened = p.openedPeers;
		p.openedPeers = new Set(['PEERX']);
		s.peers.update((v) => v);
	});
	await P.waitForTimeout(300);
	row(19, await visible('#ps-mic'), 'Voice chat: the mic is in the Connect chip while in a session');
	await P.evaluate(() => {
		const s = window.__stores;
		let p;
		s.peers.subscribe((v) => (p = v))();
		p.openedPeers = p.__savedOpened ?? new Set();
		s.peers.update((v) => v);
	});

	// ---- rows 27-31: More › Windows --------------------------------------------------
	const views = [
		[27, 'flow', 'flowGraphClose', 'Node editor'],
		[28, 'explorer', 'explorerClose', 'Explorer'],
		[29, 'animation', 'animationClose', 'Animation']
	];
	for (const [n, key, closeStore, label] of views) {
		await rest();
		await tap('#ps-more');
		await tap(`#ps-tile-${key}`);
		row(n, (await read(store(closeStore))) === false, `${label}: More › Windows`);
	}
	await rest();
	await tap('#ps-more');
	const optional = await read(() => ['flowcode', 'uv', 'shader', 'hud', 'profiler', 'code'].filter((k) => !document.querySelector(`#ps-tile-${k}`)?.offsetParent));
	row(30, optional.length === 0, `Optional views are tiles in More › Windows (missing ${JSON.stringify(optional)})`);
	await rest();
	await tap('#ps-more');
	await tap('#ps-tile-explorer');
	const dock = await read(() => {
		let o;
		window.__stores.bottomDock.dockOccupants.subscribe((v) => (o = v))();
		return !!o?.explorer?.present;
	});
	row(31, dock, 'Dock tab strip: a dock view opens docked (its own tab strip and height)');

	// ---- row 33: the viewport menu (long press, and More › Tools) ---------------------
	await rest();
	const cdp = await P.context().newCDPSession(P);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 380 }] });
	await P.waitForTimeout(900);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await P.waitForTimeout(400);
	const longPress = await visible('.ctx-scroll');
	await P.keyboard.press('Escape');
	await P.mouse.click(5, 420).catch(() => {});
	await rest();
	await tap('#ps-more');
	await tap('#ps-viewport-tools');
	await P.waitForTimeout(400);
	const viaMore = await visible('.ctx-scroll');
	row(33, longPress || viaMore, `Viewport menu: long press (${longPress}) and More › Tools (${viaMore})`);
	await P.keyboard.press('Escape');
	await P.mouse.click(5, 420).catch(() => {});

	// ---- NOTES-38 #7: the bar is customisable (per device); More always stays -------------
	await rest();
	const lsBar = () => read(() => localStorage.getItem('phoneBarSlots'));
	const barIds = () => read(() => [...document.querySelectorAll('#ps-bar > button')].map((b) => b.id));
	h.check(JSON.stringify(await barIds()) === JSON.stringify(['ps-add', 'ps-objects', 'ps-play', 'ps-explorer', 'ps-more']), `default bar: Add, Objects, Play, Explorer, More (${JSON.stringify(await barIds())})`);
	// a long press (contextmenu) on a tab opens the editor
	await P.locator('#ps-objects').dispatchEvent('contextmenu');
	await P.waitForTimeout(500);
	h.check(await visible('#ps-edit-bar'), 'a long press on a bar tab opens Edit bar');
	h.check((await read(() => document.querySelector('#ps-pick-more')?.getAttribute('aria-disabled'))) === 'true', 'More cannot be taken off the bar');
	await P.locator('#ps-pick-more').tap({ force: true });
	await P.waitForTimeout(300);
	h.check((await barIds()).includes('ps-more'), 'tapping More in the editor leaves it on the bar');
	await tap('#ps-pick-explorer');
	await tap('#ps-pick-chat');
	const custom = await barIds();
	h.check(JSON.stringify(custom) === JSON.stringify(['ps-add', 'ps-objects', 'ps-play', 'ps-chat', 'ps-more']), `the bar follows the picks (${JSON.stringify(custom)})`);
	h.check((await lsBar()) === JSON.stringify(['add', 'objects', 'chat', 'more']), `the pick is saved on this device (${await lsBar()})`);
	await P.locator('#ps-pick-flow').tap({ force: true });
	await P.waitForTimeout(300);
	h.check(!(await barIds()).includes('ps-flow'), 'a full bar refuses a fifth');
	await tap('#ps-bar-done');
	h.check(!(await visible('#ps-edit-bar')) && (await visible('#ps-more-sheet')), 'Done returns to the More sheet');
	await rest();
	await tap('#ps-chat');
	h.check((await read(store('chatHidden'))) === '', 'a customised Chat slot opens Chat');
	await rest();
	await tap('#ps-more');
	await tap('#ps-edit-bar-open');
	await tap('#ps-bar-reset');
	h.check(JSON.stringify(await barIds()) === JSON.stringify(['ps-add', 'ps-objects', 'ps-play', 'ps-explorer', 'ps-more']) && (await lsBar()) === null, 'Reset to default restores the bar and forgets the key');
	await tap('#ps-bar-done');

	// ---- NOTES-38 #15: each sheet remembers its own height, per device ----------------------
	await rest();
	const detents = () => read(() => { let m; window.__stores.phoneShell.phoneDetents.subscribe((v) => (m = v))(); return m; });
	await tap('#ps-more');
	await tap('#ps-tile-chat');
	h.check((await read(() => document.querySelector('.ps-sheet')?.getAttribute('data-detent'))) === 'half', 'a sheet first opens at half');
	await tap('#ps-sheet-handle');
	await rest();
	await tap('#notif-bell');
	const otherDet = await read(() => document.querySelector('.ps-sheet')?.getAttribute('data-detent'));
	await rest();
	await tap('#ps-more');
	await tap('#ps-tile-chat');
	const chatDet = await read(() => document.querySelector('.ps-sheet')?.getAttribute('data-detent'));
	h.check(chatDet === 'full', `Chat reopens at the height it was left at (${chatDet})`);
	h.check(otherDet === 'half', `another window keeps its own height (notifications: ${otherDet})`);
	const saved = await read(() => JSON.parse(localStorage.getItem('phoneSheetDetents') || '{}'));
	h.check(saved.chat === 'full', `the heights are saved on this device (${JSON.stringify(saved)})`);
	await P.evaluate(() => window.__stores.settingsOpen.set(null));

	// ---- rows 34-35: Settings ---------------------------------------------------------
	await rest();
	await tap('#logo-menu');
	await P.locator('#sidebar70 .side-row', { hasText: 'Settings' }).first().tap();
	await P.waitForTimeout(800);
	row(34, (await read(store('settingsOpen'))) && (await visible('#settings-main')), 'Settings opens from the main menu');
	// 1.26 (37-settings) + the design map row 35: "About & what's new" on the Settings list, and
	// Reset all settings in About ▸ Danger zone (each category also has its own Reset at the end)
	const about = await read(() => [...document.querySelectorAll('dialog button, dialog a')].some((b) => b.offsetParent && /what.s new/i.test(b.textContent || '')));
	await P.evaluate(() => window.__stores.settingsSection.set('about'));
	await P.waitForTimeout(600);
	const reset = await read(() => [...document.querySelectorAll('dialog button, dialog a')].some((b) => b.offsetParent && /reset/i.test(b.textContent || '')));
	row(35, about && reset, `Reset settings / What's new are reachable in Settings (about row ${about}, reset in About ${reset})`);

	const errs = h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs.slice(0, 2))})`);
	await h.finish(browser);
});
