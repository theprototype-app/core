// 70 W1 — FILES AND FOLDERS FROM THE CODE TAB, two peers (shareNewFiles: always).
//   1 New folder + New file (Script) from the Project tree's header: an Explorer folder and file,
//     on A and on B; the script opens in a Code tab with the lifecycle stub
//   2 one undo each: Ctrl+Z in the tree takes the file back, the toast's Undo the folder — on both
//   3 the context menu: right-click a folder → New folder inside it; Shift+F10 opens it from the keys
//   4 rename (F2) and move (drag to Files, Ctrl+X then Ctrl+V onto a folder): the open tab follows
//     the name and keeps pointing at the same item; Save still writes that item
//   5 delete (Del → confirm) reaches B and closes the clean tab; Ctrl+Z restores it on both
//   6 a viewer: the header buttons are disabled with the reason, the verbs refuse, F2 opens nothing
//   7 the pop-out window: the tree's context menu opens there and New folder works from it
//   screenshots dark + light (CF_SHOTS=<dir>)
const h = require('./helpers.cjs');
const path = require('path');

const SHOTS = process.env.CF_SHOTS || '';
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name) });

/** a store under window.__stores, by dotted path */
const read = (page, p) =>
	page.evaluate((p) => {
		let obj = window.__stores;
		for (const k of p.split('.')) obj = obj[k];
		let v;
		obj.subscribe((x) => (v = x))();
		return JSON.parse(JSON.stringify(v ?? null));
	}, p);
const items = (page) => read(page, 'explorer.explorerItems');
const folders = (page) => read(page, 'explorer.explorerFolders');
const tabs = (page) => read(page, 'codeWorkspace.codeTabs');
const itemNamed = async (page, name) => (await items(page)).find((i) => i.name === name) ?? null;
const folderNamed = async (page, name) => (await folders(page)).find((f) => f.name === name) ?? null;
const row = (page, key) => page.locator(`#code-ws-project [data-tree-key="${key}"]`);
const debug = (page) => page.evaluate(() => window.__stores.codeFiles.codeFilesDebug());

/** type a name into the inline field and commit it */
async function nameIt(page, name) {
	const input = page.locator('#code-ws-name-input');
	await input.waitFor({ state: 'visible', timeout: 5000 });
	await input.fill(name);
	await input.press('Enter');
	await page.waitForTimeout(400);
}
/** h.eventually that hands back the value it settled on */
async function until(fn, pred, label, ms = 10000) {
	const end = Date.now() + ms;
	let v;
	while (Date.now() < end) {
		v = await fn().catch(() => undefined);
		if (pred(v)) break;
		await new Promise((r) => setTimeout(r, 300));
	}
	if (!pred(v)) console.log('  last: ' + JSON.stringify(v)?.slice(0, 300));
	h.check(pred(v), label);
	return v;
}
/** a menu row by its label (the shared ContextMenu) */
const menuItem = (page, label) => page.locator('[role="menuitem"]', { hasText: label }).first();

h.run(async () => {
	const browser = await h.launch();
	const storage = { 'shared:shareNewFiles': 'always' };
	const A = await h.setupPage(browser, 'A', { storage, context: { viewport: { width: 1400, height: 900 } } });
	const B = await h.setupPage(browser, 'B', { storage });
	await h.connect(B, A);
	const page = A.page;

	// the Code tab, empty (asked again if a cold page had not mounted the dock yet)
	for (let i = 0; i < 4; i++) {
		await page.evaluate(async () => {
			const s = window.__stores;
			s.codeWorkspace.startCodeWorkspace();
			s.codeWorkspaceClose.set(false);
			s.bottomDock.activateDock('code');
			s.bottomDock.dockHeight.set(560);
			s.undoToast.undoTiming.ms = 120000; // the toast must outlast the waits for B below
		});
		if (await page.locator('#code-ws-left').waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false)) break;
	}
	h.check(await page.locator('#code-ws-left').isVisible(), 'premise: the Code tab is open, its left sidebar showing');
	h.check(await row(page, 'grp:files').isVisible(), 'premise: the Project tree has a Files group');

	// ------------------------------------------------------------ 1 New folder + New file
	await page.locator('#code-ws-new-folder').click();
	await nameIt(page, 'Levels');
	const levels = await folderNamed(page, 'Levels');
	h.check(!!levels, 'New folder from the Code tab makes an Explorer folder ("Levels")');
	h.check(await row(page, 'dir:' + levels?.id).isVisible(), '…and it shows in the Project tree');
	await h.eventually(() => folderNamed(B.page, 'Levels'), (f) => f?.id === levels?.id, 'the folder reaches B under the same id', 20000);

	await row(page, 'dir:' + levels.id).focus();
	await page.locator('#code-ws-new-file').click();
	await menuItem(page, 'Script (.js)').click();
	const input = page.locator('#code-ws-name-input');
	await input.waitFor({ state: 'visible', timeout: 5000 });
	h.check(/Script/i.test((await input.getAttribute('aria-label')) ?? ''), 'the name field says what it names (' + (await input.getAttribute('aria-label')) + ')');
	await nameIt(page, 'player');
	const player = await itemNamed(page, 'player.js');
	h.check(!!player && player.folderId === levels.id, 'New file ▸ Script makes "player.js" in the folder that had focus');
	let list = await until(() => tabs(page), (t) => t?.some((x) => x.itemId === player?.id), 'the new script opens in a Code tab', 10000);
	const tabId = list?.find((x) => x.itemId === player?.id)?.id;
	const code = list?.find((x) => x.itemId === player?.id)?.code ?? '';
	h.check(/start|roundStart/.test(code), 'the script starts from the template with the lifecycle stub');
	h.check((await read(page, 'codeWorkspace.activeCodeTab')) === tabId, '…and is the active tab');
	await h.eventually(() => itemNamed(B.page, 'player.js'), (i) => i?.folderId === levels.id, 'the file reaches B, in the same folder', 20000);
	await shot(page, '01-after-new-file-dark.png');

	// ------------------------------------------------------------ 2 one undo each
	// the toast offers the NEWEST op (the file); Ctrl+Z in the tree walks further back (the folder)
	const pressed = await page.evaluate(() => {
		const b = [...document.querySelectorAll('.tp-toast--undo:not([inert]) .tp-toast-action')].find((x) => x.textContent.trim() === 'Undo');
		b?.click();
		return !!b;
	});
	h.check(pressed, 'the toast offers Undo for the new file');
	await h.eventually(() => itemNamed(page, 'player.js'), (i) => !i, "the toast's Undo takes the new file back on A", 6000);
	await h.eventually(() => itemNamed(B.page, 'player.js'), (i) => !i, '…and on B', 20000);
	h.check(!(await tabs(page)).some((t) => t.itemId === player.id), "the undone file's clean tab closes");
	h.check(await page.locator('#code-ws-left').isVisible(), '…and the Code tab stays open on the tree (it was the last tab)');
	h.check(!!(await folderNamed(page, 'Levels')), 'one undo is one action: the folder is still there');
	await row(page, 'dir:' + levels.id).focus();
	await page.keyboard.press('Control+z');
	await h.eventually(() => folderNamed(page, 'Levels'), (f) => !f, 'Ctrl+Z in the tree takes the folder back on A', 6000);
	await h.eventually(() => folderNamed(B.page, 'Levels'), (f) => !f, '…and on B', 20000);
	h.check((await debug(page)).stack.length === 0, 'nothing left to undo');
	h.check(((await read(page, 'history.undoStack'))?.length ?? 0) === 0, 'the scene history is untouched');

	// ------------------------------------------------------------ 3 the context menu
	await row(page, 'grp:files').click({ button: 'right' });
	await menuItem(page, 'New folder').click();
	await nameIt(page, 'Scripts');
	const scripts = await folderNamed(page, 'Scripts');
	h.check(!!scripts && !scripts.parentId, 'right-click on Files ▸ New folder makes a root folder ("Scripts")');
	await row(page, 'dir:' + scripts.id).focus();
	await page.keyboard.press('Shift+F10');
	h.check(await menuItem(page, 'Rename').isVisible(), 'Shift+F10 opens the menu from the keys (Rename, Move to, Delete…)');
	await menuItem(page, 'New folder').click();
	await nameIt(page, 'Enemies');
	const enemies = await folderNamed(page, 'Enemies');
	h.check(enemies?.parentId === scripts.id, 'a folder\'s menu ▸ New folder nests it ("Scripts/Enemies")');
	// a taken name is refused inline, with the reason
	await row(page, 'grp:files').click({ button: 'right' });
	await menuItem(page, 'New folder').click();
	await page.locator('#code-ws-name-input').fill('Scripts');
	await page.locator('#code-ws-name-input').press('Enter');
	await page.waitForTimeout(300);
	h.check(/already a folder/.test((await page.locator('#code-ws-name-error').innerText().catch(() => '')) ?? ''), 'a taken folder name is refused in place, with the reason');
	await page.locator('#code-ws-name-input').press('Escape');

	// ------------------------------------------------------------ 4 rename + move keep the tab
	const made = await page.evaluate((fid) => window.__stores.codeFiles.createCodeFile({ template: 'script', name: 'enemy', folderId: fid }), enemies.id);
	const enemy = made.item;
	h.check(made.ok && !!made.tabId, 'premise: "enemy.js" made in Enemies and open in a tab');
	await h.eventually(() => itemNamed(B.page, 'enemy.js'), (i) => !!i, 'premise: it reached B', 20000);
	const fileRow = () => row(page, 'f:' + enemy.id);
	for (const id of [scripts.id, enemies.id]) if ((await row(page, 'dir:' + id).getAttribute('aria-expanded')) !== 'true') await row(page, 'dir:' + id).click();
	await fileRow().waitFor({ state: 'visible', timeout: 5000 });
	await fileRow().focus();
	await page.keyboard.press('F2');
	await nameIt(page, 'boss');
	h.check((await items(page)).find((i) => i.id === enemy.id)?.name === 'boss.js', 'F2 renames the file (the extension is kept: "boss.js")');
	list = await until(() => tabs(page), (t) => t?.find((x) => x.id === made.tabId)?.name === 'boss.js', 'the open tab follows the new name', 6000);
	h.check(list?.find((x) => x.id === made.tabId)?.itemId === enemy.id, '…and still points at the same item');
	await h.eventually(() => itemNamed(B.page, 'boss.js'), (i) => !!i, 'the rename reaches B', 20000);

	await fileRow().dragTo(row(page, 'grp:files'));
	await h.eventually(async () => (await items(page)).find((i) => i.id === enemy.id)?.folderId ?? null, (f) => f === null, 'dragging the file onto Files moves it to the Library root', 6000);
	await h.eventually(() => itemNamed(B.page, 'boss.js'), (i) => !!i && !i.folderId, 'the move reaches B', 20000);
	await fileRow().focus();
	await page.keyboard.press('Control+x');
	h.check(await page.locator('#code-ws-cut').isVisible(), 'Ctrl+X marks it to move (and says how to finish)');
	await row(page, 'dir:' + scripts.id).focus();
	await page.keyboard.press('Control+v');
	await h.eventually(async () => (await items(page)).find((i) => i.id === enemy.id)?.folderId, (f) => f === scripts.id, 'Ctrl+V on a folder puts it there', 6000);
	const tab = (await tabs(page)).find((x) => x.id === made.tabId);
	h.check(tab?.itemId === enemy.id && tab?.name === 'boss.js', 'after both moves the tab still points at the file');
	await page.evaluate((id) => window.__stores.codeWorkspace.setTabCode(id, '// boss\nexport default { start() {} };\n'), made.tabId);
	await page.evaluate((id) => window.__stores.codeWorkspace.saveCodeTab(id), made.tabId);
	const saved = await until(
		() => page.evaluate(async (id) => (await (await window.__stores.explorer.itemBlob(id))?.text()) ?? '', enemy.id),
		(t) => /\/\/ boss/.test(t),
		'Save writes that same item (moved and renamed)',
		6000
	);
	h.check((await items(page)).filter((i) => i.name === 'boss.js').length === 1 && !!saved, 'one file, no copy left behind');
	await shot(page, '02-after-rename-move-dark.png');

	// ------------------------------------------------------------ 5 delete + undo
	await page.evaluate(() => window.__stores.codeWorkspace.saveAllCodeTabs());
	await fileRow().focus();
	await page.keyboard.press('Delete');
	await page.locator('#code-ws-delete-confirm').waitFor({ state: 'visible', timeout: 4000 });
	h.check(/boss\.js/.test(await page.locator('#code-ws-delete-text').innerText()), 'Del asks first, naming the file');
	await page.locator('#code-ws-delete-ok').click();
	await h.eventually(() => itemNamed(page, 'boss.js'), (i) => !i, 'the file goes (to Deleted)', 6000);
	await h.eventually(() => itemNamed(B.page, 'boss.js'), (i) => !i, '…on B too', 20000);
	h.check(!(await tabs(page)).some((t) => t.id === made.tabId), 'its clean tab closes');
	await row(page, 'grp:files').focus();
	await page.keyboard.press('Control+z');
	await h.eventually(() => itemNamed(page, 'boss.js'), (i) => i?.folderId === scripts.id, 'Ctrl+Z restores it where it was', 6000);
	await h.eventually(() => itemNamed(B.page, 'boss.js'), (i) => !!i, '…on B too', 20000);

	// ------------------------------------------------------------ screenshots, both themes
	await shot(page, '03-tree-dark.png');
	await page.evaluate(() => window.__stores.themes.theme.set('light'));
	await page.waitForTimeout(400);
	await row(page, 'dir:' + scripts.id).click({ button: 'right' });
	await page.waitForTimeout(300);
	await shot(page, '04-menu-light.png');
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));

	// ------------------------------------------------------------ 6 a viewer
	const before = { items: (await items(page)).length, folders: (await folders(page)).length };
	await page.evaluate(() =>
		window.__stores.cloudHooks.rolesInfo.set({ myId: 'a', myRole: 'viewer', amAdmin: false, order: ['viewer', 'editor', 'admin'], roleOf: () => 'viewer', setRole: () => {} })
	);
	await page.waitForTimeout(300);
	h.check((await page.locator('#code-ws-new-file').getAttribute('aria-disabled')) === 'true', "a viewer's New file is disabled");
	h.check(/View only/.test((await page.locator('#code-ws-new-folder').getAttribute('title')) ?? ''), '…with the reason on hover');
	await page.locator('#code-ws-new-folder').click({ force: true }); // aria-disabled: Playwright would wait for it
	await page.waitForTimeout(300);
	h.check((await page.locator('#code-ws-name-input').count()) === 0, 'pressing it opens nothing');
	const r = await page.evaluate(() => window.__stores.codeFiles.createCodeFolder({ name: 'Nope' }));
	h.check(!r.ok && /View only/.test(r.reason ?? ''), 'the verb itself refuses a viewer, with the reason');
	const rowOf = await itemNamed(page, 'boss.js');
	await row(page, 'f:' + rowOf.id).focus();
	await page.keyboard.press('F2');
	h.check((await page.locator('#code-ws-name-input').count()) === 0, 'F2 renames nothing for a viewer');
	await row(page, 'f:' + rowOf.id).click({ button: 'right' });
	h.check((await menuItem(page, 'Delete').getAttribute('aria-disabled')) === 'true', "the menu's Delete is disabled for a viewer");
	await page.keyboard.press('Escape');
	const after = { items: (await items(page)).length, folders: (await folders(page)).length };
	h.check(JSON.stringify(after) === JSON.stringify(before), 'nothing changed in the library');
	await shot(page, '05-viewer-dark.png');
	await page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));

	// ------------------------------------------------------------ 7 the same tree in the pop-out window
	const [pop] = await Promise.all([page.context().waitForEvent('page', { timeout: 20000 }), page.locator('#code-ws-popout').first().click()]);
	const popFiles = pop.locator('#code-ws-popped [data-tree-key="grp:files"]');
	await popFiles.waitFor({ state: 'visible', timeout: 30000 });
	await popFiles.click({ button: 'right' });
	h.check(await menuItem(pop, 'New folder').isVisible(), "in the pop-out window, the tree's menu opens there (New folder)");
	await menuItem(pop, 'New folder').click();
	await nameIt(pop, 'Popped');
	h.check(!!(await folderNamed(page, 'Popped')), '…and New folder from it makes the folder');
	await shot(pop, '06-popout-menu-dark.png');
	await pop.close();

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page errors on either peer');
	await h.finish(browser);
});
