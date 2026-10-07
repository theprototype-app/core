// 37 R14: named workspace layouts — save the windows you have open under a name and switch
// between arrangements live (no page reload). The load-bearing checks are the ones on
// windows that STAY MOUNTED while closed (chat, the object list, the dock-family panels'
// docked flag): only the `onLayoutRestore` re-reads can move those.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { storage: { flowDocked: 'false', explorerDocked: 'true' } });
	const page = A.page;

	const st = (/** @type {string} */ k) => page.evaluate((key) => localStorage.getItem(key), k);
	const rectOf = (/** @type {string} */ sel) =>
		page.evaluate((s) => {
			const el = document.querySelector(s);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), shown: r.width > 0 };
		}, sel);
	/** drag a window by its header by (dx, dy) with the real mouse */
	async function dragHeader(/** @type {string} */ sel, dx, dy) {
		const r = await page.evaluate((s) => {
			// a point of the header that is really the header: another floating window (the
			// node editor opens at its own default rect) can sit over part of it
			const win = document.querySelector(s);
			const hd = win.querySelector('.move-handle');
			const b = hd.getBoundingClientRect();
			const y = b.top + b.height / 2;
			for (let x = b.left + 20; x < b.right - 20; x += 15) {
				const at = document.elementFromPoint(x, y);
				if (at && hd.contains(at) && !at.closest('button, input, select, a')) return { x, y };
			}
			return { x: b.left + 40, y };
		}, sel);
		await page.mouse.move(r.x, r.y);
		await page.mouse.down();
		await page.mouse.move(r.x + dx / 2, r.y + dy / 2, { steps: 5 });
		await page.mouse.move(r.x + dx, r.y + dy, { steps: 5 });
		await page.mouse.up();
		await page.waitForTimeout(200);
	}

	// ---- 1. arrangement Alpha: node editor FLOATING, Explorer docked, chat open at a dragged spot
	await page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(false);
		s.explorerClose.set(false);
		s.chatHidden.set('');
	});
	await page.waitForTimeout(800);
	h.check(!!(await rectOf('#flow-window'))?.shown, 'premise: the node editor opens floating');
	await dragHeader('#chat-window', -300, -120);
	const chatAlpha = await rectOf('#chat-window');
	const storedAlpha = JSON.parse((await st('win:chat')) ?? 'null');
	h.check(!!storedAlpha && Math.abs(storedAlpha.left - chatAlpha.left) <= 2, `premise: the chat drag persisted its rect (${JSON.stringify(storedAlpha)})`);
	await page.evaluate(() => window.__stores.bottomDock.dockHeight.set(300));
	const saveA = await page.evaluate(() => window.__stores.uiLayouts.saveLayout('Alpha'));
	h.check(saveA.ok && !saveA.updated, 'Alpha saved as a new layout');

	// ---- 2. arrangement Beta: node editor closed, profiler open, chat moved again, taller dock
	await page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphClose.set(true);
		s.profilerClose.set(false);
	});
	await dragHeader('#chat-window', 220, 80);
	await page.evaluate(() => window.__stores.bottomDock.dockHeight.set(420));
	await page.waitForTimeout(300);
	const chatBeta = await rectOf('#chat-window');
	h.check(Math.abs(chatBeta.left - chatAlpha.left) > 100, `premise: chat moved between the two (${chatAlpha.left} -> ${chatBeta.left})`);
	const saveB = await page.evaluate(() => window.__stores.uiLayouts.saveLayout('Beta'));
	h.check(saveB.ok, 'Beta saved');
	const ids = await page.evaluate(() => {
		let list = [];
		window.__stores.uiLayouts.uiLayouts.subscribe((v) => (list = v))();
		return list.map((l) => ({ id: l.id, name: l.name }));
	});
	h.check(ids.length === 2 && ids[0].name === 'Alpha' && ids[1].name === 'Beta', 'two layouts listed in save order');

	// ---- 3. apply Alpha
	const okA = await page.evaluate((id) => window.__stores.uiLayouts.applyLayout(id), ids[0].id);
	await page.waitForTimeout(600);
	h.check(okA === true, 'applyLayout(Alpha) resolves true');
	const afterA = await page.evaluate(() => {
		const s = window.__stores;
		const read = (/** @type {any} */ store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		return {
			flowOpen: read(s.flowGraphClose) === false,
			profilerOpen: read(s.profilerClose) === false,
			explorerOpen: read(s.explorerClose) === false,
			chatOpen: read(s.chatHidden) === '',
			dockH: read(s.bottomDock.dockHeight)
		};
	});
	h.check(afterA.flowOpen, 'Alpha: the node editor is open again');
	h.check(!afterA.profilerOpen, 'Alpha: the profiler (opened after the save) is closed');
	h.check(afterA.explorerOpen && afterA.chatOpen, 'Alpha: Explorer and chat are open');
	h.check(afterA.dockH === 300, `Alpha: the bottom dock height comes back (${afterA.dockH})`);
	h.check(!!(await rectOf('#flow-window'))?.shown, 'Alpha: the node editor came back FLOATING');
	// the chat window never unmounts (class-hidden): only the dragWindow re-read can move it
	const chatAfterA = await rectOf('#chat-window');
	h.check(Math.abs(chatAfterA.left - chatAlpha.left) <= 2 && Math.abs(chatAfterA.top - chatAlpha.top) <= 2, `Alpha: the live chat window moved back (${chatAfterA.left},${chatAfterA.top} vs ${chatAlpha.left},${chatAlpha.top})`);

	// ---- 4. apply Beta
	await page.evaluate((id) => window.__stores.uiLayouts.applyLayout(id), ids[1].id);
	await page.waitForTimeout(600);
	const chatAfterB = await rectOf('#chat-window');
	h.check(Math.abs(chatAfterB.left - chatBeta.left) <= 2, `Beta: the chat window moved to Beta's spot (${chatAfterB.left} vs ${chatBeta.left})`);
	const flowB = await page.evaluate(() => {
		let v;
		window.__stores.flowGraphClose.subscribe((x) => (v = x))();
		return v;
	});
	h.check(flowB === true, 'Beta: the node editor is closed');

	// ---- 5. a docked flag on a mounted panel follows the layout (the panel re-read)
	await page.evaluate(() => localStorage.setItem('flowDocked', 'true'));
	await page.evaluate((id) => window.__stores.uiLayouts.applyLayout(id), ids[0].id);
	await page.waitForTimeout(600);
	h.check(!!(await rectOf('#flow-window'))?.shown && (await st('flowDocked')) === 'false', 'a stale docked flag is overwritten: Alpha re-floats the node editor');

	// ---- 6. the UI: menu ▸ Layouts popover saves, lists, applies, renames, deletes
	await page.evaluate(() => window.__stores.closeMenu.set(false));
	await page.waitForTimeout(300);
	await page.click('#open-layouts');
	await page.waitForSelector('#layouts-menu');
	h.check(true, 'menu ▸ Layouts opens the popover');
	await page.fill('#layouts-menu-name', 'Gamma');
	await page.click('#layouts-menu-save');
	await page.waitForTimeout(200);
	const rows = await page.$$eval('#layouts-menu-list li', (els) => els.map((e) => e.textContent?.trim()));
	h.check(rows.length === 3 && rows[2]?.includes('Gamma'), `the saved layout is listed (${rows.join(' | ')})`);
	await page.fill('#layouts-menu-name', 'gamma');
	await page.click('#layouts-menu-save');
	await page.waitForTimeout(200);
	h.check((await page.$$('#layouts-menu-list li')).length === 3, 'saving the same name (any case) updates instead of adding');
	await page.click('#layouts-menu-list li:nth-child(1) .wl-apply');
	await page.waitForTimeout(700);
	h.check(await page.evaluate(() => localStorage.getItem('uiLayouts:active')) === ids[0].id, 'clicking a row applies it (Alpha marked active)');
	// rename Beta via the pencil
	await page.click('#open-layouts').catch(() => {});
	if (!(await page.$('#layouts-menu'))) {
		await page.evaluate(() => window.__stores.uiLayouts.layoutsMenuOpen.set(true));
		await page.waitForSelector('#layouts-menu');
	}
	await page.click('#layouts-menu-list li:nth-child(2) .wl-icon[title="Rename"]');
	await page.fill('#layouts-menu-list .wl-rename', 'Beta two');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(200);
	const names = await page.$$eval('#layouts-menu-list .wl-name', (els) => els.map((e) => e.textContent));
	h.check(names[1] === 'Beta two', `rename sticks (${names.join(',')})`);
	await page.click('#layouts-menu-list li:nth-child(3) .wl-danger');
	await page.waitForTimeout(200);
	h.check((await page.$$('#layouts-menu-list li')).length === 2, 'delete removes the row');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	h.check(!(await page.$('#layouts-menu')), 'Escape closes the popover');

	// ---- 7. a reload is still a clean slate, and the list survives
	await h.freshReload(A);
	const reload = await page.evaluate(() => {
		let flow, list;
		window.__stores.flowGraphClose.subscribe((x) => (flow = x))();
		window.__stores.uiLayouts.uiLayouts.subscribe((x) => (list = x))();
		return { flowClosed: flow, count: list.length };
	});
	h.check(reload.flowClosed === true, 'after a reload nothing is open (no layout is applied at boot)');
	h.check(reload.count === 2, 'the saved layouts survive the reload');

	// ---- 8. Settings ▸ Interface carries the same list, searchable
	await page.evaluate(() => window.__stores.settingsOpen.set(true));
	await page.waitForTimeout(500);
	await page.getByText('Interface', { exact: true }).first().click();
	await page.waitForTimeout(300);
	const inSettings = await page.$$eval('#settings-layouts-list li', (els) => els.length).catch(() => 0);
	h.check(inSettings === 2, `Settings ▸ Interface lists the layouts (${inSettings})`);
	await page.click('#settings-layouts-list li:nth-child(1) .wl-apply');
	await page.waitForTimeout(800);
	const settingsClosed = await page.evaluate(() => {
		let v;
		window.__stores.settingsOpen.subscribe((x) => (v = x))();
		return !v;
	});
	h.check(settingsClosed && !!(await rectOf('#flow-window'))?.shown, 'applying from Settings closes Settings and the layout STAYS (not undone by the panel restore)');

	await h.finish(browser);
});
