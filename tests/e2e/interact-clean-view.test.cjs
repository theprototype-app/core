// 30b P1: INTERACT AND PLAY DRAW NO EDITOR SCAFFOLDING. The Quest report: "In interact
// mode I do not need helper boxes or shapes, outlines around objects." Before this, Play
// hid the helper LAYER and the grid, and Interact hid nothing at all — the grid, the
// collider/trigger wireframes, the selection outline, a peer's lock box, the tiny-object
// dots, the VR selection shell and the VR hover box all stayed. Every one of them now
// answers ONE predicate (helperLayer.helpersHidden / editorHelpersShown), so this suite
// builds a scene holding one of each and reads each one in Edit, Interact, back in Edit,
// and in Play.
const h = require('./helpers.cjs');

const read = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		const scene = get(s.globalScene);
		const cam = get(s.editorCam) || get(s.globalCamera);
		const HL = s.helperLayer.HELPER_LAYER;
		const colliders = scene.getObjectByName('collider-proxies');
		const locks = scene.getObjectByName('lock-highlights');
		const tiny = scene.getObjectByName('tiny-object-markers');
		const shell = scene.getObjectByName('vr-selection-shell');
		const hover = scene.getObjectByName('vr-hover-box');
		const outline = window.__outlineDebug?.() ?? null;
		return {
			mode: get(s.editorMode),
			locked: get(s.isLocked),
			grid: !!scene.getObjectByName('editor-grid'),
			helperLayer: !!cam?.layers?.isEnabled?.(HL),
			colliders: !!colliders?.visible && colliders.children.length > 0,
			locks: !!locks?.visible && locks.children.length > 0,
			tiny: !!tiny?.visible,
			shell: !!shell?.visible,
			hover: !!hover?.visible,
			outlineSelected: outline ? outline.selected : -1,
			outlineLocked: outline ? outline.locked : -1
		};
	});

const everything = (r) => r.grid && r.helperLayer && r.colliders && r.locks && r.tiny && r.outlineSelected > 0 && r.outlineLocked > 0;
const nothing = (r) => !r.grid && !r.helperLayer && !r.colliders && !r.locks && !r.tiny && r.outlineSelected === 0 && r.outlineLocked === 0;

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// ---- the fixture: one of each helper --------------------------------------------------
	const ids = await A.page.evaluate(async () => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		s.commandsHandler.sceneCommand('/light point');
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		const boxes = get(s.objectsGroup).children.filter((c) => c.name === 'Box');
		const [selected, lockedByPeer, tiny] = boxes;
		selected.position.set(-1.5, 0.5, 0);
		lockedByPeer.position.set(1.5, 0.5, 0);
		tiny.position.set(0, 0.5, -1);
		tiny.scale.setScalar(0.0005);
		s.colliderHelpers.showColliders.set(true);
		// a peer holding the second box (LockHighlights + the locked outline read this)
		s.lockedObjects.set([['peer-elsewhere', lockedByPeer.uuid]]);
		s.objectActions.selectObject(selected.uuid);
		s.objectsGroup.update((g) => g);
		return { selected: selected.uuid, locked: lockedByPeer.uuid };
	});
	await A.page.waitForTimeout(1200);

	// ---- 1. Edit shows all of it -------------------------------------------------------------
	let r = await read(A.page);
	h.check(r.mode === 'edit', 'premise: the editor starts in Edit');
	h.check(everything(r), `Edit: grid, helper layer, colliders, lock box, tiny dot and both outlines are drawn (${JSON.stringify(r)})`);

	// ---- 2. Interact hides every one ------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await A.page.waitForTimeout(600);
	r = await read(A.page);
	h.check(r.mode === 'interact', 'Interact is on');
	h.check(!r.grid, `Interact: no editor grid (${r.grid})`);
	h.check(!r.helperLayer, 'Interact: the camera stops drawing the helper layer (light helpers, proxies, frustums)');
	h.check(!r.colliders, 'Interact: no collider wireframes');
	h.check(!r.locks, "Interact: no peer lock box");
	h.check(!r.tiny, 'Interact: no tiny-object dot');
	h.check(r.outlineSelected === 0 && r.outlineLocked === 0, `Interact: no selection or lock outline (${r.outlineSelected}/${r.outlineLocked})`);
	const kept = await A.page.evaluate(() => { let v; window.__stores.selectedObjects.subscribe((x) => (v = x))(); return v.length; });
	h.check(kept === 1, `Interact keeps the selection itself — only its glare goes (${kept})`);

	// ---- 3. VR: the selection shell and the hover box stand down in Interact ---------------------
	await A.page.evaluate(() => window.__stores.isVRMode.set(true));
	const vr = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		const box = get(s.objectsGroup).getObjectByProperty('uuid', uuid);
		s.vrControls.updateHoverBox(box);
		const hover = get(s.globalScene).getObjectByName('vr-hover-box');
		return { hover: !!hover?.visible };
	}, ids.selected);
	await A.page.waitForTimeout(400);
	r = await read(A.page);
	h.check(!r.shell, 'VR Interact: no selection shell');
	h.check(!vr.hover, 'VR Interact: the hover box refuses to show');
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	const vrEdit = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		const box = get(s.objectsGroup).getObjectByProperty('uuid', uuid);
		s.vrControls.updateHoverBox(box);
		return !!get(s.globalScene).getObjectByName('vr-hover-box')?.visible;
	}, ids.selected);
	await A.page.waitForTimeout(400);
	r = await read(A.page);
	h.check(r.shell && vrEdit, `VR Edit: the selection shell and hover box are back (shell ${r.shell}, hover ${vrEdit})`);
	await A.page.evaluate(() => {
		window.__stores.vrControls.updateHoverBox(null);
		window.__stores.isVRMode.set(false);
	});
	await A.page.waitForTimeout(600);

	// ---- 4. back in Edit on the desktop, everything returns ---------------------------------------
	r = await read(A.page);
	h.check(everything(r), `back to Edit: all of it returns (${JSON.stringify(r)})`);

	// ---- 5. Play hides them all too (the grid and helper layer already did; now the rest) ---------
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(600);
	r = await read(A.page);
	h.check(nothing(r), `Play: nothing of the editor is drawn (${JSON.stringify(r)})`);
	// ...unless the debug toggle asks for them
	await A.page.evaluate(() => window.__stores.helperLayer.helpersInPlay.set(true));
	await A.page.waitForTimeout(500);
	r = await read(A.page);
	h.check(r.grid && r.colliders && r.helperLayer, `"Show helpers in Play (debug)" still brings the scaffolding back (${JSON.stringify(r)})`);
	await A.page.evaluate(() => {
		window.__stores.helperLayer.helpersInPlay.set(false);
		window.__stores.isLocked.set(false);
		window.__stores.lockedObjects.set([]);
	});

	await h.finish(browser);
});
