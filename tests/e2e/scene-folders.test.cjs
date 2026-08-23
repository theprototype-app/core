// 21-G1 — SCENES, NOT LEVELS; DOWNLOAD; PACK RENAME; RECIPE RE-HOMING.
//
// Four changes, each with the thing that would have caught its bug:
//
//   `Scenes` not `Levels`      the folder a save lands in is renamed AND demoted:
//                              discovery is BY KIND now, so `levelItems()` finds a
//                              .tpscene wherever it lives and stops offering a PNG
//                              that happens to sit in the scenes folder. Sections 1-3.
//                              21-H1 (locked answer 6) finished the job: NO folder is
//                              invented at all any more — a scene lands in the folder
//                              you are browsing, else at the library root — so section
//                              1 asserts the absence, and the `Scenes` folder the later
//                              sections rename and delete is one a user MADE.
//   Download                   the library holds the only copy of an imported model or
//                              a painted texture; there was no way to get bytes back
//                              out. Asserted by HASHING the downloaded file against the
//                              item's own content hash. Section 4.
//   Pack rename                the reported "the Audio Essentials folder can't be
//                              renamed". The folder always could; the PACK ROW beside
//                              it, with the same name, had no rename at all. Renaming
//                              writes the TITLE (the `name` is identity) and must
//                              SURVIVE A RELOAD, which is the whole reason the override
//                              lives outside the pack list. Section 5.
//   Recipes re-homed           the object menu's Game submenu is gone; the collectible
//                              recipe lives in the node editor's Game category and acts
//                              on the SELECTION. Sections 6-7.
//
// Run: APP_URL='https://localhost:5201/' npm run e2e -- scene-folders
const fs = require('fs');
const crypto = require('crypto');
const h = require('./helpers.cjs');
// 21-I4: the folder export is asserted on the REAL downloaded bytes
const { unzipSync, strFromU8 } = require('fflate');

// ---- reading the world -----------------------------------------------------------
const folderNames = (peer) =>
	peer.page.evaluate(() => {
		let f;
		window.__stores.explorer.explorerFolders.subscribe((v) => (f = v))();
		return f.map((x) => x.name);
	});

const folderIdNamed = (peer, name) =>
	peer.page.evaluate((n) => {
		let f;
		window.__stores.explorer.explorerFolders.subscribe((v) => (f = v))();
		return f.find((x) => x.name === n)?.id ?? null;
	}, name);

/** exactly what the Travel node's card lists */
const travelChoices = (peer) =>
	peer.page.evaluate(() => window.__stores.levels.levelItems().map((i) => i.name));

const packTitles = (peer) =>
	peer.page.evaluate(() => {
		let p;
		window.__stores.packs.packs.subscribe((v) => (p = v))();
		return p.map((x) => ({ name: x.name, title: x.title, source: x.source }));
	});

const menuRows = (peer) =>
	peer.page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
			.map((el) => el.textContent?.trim())
			.filter(Boolean)
	);

const closeMenu = async (peer) => {
	await peer.page.mouse.click(4, 4);
	await peer.page.waitForTimeout(250);
};

const makeBoxes = (peer, count) =>
	peer.page.evaluate(async (n) => {
		const s = window.__stores;
		const uuids = [];
		for (let i = 0; i < n; i++) {
			s.commandsHandler.sceneCommand('/create box');
			await new Promise((r) => setTimeout(r, 1100));
			let group;
			s.objectsGroup.subscribe((v) => (group = v))();
			uuids.push(group.children[group.children.length - 1].uuid);
		}
		s.objectActions.deselectObject();
		return uuids;
	}, count);

/** 21-I4: the world, by uuid — "did the scene really change" has no cheaper answer */
const worldUuids = (peer) =>
	peer.page.evaluate(() => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return (group?.children ?? []).map((c) => c.uuid);
	});

const currentLevelOf = (peer) =>
	peer.page.evaluate(() => {
		let at;
		window.__stores.levels.currentLevel.subscribe((v) => (at = v))();
		return at;
	});

/** 21-G9's flag, READ — the guard reads it too and never recomputes it */
const dirtyOf = (peer) =>
	peer.page.evaluate(() => {
		let d;
		window.__stores.sceneIdentity.sceneDirty.subscribe((v) => (d = v))();
		return d;
	});

/** the live confirm/choice dialog: `{title, message, choices[]}` or null */
const dialogOf = (peer) =>
	peer.page.evaluate(() => {
		let d;
		window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
		return d
			? {
					title: d.title,
					message: d.message,
					choices: (d.choices ?? []).map((c) => c.label),
					cancel: d.cancelLabel
				}
			: null;
	});

/**
 * Right-click the grid BACKGROUND — and prove the pixel really is background before
 * clicking it. This grid fills up as the suite runs, so a fixed offset that was empty
 * space in section 1 is a card by section 9, and `gridMenu` correctly returns early on
 * a card: the menu simply never opens and the assertion reads as a missing entry.
 */
const gridBackgroundMenu = async (peer) => {
	const box = await peer.page.locator('#explorer-list [role="region"]').first().boundingBox();
	if (!box) return false;
	const pt = await peer.page.evaluate((b) => {
		for (let y = b.y + b.height - 8; y > b.y + 6; y -= 10)
			for (let x = b.x + b.width - 12; x > b.x + 10; x -= 24) {
				const el = document.elementFromPoint(x, y);
				if (!el || el.closest('.explorer-card, .explorer-folder-card')) continue;
				if (el.closest('#explorer-list')) return { x, y };
			}
		return null;
	}, box);
	if (!pt) return false;
	await peer.page.mouse.click(pt.x, pt.y, { button: 'right' });
	await peer.page.waitForTimeout(320);
	return true;
};

/** answer it: a choice VALUE, or false for cancel */
const answerDialog = (peer, answer) =>
	peer.page.evaluate((a) => window.__stores.confirmDialog.resolveConfirm(a), answer);

const toastsOf = (peer) =>
	peer.page.evaluate(() => {
		let toasts;
		window.__stores.toastStore.subscribe((t) => (toasts = t))();
		return (toasts ?? []).map((t) => (typeof t === 'string' ? t : (t.text ?? '')));
	});

const clearToasts = (peer) => peer.page.evaluate(() => window.__stores.toastStore.set([]));

const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});

/** a scene asset with ONE recognisable object in it; leaves the world holding it */
const seedScene = async (peer, name) => {
	const [uuid] = await makeBoxes(peer, 1);
	const item = await peer.page.evaluate((n) => window.__stores.levels.saveSceneAsLevel(n), name);
	return { uuid, item };
};

/** the dialog BLOCKS the double-click's handler, so it is answered from here while the
 *  page awaits — the project-file `answerOpenConfirm` shape */
const waitForDialog = (peer, expect) =>
	h.eventually(
		() => dialogOf(peer),
		(d) => !!d && d.title.includes(expect),
		`the unsaved-changes dialog appeared for "${expect}"`
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.levels, { timeout: 30000 });

	// =====================================================================
	// 1. THE GRID MENU SAYS "SCENE", AND A SAVE LANDS WHERE YOU ARE LOOKING
	// =====================================================================
	// 21-H1 (locked answer 6) FINISHED the demotion 21-G1 started: the app no longer
	// invents a `Scenes` folder at all. A scene lands in the folder you are browsing, or
	// at the library ROOT — and the only path that still premakes the folder is the
	// empty-library bootstrap button (`files-format-row` owns that one).
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(700);
	await A.page.locator('#explorer-list [role="region"]').first()
		.click({ button: 'right', position: { x: 200, y: 140 } });
	await A.page.waitForTimeout(300);
	const gridRows = await menuRows(A);
	h.check(
		gridRows.some((r) => r.startsWith('Save scene…')) && gridRows.some((r) => r.startsWith('New scene…')),
		`the grid menu offers both scene entries (${JSON.stringify(gridRows)})`
	);
	h.check(
		!gridRows.some((r) => /level/i.test(r)),
		'and the word "level" is gone from it entirely'
	);

	await A.page.getByText('Save scene…', { exact: false }).click();
	// 21-G10 (fork 14): the name is typed INLINE in the grid now — the browser
	// prompt this used to accept is gone (explorer-inline-input owns that contract)
	await A.page.waitForTimeout(350);
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('Alpha');
	await A.page.keyboard.press('Enter');
	await h.eventually(
		() => travelChoices(A),
		(list) => list.includes('Alpha.tpscene'),
		'the saved scene is on offer to a Travel node'
	);
	const afterFirst = await folderNames(A);
	h.check(
		afterFirst.length === 0,
		`the first save invents NO folder at all — not Scenes, not Levels (${JSON.stringify(afterFirst)})`
	);
	h.check(
		await A.page.evaluate(() => {
			let items;
			window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
			return (items.find((i) => i.name === 'Alpha.tpscene')?.folderId ?? null) === null;
		}),
		'it landed at the library ROOT, which is where the user was looking'
	);

	// the other half of the same rule: browsing a folder lands the save THERE
	const looking = await A.page.evaluate(
		() => window.__stores.explorer.createFolder('Where I am looking', null)?.id ?? null
	);
	await A.page.evaluate((id) => window.__stores.explorer.activeFolder.set(id), looking);
	await A.page.waitForTimeout(500);
	await A.page.locator('#explorer-list [role="region"]').first()
		.click({ button: 'right', position: { x: 200, y: 140 } });
	await A.page.waitForTimeout(300);
	await A.page.getByText('Save scene…', { exact: false }).click();
	await A.page.waitForTimeout(350);
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('Delta');
	await A.page.keyboard.press('Enter');
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let items;
				window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
				return items.find((i) => i.name === 'Delta.tpscene')?.folderId ?? null;
			}),
		(folderId) => folderId === looking,
		'a save made while browsing a folder lands in THAT folder'
	);
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(400);

	// =====================================================================
	// 2. DISCOVERY IS BY KIND — a folder is a place, not a registry
	// =====================================================================
	// a scenes folder now exists only because someone MADE one — which is the state the
	// rest of this suite is about, and it is a user's folder like any other
	const scenesId = await A.page.evaluate(
		() => window.__stores.explorer.createFolder('Scenes', null)?.id ?? null
	);
	h.check(!!scenesId, 'premise: a user-made `Scenes` folder');
	await A.page.evaluate(
		(folderId) => window.__stores.levels.saveSceneAsLevel('Beta', folderId),
		scenesId
	);
	// and Alpha (saved at the root) DRAGGED somewhere else entirely
	const elsewhere = await A.page.evaluate(() => {
		const s = window.__stores;
		const folder = s.explorer.createFolder('Prototypes', null);
		return folder?.id ?? null;
	});
	await A.page.evaluate((folderId) => {
		const s = window.__stores;
		let items;
		s.explorer.explorerItems.subscribe((v) => (items = v))();
		const alpha = items.find((i) => i.name === 'Alpha.tpscene');
		if (alpha) s.explorer.moveItem(alpha.id, folderId);
	}, elsewhere);
	await A.page.waitForTimeout(400);
	h.check(
		(await travelChoices(A)).includes('Alpha.tpscene'),
		'a .tpscene living outside any scenes folder is still discoverable — the folder filter is gone'
	);

	// the counterfactual for the same change, in the other direction: the OLD rule
	// counted anything sitting in the folder, so a texture dropped there was offered as
	// a travel destination. Kind-based discovery cannot make that mistake.
	await A.page.evaluate(async (folderId) => {
		const bytes = new TextEncoder().encode('not a scene');
		await window.__stores.explorer.addItemFromBytes(bytes.buffer, 'readme.txt', folderId);
	}, scenesId);
	await A.page.waitForTimeout(400);
	const withText = await travelChoices(A);
	h.check(
		!withText.includes('readme.txt'),
		`a non-scene file IN the Scenes folder is not a travel destination (${JSON.stringify(withText)})`
	);

	// =====================================================================
	// 3. THE FOLDER IS FREELY RENAMABLE AND DELETABLE
	// =====================================================================
	await A.page.evaluate(
		({ id }) => window.__stores.explorer.renameFolder(id, 'Old scenes'),
		{ id: scenesId }
	);
	await A.page.waitForTimeout(300);
	h.check((await folderNames(A)).includes('Old scenes'), 'the Scenes folder renames');
	h.check(
		(await travelChoices(A)).includes('Beta.tpscene'),
		'and every scene it holds is STILL discoverable under the new name'
	);

	// delete it: the cascade takes its contents with it (ordinary folder semantics —
	// Beta lived there), and the scene stored elsewhere is untouched
	await A.page.evaluate(({ id }) => window.__stores.explorer.deleteFolder(id), { id: scenesId });
	await A.page.waitForTimeout(500);
	const afterDelete = await travelChoices(A);
	h.check(!afterDelete.includes('Beta.tpscene'), 'deleting the folder deletes the scenes inside it');
	h.check(
		afterDelete.includes('Alpha.tpscene'),
		`a scene living elsewhere survives the folder's deletion (${JSON.stringify(afterDelete)})`
	);
	const foldersBeforeGamma = (await folderNames(A)).length;
	const remade = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Gamma'));
	h.check(!!remade?.hash, 'a save after the delete still works');
	// 21-H1: and it does NOT put the folder back — that was the pre-H1 behaviour, and
	// re-creating a folder the user has just deleted is the shape of the whole complaint
	h.check(
		(await folderNames(A)).length === foldersBeforeGamma &&
			!(await folderNames(A)).includes('Scenes'),
		`…without re-creating the folder the user deleted (${JSON.stringify(await folderNames(A))})`
	);

	// =====================================================================
	// 4. DOWNLOAD: the bytes that come out are the bytes that went in
	// =====================================================================
	// Gamma went to the ROOT (nothing was being browsed), so that is where to find it
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(500);
	const card = A.page.locator('.explorer-card[title="Gamma.tpscene"]');
	h.check((await card.count()) === 1, 'premise: the scene has a card in the grid');
	await card.click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const itemRows = await menuRows(A);
	h.check(
		itemRows.some((r) => r.startsWith('Download (.tpscene)')),
		`a scene item offers a typed Download (${JSON.stringify(itemRows)})`
	);
	h.check(
		itemRows.some((r) => r.startsWith('Open here')),
		'and the local-load entry no longer says "Travel"'
	);

	const [download] = await Promise.all([
		A.page.waitForEvent('download', { timeout: 20000 }),
		A.page.getByText('Download (.tpscene)', { exact: false }).click()
	]);
	h.check(
		download.suggestedFilename() === 'Gamma.tpscene',
		`the file is named after the item (${download.suggestedFilename()})`
	);
	const saved = await download.path();
	const bytes = fs.readFileSync(saved);
	const sha = crypto.createHash('sha256').update(bytes).digest('hex');
	h.check(
		sha === remade.hash,
		`the downloaded bytes hash to the item's own content hash (${sha.slice(0, 12)} vs ${remade.hash.slice(0, 12)}, ${bytes.length} bytes)`
	);

	// offered for every library kind, not only scenes
	await A.page.evaluate(async () => {
		const bytes = new TextEncoder().encode('hello from the library');
		await window.__stores.explorer.addItemFromBytes(bytes.buffer, 'note.txt', null);
	});
	await A.page.waitForTimeout(500);
	await A.page.locator('.explorer-card[title="note.txt"]').click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const textRows = await menuRows(A);
	h.check(
		textRows.some((r) => r.trim() === 'Download'),
		`a plain file offers an untyped Download (${JSON.stringify(textRows)})`
	);
	await closeMenu(A);

	// =====================================================================
	// 5. PACK RENAME — the row that carries the pack's name, not the folder
	// =====================================================================
	// the post-install state: importPackZip makes a real library folder AND registers a
	// pack whose row sits under Packs with the same name
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.explorer.createFolder('Audio Essentials', null);
		s.packs.registerImportedPack({ name: 'audio-essentials', title: 'Audio Essentials', items: [] });
	});
	await A.page.waitForTimeout(500);

	// the LIBRARY folder always renamed — this is the regression guard, and the reason
	// the report needed measuring rather than believing
	const audioFolder = await folderIdNamed(A, 'Audio Essentials');
	const treeRow = A.page.locator('#explorer-tree button', { hasText: 'Audio Essentials' }).first();
	await treeRow.click({ button: 'right' });
	await A.page.waitForTimeout(300);
	h.check(
		(await menuRows(A)).some((r) => r.trim() === 'Rename'),
		"the pack's LIBRARY FOLDER offers Rename (it always did — the report was about the other row)"
	);
	await closeMenu(A);
	await A.page.evaluate(({ id }) => window.__stores.explorer.renameFolder(id, 'My Sounds'), { id: audioFolder });
	await A.page.waitForTimeout(300);
	h.check((await folderNames(A)).includes('My Sounds'), 'and renaming it works');

	// the PACK ROW: what actually could not be renamed
	await A.page.locator('#packs-folder').dblclick();
	await A.page.waitForTimeout(600);
	const packRow = A.page.locator('[data-pack="audio-essentials"]');
	h.check((await packRow.count()) === 1, 'premise: the pack row is in the tree');
	await packRow.click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const packRows = await menuRows(A);
	h.check(
		packRows.some((r) => r.trim() === 'Rename'),
		`the PACK ROW offers Rename now (${JSON.stringify(packRows)})`
	);
	await A.page.locator('[role="menu"]').getByText('Rename', { exact: true }).first().click();
	await A.page.waitForTimeout(400);
	const packInput = A.page.locator('#explorer-tree input').first();
	h.check((await packInput.count()) === 1, 'it opens the same inline editor every other rename uses');
	await packInput.fill('Sound FX');
	await packInput.press('Enter');
	await A.page.waitForTimeout(500);
	const renamed = (await packTitles(A)).find((p) => p.name === 'audio-essentials');
	h.check(renamed?.title === 'Sound FX', `the pack's TITLE changed (${renamed?.title})`);
	h.check(renamed?.name === 'audio-essentials', 'and its `name` — the identity every cache keys on — did not');

	// a DEFAULT pack renames too, and that is the case the override map exists for: its
	// title is rebuilt from the pack index on every load, so without a store outside the
	// list the rename would silently revert on reload
	const builtin = (await packTitles(A)).find((p) => p.source === 'default');
	if (builtin) {
		await A.page.evaluate((name) => window.__stores.packs.renamePack(name, 'Starter Kit'), builtin.name);
		await A.page.waitForTimeout(300);
		h.check(
			(await packTitles(A)).find((p) => p.name === builtin.name)?.title === 'Starter Kit',
			`a built-in pack renames as well (${builtin.name})`
		);
	} else {
		h.check(true, 'no default pack in this environment — the built-in rename is untested here');
	}

	await h.freshReload(A);
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(1200);
	await h.eventually(
		() => packTitles(A),
		(list) => list.some((p) => p.name === 'audio-essentials' && p.title === 'Sound FX'),
		'the rename SURVIVES a reload (an imported pack)'
	);
	if (builtin)
		h.check(
			(await packTitles(A)).find((p) => p.name === builtin.name)?.title === 'Starter Kit',
			'…and so does a BUILT-IN pack rename, whose title the index would otherwise rebuild'
		);

	// =====================================================================
	// 6. DOUBLE-CLICK A SCENE CARD AND IT OPENS
	// =====================================================================
	// 21-I4. The right-click menu has offered "Open here" since 21-F4; the double-click
	// every OTHER card in this grid answers to did nothing at all, which reads as a
	// broken card rather than as a missing feature.
	//
	// "Did it open" is asserted on OBJECT UUIDS, never on a count: two scenes with one
	// box each are indistinguishable by count, and a count is exactly what a travel that
	// silently did nothing would also satisfy.
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(400);
	const sceneA = await seedScene(A, 'Opened A');
	await A.page.evaluate((u) => window.__stores.objectActions.deleteObjectsByUuid([u]), sceneA.uuid);
	await A.page.waitForTimeout(400);
	const sceneB = await seedScene(A, 'Opened B');
	await A.page.waitForTimeout(600);
	h.check(
		!!sceneA.item?.hash && !!sceneB.item?.hash && sceneA.item.hash !== sceneB.item.hash,
		'premise: two scene assets, each holding a different box'
	);
	h.check(
		(await worldUuids(A)).includes(sceneB.uuid) && !(await worldUuids(A)).includes(sceneA.uuid),
		'premise: the world is scene B'
	);
	// a save WRITES currentLevel, and 21-G9 resets the flag there by construction
	h.check((await dirtyOf(A)) === false, 'premise: a scene just saved is CLEAN');

	await clearToasts(A);
	const cardA = A.page.locator('.explorer-card[title="Opened A.tpscene"]');
	h.check((await cardA.count()) === 1, 'premise: scene A has a card in the grid');
	await cardA.dblclick();
	await h.eventually(
		() => worldUuids(A),
		(u) => u.includes(sceneA.uuid) && !u.includes(sceneB.uuid),
		'a double-click on a CLEAN scene loads it — the world really changed'
	);
	h.check(
		(await dialogOf(A)) === null,
		'…with no dialog at all: there was nothing to lose, so nothing was asked'
	);
	const atA = await currentLevelOf(A);
	h.check(
		atA?.hash === sceneA.item.hash && atA?.name === 'Opened A',
		`and the app knows where it is (${atA?.name} / ${String(atA?.hash).slice(0, 12)})`
	);

	// =====================================================================
	// 7. THE UNSAVED-CHANGES GUARD, IN ALL THREE DIRECTIONS
	// =====================================================================
	// Opening a scene REPLACES the world, so it is the one card action in this grid that
	// can destroy work. The flag it reads is 21-G9's throttled `sceneDirty`, driven here
	// the way a user drives it — by editing and waiting — rather than by poking the store.
	const [strayBox] = await makeBoxes(A, 1);
	await h.eventually(
		() => dirtyOf(A),
		(d) => d === true,
		'editing the open scene marks it dirty (the real throttled signal, not a poke)',
		12000
	);

	// --- direction 1: CANCEL leaves the world exactly as it was ---
	const beforeCancel = await worldUuids(A);
	const cardB = A.page.locator('.explorer-card[title="Opened B.tpscene"]');
	await cardB.dblclick();
	await waitForDialog(A, 'Opened B');
	const dialog = await dialogOf(A);
	h.check(
		(dialog?.title ?? '').includes('Opened B.tpscene') &&
			/unsaved changes/i.test(dialog?.message ?? '') &&
			(dialog?.message ?? '').includes('Opened A'),
		`it names the scene being opened AND the one at risk ("${dialog?.title}" / "${dialog?.message}")`
	);
	h.check(
		JSON.stringify(dialog?.choices) === JSON.stringify(['Save and open', 'Open anyway']) &&
			dialog?.cancel === 'Cancel',
		`it is the DCC three-way, not a yes/no (${JSON.stringify(dialog?.choices)} + ${dialog?.cancel})`
	);
	await answerDialog(A, false);
	await A.page.waitForTimeout(1200);
	h.check(
		JSON.stringify(await worldUuids(A)) === JSON.stringify(beforeCancel) &&
			(await worldUuids(A)).includes(strayBox),
		'CANCEL loads nothing — the edited world is untouched, stray box and all'
	);
	h.check(
		(await currentLevelOf(A))?.hash === sceneA.item.hash,
		'…and the app still says it is standing in scene A'
	);

	// --- direction 2: OPEN WITHOUT SAVING really opens ---
	await cardB.dblclick();
	await waitForDialog(A, 'Opened B');
	await answerDialog(A, 'open');
	await h.eventually(
		() => worldUuids(A),
		(u) => u.includes(sceneB.uuid) && !u.includes(strayBox),
		'"Open anyway" loads the scene and the unsaved edit leaves the viewport'
	);
	h.check(
		(await currentLevelOf(A))?.name === 'Opened B',
		'and the app moves with it'
	);
	// THE BUG THIS SECTION FOUND, kept as its guard. `currentLevel.name` is the key
	// travel-away publishes under, and the card's name carries the `.tpscene`
	// extension — handing THAT over filed a second scene per open, so every open
	// minted a duplicate card and split the history in two.
	const sceneKeys = Object.keys((await manifestOf(A)).scenes);
	h.check(
		!sceneKeys.some((n) => /\.tpscene$/i.test(n)),
		`opening a scene files it under its SCENE name, never its file name (${JSON.stringify(sceneKeys)})`
	);
	h.check(
		(await A.page.locator('.explorer-card[title="Opened B.tpscene"]').count()) === 1,
		'…so opening it leaves ONE card for it, not a second one per visit'
	);

	// --- direction 3: SAVE AND OPEN keeps the departing scene ---
	const [keptBox] = await makeBoxes(A, 1);
	await h.eventually(() => dirtyOf(A), (d) => d === true, 'scene B is dirty again', 12000);
	const historyBefore = (await manifestOf(A)).scenes['Opened B'].history.length;
	await clearToasts(A);
	await cardA.dblclick();
	await waitForDialog(A, 'Opened A');
	await answerDialog(A, 'save');
	await h.eventually(
		() => worldUuids(A),
		(u) => u.includes(sceneA.uuid) && !u.includes(keptBox),
		'"Save and open" opens the other scene too'
	);
	const historyAfter = (await manifestOf(A)).scenes['Opened B'].history.length;
	h.check(
		historyAfter === historyBefore + 1,
		`…having first written a new version of the scene it LEFT (${historyBefore} -> ${historyAfter} in its history)`
	);
	// and that version is the edited one — the point of saving at all
	const savedBack = await A.page.evaluate(async () => {
		const s = window.__stores;
		let m;
		s.projectManifest.projectManifest.subscribe((v) => (m = v))();
		const entry = m.scenes['Opened B'];
		const hash = entry.history[entry.history.length - 1];
		const item = s.explorer.itemByHash(hash);
		if (!item) return null;
		const blob = await s.explorer.itemBlob(item.id);
		const payload = await s.sessions.readSessionZip(await blob.arrayBuffer());
		return payload?.count ?? null;
	});
	h.check(
		savedBack !== null && savedBack >= 2,
		`the saved version really carries the edit (${savedBack} objects in the new .tpscene)`
	);

	// =====================================================================
	// 8. DOUBLE-CLICKING THE SCENE YOU ARE ALREADY IN
	// =====================================================================
	// Re-applying the file over your own edits is not what a double-click means, and it
	// is the one "open" that can ONLY lose work — so it is a cheap no-op with a word.
	const before = await worldUuids(A);
	await clearToasts(A);
	await cardA.dblclick();
	await h.eventually(
		() => toastsOf(A),
		(t) => t.some((x) => /already in/i.test(x)),
		'double-clicking the open scene says so instead of reloading it'
	);
	h.check(
		JSON.stringify(await worldUuids(A)) === JSON.stringify(before),
		'and nothing at all was loaded'
	);
	h.check((await dialogOf(A)) === null, 'no dialog either — there is nothing to decide');

	// =====================================================================
	// 9. THE EXPORT ENTRIES ARE CONTEXT-SENSITIVE
	// =====================================================================
	// 21-I4 locked answer 3. A background menu means WHERE YOU ARE: the project at the
	// library root, that folder inside one. Offering "Export project" from inside a
	// folder hands the user a file of everything they are NOT looking at.
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(500);
	h.check(await gridBackgroundMenu(A), 'premise: the ROOT grid background opens its menu');
	const rootRows = await menuRows(A);
	h.check(
		rootRows.some((r) => r.startsWith('New folder')),
		'premise: it really is the background menu and not a card menu'
	);
	h.check(
		rootRows.some((r) => r.startsWith('Export project (.tp)')),
		`the ROOT background offers the project export (${JSON.stringify(rootRows)})`
	);
	h.check(
		!rootRows.some((r) => r.startsWith('Export folder')),
		'and not a folder export — there is no folder here'
	);
	await closeMenu(A);

	const protoId = await folderIdNamed(A, 'Prototypes');
	await A.page.evaluate((id) => window.__stores.explorer.activeFolder.set(id), protoId);
	await A.page.waitForTimeout(500);
	h.check(await gridBackgroundMenu(A), 'premise: the background menu opens inside a folder too');
	const insideRows = await menuRows(A);
	h.check(
		insideRows.some((r) => r.startsWith('Export folder as .tp')),
		`inside a folder the background offers the FOLDER export (${JSON.stringify(insideRows)})`
	);
	h.check(
		!insideRows.some((r) => r.startsWith('Export project (.tp)')),
		'and the project export is gone from it'
	);
	await closeMenu(A);
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(400);

	// the folder's OWN menu — the primary surface, and the one locked answer 3 names
	const protoRow = A.page.locator('#explorer-tree button', { hasText: 'Prototypes' }).first();
	await protoRow.click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const folderRows = await menuRows(A);
	h.check(
		folderRows.some((r) => r.startsWith('Export folder as .tp')),
		`a folder's own menu offers it (${JSON.stringify(folderRows)})`
	);
	await closeMenu(A);

	// and it belongs to FOLDERS: a file card's menu has neither export
	await A.page.locator('.explorer-card[title="note.txt"]').click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const fileRows = await menuRows(A);
	h.check(
		!fileRows.some((r) => /^Export (folder|project)/.test(r)),
		`an item's menu carries neither export (${JSON.stringify(fileRows)})`
	);
	await closeMenu(A);

	// =====================================================================
	// 10. THE FOLDER EXPORT, ASSERTED ON THE REAL DOWNLOADED BYTES
	// =====================================================================
	// THE DECISION this section exists to hold: a .tp's manifest may only claim scenes
	// the file CARRIES. A folder export that shipped the whole project's manifest would
	// open on the other machine as a project full of dead pointers — the rule
	// projectFile.js's own header states, and the one thing about this feature that
	// cannot be seen by looking at the Explorer afterwards.
	const act = await A.page.evaluate(() => {
		const s = window.__stores;
		const folder = s.explorer.createFolder('Act 1', null);
		const props = s.explorer.createFolder('Props', folder.id);
		return { folder: folder.id, props: props.id };
	});
	// a scene INSIDE it, and a plain file inside its SUBFOLDER (the subtree, not one level)
	const inside = await A.page.evaluate(
		(id) => window.__stores.levels.saveSceneAsLevel('Act One', id),
		act.folder
	);
	const propHash = await A.page.evaluate(async (id) => {
		const bytes = new TextEncoder().encode('a prop that lives two levels down');
		const item = await window.__stores.explorer.addItemFromBytes(bytes.buffer, 'prop.txt', id);
		return item?.hash ?? null;
	}, act.props);
	await A.page.waitForTimeout(600);
	h.check(!!inside?.hash && !!propHash, 'premise: a folder with a scene and a subfolder file');

	// the COUNTERFACTUAL, computed in-test: the same export unscoped. Without it, every
	// number below is consistent with the folder id having been ignored entirely.
	const both = await A.page.evaluate(async (folderId) => {
		const s = window.__stores;
		const whole = await s.projectFile.exportProject();
		const part = await s.projectFile.exportProject({ folderId });
		return {
			whole: { scenes: whole.scenes, items: whole.items, folder: whole.folder },
			part: { scenes: part.scenes, items: part.items, folder: part.folder, omitted: part.omittedScenes }
		};
	}, act.folder);
	h.check(
		both.part.items < both.whole.items && both.part.scenes < both.whole.scenes,
		`the scoped export is a SLICE of the whole one (${JSON.stringify(both.part)} vs ${JSON.stringify(both.whole)})`
	);
	h.check(
		both.whole.folder === null && both.part.folder === 'Act 1',
		'…and it knows which folder it is'
	);
	h.check(both.part.omitted > 0, `it counts what it left behind (${both.part.omitted} project scenes)`);

	// now the real thing, through the real menu, and read as BYTES
	await clearToasts(A);
	const actRow = A.page.locator('#explorer-tree button', { hasText: 'Act 1' }).first();
	await actRow.click({ button: 'right' });
	await A.page.waitForTimeout(300);
	const [tp] = await Promise.all([
		A.page.waitForEvent('download', { timeout: 25000 }),
		A.page.getByText('Export folder as .tp', { exact: false }).click()
	]);
	h.check(
		tp.suggestedFilename() === 'Act 1.tp',
		`the file is named after the FOLDER, which is now the project (${tp.suggestedFilename()})`
	);
	const zipBytes = fs.readFileSync(await tp.path());
	const entries = unzipSync(new Uint8Array(zipBytes));
	const doc = JSON.parse(strFromU8(entries['project.json']));
	h.check(!!doc && doc.format === 2, `it is a real .tp (format ${doc?.format})`);
	h.check(doc.name === 'Act 1', `the project is named after the folder ("${doc.name}")`);

	// THE COHERENCE INVARIANT
	const claimed = Object.keys(doc.manifest.scenes);
	h.check(
		JSON.stringify(claimed) === JSON.stringify(['Act One']),
		`the manifest claims ONLY the scene inside the folder (${JSON.stringify(claimed)})`
	);
	const carriedHashes = new Set((doc.scenes ?? []).map((s) => s.hash));
	const dead = claimed.filter((name) => {
		const history = doc.manifest.scenes[name].history;
		return !carriedHashes.has(history[history.length - 1]);
	});
	h.check(
		dead.length === 0,
		`every scene the manifest claims has its POINTER version in the file — no dead pointers (${JSON.stringify(dead)})`
	);
	h.check(
		(doc.scenes ?? []).every((s) => !!entries[s.file]),
		'and every scene row it lists really is a zip entry'
	);
	h.check(
		doc.skipped?.omittedScenes > 0,
		`the file itself records that it is a slice (skipped.omittedScenes = ${doc.skipped?.omittedScenes})`
	);

	// the Explorer half: the subtree, RE-ROOTED
	const itemNames = (doc.items ?? []).map((i) => i.name);
	h.check(
		itemNames.includes('Act One.tpscene') && itemNames.includes('prop.txt'),
		`it carries the folder's own files and its subfolder's (${JSON.stringify(itemNames)})`
	);
	h.check(
		!itemNames.includes('note.txt') && !itemNames.includes('Alpha.tpscene') &&
			!itemNames.includes('Opened A.tpscene'),
		'and nothing from outside the folder'
	);
	const folderRowNames = (doc.folders ?? []).map((f) => f.name);
	h.check(
		JSON.stringify(folderRowNames) === JSON.stringify(['Props']),
		`the exported folder is the ROOT — it is not a row, its child is (${JSON.stringify(folderRowNames)})`
	);
	const propsRow = (doc.folders ?? []).find((f) => f.name === 'Props');
	h.check(propsRow?.parentId === null, 'the child folder re-parents to the new root');
	h.check(
		(doc.items ?? []).find((i) => i.name === 'Act One.tpscene')?.folderId === null,
		'a file that sat directly in the folder lands at the new root too'
	);
	h.check(
		(doc.items ?? []).find((i) => i.name === 'prop.txt')?.folderId === propsRow?.id,
		'…while one in the subfolder keeps its place under it'
	);

	// the BYTES really travelled — fflate hands out VIEWS into one buffer, so a hash
	// taken without the byteOffset slice is a hash of the whole zip's tail
	const propRow = (doc.items ?? []).find((i) => i.name === 'prop.txt');
	const view = entries[propRow.file];
	const propSha = crypto
		.createHash('sha256')
		.update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
		.digest('hex');
	h.check(
		propSha === propHash,
		`the carried bytes hash to the item's own content hash (${propSha.slice(0, 12)} vs ${String(propHash).slice(0, 12)})`
	);

	// and the toast tells the truth about both halves
	await h.eventually(
		() => toastsOf(A),
		(list) => list.some((t) => /Folder exported: Act 1/.test(t) && /outside this folder/.test(t)),
		'the toast names the folder AND what it left out'
	);

	// an EMPTY folder refuses rather than writing a zip of nothing
	await clearToasts(A);
	const emptyId = await A.page.evaluate(
		() => window.__stores.explorer.createFolder('Nothing here', null)?.id ?? null
	);
	const refused = await A.page.evaluate(
		(id) => window.__stores.projectFile.downloadProject({ folderId: id }),
		emptyId
	);
	h.check(refused === null, 'exporting an empty folder refuses');
	await h.eventually(
		() => toastsOf(A),
		(list) => list.some((t) => /is empty/i.test(t)),
		'and says why'
	);

	// =====================================================================
	// 11. THE OBJECT MENU HAS NO GAME SUBMENU
	// =====================================================================
	const [box] = await makeBoxes(A, 1);
	const objectMenu = await A.page.evaluate((id) => {
		const items = window.__stores.objectMenu.buildObjectMenuItems(id);
		const labels = [];
		const walk = (list, path) => {
			for (const item of list ?? []) {
				if (!item || item.section || item.header) continue;
				if (item.children) walk(item.children, [...path, item.label]);
				else labels.push([...path, item.label].join(' > '));
			}
		};
		walk(items, []);
		return { top: items.map((i) => i.label).filter(Boolean), leaves: labels };
	}, box);
	h.check(
		!objectMenu.top.includes('Game'),
		`the object context menu has no Game submenu (${JSON.stringify(objectMenu.top)})`
	);
	h.check(
		!objectMenu.leaves.some((l) => /collectible/i.test(l)),
		'and no collectible entry survives anywhere inside it'
	);
	h.check(
		objectMenu.leaves.some((l) => l === 'Save as prefab') && objectMenu.leaves.some((l) => l.startsWith('Delete')),
		'while the rest of the menu is intact (the removal took exactly one submenu)'
	);

	// =====================================================================
	// 7. THE RECIPE HAS LEFT CORE ALTOGETHER
	// =====================================================================
	// 21-G1 moved it from the object menu into the node editor's Game category; 21-G R3a
	// moved it out of core, into the collectible MODULE, which offers it from its own
	// manager toolbox. So this section keeps the two facts that are still core's: the
	// module is not here (nothing of the recipe is), and the node editor's pane menu — the
	// place 21-G1 put it — carries no collectible entry either. The module's own suite owns
	// the entry, the dialog and the chain it builds.
	h.check(
		await A.page.evaluate(() => !window.__stores.gameRecipes),
		'core exposes no recipe at all — the entry lives in the collectible module\'s manager toolbox now'
	);

	await A.page.evaluate((id) => window.__stores.objectActions.applySelectionSet([id]), box);
	await A.page.waitForTimeout(300);

	// the pane menu is still reached the way a user reaches it. The Explorer is the
	// dock's EXCLUSIVE panel — opening the flow editor without closing it leaves the pane
	// mounted but hidden, which reads as "the pane is not visible" rather than as a bug.
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.explorerClose.set(true);
		s.flowGraphClose.set(false);
		s.bottomDock.activateDock('flow');
		s.setActiveGraph(s.SCENE_GRAPH);
	});
	const pane = A.page.locator('.svelte-flow__pane');
	await pane.waitFor({ state: 'visible', timeout: 15000 });
	await A.page.waitForTimeout(600);
	// THE REACHABILITY TRAP this section exists to pin, and the one piece of 21-G1 that is
	// still core's: the editor's scope FOLLOWS the selection, so having an object selected
	// puts the editor on THAT object's (empty) flow, whose explanation overlay covers the
	// pane. Until 21-G1 forwarded the right-click, the pane menu was unreachable there —
	// which is now what a module's own entry depends on too.
	const overlay = A.page.locator('#flow-empty-state');
	const covered = (await overlay.count()) === 1;
	h.check(covered, 'premise: a selected object scopes the editor to its EMPTY flow, covering the pane');
	await (covered ? overlay : pane).click({ button: 'right', position: { x: 380, y: 100 } });
	await A.page.waitForTimeout(350);
	h.check(
		await A.page.locator('[role="menu"]').first().isVisible(),
		'the pane menu opens THROUGH that overlay — an explanation is not a modal'
	);
	// the counterfactual of the check this used to be: the shared filter flattens every
	// leaf, so a search across the WHOLE menu is the strongest way to say the recipe is not
	// in it any more — and searching for the word the user would type is the same reading
	// the positive check made.
	await A.page.locator('.ctx-filter-input').fill('collectible');
	await A.page.waitForTimeout(300);
	const matches = await A.page.evaluate(() =>
		[...document.querySelectorAll('.ctx-match')].map((m) => m.textContent?.trim())
	);
	h.check(
		!matches.some((m) => /collectible/i.test(m ?? '')),
		`and no collectible entry anywhere in the node editor's own menu (${matches.length} matches: ${JSON.stringify(matches.slice(0, 3))})`
	);
	// the search itself still works — otherwise the check above would pass on a broken
	// filter rather than on an absent entry
	await A.page.locator('.ctx-filter-input').fill('latch');
	await A.page.waitForTimeout(300);
	const latchMatches = await A.page.evaluate(() =>
		[...document.querySelectorAll('.ctx-match')].map((m) => m.textContent?.trim())
	);
	h.check(
		latchMatches.some((m) => /latch/i.test(m ?? '')),
		`premise: the same filter DOES find the chain primitives, which stayed in core (${JSON.stringify(latchMatches.slice(0, 3))})`
	);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(250);

	const errs = await h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs.slice(0, 2))})`);
	await h.finish(browser);
});
