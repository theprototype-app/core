// ROADMAP 22 R6 — DUPLICATE / COPY-PASTE, and what a scene copy IS.
//
// Roadmap 24-C1/C3 shipped Duplicate, Copy, Cut and Paste for every kind, and for a SCENE
// the Duplicate asks a name (its identity is the name inside the file). What it left was
// the PASTE of a scene: it copied the RECORD — a second "Arena.tpscene" card pointing at
// the same hash, the same name inside — one scene, two cards, and the next fold hid one.
// R6 makes a pasted scene a scene COPY under the Finder copy name, the file a Save would
// have made (sceneCopyBytes + sceneCopyName, both already there), landing where it was
// pasted. Every other kind is its content hash, and a second record of it is exactly
// what Copy/Paste means — the 24-C2 rule, asserted here as the counterfactual the brief
// names for a texture (a second record, the same bytes; see QUESTIONS-29-sessions §1).
//
//   §1  The Duplicate entry states the rule per kind.
//   §2  Ctrl+C / Ctrl+V of a scene into a folder: a scene copy — its own name inside, a
//       fresh identity, its own hash, its own manifest entry, in the target folder. A
//       second paste takes the next copy name. The source is untouched.
//   §3  Ctrl+C / Ctrl+V of a texture: a second record, the SAME hash (the 24-C2 rule).
//   §4  Duplicate on the scene card through the real menu: the naming input, then a copy.
//   §5  The copy travels: a peer receives a NEW scene, not a second card for the old one.
//
// Run: APP_URL='https://theprototype.app:5211/' npm run e2e -- scene-duplicate
const h = require('./helpers.cjs');
const { unzipSync, strFromU8 } = require('fflate');

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const itemsOf = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.map((i) => ({ id: i.id, name: i.name, kind: i.kind, hash: i.hash, folderId: i.folderId ?? null }));
	});
const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});
const foldersOf = (peer) =>
	peer.page.evaluate(() => {
		let list;
		window.__stores.explorer.explorerFolders.subscribe((x) => (list = x))();
		return list.map((f) => ({ id: f.id, name: f.name }));
	});
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
const menuLabels = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].map((r) => ({
			label: r.innerText.trim().split('\n')[0],
			disabled: r.getAttribute('aria-disabled') === 'true' || r.classList.contains('cursor-default'),
			title: r.getAttribute('title') ?? r.querySelector('[title]')?.getAttribute('title') ?? ''
		}))
	);
const key = async (page, code) => {
	await page.keyboard.press(code);
	await page.waitForTimeout(400);
};
const toastTexts = (page) =>
	page.evaluate(() => {
		let v;
		window.__stores.notifications.subscribe((x) => (v = x))();
		return v.map((n) => String(n.text ?? ''));
	});
const addBox = (p) =>
	p.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		window.__stores.objectActions.deselectObject();
	});
const wipe = async (p) => {
	await p.page.evaluate(async () => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const uuids = (g?.children ?? []).map((c) => c.uuid);
		if (uuids.length) s.objectActions.deleteObjectsByUuid(uuids);
		await s.explorer.clearLibrary();
		s.projectManifest.manifestRestore({ scenes: {}, assets: [], changedAt: 1 }, false);
		s.levels.currentLevel.set(null);
	});
	await p.page.waitForTimeout(700);
};
const openExplorer = async (p) => {
	await p.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await p.page.locator('#explorer-slot').click();
	await p.page.waitForTimeout(700);
	await p.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
};
const pasteInto = async (page, folderId) => {
	await page.evaluate((id) => window.__stores.explorer.activeFolder.set(id), folderId);
	await page.waitForTimeout(500);
	await page.locator('#explorer-grid').click({ position: { x: 5, y: 5 } }).catch(() => {});
	await page.evaluate(() => document.getElementById('explorer-grid')?.focus());
	await key(page, 'Control+KeyV');
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await openExplorer(A);
	await wipe(A);
	await addBox(A);
	await page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	await h.eventually(() => itemsOf(A), (l) => l.some((i) => i.name === 'Arena.tpscene'), 'premise: Arena.tpscene is in the library');
	const source = (await itemsOf(A)).find((i) => i.name === 'Arena.tpscene');
	// a texture and a target folder
	await page.evaluate(async (png) => {
		const s = window.__stores.explorer;
		const bytes = Uint8Array.from(atob(png.split(',')[1]), (c) => c.charCodeAt(0));
		await s.addItemFromBytes(bytes.buffer, 'pixel.png', null);
		s.createFolder('Target', null);
	}, TINY_PNG);
	await h.eventually(() => itemsOf(A), (l) => l.some((i) => i.name === 'pixel.png'), 'premise: a texture is in the library');
	const target = (await foldersOf(A)).find((f) => f.name === 'Target');
	h.check(!!target, 'premise: a Target folder exists');

	// =====================================================================
	// 1. THE MENU STATES THE RULE PER KIND
	// =====================================================================
	await page.locator('.explorer-card', { hasText: 'Arena.tpscene' }).first().click({ button: 'right' });
	await page.waitForTimeout(300);
	let dup = (await menuLabels(page)).find((l) => l.label === 'Duplicate');
	h.check(!!dup && !dup.disabled && /new name/.test(dup.title), `§1 on a scene, Duplicate is offered and says it makes a copy under a NEW NAME (${JSON.stringify(dup)})`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	await page.locator('.explorer-card', { hasText: 'pixel.png' }).first().click({ button: 'right' });
	await page.waitForTimeout(300);
	dup = (await menuLabels(page)).find((l) => l.label === 'Duplicate');
	h.check(!!dup && !dup.disabled && /same bytes/.test(dup.title), `§1 on a texture, Duplicate says a second record of the SAME BYTES — a file is its content hash (${JSON.stringify(dup)})`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);

	// =====================================================================
	// 2. Ctrl+C / Ctrl+V OF A SCENE IS A SCENE COPY
	// =====================================================================
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(300);
	await page.locator('.explorer-card', { hasText: 'Arena.tpscene' }).first().click();
	await page.waitForTimeout(200);
	await key(page, 'Control+KeyC');
	await pasteInto(page, target.id);
	await h.eventually(() => itemsOf(A), (l) => l.some((i) => i.name === 'Arena copy.tpscene'), '§2 THE FIX: a pasted scene lands as "Arena copy.tpscene", never a second Arena.tpscene', 15000);
	let all = await itemsOf(A);
	const copy = all.find((i) => i.name === 'Arena copy.tpscene');
	h.check(all.filter((i) => i.name === 'Arena.tpscene').length === 1, `§2 …and there is still exactly ONE Arena.tpscene (${all.filter((i) => i.kind === 'scene').map((i) => i.name).join(', ')})`);
	h.check(copy?.folderId === target.id, '§2 the copy landed in the folder it was pasted into');
	h.check(!!copy && copy.hash !== source.hash && copy.id !== source.id, `§2 its own hash and record (${source.hash.slice(0, 8)} / ${copy?.hash?.slice(0, 8)})`);
	const srcJson = sessionJsonOf(await blobB64(A, source.id));
	const copyJson = sessionJsonOf(await blobB64(A, copy.id));
	h.check(copyJson.name === 'Arena copy' && srcJson.name === 'Arena', `§2 inside the file the copy is "${copyJson.name}", the source still "${srcJson.name}"`);
	h.check(copyJson.id !== srcJson.id && (copyJson.objects ?? []).length === (srcJson.objects ?? []).length && (copyJson.objects ?? []).length === 1, '§2 a fresh identity, the same content');
	await h.eventually(
		() => manifestOf(A),
		(m) => JSON.stringify(m.scenes?.['Arena copy']?.history) === JSON.stringify([copy.hash]) && JSON.stringify(m.scenes?.Arena?.history) === JSON.stringify([source.hash]),
		'§2 the manifest gains "Arena copy" as its OWN scene; Arena\'s history is untouched',
		10000
	);
	// paste again: the next copy name, no collision
	await key(page, 'Control+KeyV');
	await h.eventually(() => itemsOf(A), (l) => l.some((i) => i.name === 'Arena copy 2.tpscene'), '§2 a second paste takes the next copy name', 15000);
	all = await itemsOf(A);
	h.check(all.filter((i) => i.kind === 'scene').length === 3 && new Set(all.filter((i) => i.kind === 'scene').map((i) => i.hash)).size === 3, `§2 three scene cards, three different hashes (${all.filter((i) => i.kind === 'scene').map((i) => i.name).join(', ')})`);

	// =====================================================================
	// 3. Ctrl+C / Ctrl+V OF A TEXTURE IS A SECOND RECORD, SAME HASH
	// =====================================================================
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(300);
	await page.locator('.explorer-card', { hasText: 'pixel.png' }).first().click();
	await page.waitForTimeout(200);
	await key(page, 'Control+KeyC');
	await pasteInto(page, target.id);
	await h.eventually(() => itemsOf(A), (l) => l.filter((i) => i.name === 'pixel.png').length === 2, '§3 COUNTERFACTUAL: a pasted texture is a second record…', 8000);
	all = await itemsOf(A);
	const pngs = all.filter((i) => i.name === 'pixel.png');
	h.check(pngs[0].hash === pngs[1].hash && pngs[0].id !== pngs[1].id, `§3 …of the SAME hash, its own id — identical bytes are one file with two pointers (24-C2) (${pngs.map((i) => i.hash.slice(0, 8)).join(' = ')})`);
	h.check(pngs.some((i) => i.folderId === target.id) && pngs.some((i) => i.folderId === null), '§3 one in the root, one in Target');
	h.check(!Object.keys((await manifestOf(A)).scenes).some((n) => /pixel/.test(n)), '§3 …and no manifest scene was minted for it — only a scene has a scene entry');

	// =====================================================================
	// 4. DUPLICATE ON THE CARD, THROUGH THE REAL MENU
	// =====================================================================
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(300);
	await page.locator('.explorer-card', { hasText: 'Arena.tpscene' }).first().click({ button: 'right' });
	await page.waitForTimeout(300);
	await page.getByRole('menuitem', { name: /^Duplicate/ }).click();
	const prefilled = await h.eventually(
		() => page.locator('#explorer-new-card input').inputValue().catch(() => null),
		(v) => v === 'Arena copy 3',
		'§4 the inline name input opens, prefilled with the NEXT free copy name ("Arena copy 3" — the two pasted copies are taken)'
	);
	void prefilled;
	await page.locator('#explorer-new-card input').fill('Colosseum');
	await page.keyboard.press('Enter');
	await h.eventually(() => itemsOf(A), (l) => l.some((i) => i.name === 'Colosseum.tpscene'), '§4 Enter makes the copy under the typed name', 15000);
	await h.eventually(() => manifestOf(A), (m) => Array.isArray(m.scenes?.Colosseum?.history) && m.scenes.Colosseum.history.length === 1, '§4 …as its own manifest scene', 10000);
	h.check((await toastTexts(page)).some((t) => /Duplicated Arena as Colosseum/.test(t)), '§4 the toast names both scenes');
	// a taken name is refused at Enter
	await page.locator('.explorer-card', { hasText: 'Arena.tpscene' }).first().click({ button: 'right' });
	await page.waitForTimeout(300);
	await page.getByRole('menuitem', { name: /^Duplicate/ }).click();
	await h.eventually(() => page.locator('#explorer-new-card input').inputValue().catch(() => null), (v) => typeof v === 'string' && v.length > 0, 'premise: the input opened again');
	await page.locator('#explorer-new-card input').fill('Colosseum');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(500);
	h.check((await toastTexts(page)).some((t) => /"Colosseum" already exists/.test(t)), '§4 a taken name is refused with the reason (a copy may not become a version of another scene)');
	h.check((await itemsOf(A)).filter((i) => i.name === 'Colosseum.tpscene').length === 1, '§4 …and nothing was made');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);

	// =====================================================================
	// 5. THE COPY TRAVELS AS A NEW SCENE
	// =====================================================================
	const B = await h.setupPage(browser, 'B');
	await openExplorer(B);
	await h.connect(B, A);
	await h.eventually(
		() => manifestOf(B),
		(m) => !!m.scenes?.['Arena copy'] && !!m.scenes?.Colosseum && !!m.scenes?.Arena,
		'§5 the peer learns the copies as scenes of their own, beside the original',
		20000
	);
	await h.eventually(
		() => B.page.evaluate(() => [...document.querySelectorAll('.explorer-card')].map((el) => el.getAttribute('title'))),
		(titles) => titles.includes('Arena copy.tpscene') && titles.includes('Arena.tpscene') && titles.filter((t) => t === 'Arena.tpscene').length === 1,
		'§5 …one card each, never a second Arena.tpscene'
	);

	h.check((await h.pageErrors(A)).length === 0, `no page errors on A (${JSON.stringify(await h.pageErrors(A))})`);
	h.check((await h.pageErrors(B)).length === 0, `no page errors on B (${JSON.stringify(await h.pageErrors(B))})`);
	await h.finish(browser);
});
