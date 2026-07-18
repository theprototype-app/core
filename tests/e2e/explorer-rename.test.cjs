// Phase 170: Explorer inline rename (no browser prompt) for BOTH thumbnail items
// and folders, staying in the thumbnail grid. The thumbnail folder menu drops
// "New subfolder" (tree-only), while the tree keeps it.
const h = require('./helpers.cjs');

const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR4nGP8z8Dwn4EIwESMolGF+BUyMjAwMDIQBMQrJKgUvzt/EnIhAJTfBhFVsHRAAAAAAElFTkSuQmCC';

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open Explorer + seed a folder and an item at root
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	await A.page.evaluate((png) => {
		window.__stores.explorer.activeFolder.set(null);
		window.__stores.explorer.createFolder('Models', null);
		const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
		const dt = new DataTransfer();
		dt.items.add(new File([bytes], 'tiny.png', { type: 'image/png' }));
		document.querySelector('#explorer-list').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
	}, TINY_PNG);
	await A.page.waitForTimeout(1000);

	// --- 170.3: the thumbnail folder menu omits "New subfolder" (tree-only) ---
	await A.page.locator('#explorer-list .explorer-folder-card', { hasText: 'Models' }).click({ button: 'right' });
	await A.page.waitForTimeout(200);
	const noSub = (await A.page.getByText('New subfolder', { exact: true }).count()) === 0;
	h.check(noSub, 'thumbnail folder menu drops "New subfolder"');
	h.check(await A.page.getByText('Rename', { exact: true }).isVisible(), 'thumbnail folder menu keeps "Rename"');

	// --- 170.2: folder rename stays inline in the thumbnail card (no prompt) ---
	await A.page.getByText('Rename', { exact: true }).click();
	await A.page.waitForTimeout(200);
	const folderInput = A.page.locator('#explorer-list .explorer-folder-card input');
	h.check(await folderInput.isVisible(), 'folder rename opens an inline input in the card');
	await folderInput.fill('Meshes');
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(300);
	const folderRenamed = await A.page.evaluate(
		() =>
			new Promise((res) =>
				window.__stores.explorer.explorerFolders.subscribe((f) => res(f.some((x) => x.name === 'Meshes')))()
			)
	);
	h.check(folderRenamed, 'folder renamed inline on Enter');

	// --- 170.1: item rename is inline (previously a window.prompt) ---
	await A.page.locator('#explorer-list .explorer-card', { hasText: 'tiny.png' }).click({ button: 'right' });
	await A.page.waitForTimeout(200);
	await A.page.getByText('Rename', { exact: true }).click();
	await A.page.waitForTimeout(200);
	const itemInput = A.page.locator('#explorer-list .explorer-card input');
	h.check(await itemInput.isVisible(), 'item rename opens an inline input in the card (no prompt)');
	await itemInput.fill('renamed.png');
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(300);
	const itemRenamed = await A.page.evaluate(
		() =>
			new Promise((res) =>
				window.__stores.explorer.explorerItems.subscribe((i) => res(i.some((x) => x.name === 'renamed.png')))()
			)
	);
	h.check(itemRenamed, 'item renamed inline on Enter');

	// --- 170.3b: the TREE folder menu still offers "New subfolder" ---
	await A.page.locator('#explorer-tree button', { hasText: 'Meshes' }).click({ button: 'right' });
	await A.page.waitForTimeout(200);
	h.check(
		await A.page.getByText('New subfolder', { exact: true }).isVisible(),
		'tree folder menu keeps "New subfolder"'
	);

	await h.finish(browser);
});
