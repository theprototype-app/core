// Which object the UV editor shows, and whether it can show an IMPORTED model's
// texture. Four user reports, all one question:
//   - right-click > Edit Mesh showed nothing until you clicked the object first
//   - deselecting left the previous object's texture on screen
//   - what should multi-select do?
//   - an imported .obj with textures showed no texture at all
const h = require('./helpers.cjs');

const openEditor = async (page) => {
	await page.evaluate(() => {
		window.__stores.uvEditorClose.set(false);
		window.__stores.bottomDock.activateDock('uv');
	});
	await page.waitForTimeout(600);
};

/** what the editor is showing right now */
const shown = (page) =>
	page.evaluate(() => {
		const dbg = window.__uvDebug?.();
		const wrap = document.getElementById('uv-canvas-wrap');
		return {
			hasCanvas: !!document.getElementById('uv-canvas'),
			tris: dbg?.tris ?? null,
			empty: (wrap?.textContent ?? '').includes('Select a mesh'),
			multiNote: document.getElementById('uv-multi-note')?.textContent?.trim() ?? null
		};
	});

const makeBox = (page, name) =>
	page.evaluate(async (name) => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = name;
		return box.uuid;
	}, name);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await openEditor(A.page);

	const first = await makeBox(A.page, 'boxOne');
	const second = await makeBox(A.page, 'boxTwo');

	// ---------- deselect must EMPTY the editor ----------
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid), first);
	await A.page.waitForTimeout(400);
	const selected = await shown(A.page);
	h.check(selected.hasCanvas && selected.tris === 12, `a selected box shows its UV map (${selected.tris} tris)`);
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(400);
	const afterDeselect = await shown(A.page);
	h.check(
		!afterDeselect.hasCanvas && afterDeselect.empty,
		'THE BUG: deselecting empties the editor instead of leaving the old texture up'
	);

	// ---------- right-click > Edit Mesh, with NO primary selection ----------
	// that entry point never sets the primary, which is why the editor was blank
	await A.page.evaluate((uuid) => {
		const w = window.__stores;
		w.objectActions.deselectObject();
		w.faceEdit.enterFaceEdit(uuid);
	}, second);
	await A.page.waitForTimeout(500);
	const editing = await shown(A.page);
	h.check(
		editing.hasCanvas && editing.tris === 12,
		`THE BUG: entering Edit Mesh alone is enough to show the object (${editing.tris} tris)`
	);
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.waitForTimeout(300);

	// ---------- multi-select edits the primary and SAYS so ----------
	await A.page.evaluate(
		({ a, b }) => {
			const w = window.__stores;
			w.objectActions.selectObject(a);
			w.selectedObjects.set([a, b]);
		},
		{ a: first, b: second }
	);
	await A.page.waitForTimeout(500);
	const multi = await shown(A.page);
	h.check(multi.hasCanvas, 'a multi-selection still edits one object rather than going blank');
	h.check(
		(multi.multiNote ?? '').includes('2'),
		`...and the topbar says which of how many (${multi.multiNote})`
	);

	// ---------- an imported model: a GROUP, with a real THREE texture ----------
	// This is the shape an .obj/.gltf import lands in: a Group whose child mesh
	// carries the geometry, and a texture that never went through applyMap (so
	// there is no mapDataUrl for the editor to decode).
	const importedChild = await A.page.evaluate(async () => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const group = new w.THREE.Group();
		group.name = 'importedModel';
		const c = document.createElement('canvas');
		c.width = c.height = 16;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#3388ff';
		ctx.fillRect(0, 0, 16, 16);
		const mesh = new w.THREE.Mesh(
			new w.THREE.BoxGeometry(1, 1, 1),
			// a real texture, NO userData.mapDataUrl — exactly the import case
			new w.THREE.MeshStandardMaterial({ map: new w.THREE.CanvasTexture(c) })
		);
		mesh.name = 'importedMesh';
		group.add(mesh);
		g.add(group);
		w.objectsGroup.update((v) => v);
		w.objectActions.selectObject(group.uuid);
		return { group: group.uuid, mesh: mesh.uuid };
	});
	await A.page.waitForTimeout(600);
	const imported = await A.page.evaluate(async ({ mesh }) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const target = w.uvEditor.meshWithUvs(g.getObjectByProperty('uuid', mesh).parent);
		return {
			hasCanvas: !!document.getElementById('uv-canvas'),
			tris: window.__uvDebug?.().tris ?? null,
			resolvedToMesh: target?.uuid === mesh,
			// the fallback the editor now draws when there is no dataURL
			hasImage: !!w.uvEditor.textureImageOf(target, 0),
			noDataUrl: !target?.material?.userData?.mapDataUrl
		};
	}, importedChild);
	h.check(
		imported.resolvedToMesh,
		'THE BUG: selecting an imported GROUP resolves to the child mesh that has the UVs'
	);
	h.check(imported.hasCanvas && imported.tris === 12, `...so its UV map is shown (${imported.tris} tris)`);
	h.check(imported.noDataUrl, 'premise: an imported texture has no mapDataUrl to decode');
	h.check(
		imported.hasImage,
		"THE BUG: the backdrop falls back to the live texture's own image, so an import is not a blank square"
	);

	// ---------- the slot controls are actually reachable ----------
	const controls = await A.page.evaluate(() => {
		const btn = document.getElementById('uv-slot-image-0');
		if (!btn) return { present: false };
		const style = getComputedStyle(btn);
		return {
			present: true,
			// they used to be opacity-0 until hover, and were reported as missing
			visible: style.opacity !== '0' && style.display !== 'none' && btn.getBoundingClientRect().width > 0,
			tooltipMentionsCube: (document.getElementById('uv-filter-faces')?.title ?? '').includes('cube')
		};
	});
	h.check(controls.present, 'a slot row has its image button in the DOM');
	h.check(controls.visible, 'THE BUG: the slot buttons are VISIBLE without hovering');
	h.check(
		!controls.tooltipMentionsCube,
		'the face-filter tooltip states the rule, not the cube example'
	);

	await h.finish(browser);
});
