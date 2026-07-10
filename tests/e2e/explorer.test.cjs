// Phase 95: Explorer asset browser — drag-in import (DOM drop path), folder
// CRUD + item moves, thumbnails, persistence across reload, dock/undock, and
// the shared bottom dock tabs with the Flow editor.
const h = require('./helpers.cjs');

const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR4nGP8z8Dwn4EIwESMolGF+BUyMjAwMDIQBMQrJKgUvzt/EnIhAJTfBhFVsHRAAAAAAElFTkSuQmCC';

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open via the hud folder button
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	h.check(await A.page.locator('#explorer-list').isVisible(), 'Explorer docks open from the hud button');

	// DOM drop path: a real drop event with files imports them
	await A.page.evaluate((png) => {
		const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
		const dt = new DataTransfer();
		dt.items.add(new File([bytes], 'tiny.png', { type: 'image/png' }));
		dt.items.add(new File([new Blob(['hello'])], 'notes.txt', { type: 'text/plain' }));
		dt.items.add(new File([new Blob(['nope'])], 'bad.xyz', { type: 'application/octet-stream' }));
		document
			.querySelector('#explorer-list')
			.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
	}, TINY_PNG);
	await A.page.waitForTimeout(1200);
	const imported = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.explorer.explorerItems.subscribe((items) =>
					resolve(items.map((i) => ({ name: i.name, kind: i.kind, thumb: !!i.thumbnail, hash: i.hash.length })))
				)();
			})
	);
	h.check(
		imported.length === 2 && imported.some((i) => i.name === 'tiny.png') && imported.some((i) => i.name === 'notes.txt'),
		`drop imports supported files, skips unsupported (${imported.map((i) => i.name).join(',')})`
	);
	h.check(imported.find((i) => i.name === 'tiny.png')?.thumb === true, 'image got a thumbnail');
	h.check(imported.every((i) => i.hash === 64), 'items carry a content hash');

	// folder CRUD + move
	await A.page.evaluate(async () => {
		const folder = window.__stores.explorer.createFolder('Textures', null);
		let items = [];
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		window.__stores.explorer.moveItem(items.find((i) => i.name === 'tiny.png').id, folder.id);
		window.__stores.explorer.activeFolder.set(folder.id);
	});
	await A.page.waitForTimeout(400);
	h.check(
		await A.page.locator('#explorer-list .explorer-card', { hasText: 'tiny.png' }).isVisible(),
		'moved item shows inside its folder'
	);
	h.check(
		!(await A.page.locator('#explorer-list .explorer-card', { hasText: 'notes.txt' }).isVisible()),
		'other items stay outside the folder'
	);

	// prefabs virtual folder exists
	await A.page.locator('#prefabs-folder').click();
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.getByText('No prefabs yet', { exact: false }).isVisible(),
		'Prefabs virtual folder renders'
	);

	// undock -> floating window -> dock back
	await A.page.locator('#explorer-undock').click();
	await A.page.waitForTimeout(400);
	h.check(await A.page.locator('#explorer-window').isVisible(), 'Explorer undocks into a window');
	await A.page.locator('#explorer-dock').click();
	await A.page.waitForTimeout(400);
	h.check(await A.page.locator('#explorer-list').isVisible(), 'docks back to the bottom');

	// shared dock with the Flow editor: tabs appear, switching swaps panels
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(600);
	const flowTabs = A.page.locator('#flow-list button', { hasText: 'Explorer' });
	h.check((await flowTabs.count()) === 1, 'shared dock shows notebook tabs');
	const explorerHidden = await A.page.evaluate(
		() => getComputedStyle(document.querySelector('#explorer-list')).display === 'none'
	);
	h.check(explorerHidden, 'Flow owns the dock while its tab is active');
	await flowTabs.click();
	await A.page.waitForTimeout(400);
	const swapped = await A.page.evaluate(() => ({
		explorer: getComputedStyle(document.querySelector('#explorer-list')).display !== 'none',
		flow: getComputedStyle(document.querySelector('#flow-list')).display === 'none'
	}));
	h.check(swapped.explorer && swapped.flow, 'Explorer tab takes the dock, Flow hides');

	// persistence: items + folders survive a reload
	await A.page.reload();
	await A.page.waitForTimeout(2500);
	const persisted = await A.page.evaluate(async () => {
		await window.__stores.explorer.loadExplorer();
		return new Promise((resolve) => {
			window.__stores.explorer.explorerItems.subscribe((items) => {
				window.__stores.explorer.explorerFolders.subscribe((folders) =>
					resolve({ items: items.length, folders: folders.map((f) => f.name) })
				)();
			})();
		});
	});
	h.check(
		persisted.items === 2 && persisted.folders.includes('Textures'),
		`library persists across reload (${persisted.items} items, folders ${persisted.folders.join(',')})`
	);

	await h.finish(browser);
});
