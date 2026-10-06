// 37 R4 — FOLDERS, TAGS AND A FILTER IN THE LIBRARY'S PREFAB TAB, driven through the UI:
// the grid background's New folder, the card menu's Move to folder, a folder card and the
// breadcrumb, the Properties tag input, the tag chips and the search. All local.
const h = require('./helpers.cjs');

const cards = (A) =>
	A.page.evaluate(() => [...document.querySelectorAll('#explorer-list .explorer-card')].map((c) => c.getAttribute('data-card-id')));
const crumbs = (A) => A.page.evaluate(() => [...document.querySelectorAll('#explorer-crumbs button')].map((b) => b.textContent.trim()).filter(Boolean));
const records = (A) =>
	A.page.evaluate(
		() => new Promise((r) => window.__stores.prefabs.prefabs.subscribe((l) => r(l.map((p) => ({ name: p.name, folder: p.folder ?? '', tags: p.tags ?? [] }))))())
	);

async function closeMenus(A) {
	await A.page.evaluate(() => {
		const backdrop = [...document.querySelectorAll('[role="presentation"]')].find((el) => el.className.includes?.('inset-0'));
		if (!backdrop) return;
		backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	});
	await A.page.waitForTimeout(250);
}
/** a tag chip of the kit's Chips (its first span is the label, the count follows) */
const chip = (A, tag) => A.page.locator('#prefab-tag-bar .chip').filter({ has: A.page.locator('span', { hasText: new RegExp('^' + tag + '$') }) });
const menuItem = (A, label, last = false) => {
	const rows = A.page.locator('[role="menuitem"]').filter({ hasText: label });
	return last ? rows.last() : rows.first();
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// ---- 0. three prefabs, the Explorer on the Prefabs view ------------------------------
	await A.page.evaluate(async () => {
		const s = window.__stores;
		await s.prefabs.loadPrefabs();
		for (const name of ['Oak chair', 'Steel chair', 'Lamp']) {
			s.commandsHandler.sceneCommand('/create box');
			await new Promise((r) => setTimeout(r, 300));
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			await s.prefabs.savePrefab(g.children[g.children.length - 1].uuid, name);
		}
		s.clearToast();
	});
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	await A.page.locator('#prefabs-folder').click();
	await A.page.waitForTimeout(400);
	h.check((await cards(A)).length === 3, `the three prefabs show (${(await cards(A)).length})`);
	h.check((await A.page.locator('#prefab-tag-bar').count()) === 0, 'no tag bar while nothing is tagged');

	// ---- 1. New folder from the grid background, named inline -----------------------------
	await closeMenus(A);
	const box = await A.page.locator('#explorer-grid').boundingBox();
	await A.page.mouse.click(box.x + box.width - 24, box.y + box.height - 24, { button: 'right' });
	await A.page.waitForSelector('[role="menu"]', { timeout: 5000 });
	await menuItem(A, 'New folder').click();
	const input = A.page.locator('#explorer-new-card input');
	await input.waitFor({ timeout: 5000 });
	await input.fill('Chairs');
	await input.press('Enter');
	await A.page.waitForTimeout(500);
	let ids = await cards(A);
	h.check(ids[0] === 'prefabfolder:Chairs', `the folder card comes first (${ids[0]})`);

	// ---- 2. Move to folder from the card menu --------------------------------------------
	for (const name of ['Oak chair', 'Steel chair']) {
		await closeMenus(A);
		await A.page.locator('#explorer-list .explorer-card', { hasText: name }).first().click({ button: 'right' });
		await A.page.waitForSelector('[role="menu"]', { timeout: 5000 });
		await menuItem(A, 'Move to folder').hover();
		await A.page.waitForTimeout(250);
		await menuItem(A, 'Chairs', true).click();
		await A.page.waitForTimeout(400);
	}
	ids = await cards(A);
	h.check(ids.length === 2 && ids.includes('prefabfolder:Chairs'), `the root now holds the folder and the lamp (${ids})`);
	const recs = await records(A);
	h.check(recs.filter((r) => r.folder === 'Chairs').length === 2, 'both chairs are filed in Chairs');

	// ---- 3. into the folder, and back by the breadcrumb ----------------------------------
	await closeMenus(A);
	await A.page.locator('[data-card-id="prefabfolder:Chairs"]').click();
	await A.page.waitForTimeout(400);
	ids = await cards(A);
	h.check(ids.length === 2 && ids.every((id) => id.startsWith('prefab:')), `inside Chairs: the two chairs (${ids.length})`);
	h.check(JSON.stringify(await crumbs(A)) === JSON.stringify(['Prefabs', 'Chairs']), `the breadcrumb reads Prefabs / Chairs (${await crumbs(A)})`);

	// ---- 4. tags in Properties --------------------------------------------------------------
	await A.page.locator('#explorer-list .explorer-card', { hasText: 'Oak chair' }).first().click();
	await A.page.waitForTimeout(300);
	await A.page.locator('#explorer-list .explorer-card', { hasText: 'Oak chair' }).first().click({ button: 'right' });
	await A.page.waitForSelector('[role="menu"]', { timeout: 5000 });
	await menuItem(A, 'Edit tags').click();
	const tagInput = A.page.locator('#prefab-tag-input');
	await tagInput.waitFor({ timeout: 5000 });
	await tagInput.fill('Wood, seat');
	await tagInput.press('Enter');
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('#prefab-details .prefab-tag').count()) === 2, 'two tag chips on the prefab');
	await A.page.evaluate(async () => {
		const s = window.__stores;
		const steel = await new Promise((r) => s.prefabs.prefabs.subscribe((l) => r(l.find((p) => p.name === 'Steel chair')))());
		await s.prefabLibrary.setPrefabTags(steel.id, 'metal, seat');
		const lamp = await new Promise((r) => s.prefabs.prefabs.subscribe((l) => r(l.find((p) => p.name === 'Lamp')))());
		await s.prefabLibrary.setPrefabTags(lamp.id, 'light');
	});
	await A.page.waitForTimeout(300);
	await A.page.locator('#explorer-crumbs button', { hasText: 'Prefabs' }).click();
	await A.page.waitForTimeout(400);
	h.check((await crumbs(A)).length === 1, 'the breadcrumb takes you back to the root');

	// ---- 5. the tag bar filters (AND), reaching inside folders -------------------------------
	const chips = await A.page.locator('#prefab-tag-bar .chip').evaluateAll((els) => els.map((e) => e.querySelector('span')?.textContent?.trim()));
	h.check(chips[0] === 'seat' && chips.length === 4, `the tag bar lists every tag, most used first (${chips})`);
	await chip(A, 'seat').click();
	await A.page.waitForTimeout(300);
	ids = await cards(A);
	h.check(ids.length === 2 && ids.every((id) => id.startsWith('prefab:')), `"seat" shows both chairs from inside their folder, no folder cards (${ids.length})`);
	await chip(A, 'wood').click();
	await A.page.waitForTimeout(300);
	h.check((await cards(A)).length === 1, 'seat AND wood is the oak chair alone');
	const pressed = await chip(A, 'wood').evaluate((el) => getComputedStyle(el).backgroundColor);
	h.check(pressed !== 'rgba(0, 0, 0, 0)', `a pressed chip is painted (${pressed})`);
	await A.page.locator('#prefab-tag-clear').click();
	await A.page.waitForTimeout(300);
	h.check((await cards(A)).length === 2, 'Clear restores the folder view');

	// ---- 6. the search matches a tag ---------------------------------------------------------
	const search = A.page.locator('#explorer-search, input[placeholder^="Search"]').first();
	if (await search.count()) {
		await search.fill('metal');
		await A.page.waitForTimeout(400);
		ids = await cards(A);
		h.check(ids.length === 1, `searching "metal" finds the steel chair by its tag (${ids.length})`);
		await search.fill('');
		await A.page.waitForTimeout(300);
	}

	// ---- 7. rename and delete a folder: nothing is lost ---------------------------------------
	await closeMenus(A);
	await A.page.locator('[data-card-id="prefabfolder:Chairs"]').click({ button: 'right' });
	await A.page.waitForSelector('[role="menu"]', { timeout: 5000 });
	await menuItem(A, 'Rename').click();
	const ren = A.page.locator('[data-card-id="prefabfolder:Chairs"] input');
	await ren.waitFor({ timeout: 5000 });
	await ren.fill('Seating');
	await ren.press('Enter');
	await A.page.waitForTimeout(400);
	h.check((await records(A)).filter((r) => r.folder === 'Seating').length === 2, 'a rename re-files its prefabs');
	await closeMenus(A);
	await A.page.locator('[data-card-id="prefabfolder:Seating"]').click({ button: 'right' });
	await A.page.waitForSelector('[role="menu"]', { timeout: 5000 });
	await menuItem(A, 'Delete folder').click();
	await A.page.waitForTimeout(400);
	const after = await records(A);
	h.check(after.length === 3 && after.every((r) => r.folder === ''), 'deleting a folder moves its prefabs up — none is deleted');

	// ---- 8. it survives a reload (idb) --------------------------------------------------------
	await A.page.evaluate(async () => {
		const s = window.__stores;
		const path = await s.prefabLibrary.createPrefabFolder('', 'Kept');
		const lamp = await new Promise((r) => s.prefabs.prefabs.subscribe((l) => r(l.find((p) => p.name === 'Lamp')))());
		await s.prefabLibrary.movePrefabsTo([lamp.id], path);
	});
	await A.page.waitForTimeout(500);
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.prefabs, { timeout: 60000 });
	const reloaded = await A.page.evaluate(async () => {
		await window.__stores.prefabs.loadPrefabs();
		await window.__stores.prefabLibrary.loadPrefabFolders();
		return new Promise((r) => window.__stores.prefabs.prefabs.subscribe((l) => r(l.map((p) => [p.name, p.folder ?? '', (p.tags ?? []).join(',')])))());
	});
	const lamp = reloaded.find((r) => r[0] === 'Lamp');
	h.check(lamp?.[1] === 'Kept' && lamp?.[2] === 'light', `folder and tags survive a reload (${JSON.stringify(lamp)})`);

	await h.finish(browser);
});
