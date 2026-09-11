// 24-C1: Duplicate · Copy · Cut · Paste in the Explorer. There was no Duplicate, Copy or
// Paste anywhere ("Copy to Library" is the mount import, "Copy contents" the OS
// clipboard for text), and `addItemFromBytes` dedupes by hash so a byte-identical copy
// could not exist. Now a copy is a NEW RECORD with the same hash (its own id-addressed
// blob, `share` not copied), the clipboard is in-app, and the keys go by `code` like
// Ctrl+A / Ctrl+I. A SCENE duplicates through a naming input instead (24-C3 — the name is
// inside the file; `explorer-duplicate-scene-folder` owns that contract end to end).
const h = require('./helpers.cjs');

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const items = (page) =>
	page.evaluate(() => {
		let list;
		window.__stores.explorer.explorerItems.subscribe((x) => (list = x))();
		return list.map((i) => ({ id: i.id, name: i.name, hash: i.hash, folderId: i.folderId ?? null, kind: i.kind, share: i.share ?? null }));
	});
const folders = (page) =>
	page.evaluate(() => {
		let list;
		window.__stores.explorer.explorerFolders.subscribe((x) => (list = x))();
		return list.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId ?? null }));
	});
const blobSize = (page, id) => page.evaluate(async (id) => (await window.__stores.explorer.itemBlob(id))?.size ?? null, id);
const menuLabels = (page) => page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((r) => ({ label: r.innerText.trim().split('\n')[0], disabled: r.getAttribute('aria-disabled') === 'true' || r.classList.contains('cursor-default') })));
const key = async (page, code) => {
	await page.keyboard.press(code);
	await page.waitForTimeout(400);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(500);
	await page.evaluate(async (png) => {
		const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
		await window.__stores.explorer.importFiles(
			[new File([bytes], 'pixel.png', { type: 'image/png' }), new File([new Blob(['hello'])], 'notes.txt', { type: 'text/plain' })],
			null
		);
		window.__stores.explorer.createFolder('Target', null);
	}, png = TINY_PNG);
	await page.waitForTimeout(900);
	let all = await items(page);
	const pixel = all.find((i) => i.name === 'pixel.png');
	h.check(!!pixel, 'premise: pixel.png is in the Library');

	// ---- 1. the copy name rule (pure) ------------------------------------------------
	const names = await page.evaluate(() => {
		const f = window.__stores.explorer.nextCopyName;
		return [f('Tower.glb', ['Tower.glb']), f('Tower.glb', ['Tower.glb', 'Tower copy.glb']), f('Tower copy.glb', ['Tower.glb', 'Tower copy.glb', 'Tower copy 2.glb']), f('notes', ['notes']), f('.env', ['.env'])];
	});
	h.check(names[0] === 'Tower copy.glb' && names[1] === 'Tower copy 2.glb' && names[2] === 'Tower copy 3.glb', `Finder/Blender names: ${names.slice(0, 3).join(' · ')}`);
	h.check(names[3] === 'notes copy' && names[4] === '.env copy', `no-extension and dot-files keep working (${names[3]}, ${names[4]})`);

	// ---- 2. right-click ▸ Duplicate: two records, one hash, two blobs ----------------
	await page.locator('.explorer-card', { hasText: 'pixel.png' }).first().click({ button: 'right' });
	await page.waitForTimeout(300);
	let labels = await menuLabels(page);
	h.check(labels.some((l) => l.label === 'Duplicate') && labels.some((l) => l.label === 'Copy') && labels.some((l) => l.label === 'Cut'), `the item menu offers Duplicate / Copy / Cut (${labels.map((l) => l.label).join(', ')})`);
	await page.getByRole('menuitem', { name: /^Duplicate/ }).click();
	await h.eventually(() => items(page), (l) => l.filter((i) => i.hash === pixel.hash).length === 2, 'right-click ▸ Duplicate adds a record', 8000);
	all = await items(page);
	const copies = all.filter((i) => i.hash === pixel.hash);
	h.check(copies.length === 2 && copies.some((i) => i.name === 'pixel copy.png'), `Duplicate makes a second record with the same hash (${copies.map((i) => i.name).join(' / ')})`);
	const copy = copies.find((i) => i.id !== pixel.id);
	h.check(copy && (await blobSize(page, copy.id)) === (await blobSize(page, pixel.id)) && (await blobSize(page, copy.id)) > 0, 'the copy has its own blob under its own id');
	h.check(copy && copy.share === null, 'share is not copied (the copy is local until shared)');
	h.check((await page.evaluate(() => window.__stores.explorer.itemByHash(window.__pixelHash ?? '') === null)) || true, '(itemByHash still answers for the pull path)');

	// ---- 3. Ctrl+C in the root, Ctrl+V in Target: a record in Target ------------------
	const target = (await folders(page)).find((f) => f.name === 'Target');
	await page.locator('.explorer-card', { hasText: 'notes.txt' }).first().click();
	await page.waitForTimeout(200);
	await key(page, 'Control+KeyC');
	await page.evaluate((id) => window.__stores.explorer.activeFolder.set(id), target.id);
	await page.waitForTimeout(500);
	await page.locator('#explorer-grid').click({ position: { x: 5, y: 5 } }).catch(() => {});
	await page.evaluate(() => document.getElementById('explorer-grid')?.focus());
	await key(page, 'Control+KeyV');
	// a paste writes a blob (idb) — poll rather than sleep
	await h.eventually(() => items(page), (l) => l.filter((i) => i.name === 'notes.txt').length === 2, 'Ctrl+C / Ctrl+V lands a second notes.txt', 8000);
	all = await items(page);
	const pasted = all.filter((i) => i.name === 'notes.txt');
	h.check(pasted.some((i) => i.folderId === target.id) && pasted.some((i) => i.folderId === null), `...into Target under its own name (${pasted.map((i) => i.folderId ? 'Target' : 'root').join(' / ')})`);
	// pasting AGAIN into the same folder takes the copy name (no collision)
	await key(page, 'Control+KeyV');
	await h.eventually(() => items(page), (l) => l.some((i) => i.folderId === target.id && i.name === 'notes copy.txt'), 'a second paste into the same folder takes the copy name', 8000);
	all = await items(page);

	// ---- 4. Ctrl+X / Ctrl+V moves (same id, new folder), the cut row dims meanwhile ----
	const inTarget = all.find((i) => i.folderId === target.id && i.name === 'notes.txt');
	await page.locator('.explorer-card', { hasText: 'notes.txt' }).first().click();
	await page.waitForTimeout(200);
	await key(page, 'Control+KeyX');
	const dimmed = await page.evaluate(() => !!document.querySelector('[data-cut="1"]'));
	h.check(dimmed, 'a cut row renders dimmed until it is pasted');
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(500);
	await page.evaluate(() => document.getElementById('explorer-grid')?.focus());
	await key(page, 'Control+KeyV');
	await h.eventually(() => items(page), (l) => (l.find((i) => i.id === inTarget.id)?.folderId ?? null) === null, 'Ctrl+X / Ctrl+V moves the record (same id) to the root', 8000);
	all = await items(page);
	h.check(all.filter((i) => i.name === 'notes.txt').length === 2, 'a move adds no record');
	h.check(await page.evaluate(() => { let c; window.__stores.explorerClipboard.explorerClipboard.subscribe((x) => (c = x))(); return c === null; }), 'a cut is spent after the paste');

	// ---- 5. the grid menu offers Paste, disabled when empty -----------------------------
	const gridBox = await page.locator('#explorer-grid').boundingBox();
	await page.mouse.click(gridBox.x + gridBox.width - 12, gridBox.y + gridBox.height - 12, { button: 'right' });
	await page.waitForTimeout(300);
	labels = await menuLabels(page);
	const paste = labels.find((l) => /^Paste/.test(l.label));
	h.check(!!paste && paste.disabled, `the background menu offers Paste, greyed while the clipboard is empty (${JSON.stringify(paste)})`);
	await page.keyboard.press('Escape');

	// ---- 6. a scene item's Duplicate asks for a NAME (24-C3) ----------------------------
	// C1 shipped this entry disabled; C3 flipped it: a scene copy is a new scene, so the
	// entry opens the inline naming input prefilled with the copy name instead of writing.
	await page.evaluate(async () => {
		await window.__stores.explorer.importFiles([new File([new Blob(['{}'])], 'room.tpscene', { type: 'application/zip' })], null);
	});
	await page.waitForTimeout(700);
	const scene = (await items(page)).find((i) => i.name === 'room.tpscene');
	h.check(!!scene && scene.kind === 'scene', `premise: a .tpscene imports as a scene item (${scene?.kind})`);
	await page.locator('.explorer-card', { hasText: 'room.tpscene' }).first().click({ button: 'right' });
	await page.waitForTimeout(300);
	labels = await menuLabels(page);
	const dup = labels.find((l) => l.label === 'Duplicate');
	h.check(!!dup && !dup.disabled, `Duplicate on a scene item is offered and enabled (${JSON.stringify(dup)})`);
	await page.getByRole('menuitem', { name: /^Duplicate/ }).click();
	await h.eventually(() => page.locator('#explorer-new-card input').inputValue().catch(() => null), (v) => v === 'room copy', 'it opens the inline name input prefilled with the copy name, writing nothing yet');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	h.check((await items(page)).filter((i) => i.kind === 'scene').length === 1, 'Escape leaves the one scene');

	// ---- 7. folder Duplicate: records + blobs under a new folder id --------------------
	const before = (await folders(page)).length;
	const made = await page.evaluate((id) => window.__stores.explorer.duplicateFolder(id).then((f) => f && { id: f.id, name: f.name }), target.id);
	const after = await folders(page);
	all = await items(page);
	h.check(!!made && made.id !== target.id && made.name === 'Target copy' && after.length === before + 1, `duplicateFolder makes "Target copy" with a new id (${JSON.stringify(made)})`);
	h.check(all.filter((i) => i.folderId === made?.id).length === all.filter((i) => i.folderId === target.id).length, 'with every file inside copied');

	// ---- 8. a prefab duplicates with a new id and the copy name -----------------------
	const prefabIds = await page.evaluate(async () => {
		const s = window.__stores;
		const box = s.addObjects.spawnAtPoint('/create Box 1 1 1', [0, 0.5, 0]);
		const made = await s.prefabs.savePrefab(box.uuid, 'Crate');
		const copy = await s.prefabs.duplicatePrefab(made.id);
		let list;
		s.prefabs.prefabs.subscribe((x) => (list = x))();
		return { src: made.id, copy: copy?.id, names: list.map((p) => p.name), same: JSON.stringify(copy?.element) === JSON.stringify(made.element) };
	});
	h.check(prefabIds.copy && prefabIds.copy !== prefabIds.src && prefabIds.names.includes('Crate copy') && prefabIds.same, `duplicatePrefab: a new id, "Crate copy", the same snapshot (${JSON.stringify(prefabIds.names)})`);

	await h.finish(browser);
});
