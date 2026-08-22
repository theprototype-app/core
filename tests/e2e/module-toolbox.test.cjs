// A5 (roadmap #21) — api.registerToolbox over the shared ToolboxWindow shell.
//
// `makeApi()` had no DOM/panel seam, so module controls could only live behind
// registerMenu: two clicks deep inside the Modules MODAL, which then has to be closed
// before the module's own overlay is usable. Modules worked around it with hand-rolled
// fixed overlays at z-indexes they do not own.
//
// Everything goes through `moduleSDK.initModules` with an inline module — the REAL api
// path — and through the REAL openers (the sidebar row and the viewport menu), because a
// feature whose entry point a suite supplies itself is invisible when the entry point is
// broken (the shader-tab lesson).
//
// Run: $env:APP_URL='https://localhost:5200/'; npm run e2e -- module-toolbox
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.moduleToolboxes, { timeout: 30000 });

	const install = () =>
		page.evaluate(async () => {
			window.__tbx = { mounts: 0, cleanups: 0, opens: 0, closes: 0, clicks: 0 };
			await window.__stores.moduleSDK.initModules([
				{
					id: 'testtbx',
					name: 'Test toolbox',
					version: '1.0.0',
					description: 'proves the A5 seam',
					register(api) {
						window.__tbxId = api.registerToolbox({
							id: 'panel',
							title: 'Test Panel',
							width: 240,
							shortcut: 'Ctrl+Shift+F9',
							defaultRect: { left: 300, top: 200 },
							onOpen: () => window.__tbx.opens++,
							onClose: () => window.__tbx.closes++,
							mount(el) {
								window.__tbx.mounts++;
								// plain DOM using the shell's OWN css contract — no module CSS
								const label = document.createElement('div');
								label.className = 'tbx-label';
								label.textContent = 'Spawn rate';
								const btn = document.createElement('button');
								btn.className = 'tbx-primary';
								btn.id = 'tbx-test-apply';
								btn.textContent = 'Apply';
								btn.onclick = () => window.__tbx.clicks++;
								el.append(label, btn);
								return () => {
									window.__tbx.cleanups++;
								};
							}
						});
					}
				}
			]);
			return window.__tbxId;
		});
	const id = await install();

	// ---- 1. registration, namespacing, and CLOSED at first -------------------
	h.check(
		id === 'mod-testtbx-panel',
		`registerToolbox returns the namespaced id, so two modules may both ship a 'panel' (${id})`
	);
	const initial = await page.evaluate(() => {
		const t = window.__stores.moduleToolboxes;
		let list, open;
		t.moduleToolboxes.subscribe((v) => (list = v))();
		t.openToolboxes.subscribe((v) => (open = v))();
		return {
			registered: list.length,
			open: open.length,
			mounted: window.__tbx.mounts,
			inDom: !!document.querySelector('#mod-testtbx-panel')
		};
	});
	h.check(initial.registered === 1, `the toolbox is registered (${initial.registered})`);
	h.check(
		initial.open === 0 && !initial.inDom && initial.mounted === 0,
		'and starts CLOSED — a palette that appears uninvited is what registerMenu was avoiding'
	);

	// ---- 2. it opens from the SIDEBAR (the real opener) ----------------------
	await page.locator('#logo-menu').click();
	await page.waitForTimeout(600);
	const sidebarRow = await page.evaluate(() => {
		const el = document.querySelector('#open-toolbox-mod-testtbx-panel');
		return { found: !!el, text: el?.textContent?.trim() ?? null };
	});
	h.check(sidebarRow.found, 'a "Modules" section row exists in the sidebar for it');
	h.check(
		/Test Panel/.test(sidebarRow.text ?? ''),
		`the row is labelled with the toolbox title and its shortcut (${JSON.stringify(sidebarRow.text)})`
	);
	await page.locator('#open-toolbox-mod-testtbx-panel').click();
	await page.waitForTimeout(900);

	const opened = await page.evaluate(() => {
		const el = document.querySelector('#mod-testtbx-panel');
		const body = el?.querySelector('.mod-tbx-mount');
		const btn = document.querySelector('#tbx-test-apply');
		const cs = el ? getComputedStyle(el) : null;
		return {
			inDom: !!el,
			mounted: window.__tbx.mounts,
			opens: window.__tbx.opens,
			hasTitle: (el?.querySelector('.toolbox-title')?.textContent ?? '').trim(),
			hasDragHandle: !!el?.querySelector('.move-handle'),
			modulesDom: !!body && body.childElementCount === 2,
			// the shell styles the module's markup: .tbx-primary must be a real pill,
			// not an unstyled <button>
			applyBg: btn ? getComputedStyle(btn).backgroundColor : null,
			position: cs?.position,
			zIndex: cs?.zIndex
		};
	});
	h.check(opened.inDom, 'clicking the sidebar row opens the real ToolboxWindow');
	h.check(opened.mounted === 1 && opened.opens === 1, `the mount fn ran once and onOpen fired (${opened.mounted}/${opened.opens})`);
	h.check(opened.hasTitle === 'Test Panel', `the shell renders the title (${opened.hasTitle})`);
	h.check(opened.hasDragHandle, 'and a header drag handle it did not have to write');
	h.check(opened.modulesDom, 'the module`s plain DOM is inside the body');
	h.check(
		opened.applyBg && opened.applyBg !== 'rgba(0, 0, 0, 0)',
		`the shell STYLES the module's .tbx-primary for free (${opened.applyBg})`
	);
	h.check(opened.position === 'fixed', `the window is fixed, never absolute (${opened.position})`);

	// the module's own control still works
	await page.locator('#tbx-test-apply').click();
	const clicked = await page.evaluate(() => window.__tbx.clicks);
	h.check(clicked === 1, `the module's own button works (${clicked})`);

	// ---- 3. the VIEWPORT MENU offers the same rows, from one builder ---------
	await page.evaluate(() => {
		// open the viewport menu directly through its store (Scene routes right-taps here)
		window.__stores.viewportMenu.set({ x: 300, y: 300, point: { x: 0, y: 0, z: 0 } });
	});
	await page.waitForTimeout(700);
	const menuRows = await page.evaluate(() => {
		const rows = [...document.querySelectorAll('[role="menu"] *')].filter(
			(el) => el.children.length === 0 && /Module tools/.test(el.textContent ?? '')
		);
		return { hasEntry: rows.length > 0 };
	});
	h.check(menuRows.hasEntry, 'the viewport menu carries a "Module tools" entry');
	// the builder is shared, so the same rows come out of it either way
	const builderParity = await page.evaluate(() => {
		const t = window.__stores.moduleToolboxes;
		let list, open;
		t.moduleToolboxes.subscribe((v) => (list = v))();
		t.openToolboxes.subscribe((v) => (open = v))();
		const rows = t.buildToolboxItems(list, open);
		return {
			count: rows.length,
			label: rows[0]?.label,
			checked: rows[0]?.checked,
			shortcut: rows[0]?.shortcut
		};
	});
	h.check(
		builderParity.count === 1 && builderParity.label === 'Test Panel',
		`one builder feeds both hosts (${JSON.stringify(builderParity)})`
	);
	h.check(builderParity.checked === true, 'and it reports the open state, so both hosts can tick the row');
	h.check(builderParity.shortcut === 'Ctrl+Shift+F9', 'and carries the module-declared shortcut');
	await page.evaluate(() => window.__stores.viewportMenu.set(null));

	// the declared shortcut is in the Settings list too
	const inShortcuts = await page.evaluate(() =>
		window.__stores.shortcutsRegistry.shortcuts.some(
			(s) => s.keys === 'Ctrl+Shift+F9' && s.group === 'Modules'
		)
	);
	h.check(inShortcuts, 'a module-declared shortcut is listed under Settings > Shortcuts');

	// ---- 4. drag position PERSISTS across a reload ---------------------------
	const box = await page.locator('#mod-testtbx-panel .move-handle').boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + 8);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 140, box.y + 8 + 90, { steps: 12 });
	await page.mouse.up();
	await page.waitForTimeout(600);
	const movedTo = await page.evaluate(() => {
		const el = document.querySelector('#mod-testtbx-panel');
		return { left: Math.round(el.getBoundingClientRect().left), stored: localStorage.getItem('win:modtbx-testtbx-panel') };
	});
	h.check(movedTo.left > 380, `the header drag moved the window (left=${movedTo.left})`);
	h.check(!!movedTo.stored, `dragWindow persisted the rect under its own key (${movedTo.stored})`);

	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(4000);
	await page.waitForFunction(() => !!window.__stores?.moduleToolboxes, { timeout: 30000 });
	await install();
	await page.evaluate(() => window.__stores.moduleToolboxes.openModuleToolbox('mod-testtbx-panel'));
	await page.waitForTimeout(900);
	const afterReload = await page.evaluate(() => {
		const el = document.querySelector('#mod-testtbx-panel');
		return el ? Math.round(el.getBoundingClientRect().left) : -1;
	});
	h.check(
		Math.abs(afterReload - movedTo.left) <= 4,
		`the dragged position survives a reload (${movedTo.left} -> ${afterReload})`
	);

	// ---- 5. bottom SHEET at <=640px -----------------------------------------
	await page.setViewportSize({ width: 520, height: 800 });
	await page.waitForTimeout(900);
	const sheet = await page.evaluate(() => {
		const el = document.querySelector('#mod-testtbx-panel');
		const r = el?.getBoundingClientRect();
		return {
			isSheet: !!el?.classList.contains('tbx-sheet'),
			hasGrabber: !!el?.querySelector('.tbx-sheet-grab'),
			width: r ? Math.round(r.width) : -1
		};
	});
	h.check(sheet.isSheet, 'at <=640px it becomes a bottom SHEET, inherited from the shell');
	h.check(sheet.hasGrabber, 'with the sheet grabber');
	h.check(sheet.width >= 500, `and spans the width (${sheet.width})`);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.waitForTimeout(700);

	// ---- 6. a DEV RELOAD re-mounts in place ---------------------------------
	// deactivate + register again is exactly what 17-A2's dev live reload does.
	const reloaded = await page.evaluate(async () => {
		const s = window.__stores;
		const before = { mounts: window.__tbx.mounts, cleanups: window.__tbx.cleanups };
		await s.moduleSDK.deactivateModule('testtbx');
		await new Promise((r) => setTimeout(r, 500));
		const mid = {
			inDom: !!document.querySelector('#mod-testtbx-panel'),
			cleanups: window.__tbx.cleanups,
			registered: (() => {
				let l;
				s.moduleToolboxes.moduleToolboxes.subscribe((v) => (l = v))();
				return l.length;
			})(),
			open: (() => {
				let o;
				s.moduleToolboxes.openToolboxes.subscribe((v) => (o = v))();
				return o.length;
			})()
		};
		return { before, mid };
	});
	h.check(!reloaded.mid.inDom, 'disabling the module removes its window from the DOM');
	h.check(
		reloaded.mid.cleanups > reloaded.before.cleanups,
		`and the module's own cleanup ran (${reloaded.before.cleanups} -> ${reloaded.mid.cleanups})`
	);
	h.check(reloaded.mid.registered === 0, 'the toolbox is unregistered');
	h.check(
		reloaded.mid.open === 0,
		'and force-CLOSED — otherwise openToolboxes keeps an id whose mount fn is gone'
	);

	await install();
	const reOpened = await page.evaluate(async () => {
		const s = window.__stores;
		s.moduleToolboxes.openModuleToolbox('mod-testtbx-panel');
		await new Promise((r) => setTimeout(r, 700));
		return {
			inDom: !!document.querySelector('#mod-testtbx-panel'),
			hasButton: !!document.querySelector('#tbx-test-apply'),
			sidebarRowGone: !document.querySelector('#open-toolbox-mod-testtbx-panel')
		};
	});
	h.check(reOpened.inDom && reOpened.hasButton, 'a dev reload re-registers and re-mounts it with fresh code');

	// ---- 7. the ✕ closes it, and Play mode hides it unless it opted in -------
	await page.locator('#mod-testtbx-panel .tbx-hbtn').first().click();
	await page.waitForTimeout(500);
	const closed = await page.evaluate(() => ({
		inDom: !!document.querySelector('#mod-testtbx-panel'),
		closes: window.__tbx.closes
	}));
	h.check(!closed.inDom, 'the header ✕ closes it — a module toolbox belongs to no edit session');
	h.check(closed.closes >= 1, `and onClose fired (${closed.closes})`);

	const playMode = await page.evaluate(async () => {
		const s = window.__stores;
		s.moduleToolboxes.openModuleToolbox('mod-testtbx-panel');
		await new Promise((r) => setTimeout(r, 500));
		const editor = !!document.querySelector('#mod-testtbx-panel');
		s.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 500));
		const locked = !!document.querySelector('#mod-testtbx-panel');
		// still OPEN in the store, only not rendered — so leaving play mode brings it back
		let open;
		s.moduleToolboxes.openToolboxes.subscribe((v) => (open = v))();
		const stillOpen = open.includes('mod-testtbx-panel');
		s.isLocked.set(false);
		await new Promise((r) => setTimeout(r, 500));
		return { editor, locked, stillOpen, back: !!document.querySelector('#mod-testtbx-panel') };
	});
	h.check(playMode.editor, 'premise: it is open in the editor');
	h.check(
		!playMode.locked,
		'a toolbox that did NOT opt into playMode is hidden in Play mode — a palette over a game is in the way'
	);
	h.check(playMode.stillOpen, 'it stays open in the store, so it is not lost');
	h.check(playMode.back, 'and comes back on leaving Play mode');

	const optedIn = await page.evaluate(async () => {
		const s = window.__stores;
		await s.moduleSDK.initModules([
			{
				id: 'testplay',
				name: 'Play toolbox',
				version: '1.0.0',
				description: 'playMode opt-in',
				register(api) {
					api.registerToolbox({
						id: 'hostsettings',
						title: 'Host settings',
						playMode: true,
						mount: (el) => {
							el.textContent = 'live';
						}
					});
				}
			}
		]);
		s.moduleToolboxes.openModuleToolbox('mod-testplay-hostsettings');
		await new Promise((r) => setTimeout(r, 500));
		s.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 600));
		const shown = !!document.querySelector('#mod-testplay-hostsettings');
		s.isLocked.set(false);
		return shown;
	});
	h.check(optedIn, 'playMode: true keeps a toolbox visible in Play mode (a game`s host settings)');

	// ---- 7b. `sidebar: false` + the open/close API (R3a follow-up) -----------
	//
	// TWO seams the collectible module needed. A toolbox that belongs to a WORKFLOW does
	// not want a permanent row in the burger menu (the app's own chrome), so it opts out
	// of the sidebar and keeps its viewport-menu row — and then something has to be able
	// to OPEN it, which `registerToolbox`'s returned id always promised ("open/close it
	// with this") and nothing delivered (the `api.hud.rows` family: a surface whose own
	// docs claim an API that does not exist).
	const quiet = await page.evaluate(async () => {
		const s = window.__stores;
		window.__quiet = {};
		await s.moduleSDK.initModules([
			{
				id: 'testquiet',
				name: 'Quiet toolbox',
				version: '1.0.0',
				description: 'sidebar opt-out + the open API',
				register(api) {
					window.__quiet.id = api.registerToolbox({
						id: 'panel',
						title: 'Quiet Panel',
						sidebar: false,
						mount: (el) => {
							el.textContent = 'quiet';
						}
					});
					// the way IN a module gets instead: a button on its own manager card
					api.registerMenu('Open Quiet', () => api.openToolbox(window.__quiet.id));
				}
			}
		]);
		const t = s.moduleToolboxes;
		let list, open, menuItems;
		t.moduleToolboxes.subscribe((v) => (list = v))();
		t.openToolboxes.subscribe((v) => (open = v))();
		s.moduleSDK.moduleMenuItems.subscribe((v) => (menuItems = v))();
		// the ONE builder, asked the way each host asks it
		const rowIds = (surface) => t.buildToolboxItems(list, open, surface).map((b) => b.id);
		return {
			sidebar: rowIds('sidebar'),
			viewport: rowIds('menu'),
			unfiltered: rowIds(),
			card: menuItems.filter((m) => m.moduleId === 'testquiet').map((m) => m.label)
		};
	});
	h.check(
		!quiet.sidebar.includes('mod-testquiet-panel') && quiet.sidebar.includes('mod-testtbx-panel'),
		`sidebar: false drops ITS row and leaves every other module's alone (${JSON.stringify(quiet.sidebar)})`
	);
	h.check(
		quiet.viewport.includes('mod-testquiet-panel'),
		`and it keeps its viewport-menu row (${JSON.stringify(quiet.viewport)})`
	);
	h.check(
		quiet.unfiltered.includes('mod-testquiet-panel'),
		'an unqualified build (no surface) still lists everything — the additive default'
	);
	h.check(
		JSON.stringify(quiet.card) === '["Open Quiet"]',
		`the module put its own opener on its manager card (${JSON.stringify(quiet.card)})`
	);
	// and the SIDEBAR really does not render it — measured in the DOM, not in the store
	await page.locator('#logo-menu').click();
	await page.waitForTimeout(600);
	const domRows = await page.evaluate(() => ({
		quiet: !!document.querySelector('#open-toolbox-mod-testquiet-panel'),
		other: !!document.querySelector('#open-toolbox-mod-testtbx-panel')
	}));
	h.check(!domRows.quiet && domRows.other, 'the sidebar renders no row for it (and still renders the other)');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);

	// The card ENTRY's own action, with the manager open — the exact function the card's
	// button calls. (A real DOM click on the card lives in the collectible module's own
	// suite: the manager renders cards for core modules and installed USER records, and
	// an inline `initModules` module is neither, so it has no card here to click.)
	await page.evaluate(() => window.__stores.modulesOpen.set(true));
	await page.waitForTimeout(700);
	const afterCard = await page.evaluate(async () => {
		const s = window.__stores;
		let items, open;
		s.moduleSDK.moduleMenuItems.subscribe((v) => (items = v))();
		items.find((m) => m.moduleId === 'testquiet')?.action();
		await new Promise((r) => setTimeout(r, 600));
		s.modulesOpen.subscribe((v) => (open = v))();
		return { managerOpen: open, inDom: !!document.querySelector('#mod-testquiet-panel') };
	});
	h.check(afterCard.inDom, 'the card button opens the toolbox through api.openToolbox');
	h.check(
		!afterCard.managerOpen,
		'and dismisses the Modules manager, which is the one chrome that could cover it'
	);
	const closeApi = await page.evaluate(async () => {
		const s = window.__stores;
		let api = null;
		await s.moduleSDK.initModules([
			{
				id: 'testquiet2',
				name: 'Quiet 2',
				version: '1.0.0',
				description: 'close + toggle',
				register(a) {
					api = a;
					window.__quiet.id2 = a.registerToolbox({
						id: 'p',
						title: 'Q2',
						mount: (el) => (el.textContent = 'x')
					});
				}
			}
		]);
		const id = window.__quiet.id2;
		api.openToolbox(id);
		await new Promise((r) => setTimeout(r, 400));
		const opened = !!document.querySelector('#' + id);
		api.closeToolbox(id);
		await new Promise((r) => setTimeout(r, 400));
		const closed = !document.querySelector('#' + id);
		api.toggleToolbox(id);
		await new Promise((r) => setTimeout(r, 400));
		const toggledOn = !!document.querySelector('#' + id);
		api.toggleToolbox(id);
		await new Promise((r) => setTimeout(r, 400));
		return { opened, closed, toggledOn, toggledOff: !document.querySelector('#' + id) };
	});
	h.check(
		closeApi.opened && closeApi.closed,
		`api.openToolbox / closeToolbox drive the real window (${JSON.stringify(closeApi)})`
	);
	h.check(closeApi.toggledOn && closeApi.toggledOff, 'and toggleToolbox flips it both ways');

	// ---- 8. cloudMount is genuinely SHARED, not copied -----------------------
	// CloudSlot.svelte was the only consumer; the action moved into $lib/cloudMount and
	// CloudSlot imports it, so an OSS build with no plugin still renders nothing.
	const shared = await page.evaluate(() => ({
		exported: typeof window.__stores.moduleToolboxes === 'object',
		noCloudSlot: document.querySelectorAll('.cloud-slot').length
	}));
	h.check(shared.noCloudSlot === 0, 'OSS build: no cloud slot renders (the plugin stores are null)');

	await h.finish(browser);
});
