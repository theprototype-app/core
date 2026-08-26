// R22 ROUND 11, PHASE 5 — SESSIONS AND PACKS.
//
//   "for sessions instead of 'import objects' should be 'import files' and within files
//    which are scenes I should be able to import objects from there"
//   "would be nice to be able to see thumbnails from project files"
//   "organize items better in grid view there and allow list view as well (details with
//    buttons for each row)"
//   "When saving current scene also make a thumbnail of it"
//   "for packs add right click create pack, so I can set name and create items there, by
//    dragging from explorer folders or multiple items"
//
// THE THUMBNAIL FINDING, recorded because it corrects the brief: session saves were NOT
// producing null. Measured through the real UI on this branch before any change — a scene
// holding one box saved a 1567-byte webp, for both the scene save and the project save,
// and both cards rendered an <img>. So the mechanism worked; what was worth fixing is that
// its two failure modes are both SILENT. §1 pins the new primary path (the live viewport,
// no second WebGL context and no ObjectLoader round trip) and the fallback behind it.
//
// Run: APP_URL='https://localhost:5203/' npm run e2e -- sessions-packs
const h = require('./helpers.cjs');

const metas = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.sessions.sessions.subscribe((x) => (v = x))();
		return (v ?? []).map((m) => ({
			id: m.id,
			name: m.name,
			thumb: m.thumbnail ? m.thumbnail.length : 0,
			count: m.count,
			lib: m.hasLibrary,
			files: m.libraryCount
		}));
	});

/** the library's items, by name — round 12's file import lands here */
const itemList = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return (v ?? []).map((i) => ({ id: i.id, name: i.name, kind: i.kind, folderId: i.folderId }));
	});

const packList = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.packs.packs.subscribe((x) => (v = x))();
		return (v ?? []).map((x) => ({ name: x.name, title: x.title, source: x.source, items: (x.items ?? []).length }));
	});

const openSessions = async (p) => {
	await p.page.evaluate(() => window.__stores.sessionsOpen.set(true));
	await p.page.waitForTimeout(1000);
};

const PNG = [
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0,
	0, 253, 212, 154, 115, 0, 0, 0, 22, 73, 68, 65, 84, 120, 156, 99, 252, 207, 192, 240, 159, 129,
	129, 129, 137, 129, 129, 1, 0, 39, 226, 4, 253, 55, 194, 200, 216, 0, 0, 0, 0, 73, 69, 78, 68,
	174, 66, 96, 130
];

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.sessions && !!window.__stores?.packs, null, {
		timeout: 30000
	});
	await page.evaluate(async () => {
		await window.__stores.explorer.loadExplorer();
		await window.__stores.explorer.clearLibrary();
		await window.__stores.packs.loadPacks();
	});
	await page.waitForTimeout(600);

	// a scene worth picturing, and two library files worth saving with it
	await page.evaluate(
		async ({ png }) => {
			const s = window.__stores;
			s.commandsHandler.sceneCommand('/create box');
			await new Promise((r) => setTimeout(r, 1200));
			s.objectActions.deselectObject();
			const e = s.explorer;
			const folder = e.createFolder('Pack source', null);
			await e.addItemFromBytes(new Uint8Array(png).buffer, 'brick.png', folder.id);
			await e.addItemFromBytes(new Uint8Array([...png.slice(0, -4), 9, 9, 9, 9]).buffer, 'moss.png', folder.id);
			await e.addItemFromBytes(new TextEncoder().encode('notes').buffer, 'loose.txt', null);
			// R22 round 12: a NESTED pair, so the picker's folder structure has more than one
			// level to draw. Different bytes per file — the library is content-hash addressed
			// and two identical fixtures are ONE item (the round-11 trap).
			const tex = e.createFolder('Textures', null);
			const bricks = e.createFolder('Bricks', tex.id);
			await e.addItemFromBytes(new Uint8Array([...png.slice(0, -4), 1, 1, 1, 1]).buffer, 'wall.png', bricks.id);
			await e.addItemFromBytes(new Uint8Array([...png.slice(0, -4), 2, 2, 2, 2]).buffer, 'floor.png', tex.id);
			return folder.id;
		},
		{ png: PNG }
	);
	await page.waitForTimeout(900);

	// ---- 1. THE THUMBNAIL, and where it comes from -----------------------------------
	const shot = await page.evaluate(() => {
		const payload = window.__stores.sessions.buildSessionPayload('probe');
		return { has: !!payload.thumbnail, len: payload.thumbnail?.length ?? 0, head: (payload.thumbnail ?? '').slice(0, 22) };
	});
	h.check(shot.has && shot.len > 200, `a saved payload carries a picture (${shot.len} bytes)`);
	h.check(/^data:image\//.test(shot.head), `…as a real image dataURL (${shot.head})`);

	// THE POINT of the new primary path: it needs no SECOND WebGL context and does no
	// ObjectLoader round trip, so a geometry the loader cannot rebuild cannot take it out.
	// A WireframeGeometry is the documented one — the old offscreen ritual THROWS on it.
	const survives = await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const mesh = new THREE.LineSegments(
			new THREE.WireframeGeometry(new THREE.BoxGeometry(1, 1, 1)),
			new THREE.LineBasicMaterial()
		);
		mesh.name = 'wire-trap';
		g.add(mesh);
		s.objectsGroup.update((v) => v);
		let offscreenThrew = false;
		try {
			new THREE.ObjectLoader().parse(g.toJSON());
		} catch {
			offscreenThrew = true;
		}
		const payload = s.sessions.buildSessionPayload('with-a-wireframe');
		const out = { offscreenThrew, thumb: payload.thumbnail?.length ?? 0 };
		g.remove(mesh);
		s.objectsGroup.update((v) => v);
		return out;
	});
	h.check(
		survives.offscreenThrew,
		'premise: the OLD offscreen ritual really cannot rebuild a WireframeGeometry — this is not a hypothetical'
	);
	h.check(
		survives.thumb > 200,
		`…and the picture survives it now, because the live viewport is read instead (${survives.thumb} bytes)`
	);

	// ---- 2. both SAVE buttons, through the real UI -----------------------------------
	await openSessions(A);
	await page.locator('#session-save').click();
	await page.waitForTimeout(300);
	await page.locator('#session-save-confirm').click();
	await h.eventually(() => metas(A), (l) => l.length === 1, 'the scene save lands');
	await page.locator('#session-save-project').click();
	await page.waitForTimeout(300);
	await page.locator('#session-save-confirm').click();
	await h.eventually(() => metas(A), (l) => l.length === 2, 'the project save lands', 20000);
	const saved = await metas(A);
	h.check(
		saved.every((m) => m.thumb > 200),
		`BOTH saves carry a thumbnail (${saved.map((m) => m.thumb).join(', ')})`
	);
	const cardImgs = await page.evaluate(
		() => [...document.querySelectorAll('.session-card img')].length
	);
	h.check(cardImgs === 2, `…and both cards render it rather than the archive icon (${cardImgs} images)`);
	const project = saved.find((m) => m.lib);
	h.check(!!project && project.files === 5, `premise: the project entry carries the library (${project?.files} files)`);

	// ---- 3. "Import files", and the two levels ---------------------------------------
	const label = await page.evaluate(
		() => document.querySelector('.session-import')?.textContent?.trim() ?? ''
	);
	h.check(/Import files/.test(label), `the button says what it does now (${label})`);
	await page.locator('.session-card', { hasText: /Project/ }).locator('.session-import').first().click();
	await page.waitForTimeout(900);
	h.check(await page.locator('#session-file-list').isVisible(), 'it opens a FILE list, not an object list');
	const files = await page.evaluate(() =>
		[...document.querySelectorAll('#session-file-list .session-file')].map((el) => ({
			text: el.textContent.replace(/\s+/g, ' ').trim(),
			kind: el.getAttribute('data-kind'),
			disabled: el.hasAttribute('disabled'),
			img: !!el.querySelector('img')
		}))
	);
	// R22 ROUND 12 RESHAPED THIS LIST, and the change is worth stating: it holds the
	// project's LIBRARY, laid out as its real folder structure, and the entry's OWN scene
	// is no longer a row in it. A library file and the scene the entry IS are different
	// things, so the scene got its own button (#session-open-scene) rather than a row that
	// had to explain itself with a "this entry" badge. Section 8 owns the structure; this
	// keeps round 11's flow honest.
	h.check(files.length === 8, `the project's five files and its three folders (${files.length})`);
	h.check(
		files.filter((f) => f.kind === 'folder').length === 3,
		`…including the folders, which used not to be drawn at all (${files.filter((f) => f.kind === 'folder').length})`
	);
	// THE THUMBNAIL ASK: a project file's own picture, which was simply never copied in
	h.check(
		files.filter((f) => f.img).length >= 2,
		`project files show their thumbnails (${files.filter((f) => f.img).length} of ${files.length} rows)`
	);

	// the entry's OWN scene, through the button that is now its home
	await page.locator('#session-open-scene').click();
	await page.waitForTimeout(900);
	h.check(
		await page.locator('#session-file-back').isVisible(),
		"the entry's own scene drills into its objects, with a way back"
	);
	const objs = await page.evaluate(() => document.querySelectorAll('#session-object-list label').length);
	h.check(objs >= 1, `…and the object checklist is there (${objs})`);
	await page.locator('#session-file-back').click();
	await page.waitForTimeout(400);
	h.check(await page.locator('#session-file-list').isVisible(), '‹ Files goes back up');

	// R22 round 12: the picker is a DIALOG now, so leaving it open shields every later click
	// (the documented trap, which cost this suite a 30s timeout when it was written).
	// Its own Close button, not Escape: stepping back from the object list unmounts the
	// button that had focus, so focus falls to <body> and a keypress reaches no dialog's
	// handler at all. Section 7 tests Escape where focus IS still inside.
	await page.locator('#session-picker').getByRole('button', { name: 'Close' }).click();
	await h.eventually(
		() => page.locator('#session-picker').count(),
		(n) => n === 0,
		'premise: the picker is closed before the next entry is clicked'
	);

	// a SCENE-ONLY entry skips the file level entirely and lands on its objects
	await page.locator('.session-card').filter({ hasNotText: 'Project' }).locator('.session-import').first().click();
	await page.waitForTimeout(900);
	h.check(
		(await page.locator('#session-object-list').count()) === 1,
		'a scene-only entry goes STRAIGHT to its objects — its file level held one row, which is a click that answers nothing'
	);
	h.check(
		(await page.locator('#session-file-list').count()) === 0,
		'…so there is no file list to step back to'
	);

	// and the import really runs — we are ALREADY on the objects, because a scene entry
	// skips the file level (round 12); there is no row to click first any more
	const worldBefore = await page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.length;
	});
	await page.locator('#session-picker label input[type="checkbox"]').first().check();
	await page.waitForTimeout(300);
	await page.locator('#session-import-selected').click();
	await h.eventually(
		() =>
			page.evaluate(() => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				return g.children.length;
			}),
		(n) => n === worldBefore + 1,
		'importing from inside a file adds the object to the scene',
		15000
	);

	// ---- 4. the LIST view ------------------------------------------------------------
	await openSessions(A);
	h.check(await page.locator('#session-view-list').isVisible(), 'the manager offers a Grid/List toggle');
	await page.locator('#session-view-list').click();
	await page.waitForTimeout(500);
	h.check(await page.locator('#session-list').isVisible(), 'List shows rows');
	const rowKit = await page.evaluate(() => {
		const row = document.querySelector('#session-list .session-row');
		if (!row) return null;
		return {
			buttons: [...row.querySelectorAll('button')].map((b) => b.getAttribute('title') || b.textContent.trim()),
			badge: row.querySelector('.session-badge')?.textContent?.trim(),
			size: row.querySelector('.session-size')?.textContent?.trim(),
			height: Math.round(row.getBoundingClientRect().height)
		};
	});
	h.check(
		!!rowKit && rowKit.buttons.length >= 5,
		`every row carries its own buttons, as asked (${JSON.stringify(rowKit?.buttons?.slice(0, 6))})`
	);
	h.check(!!rowKit && !!rowKit.badge && !!rowKit.size, `…and the facts a card spreads over four lines (${rowKit?.badge}, ${rowKit?.size})`);
	h.check(!!rowKit && rowKit.height <= 48, `a row is a ROW (${rowKit?.height}px)`);
	// the two views must offer the SAME actions — a layout is not a different feature set
	const gridActions = await page.evaluate(() => {
		document.querySelector('#session-view-grid').click();
		return new Promise((r) =>
			setTimeout(() => {
				const card = document.querySelector('.session-card');
				r([...card.querySelectorAll('button')].map((b) => (b.getAttribute('title') || b.textContent).trim()));
			}, 400)
		);
	});
	// A SUPERSET, not an equality — and the difference is deliberate: the list exposes
	// rename as a BUTTON where the grid hides it behind a double-click on the name. What
	// matters is that the list cannot LOSE an action by being a different layout.
	const missing = gridActions.filter((t) => !rowKit.buttons.includes(t));
	h.check(
		missing.length === 0,
		`the list offers every action the grid does (${gridActions.length} grid, ${rowKit.buttons.length} row; missing ${JSON.stringify(missing)})`
	);
	// the choice is remembered
	await page.locator('#session-view-list').click();
	await page.waitForTimeout(400);
	h.check(
		(await page.evaluate(() => localStorage.getItem('sessions:view'))) === 'list',
		'the view choice is a LOCAL pref'
	);
	await page.evaluate(() => window.__stores.sessionsOpen.set(false));
	await page.waitForTimeout(500);

	// ---- 5. PACKS: create one, and fill it by drag ------------------------------------
	const pure = await page.evaluate(() => {
		const p = window.__stores.packs;
		const made = p.createPack('My Test Pack');
		const again = p.createPack('My Test Pack');
		return { first: made.name, second: again.name, title: made.title, source: made.source, items: made.items.length };
	});
	h.check(pure.title === 'My Test Pack', `a pack takes the TITLE you type (${pure.title})`);
	h.check(
		pure.first === 'user-my-test-pack' && pure.second === 'user-my-test-pack-2',
		`…while its NAME is a minted identity that cannot collide (${pure.first} / ${pure.second})`
	);
	h.check(pure.source === 'imported' && pure.items === 0, 'it starts empty, on the same shelf as an imported pack');
	await page.evaluate(() => {
		let v;
		window.__stores.packs.packs.subscribe((x) => (v = x))();
		// drop the throwaway second one
		window.__stores.packs.removeImportedPack('user-my-test-pack-2');
	});

	// through the real UI: right-click the Packs grid, Create pack…, type a name
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(800);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('packs'));
	await page.waitForTimeout(600);
	const gridBox = await page.locator('#explorer-grid').boundingBox();
	await page.mouse.click(gridBox.x + gridBox.width - 60, gridBox.y + gridBox.height - 120, { button: 'right' });
	await page.waitForTimeout(500);
	const packMenu = await page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim())
	);
	h.check(
		packMenu.some((t) => /Create pack/.test(t)),
		`the Packs background offers Create pack… (${JSON.stringify(packMenu)})`
	);
	await page.getByRole('menuitem', { name: /Create pack/ }).click();
	await page.waitForTimeout(500);
	const input = page.locator('#explorer-new-card input');
	h.check(await input.isVisible(), 'the name is typed INLINE, never in a browser prompt');
	await input.fill('Bricks');
	await input.press('Enter');
	await h.eventually(
		() => packList(A),
		(list) => list.some((p) => p.title === 'Bricks'),
		'…and the pack is created',
		10000
	);
	const bricks = (await packList(A)).find((p) => p.title === 'Bricks');
	h.check(
		(await page.evaluate(() => {
			let v;
			window.__stores.explorer.activeFolder.subscribe((x) => (v = x))();
			return v;
		})) === 'pack:' + bricks.name,
		'…and opened, so there is somewhere to drop into'
	);

	// fill it by dragging a FOLDER — the user's own phrasing for "not one file at a time"
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(700);
	// The pack ROWS only exist while the Packs tree is expanded, and the double-click that
	// expands it also fires two CLICKS — which navigate into the Packs view, taking the
	// folder card we are about to drag with them. So: expand, then come back.
	await page.locator('#packs-folder').dblclick();
	await page.waitForTimeout(600);
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(700);
	h.check(
		(await page.locator('[data-pack]').count()) > 0,
		'premise: the Packs tree is expanded, so its rows are drop targets'
	);
	const dropped = await page.evaluate((packName) => {
		let folders;
		window.__stores.explorer.explorerFolders.subscribe((v) => (folders = v))();
		const folder = folders.find((f) => f.name === 'Pack source');
		const card = document.querySelector('[data-card-id="' + folder.id + '"]');
		const row = document.querySelector('[data-pack="' + packName + '"]');
		if (!card || !row) return { ok: false, card: !!card, row: !!row };
		const dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
		row.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
		row.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
		return { ok: true };
	}, bricks.name);
	h.check(dropped.ok, `premise: a folder card was dropped on the pack row (${JSON.stringify(dropped)})`);
	await h.eventually(
		() => packList(A),
		(list) => (list.find((p) => p.title === 'Bricks')?.items ?? 0) === 2,
		'a dropped FOLDER adds everything in it — "dragging from explorer folders"',
		10000
	);

	// a second drop of the same files is a no-op rather than two rows for one file
	await page.evaluate((packName) => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		const records = items.filter((i) => /brick|moss/.test(i.name));
		window.__stores.packs.addToPack(packName, records);
	}, bricks.name);
	await page.waitForTimeout(500);
	h.check(
		(await packList(A)).find((p) => p.title === 'Bricks')?.items === 2,
		'…and dropping the same files again changes nothing'
	);

	// a DEFAULT pack refuses — its contents live on a CDN this machine does not own
	const refused = await page.evaluate(() => {
		let v;
		window.__stores.packs.packs.subscribe((x) => (v = x))();
		const def = v.find((p) => p.source === 'default');
		if (!def) return 'no default pack in this build';
		let items;
		window.__stores.explorer.explorerItems.subscribe((x) => (items = x))();
		const before = (def.items ?? []).length;
		return { name: def.name, before, refusedByUi: true };
	});
	h.check(!!refused, `a built-in pack is present to refuse (${JSON.stringify(refused).slice(0, 60)})`);

	// =================================================================================
	// R22 ROUND 12 — the Sessions manager becomes a proper file browser
	// =================================================================================
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await openSessions(A);

	// ---- 7. THE PICKER IS ITS OWN MODAL, and per-kind ---------------------------------
	// "rework on this 'import files'/'import object' dialog, it feels strange when it
	// appears from top" - it grew out of the top of the body and pushed the entries down.
	// "for saved scene ... it should write 'import objects' ... I should open scene
	// automatically" - a scene entry's file level holds one row, which is a click that
	// answers nothing.
	const labels = await page.evaluate(() =>
		[...document.querySelectorAll('.session-card')].map((c) => ({
			project: /Project/.test(c.textContent || ''),
			btn: (c.querySelector('.session-import') || {}).textContent?.trim()
		}))
	);
	h.check(labels.length === 2, 'premise: a scene entry and a project entry (' + labels.length + ')');
	h.check(
		labels.some((l) => !l.project && /Import objects/.test(l.btn || '')),
		'a SCENE entry says Import objects (' + JSON.stringify(labels.map((l) => l.btn)) + ')'
	);
	h.check(
		labels.some((l) => l.project && /Import files/.test(l.btn || '')),
		'...and a PROJECT entry says Import files'
	);

	// a scene entry goes STRAIGHT to its objects
	await page.locator('.session-card').filter({ hasNotText: 'Project' }).locator('.session-import').first().click();
	await page.waitForTimeout(1200);
	h.check(await page.locator('#session-picker').isVisible(), 'the picker opens');
	h.check(
		(await page.locator('#session-object-list').count()) === 1,
		'a scene entry lands on its OBJECTS, skipping a file level with one row in it'
	);
	// it is a real dialog of its own, over the one that opened it - and NON-MODAL, or the
	// top layer would make the chrome above --z-modal inert (the documented rule)
	const modalShape = await page.evaluate(() => {
		const el = document.querySelector('#session-picker')?.closest('dialog');
		return el ? { open: el.hasAttribute('open'), ariaModal: el.getAttribute('aria-modal'), dialogs: document.querySelectorAll('dialog[open]').length } : null;
	});
	h.check(!!modalShape && modalShape.open, 'it is a DIALOG, not a block grown out of the body');
	h.check(
		!!modalShape && modalShape.ariaModal !== 'true',
		'...and NON-MODAL like every other dialog here, so the chrome above --z-modal stays live'
	);
	h.check(!!modalShape && modalShape.dialogs >= 2, 'over the Sessions dialog that opened it');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	h.check((await page.locator('#session-picker').count()) === 0, 'Escape closes it - a non-modal dialog fires no cancel event, so it needs its own handler');

	// ---- 8. THE FOLDER STRUCTURE, and multiselect ------------------------------------
	// "I should be able to multiselect files, or import folders (I do not see folder
	// structure now, but should)". It was always SAVED and never drawn.
	await page.locator('.session-card').filter({ hasText: 'Project' }).locator('.session-import').first().click();
	await page.waitForTimeout(1200);
	const tree = await page.evaluate(() =>
		[...document.querySelectorAll('#session-file-list .session-file')].map((r) => ({
			name: (r.textContent || '').replace(/\s+/g, ' ').trim().split(' ')[0],
			kind: r.getAttribute('data-kind'),
			pad: parseInt(getComputedStyle(r).paddingLeft, 10)
		}))
	);
	h.check(
		tree.filter((r) => r.kind === 'folder').length === 3,
		'the saved FOLDERS are drawn (' + JSON.stringify(tree.map((r) => r.name)) + ')'
	);
	// a STRUCTURE, not a flat list: three distinct depths, and the deepest is two levels in
	const pads = [...new Set(tree.map((r) => r.pad))].sort((a, b) => a - b);
	h.check(
		pads.length >= 3 && pads[2] >= 36,
		'...as a structure, indented by depth (' + JSON.stringify(pads) + ')'
	);

	// ticking a FOLDER takes everything under it, and the checkboxes say so
	// the NESTED one, so "everything under it" means more than its own direct children
	const folderRow = page
		.locator('#session-file-list .session-file[data-kind="folder"]')
		.filter({ hasText: 'Textures' })
		.first();
	await folderRow.locator('input[type="checkbox"]').check();
	await page.waitForTimeout(500);
	const ticked = await page.evaluate(() =>
		[...document.querySelectorAll('#session-file-list .session-file input[type="checkbox"]')].map((c) => c.checked)
	);
	h.check(
		ticked.filter(Boolean).length === 4,
		'ticking a folder ticks its SUBTREE - the child folder and both files, so the boxes agree with the act (' +
			JSON.stringify(ticked) +
			')'
	);
	const btnLabel = await page.locator('#session-import-files').textContent();
	h.check(/2 files/.test(btnLabel || ''), 'and the button counts the FILES it will bring (' + (btnLabel || '').trim() + ')');

	// the import really lands them, with their folder structure, MERGED by path
	await page.evaluate(async () => {
		await window.__stores.explorer.clearLibrary();
	});
	await page.waitForTimeout(600);
	await page.locator('#session-import-files').click();
	await h.eventually(
		() => itemList(A),
		(list) => list.some((i) => i.name === 'wall.png') && list.some((i) => i.name === 'floor.png'),
		'the ticked folder brings its files into the LIBRARY (a different act from importing objects)',
		15000
	);
	const landed = await page.evaluate(() => {
		let items, folders;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		window.__stores.explorer.explorerFolders.subscribe((v) => (folders = v))();
		const byName = (n) => folders.find((f) => f.name === n);
		const tex = byName('Textures');
		const bricks = byName('Bricks');
		return {
			folders: folders.map((f) => f.name).sort(),
			nested: !!tex && !!bricks && bricks.parentId === tex.id,
			wallIn: items.find((i) => i.name === 'wall.png')?.folderId === bricks?.id
		};
	});
	h.check(landed.nested, 'the structure comes with them, not a flat dump (' + JSON.stringify(landed.folders) + ')');
	h.check(landed.wallIn, '...and each file lands in its own folder');

	// ---- 9. LIST AND THUMBNAILS, both multiselect ------------------------------------
	// the import above CLOSED the picker (it is finished with), so open it again
	await h.eventually(
		() => page.locator('#session-picker').count(),
		(n) => n === 0,
		'premise: running the import closes the picker'
	);
	await page.locator('.session-card').filter({ hasText: 'Project' }).locator('.session-import').first().click();
	await page.waitForTimeout(1200);
	await page.locator('#picker-view-grid').click();
	await page.waitForTimeout(500);
	h.check(
		(await page.locator('#session-file-list .picker-card').count()) > 0,
		'the picker has a thumbnail view'
	);
	const cards = page.locator('#session-file-list .picker-card');
	await cards.nth(2).click();
	await cards.nth(3).click();
	await page.waitForTimeout(400);
	const pickedCards = await page.evaluate(() =>
		[...document.querySelectorAll('#session-file-list .picker-card')].filter((c) =>
			(c.getAttribute('class') || '').includes('border-primary-500')
		).length
	);
	h.check(pickedCards >= 2, 'thumbnails multiselect too, as asked (' + pickedCards + ' picked)');
	await page.locator('#picker-view-list').click();
	await page.waitForTimeout(400);
	h.check(
		(await page.evaluate(() => localStorage.getItem('sessions:pickerView'))) === 'list',
		'the picker remembers its own view, separately from the entry list'
	);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);

	// ---- 10. THE DOWNLOAD FORMATS -----------------------------------------------------
	// "instead of .json download allow to download session as .tpscene or .tp"
	const dlRows = await page.evaluate(() =>
		[...document.querySelectorAll('.session-card')][0]
			? [...document.querySelectorAll('.session-card')[0].querySelectorAll('button')].map((b) =>
					(b.textContent || '').trim()
				)
			: []
	);
	h.check(
		dlRows.some((t) => /\.tpscene/.test(t)) && dlRows.some((t) => /\.json/.test(t)),
		'a card offers .tpscene AND keeps .json (' + JSON.stringify(dlRows) + ')'
	);
	h.check(
		!dlRows.some((t) => /^\.zip$/.test(t)),
		'...and the .zip that nothing in this app recognised by name is gone'
	);
	const [dl] = await Promise.all([
		page.waitForEvent('download', { timeout: 25000 }),
		page.locator('.session-card').filter({ hasText: 'Project' }).locator('.session-download-scene').first().click()
	]);
	h.check(/\.tpscene$/.test(dl.suggestedFilename()), 'it really downloads one (' + dl.suggestedFilename() + ')');

	// THE MEASURED BUG: a project bundle used to JSON.stringify a Blob to {} and arrive
	// with every library file gone, silently. The library travels as real zip entries now.
	const roundTrip = await page.evaluate(async () => {
		const s = window.__stores;
		let list;
		s.sessions.sessions.subscribe((v) => (list = v))();
		const project = list.find((m) => m.hasLibrary);
		const payload = await s.sessions.getSession(project.id);
		const bytes = await s.sessions.exportSessionZip(payload);
		const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		const back = await s.sessions.readSessionZip(buf);
		const rows = back?.library?.items ?? [];
		return {
			saved: (payload.library?.items ?? []).length,
			read: rows.length,
			withBytes: rows.filter((r) => r.blob && r.blob.size > 0).length,
			folders: (back?.library?.folders ?? []).length
		};
	});
	h.check(
		roundTrip.saved === 5 && roundTrip.read === 5,
		'premise: the project carries five library rows both ways (' + JSON.stringify(roundTrip) + ')'
	);
	h.check(
		roundTrip.withBytes === 5,
		'THE FIX: every one comes back WITH ITS BYTES - a Blob stringifies to {} and used to arrive empty'
	);
	h.check(roundTrip.folders === 3, '...and the folder records with them');

	// ---- 11. MULTISELECT + A CONFIRMED DELETE ----------------------------------------
	// "allow multiselect in sessions so I can delete multiple files, also add confirmation
	// dialog when deleting items" - deleteSession had NO confirmation at all before.
	await page.locator('#session-view-list').click();
	await page.waitForTimeout(500);
	const rows2 = page.locator('#session-list .session-row');
	await rows2.nth(0).click();
	await page.waitForTimeout(300);
	h.check(
		(await page.locator('#session-list .session-picked').count()) === 1,
		'a click SELECTS an entry and highlights it'
	);
	await rows2.nth(1).locator('img, span').first().click({ modifiers: ['Control'] });
	await page.waitForTimeout(300);
	h.check(
		(await page.locator('#session-list .session-picked').count()) === 2,
		'ctrl-click builds a set, and every member shows it'
	);
	h.check(
		/2 selected/.test((await page.locator('#session-picked').textContent()) || ''),
		'...and the toolbar says how many'
	);

	const before = (await metas(A)).length;
	await page.locator('#session-delete-picked').click();
	await h.eventually(
		() =>
			page.evaluate(() => {
				let d;
				window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
				return d && d.title;
			}),
		(t) => /Delete 2 saved entries/.test(t || ''),
		'deleting ASKS first - it never did, not even for one entry'
	);
	await page.evaluate(() => window.__stores.confirmDialog.resolveConfirm(false));
	await page.waitForTimeout(600);
	h.check((await metas(A)).length === before, 'and Cancel keeps them (' + before + ')');
	await page.locator('#session-delete-picked').click();
	await page.waitForTimeout(600);
	await page.evaluate(() => window.__stores.confirmDialog.resolveConfirm(true));
	await h.eventually(
		() => metas(A),
		(l) => l.length === before - 2,
		'...while confirming deletes the whole set in one press',
		15000
	);

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});
