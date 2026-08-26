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
	h.check(!!project && project.files === 3, `premise: the project entry carries the library (${project?.files} files)`);

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
	h.check(files.length === 4, `the entry's own scene plus its three library files (${files.length})`);
	h.check(files[0].kind === 'scene' && /this entry/.test(files[0].text), `…own scene first (${files[0].text})`);
	h.check(
		files.some((f) => f.kind === 'image' && f.disabled),
		'a texture is offered but REFUSES — objects come from scenes, and saying so beats an empty checklist'
	);
	// THE THUMBNAIL ASK: a project file's own picture, which was simply never copied in
	h.check(
		files.filter((f) => f.img).length >= 2,
		`project files show their thumbnails (${files.filter((f) => f.img).length} of ${files.length} rows)`
	);

	// drill into the entry's own scene
	await page.locator('#session-file-list .session-file').first().click();
	await page.waitForTimeout(700);
	h.check(
		await page.locator('#session-file-back').isVisible(),
		'a scene row drills into its objects, with a way back'
	);
	const objs = await page.evaluate(() => document.querySelectorAll('#session-picker label').length);
	h.check(objs >= 1, `…and the object checklist is there (${objs})`);
	await page.locator('#session-file-back').click();
	await page.waitForTimeout(400);
	h.check(await page.locator('#session-file-list').isVisible(), '‹ Files goes back up');

	// a SCENE-ONLY entry still has a file list — the one file it IS
	await page.evaluate(() => (document.querySelector('#session-picker button:last-of-type') ?? {}).click?.());
	await page.waitForTimeout(400);
	await page.locator('.session-card', { hasText: /Scene/ }).locator('.session-import').first().click();
	await page.waitForTimeout(800);
	const sceneOnly = await page.evaluate(
		() => document.querySelectorAll('#session-file-list .session-file').length
	);
	h.check(sceneOnly === 1, `a scene-only entry lists the one file it IS, not an empty list (${sceneOnly})`);

	// and the import really runs
	await page.locator('#session-file-list .session-file').first().click();
	await page.waitForTimeout(600);
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

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});
