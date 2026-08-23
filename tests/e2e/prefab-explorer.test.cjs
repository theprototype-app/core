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

	// ---- 1. the card has a real menu (and the derived views still do not) -------------
	// The counterfactual for "a prefab card had no menu" is the rule it used to share:
	// the prefabs GRID BACKGROUND still opens nothing (gridMenu refuses this view), so a
	// menu appearing here can only be the prefab card's own — not a generic fallback.
	const grid = await A.page.locator('#explorer-list').boundingBox();
	await A.page.mouse.click(grid.x + grid.width - 24, grid.y + grid.height - 24, { button: 'right' });
	await A.page.waitForTimeout(300);
	h.check(
		(await A.page.locator('[role="menu"]').count()) === 0,
		'contrast: right-clicking the prefabs grid BACKGROUND still opens no menu'
	);

	await openPrefabMenu(A);
	const labels = await A.page.locator('[role="menuitem"]').allTextContents();
	const flat = labels.map((t) => t.trim().replace(/\s*▸\s*$/, ''));
	for (const wanted of ['Add to scene', 'Export', 'Update from selection', 'Properties', 'Rename', 'Delete'])
		h.check(flat.includes(wanted), `prefab menu offers "${wanted}"`);

	// Export is a SUBMENU with both formats
	await menuItem(A, 'Export').hover();
	await A.page.waitForTimeout(300);
	const afterHover = (await A.page.locator('[role="menuitem"]').allTextContents()).map((t) => t.trim());
	h.check(afterHover.includes('GLTF'), 'Export ▸ GLTF');
	h.check(afterHover.includes('prefab (.json)'), 'Export ▸ prefab (.json)');
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

	// ---- 5. Update from selection ----------------------------------------------------
	// The prefab is a box; re-save it from a SPHERE and the stored bytes have to change
	// in place — same id, same name, one entry, not a second one beside it.
	const boxFacts = await facts(A.page, prefabId);
	const sphereUuid = await createObject(A.page, '/create sphere');
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid, true), sphereUuid);
	await A.page.waitForTimeout(300);
	await clearToasts(A.page);
	await openPrefabMenu(A);
	await menuItem(A, 'Update from selection').click();
	await A.page.getByRole('button', { name: 'Update', exact: true }).click({ timeout: 8000 });
	await h.eventually(
		() => facts(A.page, prefabId),
		(f) => f && f.tris !== boxFacts.tris,
		'Update from selection re-saves the prefab bytes'
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
	await A.page.waitForTimeout(900);
	h.check(
		await A.page.locator('#model-preview-window').isVisible(),
		'model item: double-click opens the pop-out'
	);
	h.check(
		(await A.page.locator('#inline-preview').count()) === 0,
		'model item: the inline preview stands down too (the hang was never prefab-specific)'
	);
	await A.page.locator('#model-preview-window button[title="Close"]').click();
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
