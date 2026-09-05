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
	// Importing a dropped file is ASYNC per file (content hash, then the time-boxed
	// thumbnail, then the IndexedDB write), so a fixed settle RACES it: measured here,
	// the two supported files landed ~1.2s and ~2.0s after the drop, and the suite's
	// old 1200ms sleep read the store between them. Poll for their arrival, then let
	// the queue drain and assert the FULL set — so "skips the unsupported file" is
	// still asserted on a finished state, not mid-flight.
	const readItems = () =>
		A.page.evaluate(
			() =>
				new Promise((resolve) => {
					window.__stores.explorer.explorerItems.subscribe((items) =>
						resolve(items.map((i) => ({ name: i.name, kind: i.kind, thumb: !!i.thumbnail, hash: i.hash.length })))
					)();
				})
		);
	await h.eventually(readItems, (list) => list.length >= 2, 'the drop imports both supported files');
	await A.page.waitForTimeout(1500); // the unsupported file gets its chance to (not) arrive
	const imported = await readItems();
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

	// The shared dock has ONE slot, and the contract changed in 5651aaa ("tabbed bottom
	// dock"): the FLOW FAMILY (Node editor / Flow Code / Animation / UV) are notebook
	// tabs in it, and the Explorer is a separate panel MUTUALLY EXCLUSIVE with them —
	// activating a Flow tab CLOSES the Explorer, and the Explorer is not a tab. This
	// section used to assert the older both-mounted-one-hidden model.
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(600);
	const dock = await A.page.evaluate(() => ({
		flow: !!document.querySelector('#flow-list'),
		explorer: !!document.querySelector('#explorer-list'),
		tabs: [...document.querySelectorAll('.tab-note')].map((b) => (b.textContent || '').trim())
	}));
	h.check(dock.flow && !dock.explorer, `a Flow tab takes the dock and closes the Explorer (${JSON.stringify(dock)})`);
	h.check(dock.tabs.includes('Node editor'), 'the dock tab strip names the visible Flow panel');
	h.check(!dock.tabs.some((t) => /Explorer/i.test(t)), 'the Explorer is not a Flow-family tab');

	// ...and re-opening the Explorer takes the dock back. The two directions are NOT
	// symmetric, deliberately: a Flow tab CLOSES the Explorer (it unmounts, above),
	// while the Explorer merely becomes the visible panel and leaves the Flow tab
	// open-but-hidden — so this half is a visibility question, not a presence one.
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	const backAgain = await A.page.evaluate(() => {
		const shown = (/** @type {string} */ sel) => {
			const el = document.querySelector(sel);
			return !!el && el.getBoundingClientRect().height > 0;
		};
		return { flow: shown('#flow-list'), explorer: shown('#explorer-list') };
	});
	h.check(
		backAgain.explorer && !backAgain.flow,
		`the Explorer takes the dock back and the Flow tab hides (${JSON.stringify(backAgain)})`
	);

	// --- 106: tree v2 ---
	// inline create: the button spawns an input, Enter creates, Esc cancels
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.locator('#new-folder').click();
	await A.page.waitForTimeout(200);
	await A.page.keyboard.type('Sounds');
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(300);
	let folders = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.explorer.explorerFolders.subscribe((f) =>
					resolve(f.map((x) => ({ name: x.name, parent: x.parentId ?? null })))
				)();
			})
	);
	h.check(folders.some((f) => f.name === 'Sounds'), 'inline create makes the folder on Enter');
	await A.page.locator('#new-folder').click();
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	folders = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.explorer.explorerFolders.subscribe((f) => resolve(f.length))();
			})
	);
	h.check(folders === 2, 'Esc cancels the inline create');

	// validation: special characters refuse with a tip
	await A.page.locator('#new-folder').click();
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('bad/name');
	await A.page.waitForTimeout(200);
	const tip = await A.page.getByText("names can't contain", { exact: false }).isVisible();
	await A.page.keyboard.press('Enter'); // no-op while invalid
	await A.page.waitForTimeout(200);
	const stillEditing = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.explorer.explorerFolders.subscribe((f) =>
					resolve(!f.some((x) => /bad/.test(x.name)))
				)();
			})
	);
	h.check(tip && stillEditing, 'special characters refuse with a tip (106.3)');
	await A.page.keyboard.press('Escape');

	// folder re-parent via the store API + cycle refusal (drag payloads are
	// covered by the shared dropInto handler these calls route through)
	const parenting = await A.page.evaluate(() => {
		let list = [];
		window.__stores.explorer.explorerFolders.subscribe((f) => (list = f))();
		const textures = list.find((f) => f.name === 'Textures');
		const sounds = list.find((f) => f.name === 'Sounds');
		const ok = window.__stores.explorer.moveFolder(sounds.id, textures.id);
		const cycle = window.__stores.explorer.moveFolder(textures.id, sounds.id);
		let after = [];
		window.__stores.explorer.explorerFolders.subscribe((f) => (after = f))();
		return { ok, cycle, nested: after.find((f) => f.name === 'Sounds')?.parentId === textures.id };
	});
	h.check(parenting.ok && parenting.nested, 'folders re-parent into folders');
	h.check(parenting.cycle === false, 'a folder refuses to move into its own subtree');

	// cascade delete with the toast confirm
	await A.page.evaluate(() => {
		let list = [];
		window.__stores.explorer.explorerFolders.subscribe((f) => (list = f))();
		const textures = list.find((f) => f.name === 'Textures');
		// put an item inside so the cascade has something to remove
		let items = [];
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		window.__stores.explorer.moveItem(items[0].id, textures.id);
	});
	// exact name: the Scene manifest now shows a "textures" sub-entry (178), so a
	// substring match would be ambiguous with the "Textures" library folder
	await A.page.locator('#explorer-tree').getByRole('button', { name: 'Textures', exact: true }).click({ button: 'right' });
	await A.page.waitForTimeout(200);
	await A.page.getByText('Delete folder', { exact: true }).click();
	await A.page.waitForTimeout(300);
	// R22 round 11: the question is a strip inside the Explorer now, not a toast over the
	// viewport (see explorer-delete-confirm). Same content, one surface over.
	const cascade = await A.page.evaluate(() => {
		const el = document.querySelector('#explorer-confirm');
		return el
			? {
					title: el.querySelector('.ex-confirm-title')?.textContent?.trim() ?? '',
					detail: el.querySelector('.ex-confirm-detail')?.textContent?.trim() ?? ''
				}
			: null;
	});
	h.check(
		!!cascade && /Delete "Textures"\?/.test(cascade.title) && /2 folders and 1 item/.test(cascade.detail),
		`cascade delete confirms with counts (${JSON.stringify(cascade)})`
	);
	await A.page.locator('#explorer-confirm-yes').click();
	await A.page.waitForTimeout(400);
	const afterDelete = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.explorer.explorerFolders.subscribe((f) => {
					window.__stores.explorer.explorerItems.subscribe((items) =>
						resolve({ folders: f.length, items: items.length })
					)();
				})();
			})
	);
	h.check(
		afterDelete.folders === 0 && afterDelete.items === 1,
		`cascade removed subfolders + their items (${JSON.stringify(afterDelete)})`
	);

	// 197: the folder tree is WindowShell's primary sidebar; its splitter resizes
	// the panel and persists under ws:explorer:primaryWidth (was explorerTreeW)
	const treeBefore = await A.page.locator('#explorer-tree').boundingBox();
	const splitter = await A.page.locator('#explorer-list .ws-resize').first().boundingBox();
	await A.page.mouse.move(splitter.x + splitter.width / 2, splitter.y + 40);
	await A.page.mouse.down();
	await A.page.mouse.move(splitter.x + splitter.width / 2 + 60, splitter.y + 40, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const widened = await A.page.evaluate(() => ({
		width: document.querySelector('#explorer-tree')?.getBoundingClientRect().width ?? 0,
		saved: parseInt(localStorage.getItem('ws:explorer:primaryWidth') ?? '0')
	}));
	h.check(
		widened.width > treeBefore.width + 30 && Math.abs(widened.saved - widened.width) < 24,
		`primary sidebar resizes and persists (${Math.round(widened.width)}, saved ${widened.saved})`
	);

	// persistence: items + folders survive a reload.
	// `createFolder` updates the store and fires `persistIndex()` WITHOUT awaiting it,
	// so reloading in the next statement can outrun the IndexedDB write. Watch the
	// stored record itself rather than sleeping — that is the thing the reload reads.
	await A.page.evaluate(() => window.__stores.explorer.createFolder('Keep', null));
	await h.eventually(
		() =>
			A.page.evaluate(
				() =>
					new Promise((resolve) => {
						const request = indexedDB.open('theprototype', 1);
						request.onsuccess = () => {
							const get = request.result.transaction('snapshots').objectStore('snapshots').get('explorer:index');
							get.onsuccess = () => resolve((get.result?.folders ?? []).map((/** @type {any} */ f) => f.name));
							get.onerror = () => resolve([]);
						};
						request.onerror = () => resolve([]);
					})
			),
		(names) => names.includes('Keep'),
		'the folder reaches IndexedDB before the reload'
	);
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
		persisted.items === 1 && persisted.folders.includes('Keep'),
		`library persists across reload (${persisted.items} items, folders ${persisted.folders.join(',')})`
	);

	await h.finish(browser);
});
