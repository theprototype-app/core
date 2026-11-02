// 54i-vr (roadmap 81 X1) — "Add files…": phones and the Quest browser have no drag and drop, so the
// Explorer offers a FILE PICKER where a drop would go — the background menu, a folder's menu, a mount's
// menu and the empty view's button — and the picked files take THE SAME ROUTE as a drop
// (routeIncomingFiles): they land in that folder exactly as the same file dropped there does.
// Plus "New file ▸ Script / Note / JSON / Text" from the Code tab's own templates (codeFilesCore).
//   1. the empty folder's "Add files…" button: keyboard reachable, opens a file chooser, the file lands
//      in the folder — and a DROP of a file lands in the same folder (one router)
//   2. background menu ▸ Add files… (the active folder) · folder menu ▸ Add files… (THAT folder)
//   3. New file ▸ lists the four templates; Note makes notes.md in the folder
//   4. a phone (390x844, touch, dark + light): the empty view's button opens the chooser; shots
// Red on the 1.54.2 base: no picker anywhere (a phone could not add a file at all), no New file in the
// Explorer. Shots: SHOTS_DIR=… (dark + light, desktop menu + phone empty view).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.SHOTS_DIR || '';
const shot = async (page, name) => {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, name + '.png') });
};
// distinct bytes per file: the same bytes twice would (rightly) raise the import's duplicate ask
const txt = (name, body = 'hello from ' + name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });

h.run(async () => {
	const browser = await h.launch();

	// ---------------------------------------------------------------- desktop
	const A = await h.setupPage(browser, 'A', { storage: { theme: 'dark' } });
	const page = A.page;
	// Playwright turns file-chooser INTERCEPTION on when the first listener is added, asynchronously: a click
	// racing that leaves a headless native chooser pending, which blocks every later one. Arm it up front.
	page.on('filechooser', () => {});
	const items = () => page.evaluate(() => new Promise((r) => window.__stores.explorer.explorerItems.subscribe((v) => r(v.map((i) => ({ name: i.name, folderId: i.folderId ?? null }))))()));
	const itemNamed = async (name) => (await items()).find((i) => i.name === name) ?? null;
	const menuItem = (label) => page.locator('[role="menuitem"]', { hasText: label }).first();
	// Esc unwinds one level at a time (an open submenu first), so press until the menu is gone
	const closeMenu = async () => {
		for (let i = 0; i < 4 && (await page.locator('.ctx-scroll[role=menu]').count()) > 0; i++) {
			await page.keyboard.press('Escape');
			await page.waitForTimeout(200);
		}
	};

	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(600);
	const ids = await page.evaluate(() => {
		const ex = window.__stores.explorer;
		const inbox = ex.createFolder('Inbox', null);
		const other = ex.createFolder('Other', null);
		ex.activeFolder.set(inbox.id);
		return { inbox: inbox.id, other: other.id };
	});
	await page.waitForTimeout(500);

	// ---- 1. the empty view's button --------------------------------------------------------
	const addBtn = page.locator('#explorer-grid').getByRole('button', { name: 'Add files…' });
	await addBtn.waitFor({ timeout: 8000 });
	h.check((await addBtn.count()) === 1, 'the empty folder offers an "Add files…" button (its accessible name)');
	await addBtn.focus();
	h.check(await addBtn.evaluate((el) => el === document.activeElement), 'the button takes keyboard focus');
	const [chooser1] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), page.keyboard.press('Enter')]);
	h.check(chooser1.isMultiple(), 'Enter opens a file chooser that takes several files');
	await chooser1.setFiles([txt('picked.txt')]);
	await h.eventually(() => itemNamed('picked.txt'), (i) => !!i, 'the picked file is imported');
	h.check((await itemNamed('picked.txt'))?.folderId === ids.inbox, 'the picked file lands in the empty folder');
	// the same folder, by DROP: one router
	await page.evaluate(() => {
		const dt = new DataTransfer();
		dt.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }));
		document.querySelector('#explorer-grid').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
	});
	await h.eventually(() => itemNamed('dropped.txt'), (i) => !!i, 'a dropped file is imported');
	h.check((await itemNamed('dropped.txt'))?.folderId === ids.inbox, 'a drop lands in the same folder — picker and drop share one route');

	// ---- 2. background menu + folder menu ---------------------------------------------------
	const grid = await page.locator('#explorer-grid').boundingBox();
	const bg = { x: grid.width - 24, y: grid.height - 24 };
	await page.locator('#explorer-grid').click({ button: 'right', position: bg });
	await menuItem('Add files…').waitFor({ timeout: 4000 });
	h.check((await menuItem('Add files…').count()) === 1, 'the background menu offers Add files…');
	// shots: the background menu with New file ▸ open
	await menuItem('New file').hover();
	await page.waitForTimeout(400);
	const subs = await page.locator('[role="menuitem"]').allTextContents();
	const want = ['Script (.js)', 'Note (.md)', 'JSON (.json)', 'Text (.txt)'];
	h.check(want.every((w) => subs.some((s) => s.includes(w))), 'New file ▸ lists Script / Note / JSON / Text (' + subs.filter((s) => /\(\./.test(s)).join(', ') + ')');
	await shot(page, 'x1-menu-desktop-dark');
	await page.evaluate(() => window.__stores.themes.theme.set('light'));
	await page.waitForTimeout(400);
	await shot(page, 'x1-menu-desktop-light');
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
	await closeMenu();
	await page.locator('#explorer-grid').click({ button: 'right', position: bg });
	await menuItem('Add files…').waitFor({ timeout: 4000 });
	const [chooser2] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), menuItem('Add files…').click()]);
	await chooser2.setFiles([txt('from-menu.txt')]);
	await h.eventually(() => itemNamed('from-menu.txt'), (i) => !!i, 'background menu ▸ Add files… imports');
	h.check((await itemNamed('from-menu.txt'))?.folderId === ids.inbox, '…into the folder you are in');

	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(400);
	await page.locator('#explorer-grid .explorer-folder-card', { hasText: 'Other' }).first().click({ button: 'right' });
	await menuItem('Add files…').waitFor({ timeout: 4000 });
	const [chooser3] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), menuItem('Add files…').click()]);
	await chooser3.setFiles([txt('into-other.txt')]);
	await h.eventually(() => itemNamed('into-other.txt'), (i) => !!i, 'folder menu ▸ Add files… imports');
	h.check((await itemNamed('into-other.txt'))?.folderId === ids.other, '…into THAT folder, not the one you are in');

	// ---- 3. New file ▸ Note ------------------------------------------------------------------
	await page.evaluate((id) => window.__stores.explorer.activeFolder.set(id), ids.inbox);
	await page.waitForTimeout(400);
	await page.locator('#explorer-grid').click({ button: 'right', position: bg });
	await menuItem('New file').waitFor({ timeout: 4000 });
	await menuItem('New file').hover();
	await page.waitForTimeout(400);
	// the parent row CONTAINS its submenu in the DOM, so match the leaf row's own text exactly
	await page.locator('[role="menuitem"]').filter({ hasText: /^\s*Note \(\.md\)\s*$/ }).first().click();
	await h.eventually(() => itemNamed('notes.md'), (i) => !!i, 'New file ▸ Note makes notes.md');
	h.check((await itemNamed('notes.md'))?.folderId === ids.inbox, '…in the folder the menu was opened in');
	const body = await page.evaluate(async () => {
		const ex = window.__stores.explorer;
		const item = await new Promise((r) => ex.explorerItems.subscribe((v) => r(v.find((i) => i.name === 'notes.md')))());
		const blob = await ex.itemBlob(item.id);
		return blob ? await blob.text() : null;
	});
	if (body !== null) h.check(/^# notes/.test(body), 'the note starts from the Code tab\'s Note template (' + JSON.stringify(body) + ')');
	await A.ctx.close();

	// ---------------------------------------------------------------- phone, dark + light
	for (const theme of ['dark', 'light']) {
		const P = await h.setupPage(browser, 'phone-' + theme, {
			context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
			storage: { theme, toursSeen: '{"editor-touch":true,"editor":true}' }
		});
		const p = P.page;
		p.on('filechooser', () => {});
		await p.evaluate(() => {
			const ex = window.__stores.explorer;
			const f = ex.createFolder('Phone inbox', null);
			ex.activeFolder.set(f.id);
			window.__phoneFolder = f.id;
		});
		await p.locator('#ps-explorer').tap();
		await p.waitForTimeout(1500);
		const btn = p.locator('#explorer-list').getByRole('button', { name: 'Add files…' });
		await btn.waitFor({ timeout: 8000 });
		await shot(p, 'x1-empty-phone-' + theme);
		const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 10000 }), btn.tap()]);
		await chooser.setFiles([txt('from-phone.txt')]);
		const landedIn = () => p.evaluate(() => new Promise((r) => window.__stores.explorer.explorerItems.subscribe((v) => r(v.find((i) => i.name === 'from-phone.txt')?.folderId ?? null))()));
		await h.eventually(landedIn, (v) => !!v, theme + ' phone: a tap on Add files… opens the chooser and the file is imported');
		const landed = await landedIn();
		h.check(landed === (await p.evaluate(() => window.__phoneFolder)), theme + ' phone: …into the open folder');
		await p.waitForTimeout(500);
		await shot(p, 'x1-added-phone-' + theme);
		await P.ctx.close();
	}

	await h.finish(browser);
});
