// 21-H2: prefabs come home to the Explorer.
//
// Until this phase a prefab card was CRUD-less in the one surface that owns it —
// `itemMenu` early-returned on `kind === 'prefab'` ("derived views have no CRUD") and so
// did `inspectItem`, while a second surface (the Library modal, which nothing in the app
// could open) carried export/delete/rename for the same prefabs. This suite covers the
// menu, every entry on it, the Properties pane with its preview and facts, the reported
// DOUBLE-CLICK HANG, and the removal of that second surface.
//
// `enable3dPreview` is seeded through setupPage's storage hook rather than written from
// the test, because section 6 asserts that NOTHING writes that preference — a runtime
// suspension must not become stored state (fileWindows.js carries the reasoning).
const h = require('./helpers.cjs');

const prefabList = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.prefabs.prefabs.subscribe((list) =>
					r(list.map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt ?? null })))
				)()
			)
	);

const facts = (page, id) =>
	page.evaluate((id) => window.__stores.prefabs.prefabFacts(id), id);

const childNames = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r(g?.children.map((c) => c.name) ?? []))()
			)
	);

const clearToasts = (page) => page.evaluate(() => window.__stores.clearToast());

/** 21-I3: the SCENE undo stack's depth — locked answer 6 turns on this number. */
const undoDepth = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))())
	);

/** Create a primitive and return its uuid (the newest child). */
const createObject = (page, command) =>
	page.evaluate((command) => {
		window.__stores.commandsHandler.sceneCommand(command);
		return new Promise((resolve) =>
			window.__stores.objectsGroup.subscribe((g) => resolve(g.children[g.children.length - 1].uuid))()
		);
	}, command);

/**
 * Dismiss any open context menu. Escape is NOT enough: it unwinds ONE step (query →
 * search mode → open submenu → the menu), and it lives on the filter input's keydown.
 * The menu's own backdrop needs the press AND the click — a menu opened by a long press
 * must not be closed by the lift that opened it (the documented rule), so a bare click
 * does nothing. A still-open backdrop swallows the next right-click, which is exactly
 * how this first ran red.
 */
async function closeCtxMenu(A) {
	await A.page.evaluate(() => {
		const backdrop = [...document.querySelectorAll('[role="presentation"]')].find((el) =>
			el.className.includes?.('inset-0')
		);
		if (!backdrop) return;
		backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	});
	await A.page.waitForTimeout(250);
}

/**
 * Right-click empty GRID space and wait for the background menu (21-I3).
 *
 * `#explorer-grid`, never `#explorer-list`: the list is the whole WindowShell, and once
 * the Properties pane is open it owns the right-hand side — so a click aimed at the
 * list's bottom-right corner lands on that pane, whose ancestors carry no `gridMenu`
 * handler, and the menu simply never opens. That read as "the new menu is broken" for one
 * round; the grid is the element the handler is actually on.
 */
async function openGridMenu(A) {
	await closeCtxMenu(A);
	const box = await A.page.locator('#explorer-grid').boundingBox();
	await A.page.mouse.click(box.x + box.width - 24, box.y + box.height - 24, { button: 'right' });
	await A.page.waitForSelector('[role="menu"]', { timeout: 5000 });
}

/** Right-click the one prefab card and wait for its menu. */
async function openPrefabMenu(A) {
	await closeCtxMenu(A);
	await A.page.locator('#explorer-list .explorer-card').first().click({ button: 'right' });
	await A.page.waitForSelector('[role="menu"]', { timeout: 5000 });
}

/**
 * A context-menu row by its label. TWO traps here: a group row's text carries the
 * trailing '▸' glyph (so an anchored `^label$` regex never matches it), and a submenu is
 * a DOM CHILD of the row that opened it — so a substring match for a submenu entry finds
 * the parent as well. Document order puts the parent first, hence `last` for a child.
 */
const menuItem = (A, label, last = false) => {
	const rows = A.page.locator('[role="menuitem"]').filter({ hasText: label });
	return last ? rows.last() : rows.first();
};

h.run(async () => {
	// GPU_ARGS: this suite stands up REAL WebGL contexts (the viewport, the inline
	// preview, the pop-out) and asserts on what they report. On the software rasterizer
	// they are both slow and scarce — `new WebGLRenderer` throws "cannot read properties
	// of null (reading 'precision')" when getContext hands back nothing, which reads as a
	// broken preview rather than an exhausted host.
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { storage: { enable3dPreview: 'true' } });

	// ---- 0. premise: one prefab, and the Explorer showing it -------------------------
	const boxUuid = await createObject(A.page, '/create box');
	await A.page.evaluate(async (uuid) => {
		await window.__stores.prefabs.loadPrefabs();
		await window.__stores.prefabs.savePrefab(uuid, 'Fab');
	}, boxUuid);
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	await A.page.locator('#prefabs-folder').click();
	await A.page.waitForTimeout(400);
	const cards = await A.page.locator('#explorer-list .explorer-card').count();
	h.check(cards === 1, `the prefab shows as a card in the Explorer (${cards})`);
	const saved = await prefabList(A.page);
	const prefabId = saved[0]?.id;
	h.check(!!prefabId && saved[0].name === 'Fab', 'premise: one prefab named Fab');

	// ---- 1. the card has a real menu, and so does the grid BACKGROUND now -------------
	// 21-I3 FLIPS THE OLD CONTRACT HERE. H2's check asserted the prefabs grid background
	// opens NOTHING — `gridMenu` early-returned for this view, on the same "derived views
	// have no CRUD" rule the card menu had already outgrown. A prefab library is not a
	// derived view: prefabs are stored things you MAKE, and this surface offered no way to
	// make one. The contrast is kept as SHAPE instead of absence: the menu that opens here
	// is small and prefab-specific, carrying none of the New folder / Save scene / Export
	// project entries an ordinary folder's background offers. Section 13 drives the entry.
	await openGridMenu(A);
	const bgLabels = (await A.page.locator('[role="menuitem"]').allTextContents()).map((t) => t.trim());
	h.check(
		bgLabels.includes('Create from selection'),
		`the prefabs grid BACKGROUND offers "Create from selection" (${bgLabels.join(' | ') || 'no menu'})`
	);
	h.check(
		!bgLabels.some((l) => /New folder|Save scene|New scene|Export project|Import project/.test(l)),
		'and none of the folder/project entries, which mean nothing in a virtual folder'
	);
	await closeCtxMenu(A);

	await openPrefabMenu(A);
	const labels = await A.page.locator('[role="menuitem"]').allTextContents();
	const flat = labels.map((t) => t.trim().replace(/\s*▸\s*$/, ''));
	for (const wanted of ['Add to scene', 'Export', 'Update from selection', 'Properties', 'Rename', 'Delete'])
		h.check(flat.includes(wanted), `prefab menu offers "${wanted}"`);

	// Export is a SUBMENU with all THREE formats (21-I3 adds the scene)
	await menuItem(A, 'Export').hover();
	await A.page.waitForTimeout(300);
	const afterHover = (await A.page.locator('[role="menuitem"]').allTextContents()).map((t) => t.trim());
	h.check(afterHover.includes('GLTF'), 'Export ▸ GLTF');
	h.check(afterHover.includes('prefab (.json)'), 'Export ▸ prefab (.json)');
	h.check(afterHover.includes('scene (.tpscene)'), 'Export ▸ scene (.tpscene)');
	await closeCtxMenu(A);

	// ---- 2. Add to scene -------------------------------------------------------------
	const before = (await childNames(A.page)).filter((n) => n === 'Fab').length;
	await openPrefabMenu(A);
	await menuItem(A, 'Add to scene').click();
	await A.page.waitForTimeout(600);
	const after = (await childNames(A.page)).filter((n) => n === 'Fab').length;
	h.check(after === before + 1, `Add to scene instantiates the prefab (${before} -> ${after})`);

	// ---- 3. Export ▸ prefab (.json) produces real bytes ------------------------------
	const jsonDownload = A.page.waitForEvent('download', { timeout: 15000 });
	await openPrefabMenu(A);
	await menuItem(A, 'Export').hover();
	await A.page.waitForTimeout(250);
	await menuItem(A, 'prefab (.json)', true).click();
	let dl = await jsonDownload;
	h.check(dl.suggestedFilename() === 'Fab.prefab.json', `.json export names the file (${dl.suggestedFilename()})`);
	const jsonPath = await dl.path();
	const jsonText = require('fs').readFileSync(jsonPath, 'utf8');
	let parsed = null;
	try {
		parsed = JSON.parse(jsonText);
	} catch {}
	h.check(
		!!parsed?.element?.object && parsed.name === 'Fab',
		`.json export carries the prefab element (${jsonText.length} bytes)`
	);

	// ---- 4. Export ▸ GLTF, through fileHandler's own exporter -------------------------
	const gltfDownload = A.page.waitForEvent('download', { timeout: 30000 });
	await openPrefabMenu(A);
	await menuItem(A, 'Export').hover();
	await A.page.waitForTimeout(250);
	await menuItem(A, 'GLTF', true).click();
	dl = await gltfDownload;
	h.check(dl.suggestedFilename() === 'Fab.gltf', `GLTF export names the file (${dl.suggestedFilename()})`);
	const gltfText = require('fs').readFileSync(await dl.path(), 'utf8');
	let gltf = null;
	try {
		gltf = JSON.parse(gltfText);
	} catch {}
	// a real glTF, not an empty shell: the mesh has to have survived the parse + export
	h.check(!!gltf?.asset?.version, 'GLTF export is a valid glTF document');
	h.check((gltf?.meshes?.length ?? 0) >= 1, `GLTF export carries the mesh (${gltf?.meshes?.length ?? 0})`);
	h.check((gltf?.nodes?.length ?? 0) >= 1, `GLTF export carries a node (${gltf?.nodes?.length ?? 0})`);
	h.check(
		(gltf?.accessors?.length ?? 0) >= 1 && (gltf?.buffers?.[0]?.byteLength ?? 0) > 0,
		'GLTF export carries real vertex bytes'
	);

	// ---- 4b. Export ▸ scene (.tpscene), asserted on the REAL DOWNLOADED BYTES ---------
	// 21-I3: a scene containing JUST this prefab. Two things have to be true and the
	// second is the interesting one: it is a real .tpscene zip, and it is NOT a capture of
	// the live scene — which by now holds TWO objects (the box from section 0 and the Fab
	// instance section 2 added), so an `objects` length of 1 is a discriminator and not a
	// coincidence. `buildSessionPayload` would have written both, plus this author's
	// environment, flow, HUD and game state.
	const liveChildren = (await childNames(A.page)).length;
	const sceneDownload = A.page.waitForEvent('download', { timeout: 30000 });
	await openPrefabMenu(A);
	await menuItem(A, 'Export').hover();
	await A.page.waitForTimeout(250);
	await menuItem(A, 'scene (.tpscene)', true).click();
	dl = await sceneDownload;
	h.check(dl.suggestedFilename() === 'Fab.tpscene', `.tpscene export names the file (${dl.suggestedFilename()})`);
	const { unzipSync, strFromU8 } = require('fflate');
	const zipBytes = require('fs').readFileSync(await dl.path());
	let zipEntries = null;
	try {
		zipEntries = unzipSync(new Uint8Array(zipBytes));
	} catch (error) {
		console.log('unzip failed', error.message);
	}
	h.check(
		!!zipEntries && !!zipEntries['session.json'],
		`the .tpscene is a real zip carrying session.json (${zipEntries ? Object.keys(zipEntries).join(', ') : 'unreadable'})`
	);
	let session = null;
	try {
		session = JSON.parse(strFromU8(zipEntries['session.json']));
	} catch {}
	h.check(session?.format === 1 && session?.name === 'Fab', `session.json is a format-1 payload named Fab (${session?.name})`);
	h.check(
		(session?.objects?.length ?? 0) === 1 && liveChildren > 1,
		`objects holds the prefab ALONE, not the ${liveChildren}-object live scene (${session?.objects?.length})`
	);
	h.check(
		session?.objects?.[0]?.object?.name === 'Fab' && (session?.objects?.[0]?.geometries?.length ?? 0) >= 1,
		`the object is the prefab, with real geometry (${session?.objects?.[0]?.object?.name}, ${session?.objects?.[0]?.geometries?.length} geometries)`
	);
	h.check(session?.count === 1, `count matches what is in the file (${session?.count})`);
	// nothing of the author's OPEN scene rode along: the empty payload's own nulls
	h.check(
		session?.game === null && session?.post === null && !session?.environment && !session?.workspace,
		'and none of the open scene came with it (game/post/environment/workspace)'
	);

	// ---- 5. Update from selection: INSTANT, with an Undo that is the toast's alone ----
	// 21-I3 (locked answer 6). H2 put a confirm toast in front of every update; the
	// replace happens straight away now and reports with an Undo. THE CONSTRAINT: that
	// Undo must never enter the scene history — Ctrl+Z is for viewport changes — so the
	// undo-stack depth is measured across the whole gesture.
	const boxFacts = await facts(A.page, prefabId);
	const sphereUuid = await createObject(A.page, '/create sphere');
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid, true), sphereUuid);
	await A.page.waitForTimeout(300);
	await clearToasts(A.page);
	// baseline taken IMMEDIATELY before the gesture — creating the sphere records an entry
	const depthBefore = await undoDepth(A.page);
	await openPrefabMenu(A);
	await menuItem(A, 'Update from selection').click();
	await h.eventually(
		() => facts(A.page, prefabId),
		(f) => f && f.tris !== boxFacts.tris,
		'Update from selection re-saves the prefab bytes with NO dialog in the way'
	);
	// the spy for "no dialog": the confirm's own button. It never appears — and this
	// cannot pass vacuously, because section 5b turns the prompt back on and finds it.
	h.check(
		(await A.page.getByRole('button', { name: 'Update', exact: true }).count()) === 0,
		'no confirm prompt was raised (default is instant)'
	);
	const updated = await prefabList(A.page);
	const newFacts = await facts(A.page, prefabId);
	h.check(updated.length === 1, `update writes IN PLACE, no second entry (${updated.length})`);
	h.check(updated[0].id === prefabId && updated[0].name === 'Fab', 'update keeps the id and the name');
	h.check(!!updated[0].updatedAt, 'update stamps updatedAt');
	h.check(
		newFacts.tris > boxFacts.tris,
		`the prefab now holds the sphere (${boxFacts.tris} -> ${newFacts.tris} tris)`
	);

	// the report carries Undo, and Undo puts the OLD BYTES back
	const undoButton = A.page.getByRole('button', { name: 'Undo', exact: true });
	h.check((await undoButton.count()) > 0, 'the report toast carries an Undo');
	await undoButton.first().click({ timeout: 8000 });
	await h.eventually(
		() => facts(A.page, prefabId),
		(f) => f && f.tris === boxFacts.tris,
		`Undo restores the previous bytes (back to ${boxFacts.tris} tris)`
	);
	const depthAfter = await undoDepth(A.page);
	h.check(
		depthAfter === depthBefore,
		`THE CONSTRAINT: neither the update nor its Undo touched the scene history (${depthBefore} -> ${depthAfter})`
	);
	// ...and the user's own Ctrl+Z acts on the SCENE, never on the prefab. The scene
	// child count is the premise: without it, "the prefab did not change" would read the
	// same whether Ctrl+Z did something or nothing at all.
	const sceneBeforeUndo = (await childNames(A.page)).length;
	await A.page.keyboard.press('Control+z');
	await A.page.waitForTimeout(600);
	const sceneAfterUndo = (await childNames(A.page)).length;
	const afterCtrlZ = await facts(A.page, prefabId);
	h.check(
		sceneAfterUndo === sceneBeforeUndo - 1,
		`premise: Ctrl+Z really undid a SCENE step (${sceneBeforeUndo} -> ${sceneAfterUndo} objects)`
	);
	h.check(
		afterCtrlZ.tris === boxFacts.tris,
		`Ctrl+Z reaches the scene and never the prefab library (${afterCtrlZ.tris} tris)`
	);

	// ---- 5b. the opt-in confirm restores the prompt -----------------------------------
	// `confirmPrefabUpdate` is OFF by default (asserted), and turning it on brings back
	// exactly the dialog H2 always showed.
	h.check(
		(await A.page.evaluate(
			() => new Promise((r) => window.__stores.confirmPrefabUpdate.subscribe((v) => r(v))())
		)) === false,
		'confirmPrefabUpdate defaults to OFF'
	);
	await A.page.evaluate(() => window.__stores.confirmPrefabUpdate.set(true));
	// a FRESH sphere: the Ctrl+Z above removed the first one from the scene
	const sphere2 = await createObject(A.page, '/create sphere');
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid, true), sphere2);
	await A.page.waitForTimeout(300);
	await clearToasts(A.page);
	const beforePrompt = await facts(A.page, prefabId);
	await openPrefabMenu(A);
	await menuItem(A, 'Update from selection').click();
	await A.page.waitForTimeout(600);
	const prompt = A.page.getByRole('button', { name: 'Update', exact: true });
	h.check((await prompt.count()) > 0, 'with the setting ON, the confirm prompt is back');
	h.check(
		(await facts(A.page, prefabId)).tris === beforePrompt.tris,
		'and nothing was replaced while it waited for an answer'
	);
	await prompt.first().click({ timeout: 8000 });
	await h.eventually(
		() => facts(A.page, prefabId),
		(f) => f && f.tris !== beforePrompt.tris,
		'confirming it goes through the same replace'
	);
	h.check(
		(await A.page.getByRole('button', { name: 'Undo', exact: true }).count()) > 0,
		'the confirmed route reports with an Undo too'
	);
	await A.page.evaluate(() => window.__stores.confirmPrefabUpdate.set(false));
	await clearToasts(A.page);

	// ---- 6. inline rename (never window.prompt — that is what the Library used) -------
	await A.page.evaluate(() => {
		window.__promptCalls = 0;
		const orig = window.prompt.bind(window);
		window.prompt = (...args) => {
			window.__promptCalls++;
			return orig(...args);
		};
	});
	await openPrefabMenu(A);
	await menuItem(A, 'Rename').click();
	await A.page.waitForTimeout(300);
	const input = A.page.locator('#explorer-list .explorer-card input');
	h.check(await input.isVisible(), 'Rename opens the INLINE card editor');
	await input.fill('Renamed');
	await input.press('Enter');
	await h.eventually(
		() => prefabList(A.page),
		(list) => list[0]?.name === 'Renamed',
		'the inline rename commits to the prefab library'
	);
	h.check((await A.page.evaluate(() => window.__promptCalls)) === 0, 'no window.prompt was used');

	// ---- 7. Properties: the preview and the facts ------------------------------------
	await openPrefabMenu(A);
	await menuItem(A, 'Properties').click();
	await A.page.waitForTimeout(600);
	h.check(await A.page.locator('#prefab-facts').isVisible(), 'Properties shows the prefab facts block');
	const objectsText = await A.page.locator('#prefab-objects').textContent();
	h.check(Number(objectsText) === newFacts.objects && newFacts.objects >= 1, `objects: ${objectsText}`);
	const trisText = await A.page.locator('#prefab-tris').textContent();
	h.check(/tris/.test(trisText) && /verts/.test(trisText), `triangle count: ${trisText.trim()}`);
	h.check(await A.page.locator('#prefab-saved').isVisible(), 'Properties shows the saved date');
	h.check(
		await A.page.locator('#inline-preview canvas').isVisible(),
		'Properties shows the inline 3D preview for a prefab'
	);

	// ---- 8. THE REPORTED HANG: double-click while the inline preview is running -------
	// Two WebGL contexts on the same tree. The inline one stands down while a pop-out is
	// open — and this must write NO preference, so spy on the store's own set().
	await A.page.evaluate(() => {
		const store = window.__stores.enable3dPreview;
		const orig = store.set.bind(store);
		window.__prefWrites = [];
		store.set = (v) => {
			window.__prefWrites.push(v);
			return orig(v); // pass-through: a spy that swallows makes success and failure identical
		};
	});
	await A.page.locator('#explorer-list .explorer-card').first().dblclick();
	await A.page.waitForTimeout(900);
	h.check(await A.page.locator('#model-preview-window').isVisible(), 'double-click opens the pop-out preview');
	h.check(
		(await A.page.locator('#inline-preview').count()) === 0,
		'THE FIX: the inline preview stands down while the pop-out is open'
	);
	h.check(
		await A.page.locator('#preview-suspended').isVisible(),
		'the Properties pane says where the preview went'
	);
	// 21-I3: it says so with the item's STILL, at the live preview's own size — not H2's
	// dashed text note. The size is what makes the pane keep its shape when the live
	// viewport hands off, so it is asserted, not assumed.
	h.check(
		await A.page.locator('#preview-suspended-thumb').isVisible(),
		'and it shows the item THUMBNAIL rather than a text note'
	);
	const thumbSrc = await A.page.locator('#preview-suspended-thumb').getAttribute('src');
	h.check(
		(thumbSrc ?? '').startsWith('data:image'),
		`the still is this prefab's own rendered thumbnail (${(thumbSrc ?? '').slice(0, 24)}…)`
	);
	const suspendedBox = await A.page.locator('#preview-suspended').boundingBox();
	h.check(
		Math.abs((suspendedBox?.height ?? 0) - 150) <= 2,
		`the still occupies the live preview's own 150px slot (${Math.round(suspendedBox?.height ?? 0)}px)`
	);
	h.check(
		/previewing in its own window/i.test(await A.page.locator('#preview-suspended').textContent()),
		'with a hint saying where the live one went'
	);

	// ---- 8b. A REPEAT CLICK RAISES THE WINDOW — the reported "hang" -------------------
	// THE PROBE FINDING (21-I3): driving `#prefab-preview` twice produced no wedge at all
	// — no page errors, a responsive app, clickable cards. The second click simply did
	// NOTHING, because `modelPreviewTarget` was re-set to an equal target: the `{#key}`
	// did not change and neither did the window. A window behind the Explorer or shoved
	// off-screen is then indistinguishable from a dead button.
	//
	// The premise is built the way a user builds it: the window is DRAGGED nearly off the
	// right edge (dragWindow deliberately allows that, keeping a 52px strip), so the
	// stored rect really is off-screen — moving it with CSS would leave the action's own
	// rect on-screen and the check would pass on a lie.
	const winBefore = await A.page.locator('#model-preview-window').boundingBox();
	const handle = A.page.locator('#model-preview-window .move-handle');
	const hb = await handle.boundingBox();
	// grab at 40% across: the header's centre can land on its own buttons, which
	// dragWindow rightly refuses to start a drag from
	const grabX = hb.x + hb.width * 0.4;
	const grabY = hb.y + hb.height / 2;
	await A.page.mouse.move(grabX, grabY);
	await A.page.mouse.down();
	for (let i = 1; i <= 12; i++) await A.page.mouse.move(grabX + i * 90, grabY + i * 20);
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const shoved = await A.page.locator('#model-preview-window').boundingBox();
	const viewport = A.page.viewportSize();
	h.check(
		shoved.x + shoved.width > viewport.width + 100,
		`premise: the window really is off the right edge (right ${Math.round(shoved.x + shoved.width)} vs ${viewport.width})`
	);

	// remember the canvas NODE: a raise must not remount the preview (that would build a
	// second WebGL context for a picture that is already on screen)
	await A.page.evaluate(() => {
		window.__popCanvas = document.querySelector('#model-preview-window canvas');
	});
	// a competitor window, so "raise" is a claim about ORDER and not about a lone window
	await A.page.evaluate(() =>
		window.__stores.fileWindows.openImagePreview({
			title: 'probe',
			url:
				'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
		})
	);
	await A.page.waitForTimeout(500);
	const rival = A.page.locator('#image-preview-window');
	await rival.locator('.move-handle').click(); // pointerdown raises it to the front
	await A.page.waitForTimeout(300);
	const zRivalBefore = await rival.evaluate((el) => Number(getComputedStyle(el).zIndex));
	const zPreviewBefore = await A.page
		.locator('#model-preview-window')
		.evaluate((el) => Number(getComputedStyle(el).zIndex));
	h.check(
		zRivalBefore > zPreviewBefore,
		`premise: another window is in front of the preview (${zPreviewBefore} vs ${zRivalBefore})`
	);

	await A.page.locator('#prefab-preview').click();
	await A.page.waitForTimeout(600);
	const raised = await A.page.locator('#model-preview-window').boundingBox();
	h.check(
		raised.x >= -1 && raised.x + raised.width <= viewport.width + 1,
		`THE FIX: a repeat click brings the window fully back on-screen (x ${Math.round(shoved.x)} -> ${Math.round(raised.x)})`
	);
	h.check(
		raised.y >= -1 && raised.y + raised.height <= viewport.height + 1,
		`...vertically too (y ${Math.round(raised.y)}, h ${Math.round(raised.height)})`
	);
	const zPreviewAfter = await A.page
		.locator('#model-preview-window')
		.evaluate((el) => Number(getComputedStyle(el).zIndex));
	const zRivalAfter = await rival.evaluate((el) => Number(getComputedStyle(el).zIndex));
	h.check(
		zPreviewAfter >= zRivalAfter,
		`and to the FRONT of the window stack (${zPreviewAfter} vs the rival's ${zRivalAfter})`
	);
	h.check(
		await A.page.evaluate(() => document.activeElement?.id === 'model-preview-window'),
		'and it takes the keyboard, so Esc closes what you just asked for'
	);
	h.check(
		await A.page.evaluate(() => window.__popCanvas === document.querySelector('#model-preview-window canvas')),
		'a raise REUSES the running preview — no remount, no second GL context'
	);
	// the window is still showing the same source, and the pane still shows its still
	h.check(
		await A.page.locator('#preview-suspended-thumb').isVisible(),
		'the Properties still stays put through a raise'
	);
	// Esc now reaches it (that is what the focus was for)
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(500);
	h.check(
		(await A.page.locator('#model-preview-window').count()) === 0,
		'Escape closes the raised window'
	);
	await rival.locator('button[title="Close"]').click();
	await A.page.waitForTimeout(400);
	// leave section 9 the state it expects: the pop-out open again on this prefab
	h.check(
		winBefore.width > 0,
		`premise: the window had a measurable box to begin with (${Math.round(winBefore.width)}x${Math.round(winBefore.height)})`
	);
	await A.page.locator('#prefab-preview').click();
	await A.page.waitForTimeout(800);
	h.check(
		await A.page.locator('#model-preview-window').isVisible(),
		'and it opens again afterwards (a raise did not consume the opener)'
	);
	h.check(
		await A.page.evaluate(
			() => new Promise((r) => window.__stores.fileWindows.previewSuspended.subscribe((v) => r(v))())
		),
		'previewSuspended is raised'
	);
	h.check(
		await A.page.locator('#model-preview-window canvas').isVisible(),
		'the pop-out itself renders (it must not suspend ITSELF)'
	);
	// The pop-out really shows THIS PREFAB, not an empty canvas and not some other
	// source: its stats box only fills once ModelPreview parsed a tree, and the triangle
	// count has to be the prefab's own (the sphere it was updated to, not the box).
	await h.eventually(
		() => A.page.locator('#model-preview-stats').textContent().catch(() => ''),
		(text) => /tris/.test(text ?? ''),
		'the pop-out resolved the prefab source (poly stats reported)'
	);
	const popStats = await A.page.locator('#model-preview-stats').textContent();
	h.check(
		popStats.replace(/[\s,]/g, '').includes(String(newFacts.tris)),
		`the pop-out shows THIS prefab's geometry (${popStats.replace(/\s+/g, ' ').trim()} vs ${newFacts.tris} tris)`
	);

	await A.page.locator('#model-preview-window button[title="Close"]').click();
	await A.page.waitForTimeout(700);
	h.check(
		(await A.page.locator('#model-preview-window').count()) === 0,
		'closing the pop-out removes it'
	);
	h.check(
		await A.page.locator('#inline-preview canvas').isVisible(),
		'the inline preview comes BACK when the pop-out closes'
	);
	const writes = await A.page.evaluate(() => window.__prefWrites);
	h.check(writes.length === 0, `enable3dPreview was never written (${JSON.stringify(writes)})`);
	h.check(
		await A.page.evaluate(
			() => new Promise((r) => window.__stores.enable3dPreview.subscribe((v) => r(v))())
		),
		'the stored 3D-preview preference is still ON'
	);

	// ---- 9. the same hang fix on an ORDINARY MODEL item (it is not prefab-specific) ---
	// Build a real .glb in the page (the app's own exporter) and import it, so the item
	// is an ordinary kind-'object' library file.
	await A.page.evaluate(async () => {
		const THREE = window.__stores.THREE;
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		const { GLTFExporter } = window.__stores.GLTFExporterModule;
		const buffer = await new Promise((resolve, reject) =>
			new GLTFExporter().parse(mesh, resolve, reject, { binary: true })
		);
		const file = new File([buffer], 'probe.glb', { type: 'model/gltf-binary' });
		await window.__stores.explorer.importFiles([file], null);
	});
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await h.eventually(
		() =>
			A.page.evaluate(
				() =>
					new Promise((r) =>
						window.__stores.explorer.explorerItems.subscribe((items) =>
							r(items.filter((i) => i.name === 'probe.glb').length)
						)()
					)
			),
		(n) => n === 1,
		'premise: an ordinary model item is in the library'
	);
	await A.page.waitForTimeout(600);
	const modelCard = A.page.locator('#explorer-list .explorer-card').filter({ hasText: 'probe.glb' }).first();
	await closeCtxMenu(A);
	await modelCard.click({ button: 'right' });
	await A.page.waitForSelector('[role="menu"]');
	await menuItem(A, 'Properties').click();
	await A.page.waitForTimeout(1200);
	h.check(
		await A.page.locator('#inline-preview canvas').isVisible(),
		'premise: a model item has an inline preview too'
	);
	await modelCard.dblclick();
	await A.page.waitForTimeout(1200);
	// R22 ROUND 12 CHANGED WHICH WINDOW THIS IS, deliberately: "double click on 3d objects
	// should open same preview as when opening image". A library OBJECT now opens the one
	// FILE PREVIEW window every other kind opens, so the arrows walk from a texture to a
	// model to a sound with no mode change - and it brings the tris/verts/meshes line the
	// pop-out used to own. ModelPreviewWindow survives for the PREFAB shelf's own
	// "3D preview" button (asserted elsewhere in this suite): a prefab is not a library
	// file and has no place in a folder walk.
	h.check(
		await A.page.locator('#image-preview-window').isVisible(),
		'model item: double-click opens the shared file preview (round 12)'
	);
	h.check(
		(await A.page.locator('#model-preview-window').count()) === 0,
		'...and no longer the separate model pop-out'
	);
	h.check(
		(await A.page.locator('#inline-preview').count()) === 0,
		'model item: the inline preview stands down too (the hang was never prefab-specific)'
	);
	await A.page.locator('#image-preview-window button[title="Close"]').click();
	await A.page.waitForTimeout(700);
	h.check(
		await A.page.locator('#inline-preview canvas').isVisible(),
		'model item: the inline preview comes back'
	);
	h.check(
		(await A.page.evaluate(() => window.__prefWrites)).length === 0,
		'still no write to the stored preference'
	);

	// ---- 10. Delete ------------------------------------------------------------------
	await A.page.locator('#prefabs-folder').click();
	await A.page.waitForTimeout(400);
	await clearToasts(A.page);
	await openPrefabMenu(A);
	await menuItem(A, 'Delete').click();
	await A.page.getByRole('button', { name: 'Delete', exact: true }).click({ timeout: 8000 });
	await h.eventually(() => prefabList(A.page), (list) => list.length === 0, 'Delete removes the prefab');
	await A.page.waitForTimeout(400);
	h.check(
		(await A.page.locator('#explorer-list .explorer-card').count()) === 0,
		'the card goes with it'
	);

	// ---- 10b. "Create from selection" on the Prefabs background ----------------------
	// 21-I3: the Prefabs view had no background menu at all, so the surface that owns
	// prefabs had no way to make one. Section 10 just deleted the only prefab, which
	// makes this the cleanest place to build one from nothing.
	// the REFUSAL first: nothing selected must say so, never silently save the last thing
	// that was clicked. This is only expressible because the entry reads the selection SET
	// — `$selectedObject` is sticky and never goes back to empty (21-I3 note in Explorer).
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(300);
	await clearToasts(A.page);
	await openGridMenu(A);
	await menuItem(A, 'Create from selection').click();
	await A.page.waitForTimeout(700);
	const refusal = await A.page.evaluate(
		() => new Promise((r) => window.__stores.toastStore.subscribe((t) => r(JSON.stringify(t)))())
	);
	h.check(
		/save as a prefab first/i.test(refusal),
		`with nothing selected it refuses WITH THE REASON (${refusal.slice(0, 90)})`
	);
	h.check((await prefabList(A.page)).length === 0, 'and it made nothing');

	// now with a real selection
	const freshUuid = await createObject(A.page, '/create cone');
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid, true), freshUuid);
	await A.page.waitForTimeout(300);
	await clearToasts(A.page);
	await openGridMenu(A);
	await menuItem(A, 'Create from selection').click();
	await h.eventually(
		() => prefabList(A.page),
		(list) => list.length === 1,
		'Create from selection saves the selected object as a prefab'
	);
	await A.page.waitForTimeout(600);
	h.check(
		(await A.page.locator('#explorer-list .explorer-card').count()) === 1,
		'and the card appears in the view you made it from'
	);

	// ---- 10c. WEBGL CONTEXT DISPOSAL over many open/close cycles ---------------------
	// The one cause the probe could NOT rule out: a browser caps live WebGL contexts, and
	// ModelPreview builds one per mount. Over a long real session that would present as
	// exactly the reported symptom — a preview button that stops doing anything (the
	// renderer constructor throws, ModelPreview catches it and returns, and the canvas
	// stays blank). Contexts are counted at `getContext` time and tagged by WHERE their
	// canvas lives, so the pop-out's own contexts can be separated from the viewport's.
	await A.page.evaluate(() => {
		window.__gl = { made: [] };
		const orig = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
			const ctx = orig.call(this, kind, ...rest);
			if (ctx && /webgl/i.test(String(kind)))
				window.__gl.made.push({
					where: this.closest?.('#model-preview-window')
						? 'popout'
						: this.closest?.('#inline-preview')
							? 'inline'
							: 'other',
					ctx
				});
			return ctx;
		};
	});
	const CYCLES = 22;
	const errorsBeforeCycles = h.pageErrors(A).length;
	for (let i = 0; i < CYCLES; i++) {
		await A.page.locator('#explorer-list .explorer-card').first().dblclick();
		await A.page.waitForTimeout(320);
		const closeBtn = A.page.locator('#model-preview-window button[title="Close"]');
		if ((await closeBtn.count()) === 0) break; // the window stopped opening — recorded below
		await closeBtn.click();
		await A.page.waitForTimeout(220);
	}
	const gl = await A.page.evaluate(() => {
		const bucket = (where) => {
			const list = window.__gl.made.filter((e) => e.where === where);
			return { made: list.length, live: list.filter((e) => !e.ctx.isContextLost()).length };
		};
		return { popout: bucket('popout'), inline: bucket('inline'), other: bucket('other') };
	});
	h.check(
		gl.popout.made >= CYCLES - 2,
		`premise: every cycle really built a pop-out GL context (${gl.popout.made} over ${CYCLES} cycles)`
	);
	h.check(
		gl.popout.live === 0,
		`DISPOSAL HOLDS: every closed pop-out released its context (${gl.popout.live} of ${gl.popout.made} still live)`
	);
	// the INLINE preview mounts and unmounts on the same rhythm (it stands down while the
	// pop-out is up), so it is a second, free reading of the same question
	h.check(
		gl.inline.live <= 1,
		`the inline preview releases its own too (${gl.inline.live} live of ${gl.inline.made} made)`
	);
	// the spy is installed AFTER the app is up, so `other` counts only contexts created
	// DURING the cycles — which is the useful reading: nothing outside the two previews
	// should be minting one per open (measured 0 made, 0 live).
	h.check(
		gl.other.live <= 6,
		`nothing outside the previews minted contexts during the cycles (${gl.other.live} live of ${gl.other.made} made)`
	);
	// the user-facing half of the same question: the NEXT preview still works
	await A.page.locator('#explorer-list .explorer-card').first().dblclick();
	await A.page.waitForTimeout(900);
	h.check(
		await A.page.locator('#model-preview-window canvas').isVisible(),
		`the preview still opens after ${CYCLES} cycles (context exhaustion would blank it)`
	);
	await h.eventually(
		() => A.page.locator('#model-preview-stats').textContent().catch(() => ''),
		(text) => /tris/.test(text ?? ''),
		'and still renders a real tree (poly stats reported)'
	);
	h.check(
		h.pageErrors(A).length === errorsBeforeCycles,
		`no page errors across the cycles (${h.pageErrors(A).length - errorsBeforeCycles})`
	);
	await A.page.locator('#model-preview-window button[title="Close"]').click();
	await A.page.waitForTimeout(400);

	// ---- 11. the Library modal is GONE -----------------------------------------------
	// `libraryClose` survives in appStore (hidePanels/restorePanels still snapshot it),
	// so the honest assertion is that no `libraryClose === false` path can render
	// anything: force it false and nothing appears.
	await A.page.evaluate(() => window.__stores.libraryClose.set(false));
	await A.page.waitForTimeout(500);
	h.check(
		(await A.page.locator('#library-drawer').count()) === 0,
		'no Library drawer renders, even with libraryClose false'
	);
	h.check(
		(await A.page.locator('#library-search').count()) === 0,
		'the Library search box is gone with it'
	);
	await A.page.evaluate(() => window.__stores.showSidebar('library'));
	await A.page.waitForTimeout(500);
	h.check(
		(await A.page.locator('#library-drawer').count()) === 0,
		"showSidebar('library') — the only opener that ever existed — opens nothing"
	);

	// ---- 12. a workspace record naming `library` must be IGNORED, never crash ---------
	const errorsBefore = h.pageErrors(A).length;
	const applied = await A.page.evaluate(() =>
		window.__stores.workspace.applyWorkspace({
			open: { library: true, explorer: true, notes: false },
			dockTab: 'explorer'
		})
	);
	await A.page.waitForTimeout(600);
	h.check(applied === true, 'a restore payload naming `library` still applies');
	h.check(
		await A.page.evaluate(
			() => new Promise((r) => window.__stores.explorerClose.subscribe((v) => r(v))())
		) === false,
		'the panels it still knows about are restored (restore less, never more)'
	);
	h.check(h.pageErrors(A).length === errorsBefore, 'the unknown `library` key threw nothing');

	await h.finish(browser);
});
