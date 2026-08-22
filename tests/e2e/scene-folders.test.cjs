// 21-G1 — SCENES, NOT LEVELS; DOWNLOAD; PACK RENAME; RECIPE RE-HOMING.
//
// Four changes, each with the thing that would have caught its bug:
//
//   `Scenes` not `Levels`      the folder a save lands in is renamed AND demoted:
//                              discovery is BY KIND now, so `levelItems()` finds a
//                              .tpscene wherever it lives and stops offering a PNG
//                              that happens to sit in the scenes folder. Sections 1-3.
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

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.levels, { timeout: 30000 });

	// =====================================================================
	// 1. THE GRID MENU SAYS "SCENE", AND A SAVE LANDS IN `Scenes`
	// =====================================================================
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

	A.page.once('dialog', (d) => d.accept('Alpha'));
	await A.page.getByText('Save scene…', { exact: false }).click();
	await h.eventually(
		() => folderNames(A),
		(names) => names.includes('Scenes'),
		'the first save premakes the `Scenes` folder'
	);
	h.check(!(await folderNames(A)).includes('Levels'), 'and nothing is called Levels any more');
	await h.eventually(
		() => travelChoices(A),
		(list) => list.includes('Alpha.tpscene'),
		'the saved scene is on offer to a Travel node'
	);

	// =====================================================================
	// 2. DISCOVERY IS BY KIND — the folder is a place, not a registry
	// =====================================================================
	// a second scene, then DRAGGED somewhere else entirely
	const beta = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Beta'));
	const elsewhere = await A.page.evaluate(() => {
		const s = window.__stores;
		const folder = s.explorer.createFolder('Prototypes', null);
		return folder?.id ?? null;
	});
	await A.page.evaluate(
		({ id, folderId }) => window.__stores.explorer.moveItem(id, folderId),
		{ id: beta.id, folderId: elsewhere }
	);
	await A.page.waitForTimeout(400);
	h.check(
		(await travelChoices(A)).includes('Beta.tpscene'),
		'a .tpscene moved OUT of Scenes is still discoverable — the folder filter is gone'
	);

	// the counterfactual for the same change, in the other direction: the OLD rule
	// counted anything sitting in the folder, so a texture dropped there was offered as
	// a travel destination. Kind-based discovery cannot make that mistake.
	const scenesId = await folderIdNamed(A, 'Scenes');
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
		(await travelChoices(A)).includes('Alpha.tpscene'),
		'and every scene it holds is STILL discoverable under the new name'
	);

	// delete it: the cascade takes its contents with it (ordinary folder semantics —
	// Alpha lived there), and the scene stored elsewhere is untouched
	await A.page.evaluate(({ id }) => window.__stores.explorer.deleteFolder(id), { id: scenesId });
	await A.page.waitForTimeout(500);
	const afterDelete = await travelChoices(A);
	h.check(!afterDelete.includes('Alpha.tpscene'), 'deleting the folder deletes the scenes inside it');
	h.check(
		afterDelete.includes('Beta.tpscene'),
		`a scene living elsewhere survives the folder's deletion (${JSON.stringify(afterDelete)})`
	);
	const remade = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Gamma'));
	h.check(!!remade?.hash, 'a save after the delete still works');
	h.check((await folderNames(A)).includes('Scenes'), 'and premakes `Scenes` again');

	// =====================================================================
	// 4. DOWNLOAD: the bytes that come out are the bytes that went in
	// =====================================================================
	const gammaFolder = await folderIdNamed(A, 'Scenes');
	await A.page.evaluate((id) => window.__stores.explorer.activeFolder.set(id), gammaFolder);
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
	await A.page.evaluate(async (folderId) => {
		const bytes = new TextEncoder().encode('hello from the library');
		await window.__stores.explorer.addItemFromBytes(bytes.buffer, 'note.txt', folderId);
	}, gammaFolder);
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
	// 6. THE OBJECT MENU HAS NO GAME SUBMENU
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
	// 7. THE RECIPE LIVES IN THE NODE EDITOR'S GAME CATEGORY
	// =====================================================================
	// with NOTHING selected it is offered and REFUSED, with the reason on the row
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(300);
	const empty = await A.page.evaluate(() => window.__stores.gameRecipes.recipeMenuItems());
	const emptyEntry = empty.find((i) => i.label);
	h.check(
		empty.some((i) => i.section === 'Recipes'),
		'the entry sits under its own Recipes section, apart from the node rows'
	);
	h.check(
		emptyEntry?.disabled === true && /select/i.test(emptyEntry?.tooltip ?? ''),
		`with no selection it is disabled WITH the reason ("${emptyEntry?.tooltip?.slice(0, 40)}…")`
	);

	// it reads the SELECTION SET, not the sticky primary — deselect leaves `selectedObject`
	// pointing at the last box, and the entry must still refuse
	h.check(
		await A.page.evaluate(() => {
			let sticky;
			window.__stores.selectedObject.subscribe((v) => (sticky = v))();
			return !!sticky?.uuid;
		}),
		'premise: the sticky selectedObject still holds the deselected box (the trap this avoids)'
	);

	await A.page.evaluate((id) => window.__stores.objectActions.applySelectionSet([id]), box);
	await A.page.waitForTimeout(300);
	const armed = await A.page.evaluate(() => window.__stores.gameRecipes.recipeMenuItems());
	h.check(
		armed.find((i) => i.label)?.disabled === false,
		'selecting an object arms it'
	);

	// now drive it through the REAL menu, the way a user reaches it. The Explorer is the
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
	// THE REACHABILITY TRAP this section exists to pin: the editor's scope FOLLOWS the
	// selection, so having an object selected — the very state the recipe acts on — puts
	// the editor on THAT object's (empty) flow, whose explanation overlay covers the
	// pane. Until 21-G1 forwarded the right-click, the entry was unreachable in the only
	// state where it is enabled.
	const overlay = A.page.locator('#flow-empty-state');
	const covered = (await overlay.count()) === 1;
	h.check(covered, 'premise: a selected object scopes the editor to its EMPTY flow, covering the pane');
	await (covered ? overlay : pane).click({ button: 'right', position: { x: 380, y: 100 } });
	await A.page.waitForTimeout(350);
	h.check(
		await A.page.locator('[role="menu"]').first().isVisible(),
		'the pane menu opens THROUGH that overlay — an explanation is not a modal'
	);
	// the shared filter flattens every leaf as "Group ▸ Label", which also proves the
	// entry is INSIDE the Game category rather than loose at the top level
	await A.page.locator('.ctx-filter-input').fill('make selected');
	await A.page.waitForTimeout(300);
	const matches = await A.page.evaluate(() =>
		[...document.querySelectorAll('.ctx-match')].map((m) => m.textContent?.trim())
	);
	h.check(
		matches.some((m) => m.includes('Game') && m.includes('Make selected collectible')),
		`the node editor's Game category carries the recipe (${JSON.stringify(matches.slice(0, 3))})`
	);
	await A.page.locator('.ctx-match', { hasText: 'Make selected collectible' }).first().click();

	await A.page.waitForSelector('#collectible-variable', { timeout: 8000 });
	h.check(true, 'clicking it opens the recipe dialog');
	await A.page.fill('#collectible-variable', 'shards');
	await A.page.click('#collectible-create');
	await A.page.waitForTimeout(1000);

	const chain = await A.page.evaluate((id) => {
		let g;
		window.__stores.flowGraphs.subscribe((v) => (g = v))();
		const nodes = g.scene?.nodes ?? [];
		const edges = g.scene?.edges ?? [];
		const sel = nodes.find((n) => n.type === 'objectselector' && n.data?.selected === id);
		if (!sel) return null;
		const back = (targetId, handle) => {
			const e = edges.find((x) => x.target === targetId && (handle === undefined || (x.targetHandle ?? null) === handle));
			return e ? nodes.find((n) => n.id === e.source) : null;
		};
		const vis = back(sel.id, null);
		const gate = back(vis?.id, 'on');
		const latch = back(gate?.id, 'a');
		const click = back(latch?.id, 'set');
		const counter = nodes.find((n) => n.type === 'setvariable');
		return {
			vis: vis?.type ?? null,
			whilePlaying: vis?.data?.whilePlaying ?? null,
			latch: latch?.type ?? null,
			perRound: latch?.data?.perRound ?? null,
			click: click?.type ?? null,
			variable: counter?.data?.name ?? null
		};
	}, box);
	h.check(
		chain?.click === 'onclick' && chain?.latch === 'latch' && chain?.vis === 'visibility',
		`the recipe built the same chain from its new home (${JSON.stringify(chain)})`
	);
	h.check(chain?.variable === 'shards', `into the variable the dialog asked for ("${chain?.variable}")`);
	h.check(
		chain?.perRound === true && chain?.whilePlaying === true,
		'with 21-F2\'s two opt-in flags still stamped on it'
	);

	const errs = await h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs.slice(0, 2))})`);
	await h.finish(browser);
});
