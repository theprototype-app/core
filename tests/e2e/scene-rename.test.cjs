// ROADMAP 22 R5 — SCENE RENAME, FILES FOLLOW. Fork 3, locked: the SCENE is primary; its
// `.tpscene` files follow; a loose file's rename is just the file's rename.
//
//   §1  The chip reads `Scene [file.tpscene]`.
//   §2  A taken name is refused at the chip (a scene may not become a version of another).
//   §3  Double-click → rename: the manifest rekeys and RECORDS it, every version file
//       follows, the open scene follows, BOTH forms of Travel node are rewritten.
//   §4  Replicated: the peer standing in the scene reads the new name in its own header,
//       its manifest carries the record, and a Travel by the OLD name (a graph on disk
//       nobody rewrote) resolves at fire time and lands in the renamed scene.
//   §5  COUNTERFACTUALS: strip the record → the stale name is dead ("No scene called");
//       undo the live rewrite → the applier does it again (it is the thing doing it).
//   §6  THE MERGE FOLD: a stale peer's document still carrying the old key folds into the
//       new one (its novel save kept); a FRESH scene reusing the old name stays and spends
//       the record.
//   §7  A loose file: the file renames, the open scene follows, the manifest is untouched.
//   §8  The card menu offers "Rename scene…" for a project scene.
//
// Run: APP_URL='https://theprototype.app:5211/' npm run e2e -- scene-rename
const h = require('./helpers.cjs');

const at = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});
const manifest = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
		return { scenes: m.scenes, renames: m.renames ?? null, name: m.name };
	});
const itemNames = (p) =>
	p.page.evaluate(() => {
		const s = window.__stores.explorer;
		let v, hid;
		s.explorerItems.subscribe((x) => (v = x))();
		s.hiddenItems.subscribe((x) => (hid = x))();
		return { visible: v.map((i) => i.name).sort(), hidden: hid.map((i) => i.name).sort() };
	});
const chip = (p) =>
	p.page.evaluate(() => ({
		scene: document.querySelector('#explorer-scene')?.textContent?.trim() ?? null,
		file: document.querySelector('#explorer-scene-file')?.textContent?.trim() ?? null,
		input: document.querySelector('#explorer-scene-input') ? true : false
	}));
const travelNodes = (p) =>
	p.page.evaluate(() =>
		window.__stores.allNodes()
			.filter((n) => n.data?.type === 'travel')
			.map((n) => ({ id: n.id, sceneName: n.data.sceneName ?? '', level: n.data.level ?? '', levelName: n.data.levelName ?? '' }))
			.sort((a, b) => a.id.localeCompare(b.id))
	);
const lastToasts = (p) =>
	p.page.evaluate(() => {
		let n;
		window.__stores.notifications.subscribe((x) => (n = x))();
		return n.slice(-4).map((x) => x.text);
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
/** rename through the CHIP: double-click, type, Enter */
const renameAtChip = async (p, to) => {
	await p.page.locator('#explorer-scene').dblclick();
	await h.eventually(() => chip(p), (c) => c.input, 'premise: the double-click opened the scene name for editing');
	await p.page.locator('#explorer-scene-input').fill(to);
	await p.page.keyboard.press('Enter');
	await p.page.waitForTimeout(500);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await openExplorer(A);
	await wipe(A);
	await addBox(A);
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Depot'));
	await h.eventually(() => at(A), (v) => v?.name === 'Depot', 'premise: a scene called Depot exists (the taken name)');
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	await h.eventually(() => at(A), (v) => v?.name === 'Arena', 'premise: A saved Arena and stands in it');
	const arenaV1 = (await at(A)).hash;
	// two Travel nodes in the live scene graph: by NAME and by frozen HASH (version 1)
	await A.page.evaluate((hash) => {
		const s = window.__stores;
		const make = (id, data) => ({ id, type: 'travel', position: { x: 40, y: 40 }, data: { label: 'Travel to scene', type: 'travel', level: '', levelName: '', ...data }, class: 'w-[150px]' });
		s.nodesHandler.createFlowNode(make('tr-name', { sceneName: 'Arena' }), 'scene');
		s.nodesHandler.createFlowNode(make('tr-hash', { level: hash, levelName: 'Arena' }), 'scene');
	}, arenaV1);
	h.check((await travelNodes(A)).length === 2, 'premise: two Travel nodes name Arena, one by name and one by hash');
	// …and SAVED, so the scene is clean before the rename (the dirty check below measures the rename, not these nodes)
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	await h.eventually(() => manifest(A), (m) => (m.scenes.Arena?.history ?? []).length === 2, 'premise: Arena has two versions, the nodes in the second');
	const arenaHash = (await at(A)).hash;
	await A.page.waitForTimeout(2600); // the dirty throttle

	// =====================================================================
	// 1. THE CHIP READS "Scene [file]"
	// =====================================================================
	await h.eventually(
		() => chip(A),
		(c) => c.scene === 'Arena' && c.file === '[Arena.tpscene]',
		'§1 the header chip reads the scene NAME and, in brackets, the FILE it is loaded from'
	);

	// =====================================================================
	// 2. A TAKEN NAME IS REFUSED
	// =====================================================================
	await renameAtChip(A, 'Depot');
	const refused = await lastToasts(A);
	h.check(refused.some((t) => /already exists/.test(t)), `§2 renaming onto an existing scene is refused with the reason (${JSON.stringify(refused.at(-1))})`);
	h.check((await chip(A)).scene === 'Arena' && !!(await manifest(A)).scenes.Arena, '§2 …and nothing moved: the chip still says Arena, the manifest still keys it');

	// =====================================================================
	// 3. THE PEER, THEN THE RENAME
	// =====================================================================
	const B = await h.setupPage(browser, 'B');
	await openExplorer(B);
	await h.connect(B, A);
	await h.eventually(() => at(B), (v) => v?.name === 'Arena', 'premise: the joiner adopted Arena on connect');
	await h.eventually(() => chip(B), (c) => c.scene === 'Arena', 'premise: the joiner\'s chip reads Arena');

	await renameAtChip(A, 'Vault');
	await h.eventually(
		() => chip(A),
		(c) => c.scene === 'Vault' && c.file === '[Vault.tpscene]',
		'§3 THE RENAME: the chip reads Vault, and the file half followed to Vault.tpscene'
	);
	const mA = await manifest(A);
	h.check(!mA.scenes.Arena && !!mA.scenes.Vault, `§3 the manifest keys the scene by its new name only (${Object.keys(mA.scenes).sort()})`);
	h.check(mA.scenes.Vault?.history?.includes(arenaHash), '§3 …with the SAME history — a rename is not a new version');
	h.check(mA.renames?.Arena?.to === 'Vault' && mA.renames.Arena.at > 0, `§3 …and the rename is RECORDED (${JSON.stringify(mA.renames)})`);
	const files = await itemNames(A);
	h.check(
		files.visible.includes('Vault.tpscene') && !files.visible.includes('Arena.tpscene') && !files.hidden.includes('Arena.tpscene'),
		`§3 the files followed on both shelves (${JSON.stringify(files)})`
	);
	const after = await at(A);
	h.check(after?.name === 'Vault' && after.hash === arenaHash, `§3 the open scene follows by name and keeps its hash (${after?.name}, same hash: ${after?.hash === arenaHash})`);
	await A.page.waitForTimeout(2600); // past the dirty throttle, so a recompute had its chance
	h.check(
		(await A.page.evaluate(() => {
			let d;
			window.__stores.sceneIdentity.sceneDirty.subscribe((x) => (d = x))();
			return d;
		})) === false,
		'§3 renaming is not an edit — the scene is not dirty'
	);
	await h.eventually(
		() => travelNodes(A),
		(n) => n.find((x) => x.id === 'tr-name')?.sceneName === 'Vault' && n.find((x) => x.id === 'tr-hash')?.levelName === 'Vault',
		'§3 THE DATA HAZARD: both Travel nodes were rewritten — by-name to Vault, by-hash keeps its hash and reads Vault'
	);
	h.check((await travelNodes(A)).find((x) => x.id === 'tr-hash')?.level === arenaV1, '§3 …the frozen hash itself untouched');

	// =====================================================================
	// 4. REPLICATED
	// =====================================================================
	await h.eventually(() => chip(B), (c) => c.scene === 'Vault', '§4 the peer standing in the scene reads the new name in ITS header', 15000);
	await h.eventually(
		() => manifest(B),
		(m) => !!m.scenes.Vault && !m.scenes.Arena && m.renames?.Arena?.to === 'Vault',
		'§4 the peer\'s manifest keys Vault and carries the record'
	);
	h.check((await at(B))?.name === 'Vault', '§4 the peer\'s open scene followed the rename (an adopted identity carries the name)');
	// a Travel by the OLD name — what a graph in a file on disk says
	const stale = await B.page.evaluate(() => window.__stores.levels.travelToScene('Arena'));
	h.check(stale === true, '§4 travelToScene("Arena") on the peer resolves through the record and LOADS');
	await h.eventually(
		() => at(B),
		(v) => v?.name === 'Vault' && v.hash === arenaHash,
		'§4 …landing in Vault with the very bytes Arena had (pulled from the host)',
		30000
	);
	await h.eventually(() => chip(B), (c) => c.file === '[Vault.tpscene]', '§4 …and the peer\'s file half reads Vault.tpscene: the pulled file landed under the new name');

	// =====================================================================
	// 5. COUNTERFACTUALS
	// =====================================================================
	const noRecord = await B.page.evaluate(() => {
		const s = window.__stores.projectManifest;
		let m;
		s.projectManifest.subscribe((x) => (m = x))();
		const { renames, ...rest } = m;
		s.manifestRestore({ ...rest, changedAt: (m.changedAt ?? 0) + 1 }, false);
		return window.__stores.levels.travelToScene('Arena');
	});
	const deadToast = await lastToasts(B);
	h.check(noRecord === false && deadToast.some((t) => /No scene called "Arena"/.test(t)), `§5 COUNTERFACTUAL: with the record stripped, the old name is DEAD (${JSON.stringify(deadToast.at(-1))})`);
	await B.page.evaluate((rec) => {
		const s = window.__stores.projectManifest;
		let m;
		s.projectManifest.subscribe((x) => (m = x))();
		s.manifestRestore({ ...m, renames: rec, changedAt: (m.changedAt ?? 0) + 1 }, false);
	}, mA.renames);
	h.check((await B.page.evaluate(() => window.__stores.levels.travelToScene('Arena'))) === true, '§5 …and alive again with the record back');
	// undo the LIVE rewrite by hand → the applier redoes it (idempotent, and it is the thing)
	await A.page.evaluate(() => window.__stores.nodesHandler.updateFlowNodeData('tr-name', { sceneName: 'Arena' }, 'scene'));
	h.check((await travelNodes(A)).find((x) => x.id === 'tr-name')?.sceneName === 'Arena', 'premise: the by-name node is stale again');
	const redone = await A.page.evaluate(() => window.__stores.levels.applySceneRenames());
	h.check(redone >= 1 && (await travelNodes(A)).find((x) => x.id === 'tr-name')?.sceneName === 'Vault', `§5 COUNTERFACTUAL: the applier rewrites a stale node again (${redone} thing(s) moved) — it is what keeps live graphs right`);

	// =====================================================================
	// 6. THE MERGE FOLD
	// =====================================================================
	const foldedStale = await A.page.evaluate((hash) => {
		const s = window.__stores.projectManifest;
		let m;
		s.projectManifest.subscribe((x) => (m = x))();
		// a peer that never heard: still keys Arena, and saved a novel version under it
		s.applyRemoteManifest({ manifest: { scenes: { Arena: { history: [hash, 'stale-novel-1'], pinned: [] } }, assets: [], changedAt: (m.changedAt ?? 0) + 5 } });
		s.projectManifest.subscribe((x) => (m = x))();
		return { keys: Object.keys(m.scenes).sort(), vault: m.scenes.Vault?.history ?? [], renames: m.renames ?? null };
	}, arenaHash);
	h.check(
		!foldedStale.keys.includes('Arena') && foldedStale.keys.includes('Vault'),
		`§6 a stale document's Arena is FOLDED into Vault, not resurrected beside it (${JSON.stringify(foldedStale.keys)})`
	);
	h.check(foldedStale.vault.includes('stale-novel-1') && foldedStale.vault.includes(arenaHash), `§6 …keeping the stale peer's novel save in Vault's history (${JSON.stringify(foldedStale.vault)})`);
	h.check(foldedStale.renames?.Arena?.to === 'Vault', '§6 …and the record survives for the next late peer');
	const foldedFresh = await A.page.evaluate(() => {
		const s = window.__stores.projectManifest;
		let m;
		s.projectManifest.subscribe((x) => (m = x))();
		// a brand-new scene that reuses the old name: shares no hash with Vault's line
		s.applyRemoteManifest({ manifest: { ...m, scenes: { ...m.scenes, Arena: { history: ['fresh-arena-1'], pinned: [] } }, changedAt: (m.changedAt ?? 0) + 5 } });
		s.projectManifest.subscribe((x) => (m = x))();
		return { keys: Object.keys(m.scenes).sort(), arena: m.scenes.Arena?.history ?? [], renames: m.renames ?? null };
	});
	h.check(
		foldedFresh.keys.includes('Arena') && foldedFresh.keys.includes('Vault') && foldedFresh.arena.join() === 'fresh-arena-1',
		`§6 a FRESH scene reusing the old name is kept as its own scene (${JSON.stringify(foldedFresh.keys)})`
	);
	h.check(!foldedFresh.renames?.Arena, `§6 …and the record is SPENT, so the new Arena is never redirected (${JSON.stringify(foldedFresh.renames)})`);

	// =====================================================================
	// 7. A LOOSE FILE
	// =====================================================================
	const looseBytes = await A.page.evaluate(async () => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('cube');
		delete payload.workspace;
		const b = await s.sessions.exportSessionZip(payload, { assets: true, packs: false, flow: true });
		return Array.from(b);
	});
	await A.page.evaluate((arr) => {
		const f = new File([new Uint8Array(arr)], 'cube.tpscene', { type: 'application/zip' });
		const dt = new DataTransfer();
		dt.items.add(f);
		document.querySelector('#explorer-list').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
	}, looseBytes);
	await h.eventually(() => itemNames(A), (n) => n.visible.includes('cube.tpscene'), 'premise: a loose cube.tpscene is in the library');
	const cubeHash = await A.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.find((i) => i.name === 'cube.tpscene').hash;
	});
	await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash), cubeHash);
	await h.eventually(() => at(A), (v) => v?.name === 'cube' && v?.unsaved === true, 'premise: it opens LOOSE');
	const scenesBefore = Object.keys((await manifest(A)).scenes).sort();
	await renameAtChip(A, 'Crate');
	await h.eventually(() => chip(A), (c) => c.scene === 'Crate' && c.file === '[Crate.tpscene]', '§7 a loose scene renames: the chip reads Crate [Crate.tpscene]');
	const mLoose = await manifest(A);
	h.check(
		Object.keys(mLoose.scenes).sort().join() === scenesBefore.join() && !mLoose.renames?.cube,
		`§7 …the manifest is UNTOUCHED — a loose file's rename is the file's rename (${Object.keys(mLoose.scenes).sort()})`
	);
	h.check((await at(A))?.unsaved === true && (await at(A))?.hash === cubeHash, '§7 …and the scene stays loose, same bytes');

	// =====================================================================
	// 8. THE CARD MENU
	// =====================================================================
	await A.page.locator('.explorer-card[title="Vault.tpscene"]').first().click({ button: 'right' });
	await A.page.waitForTimeout(400);
	const menu = await A.page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => el.textContent?.trim() ?? ''));
	h.check(menu.some((t) => /^Rename scene/.test(t)) && menu.some((t) => /^Rename$/.test(t)), `§8 a project scene's card offers "Rename scene…" beside the file's own Rename (${JSON.stringify(menu)})`);
	await A.page.evaluate(() => {
		const el = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((x) => /^Rename scene/.test(x.textContent?.trim() ?? ''));
		el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	});
	await A.page.waitForTimeout(400);
	const inline = await A.page.evaluate(() => document.querySelector('.explorer-card[title="Vault.tpscene"] input')?.value ?? null);
	h.check(inline === 'Vault', `§8 …opening the inline editor on the card, prefilled with the SCENE name (${JSON.stringify(inline)})`);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(300);
	const crateMenu = await (async () => {
		await A.page.locator('.explorer-card[title="Crate.tpscene"]').first().click({ button: 'right' });
		await A.page.waitForTimeout(400);
		return A.page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => el.textContent?.trim() ?? ''));
	})();
	h.check(!crateMenu.some((t) => /^Rename scene/.test(t)), `§8 …and a LOOSE file's card does not (its plain Rename is the rename) (${JSON.stringify(crateMenu)})`);
	await A.page.keyboard.press('Escape');

	h.check((await h.pageErrors(A)).length === 0, `no page errors on A (${JSON.stringify(await h.pageErrors(A))})`);
	h.check((await h.pageErrors(B)).length === 0, `no page errors on B (${JSON.stringify(await h.pageErrors(B))})`);
	await h.finish(browser);
});
