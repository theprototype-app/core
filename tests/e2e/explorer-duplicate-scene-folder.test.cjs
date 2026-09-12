// 24-C3 — DUPLICATE A SCENE, DUPLICATE A FOLDER.
//
// A scene's identity is its NAME and the name is INSIDE the .tpscene, so C1's Duplicate
// (a second record of the same bytes) cannot be a scene copy — it would be a second card
// of the SAME scene and the first publish would fold one onto the hidden shelf. A scene
// copy rewrites the file (fresh id/createdAt, the new name, the workspace stripped as a
// save strips it), lands as a NEW hash with a history of its own, and therefore costs a
// peer exactly ONE transfer (accepted in the plan). A FOLDER copy is C1's helper wired
// to the folder menu and Ctrl+D: a new folder id and new record ids, so once the copy is
// shared, C2's row identity makes every held-hash row a ZERO-transfer copy on the peer.
//
// Two peers; A dials nobody (B dials A, so A is the host and the writer). Fixtures are a
// one-box scene and a few hundred bytes of text: every transfer here takes the single-shot
// assetfile path, so nothing depends on the chunk protocol (dead on this box — see the
// 24-C-e2e handoff). Peer pulls get 30 s windows, never a 10 s fuse.
//
// Run: APP_URL='https://theprototype.app:5177/' node tests/e2e/explorer-duplicate-scene-folder.test.cjs
const h = require('./helpers.cjs');
const { zipSync, strToU8, unzipSync, strFromU8 } = require('fflate');

const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});
const itemsOf = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.map((i) => ({ id: i.id, name: i.name, kind: i.kind, hash: i.hash, folderId: i.folderId ?? null, share: i.share ?? null, thumbnail: i.thumbnail ?? null }));
	});
const foldersOf = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerFolders.subscribe((x) => (v = x))();
		return v.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId ?? null, share: f.share ?? null }));
	});
const scenesOf = (items) => items.filter((i) => i.kind === 'scene');
/** the ledger's incoming rows — what "a transfer on B" means */
const inTransfers = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.transferLedger.transfers.subscribe((x) => (v = x))();
		return v.filter((t) => t.dir === 'in').map((t) => ({ hash: t.hash, state: t.state, size: t.size, error: t.error ?? null }));
	});
const allTransfers = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.transferLedger.transfers.subscribe((x) => (v = x))();
		return v.map((t) => ({ hash: t.hash.slice(0, 8), state: t.state, dir: t.dir }));
	});
/** rows that MOVED BYTES for a hash — a 6 s "nobody answered" fuse that lost to a slow
 *  peer leaves a failed row beside the done one; the property is that bytes moved ONCE */
const doneFor = (rows, hash) => rows.filter((t) => t.hash === hash && t.state === 'done');
const brief = (rows) => JSON.stringify(rows.map((t) => ({ hash: t.hash.slice(0, 8), state: t.state, size: t.size, error: t.error })));
const clearLedger = (peer) => peer.page.evaluate(() => window.__stores.transferLedger.transfers.set([]));
const blobText = (peer, id) =>
	peer.page.evaluate(async (id) => {
		const blob = await window.__stores.explorer.itemBlob(id);
		return blob ? await blob.text() : null;
	}, id);
/** a stored file's bytes, base64 — decoded in NODE so the assertion reads the zip itself */
const blobB64 = (peer, id) =>
	peer.page.evaluate(async (id) => {
		const blob = await window.__stores.explorer.itemBlob(id);
		if (!blob) return null;
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let s = '';
		for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
		return btoa(s);
	}, id);
const sessionJsonOf = (b64) => {
	const z = unzipSync(Buffer.from(b64, 'base64'));
	return JSON.parse(strFromU8(z['session.json']));
};
const currentLevelOf = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});
const worldCount = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return (g?.children ?? []).length;
	});
const menuLabels = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].map((r) => ({
			label: r.innerText.trim().split('\n')[0],
			disabled: r.getAttribute('aria-disabled') === 'true' || r.classList.contains('cursor-default')
		}))
	);
const newCardValue = (page) => page.locator('#explorer-new-card input').inputValue().catch(() => null);
/** every toast also lands in the notification history, which does not expire under us */
const toastTexts = (page) =>
	page.evaluate(() => {
		let v;
		window.__stores.notifications.subscribe((x) => (v = x))();
		return v.map((n) => String(n.text ?? ''));
	});
const settle = async (peer) => {
	await peer.page.waitForFunction(() => !!window.__stores?.sharedLibrary && !!window.__stores?.explorer && !!window.__stores?.levels, { timeout: 30000 });
	await peer.page.evaluate(() => window.__stores.explorer.loadExplorer());
	// the share-new-files ASK is its own surface (shared-library covers it); `never` is
	// "behave as before" for OWN new files — folder inheritance still shares what lands in a
	// shared folder, which is the rule both halves below stand on
	await peer.page.evaluate(() => window.__stores.sharedLibrary.shareNewFiles.set('never'));
};
const addFile = (peer, text, name, folderId = null) =>
	peer.page.evaluate(
		async ([text, name, folderId]) => {
			const buf = new TextEncoder().encode(text).buffer;
			const item = await window.__stores.explorer.addItemFromBytes(buf, name, folderId);
			return { id: item.id, hash: item.hash, name: item.name };
		},
		[text, name, folderId]
	);
const focusGrid = (page) => page.evaluate(() => document.getElementById('explorer-grid')?.focus());

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const NOTES_TEXT = 'folder copy fixture: ' + 'a few hundred bytes of notes, shared once, copied for free. '.repeat(5);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await settle(A);
	await settle(B);
	await h.connect(B, A);

	// ---- 1. PREMISE: a shared folder holding a saved scene, which B downloads ONCE -----
	const levelsId = await A.page.evaluate(() => {
		const f = window.__stores.explorer.createFolder('Levels', null);
		window.__stores.sharedLibrary.shareFolder(f.id);
		return f.id;
	});
	await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		s.objectActions.deselectObject();
	});
	const saved = await A.page.evaluate((fid) => window.__stores.levels.saveSceneAsLevel('Arena', fid), levelsId);
	h.check(!!saved?.hash && saved.name === 'Arena.tpscene', `premise: Arena saved into the shared folder (${saved?.hash?.slice(0, 8)})`);
	// a picture on the source card, so "the thumbnail is carried over" below can FAIL: a
	// .tpscene decodes to no thumbnail of its own, and null === null proves nothing
	await A.page.evaluate(([id, png]) => window.__stores.explorer.patchRecord(id, { thumbnail: png }), [saved.id, TINY_PNG]);
	await h.eventually(() => manifestOf(A), (m) => (m.scenes?.Arena?.history ?? []).length === 1 && m.scenes.Arena.history[0] === saved.hash, 'the manifest names Arena with one version');
	await h.eventually(() => itemsOf(B), (items) => items.some((i) => i.hash === saved.hash && i.share === 'peer'), 'B auto-downloads the scene from the shared folder', 30000);
	await h.eventually(() => inTransfers(B), (rows) => doneFor(rows, saved.hash).length === 1, 'exactly one transfer moved the scene (the premise every count below rests on)', 30000);
	console.log('  B ledger after Arena: ' + brief(await inTransfers(B)));

	// ---- 2. THE NAMING RULES (pure) ---------------------------------------------------
	const names = await A.page.evaluate(() => {
		const l = window.__stores.levels;
		return {
			copy: l.sceneCopyName('Arena'),
			fromFile: l.sceneCopyName('Arena.tpscene'),
			taken: l.sceneNameTaken('Arena'),
			takenCase: l.sceneNameTaken('arena'),
			free: l.freeSceneName('Arena'),
			fresh: l.freeSceneName('Zed'),
			untaken: l.sceneNameTaken('Zed')
		};
	});
	h.check(names.copy === 'Arena copy' && names.fromFile === 'Arena copy', `the copy name is the Finder/Blender one, extension or not (${names.copy} / ${names.fromFile})`);
	h.check(names.taken && names.takenCase && !names.untaken, `a project scene's name is taken, case-insensitively (${JSON.stringify([names.taken, names.takenCase, names.untaken])})`);
	h.check(names.free === 'Arena copy' && names.fresh === 'Zed', `freeSceneName keeps a free name and copy-names a taken one (${names.free} / ${names.fresh})`);

	// ---- 3. THE UI PATH: Duplicate on a scene card is ENABLED, asks a name, makes a scene
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(500);
	await A.page.evaluate((id) => window.__stores.explorer.activeFolder.set(id), levelsId);
	await A.page.waitForTimeout(400);
	await A.page.locator('.explorer-card', { hasText: 'Arena.tpscene' }).first().click({ button: 'right' });
	await A.page.waitForTimeout(300);
	let labels = await menuLabels(A.page);
	const dup = labels.find((l) => l.label === 'Duplicate');
	// C1 §6 asserted this entry DISABLED; C3 is the counterfactual
	h.check(!!dup && !dup.disabled, `Duplicate on a scene card is offered and enabled (${JSON.stringify(dup)})`);
	await A.page.getByRole('menuitem', { name: /^Duplicate/ }).click();
	await h.eventually(() => newCardValue(A.page), (v) => v === 'Arena copy', 'the inline name input opens in the grid, prefilled with the copy name');
	const before = scenesOf(await itemsOf(A));
	await A.page.keyboard.press('Enter');
	await h.eventually(() => itemsOf(A), (items) => scenesOf(items).length === before.length + 1 && items.some((i) => i.name === 'Arena copy.tpscene'), 'Enter makes a second scene item, "Arena copy.tpscene"', 15000);
	const itemsA = await itemsOf(A);
	const source = itemsA.find((i) => i.id === saved.id);
	const copy = itemsA.find((i) => i.name === 'Arena copy.tpscene');
	h.check(!!copy && copy.hash !== source.hash && copy.id !== source.id, `two scene rows with different hashes and names (${source.hash.slice(0, 8)} / ${copy?.hash?.slice(0, 8)})`);
	h.check(copy?.folderId === levelsId, 'the copy lands beside its source, in the same folder');
	h.check(copy?.thumbnail === TINY_PNG, 'the source card\'s thumbnail is carried over to the copy');
	// the record appears as soon as it is written; the manifest entry follows the idb write
	// the same call awaits, so it is polled rather than read at the first sight of the card
	await h.eventually(
		() => manifestOf(A),
		(m) => JSON.stringify(m.scenes?.['Arena copy']?.history) === JSON.stringify([copy.hash]),
		'the manifest gains a scene "Arena copy" whose history is the copy\'s hash alone',
		10000
	);
	const mA = await manifestOf(A);
	h.check(JSON.stringify(mA.scenes?.Arena?.history) === JSON.stringify([saved.hash]), 'Arena\'s own history is untouched — a copy is a new scene, not a new version');
	const srcJson = sessionJsonOf(await blobB64(A, source.id));
	const copyJson = sessionJsonOf(await blobB64(A, copy.id));
	h.check(copyJson.name === 'Arena copy' && srcJson.name === 'Arena', `inside the file the copy is named "${copyJson.name}" (the source still "${srcJson.name}")`);
	h.check(copyJson.id !== srcJson.id && copyJson.createdAt >= srcJson.createdAt, 'the copy has a fresh identity (new id, new createdAt)');
	h.check((copyJson.objects ?? []).length === (srcJson.objects ?? []).length && (copyJson.objects ?? []).length === 1, `and the same content — ${(copyJson.objects ?? []).length} object(s)`);
	h.check(!('workspace' in copyJson), 'the author\'s workspace is stripped, as a save strips it');
	h.check((await toastTexts(A.page)).some((t) => /Duplicated Arena as Arena copy/.test(t)), 'the toast names both scenes');

	// ---- 4. THE COPY COSTS B ONE TRANSFER (the accepted rule), and B learns the scene ---
	await h.eventually(() => itemsOf(B), (items) => items.some((i) => i.hash === copy.hash && i.share === 'peer' && i.name === 'Arena copy.tpscene' && i.folderId === levelsId), 'B receives the copy as a shared file in the same folder', 30000);
	await h.eventually(() => inTransfers(B), (rows) => doneFor(rows, copy.hash).length === 1, 'B pulled the copy\'s bytes exactly ONCE — new bytes, one transfer', 30000);
	const bRows = await inTransfers(B);
	h.check(bRows.filter((t) => t.state === 'done').length === 2 && bRows.every((t) => t.hash === saved.hash || t.hash === copy.hash), `...and nothing else moved: one done row per scene hash (${brief(bRows)})`);
	const mB = await manifestOf(B);
	h.check(JSON.stringify(mB.scenes?.['Arena copy']?.history) === JSON.stringify([copy.hash]), 'B\'s manifest names the new scene with the same single version');

	// ---- 5. A TAKEN NAME is refused at Enter and discarded at Escape ---------------------
	await A.page.locator('.explorer-card', { hasText: 'Arena.tpscene' }).first().click({ button: 'right' });
	await A.page.waitForTimeout(300);
	await A.page.getByRole('menuitem', { name: /^Duplicate/ }).click();
	await h.eventually(() => newCardValue(A.page), (v) => v === 'Arena copy 2', 'a second duplicate prefills the next free copy name');
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('Arena copy');
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(600);
	h.check((await newCardValue(A.page)) === 'Arena copy', 'Enter on a name the project already has keeps the input open');
	h.check((await toastTexts(A.page)).some((t) => /already exists/.test(t)), 'and says why');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(400);
	h.check((await newCardValue(A.page)) === null, 'Escape removes the input');
	h.check(scenesOf(await itemsOf(A)).length === before.length + 1, 'having created nothing');

	// ---- 6. Ctrl+D on a selected scene card opens the same naming input -----------------
	await A.page.locator('.explorer-card', { hasText: 'Arena.tpscene' }).first().click();
	await A.page.waitForTimeout(200);
	await focusGrid(A.page);
	await A.page.keyboard.press('Control+KeyD');
	await h.eventually(() => newCardValue(A.page), (v) => v === 'Arena copy 2', 'Ctrl+D on one selected scene asks for the copy\'s name');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(300);

	// ---- 7. FOLDER: duplicate a folder holding a shared file; share the copy; B copies it
	//         from its own disk with NO transfer -----------------------------------------
	const propsId = await A.page.evaluate(() => {
		const f = window.__stores.explorer.createFolder('Props', null);
		window.__stores.sharedLibrary.shareFolder(f.id);
		return f.id;
	});
	const notes = await addFile(A, NOTES_TEXT, 'notes.txt', propsId);
	await A.page.evaluate(() => window.__stores.sharedLibrary.publishMine(true));
	await h.eventually(() => itemsOf(B), (items) => items.some((i) => i.id === notes.id && i.hash === notes.hash && i.share === 'peer'), 'B downloads the shared text file under A\'s record id', 30000);
	await h.eventually(() => inTransfers(B), (rows) => doneFor(rows, notes.hash).length === 1, 'once', 30000);
	await clearLedger(A);
	await clearLedger(B);
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(400);
	// the folder menu offers the C1 quartet
	await A.page.locator('.explorer-folder-card', { hasText: 'Props' }).first().click({ button: 'right' });
	await A.page.waitForTimeout(300);
	labels = await menuLabels(A.page);
	h.check(['Duplicate folder', 'Copy', 'Cut'].every((l) => labels.some((x) => x.label === l)) && labels.some((x) => /^Paste/.test(x.label)), `the folder menu offers Duplicate folder / Copy / Cut / Paste (${labels.map((l) => l.label).join(', ')})`);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	// Ctrl+D on the selected folder card
	await A.page.locator('.explorer-folder-card', { hasText: 'Props' }).first().click();
	await A.page.waitForTimeout(200);
	await focusGrid(A.page);
	await A.page.keyboard.press('Control+KeyD');
	await h.eventually(() => foldersOf(A), (fs) => fs.some((f) => f.name === 'Props copy'), 'Ctrl+D on a folder card makes "Props copy"', 10000);
	const copyFolder = (await foldersOf(A)).find((f) => f.name === 'Props copy');
	await h.eventually(() => itemsOf(A), (items) => items.some((i) => i.folderId === copyFolder.id && i.hash === notes.hash), 'with its file copied inside — same hash, a new record', 10000);
	const copyItem = (await itemsOf(A)).find((i) => i.folderId === copyFolder.id && i.hash === notes.hash);
	h.check(copyFolder.id !== propsId && copyItem.id !== notes.id, 'a new folder id and a new record id — network identity is minted here');
	h.check(copyFolder.share === null && copyItem.share === null, 'the copy is LOCAL until shared (share is not copied — the C1 rule)');
	await A.page.waitForTimeout(2500);
	h.check((await itemsOf(B)).filter((i) => i.hash === notes.hash).length === 1 && !(await foldersOf(B)).some((f) => f.id === copyFolder.id), 'so B has heard nothing about it yet');
	// share the copy: the rows go out with NEW ids and a hash B already holds
	await A.page.evaluate((id) => window.__stores.sharedLibrary.shareFolder(id), copyFolder.id);
	await h.eventually(() => foldersOf(B), (fs) => fs.some((f) => f.id === copyFolder.id && f.name === 'Props copy'), 'B creates the copy folder under the SAME id (the folder rule)', 30000);
	await h.eventually(() => itemsOf(B), (items) => items.some((i) => i.id === copyItem.id && i.hash === notes.hash && i.share === 'peer' && i.folderId === copyFolder.id), 'B materialises the copied file under its record id, in the copy folder', 30000);
	h.check((await itemsOf(B)).filter((i) => i.hash === notes.hash).length === 2, 'B now holds two records for the hash');
	h.check((await blobText(B, copyItem.id)) === NOTES_TEXT, 'the copy\'s blob on B holds the bytes — copied from B\'s own disk');
	await B.page.waitForTimeout(1500);
	const ledgerB = await allTransfers(B);
	const ledgerA = await allTransfers(A);
	h.check(ledgerB.length === 0, `ZERO transfers on B for the whole folder copy (${JSON.stringify(ledgerB)})`);
	h.check(ledgerA.length === 0, `...and A sent no bytes either (${JSON.stringify(ledgerA)})`);

	// ---- 8. OPEN THE COPY: a double-click loads it as a scene of its own -----------------
	await A.page.evaluate((id) => window.__stores.explorer.activeFolder.set(id), levelsId);
	await A.page.waitForTimeout(400);
	await A.page.locator('.explorer-card', { hasText: 'Arena copy.tpscene' }).first().dblclick();
	await h.eventually(() => currentLevelOf(A), (at) => at?.name === 'Arena copy' && at.hash === copy.hash, 'double-clicking the copy opens it — currentLevel names the copy', 20000);
	const at = await currentLevelOf(A);
	h.check(!at?.unsaved && !at?.private, `a tracked, shared project scene (unsaved=${!!at?.unsaved}, private=${!!at?.private})`);
	h.check((await worldCount(A)) === 1, 'with the one box the source had');

	// ---- 9. TEMPLATES: "Save to Library" files a template as a new scene, loading nothing
	const sessionJson = await A.page.evaluate(() => {
		const s = window.__stores;
		const mk = (name, x) => {
			const m = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial({ color: 0x88aaff }));
			m.name = name;
			m.position.set(x, 0.5, 0);
			return m.toJSON();
		};
		return JSON.stringify({ format: 1, name: 'Mock Template', count: 2, objects: [mk('tplA', 0), mk('tplB', 2)], nodes: [], edges: [], annotations: [], joints: [], camera: null, workspace: { selection: ['x'] } });
	});
	const tpsceneBytes = Buffer.from(zipSync({ 'session.json': strToU8(sessionJson) }));
	await A.page.route('**/cdn.jsdelivr.net/**', (route) => {
		const url = route.request().url();
		if (!url.includes('/theprototype-app/scenes@')) return route.continue();
		if (url.endsWith('/index.json'))
			return route.fulfill({
				json: {
					version: 2,
					templates: [{ slug: 'mock-blockout', title: 'Mock Blockout', description: 'Greybox', scene: 'templates/mock-blockout/scene.tpscene', license: 'CC0-1.0', tags: ['greybox'], bytes: 1234 }],
					examples: [],
					games: []
				}
			});
		if (url.includes('mock-blockout/scene.tpscene')) return route.fulfill({ body: tpsceneBytes, contentType: 'application/zip' });
		return route.fulfill({ status: 404 });
	});
	const worldBefore = await worldCount(A);
	const scenesBefore = scenesOf(await itemsOf(A)).length;
	await A.page.locator('#logo-menu').click();
	await A.page.waitForTimeout(300);
	await A.page.locator('#open-templates').click();
	await h.eventually(() => A.page.locator('[data-scene-slug="mock-blockout"]').isVisible(), (v) => v === true, 'the template card renders from the mocked index', 15000);
	h.check(await A.page.locator('[data-scene-save="mock-blockout"]').isVisible(), 'the card carries a "save to Library" button beside its load action');
	await A.page.locator('[data-scene-save="mock-blockout"]').click();
	await h.eventually(() => itemsOf(A), (items) => items.some((i) => i.name === 'Mock Blockout.tpscene'), 'Save to Library files the template as "Mock Blockout.tpscene"', 20000);
	const tpl = (await itemsOf(A)).find((i) => i.name === 'Mock Blockout.tpscene');
	await h.eventually(
		() => manifestOf(A),
		(m) => JSON.stringify(m.scenes?.['Mock Blockout']?.history) === JSON.stringify([tpl.hash]),
		'under the template\'s own title, as a project scene with one version',
		10000
	);
	const tplJson = sessionJsonOf(await blobB64(A, tpl.id));
	h.check(tplJson.name === 'Mock Blockout' && (tplJson.objects ?? []).length === 2 && !('workspace' in tplJson), `the file is renamed inside (${tplJson.name}), keeps its ${(tplJson.objects ?? []).length} objects, drops the workspace`);
	h.check((await worldCount(A)) === worldBefore && (await currentLevelOf(A))?.name === 'Arena copy', 'the open scene is untouched — saving is not loading');
	h.check(await A.page.locator('#templates-modal').isVisible(), 'and the modal stays open for the next one');
	await A.page.locator('[data-scene-save="mock-blockout"]').click();
	await h.eventually(() => itemsOf(A), (items) => items.some((i) => i.name === 'Mock Blockout copy.tpscene'), 'saving it again takes the copy name — the title is taken now', 20000);
	h.check(scenesOf(await itemsOf(A)).length === scenesBefore + 2, 'two library scenes from one template, no version appended to either');
	await A.page.keyboard.press('Escape');

	await h.finish(browser);
});
