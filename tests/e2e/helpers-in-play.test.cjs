// 24-E2: helpers on their own render layer, hidden in Play, a debug toggle. Light
// helpers + pick proxies and camera frustums (scene root) were gated by editor prefs
// only; camera MARKERS are replicated meshes that rendered inside the game, in camera
// previews and in captures (reported). Now: scene-root helpers sit on HELPER_LAYER (30 since 30b P0 — 1 is the XR LEFT-EYE layer)
// for good and only the editor camera enables it (off in Play unless the debug toggle);
// markers HOP onto the layer while hidden (Play / a preview / a capture's render) and
// come back to layer 0 after, so every raycaster in the app keeps picking them.
const h = require('./helpers.cjs');

const state = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const HL = s.helperLayer.HELPER_LAYER;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		const cam = get(s.editorCam) || get(s.globalCamera);
		const scene = get(s.globalScene);
		const group = get(s.objectsGroup);
		const markers = [];
		group?.traverse((n) => { if (n.userData?.camera) markers.push({ uuid: n.uuid, mask: n.layers.mask }); });
		const helperMasks = scene.children.filter((c) => /LightHelper$/.test(c.type || '') || c.name === 'light-proxies' || c.name === 'camera-frustums').map((c) => ({ name: c.name || c.type, mask: c.layers.mask, kids: c.children.map((k) => k.layers.mask) }));
		return {
			locked: get(s.isLocked),
			camHelper: !!cam?.layers?.isEnabled?.(HL),
			camMask: cam?.layers?.mask ?? null,
			markers,
			helperMasks,
			chip: !!document.querySelector('#helpers-debug-chip'),
			outlineLayers: s.editOverlays.outlineLayerList(),
			selected: get(s.selectedObjects)
		};
	});
const bit = (mask, n) => (mask & (1 << n)) !== 0;
// 30b P0: the helper layer is read from the app, never assumed (it was 1 — the XR left eye)
let HL = 30;

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	HL = await A.page.evaluate(() => window.__stores.helperLayer.HELPER_LAYER);
	h.check(HL !== 1 && HL !== 2, `the helper layer is not one of three's XR EYE layers 1/2 (${HL})`);
	const ids = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/light point');
		const marker = s.addObjects.spawnAtPoint('/create Camera', [0, 1, 0]);
		s.objectActions.deselectObject();
		return { marker: marker.uuid };
	});
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(800);
	await h.eventually(() => B.page.evaluate((u) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return !!g.getObjectByProperty('uuid', u); }, ids.marker), (ok) => ok, 'B received the marker', 15000);

	// ---- 1. outside Play: helpers on layer 1 only, the editor camera renders it -------
	let s = await state(A.page);
	h.check(!s.outlineLayers.includes(HL), `premise: the outline passes do not use the helper layer (${JSON.stringify(s.outlineLayers)})`);
	h.check(s.helperMasks.length >= 2 && s.helperMasks.every((e) => e.kids.length === 0 || e.kids.every((m) => m === 1 << HL)) && s.helperMasks.filter((e) => /LightHelper$/.test(e.name)).every((e) => e.mask === 1 << HL), `light helper + proxies + frustum root children sit on the helper layer only (${JSON.stringify(s.helperMasks)})`);
	h.check(s.camHelper === true, `the editor camera renders the helper layer outside Play (mask ${s.camMask})`);
	h.check(s.markers.length === 1 && bit(s.markers[0].mask, 0) && !bit(s.markers[0].mask, HL), `the marker is ordinary scenery outside Play (mask ${s.markers[0]?.mask})`);

	// ---- 2. a real click still picks the marker (it never left layer 0) ---------------
	const at = await h.projectPoint(A.page, [0, 1, 0]);
	await A.page.mouse.click(Math.round(at.x), Math.round(at.y));
	await A.page.waitForTimeout(400);
	s = await state(A.page);
	h.check(s.selected.includes(ids.marker), `a viewport click selects the marker (${s.selected.length})`);
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());

	// ---- 3. Play hides everything: camera layer off, markers hop to layer 1 ----------
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(400);
	s = await state(A.page);
	h.check(s.locked === true && s.camHelper === false, `in Play the camera no longer renders the helper layer (mask ${s.camMask})`);
	h.check(!bit(s.markers[0].mask, 0) && bit(s.markers[0].mask, HL), `the marker hopped onto the helper layer (mask ${s.markers[0].mask})`);
	h.check(!s.chip, 'no DEBUG chip while helpers are hidden');

	// ---- 4. the debug toggle brings them back, with the chip -----------------------------
	await A.page.evaluate(() => window.__stores.helperLayer.helpersInPlay.set(true));
	await A.page.waitForTimeout(400);
	s = await state(A.page);
	h.check(s.camHelper === true && bit(s.markers[0].mask, 0), `"Show helpers in Play" re-enables the layer and the marker (mask ${s.markers[0].mask})`);
	h.check(s.chip, 'the DEBUG chip is in the play HUD');
	await A.page.evaluate(() => window.__stores.helperLayer.helpersInPlay.set(false));
	await A.page.waitForTimeout(300);
	s = await state(A.page);
	h.check(s.camHelper === false && !bit(s.markers[0].mask, 0) && !s.chip, 'toggling it off hides them again');

	// ---- 5. leaving Play restores the editor view -----------------------------------------
	await A.page.evaluate(() => window.__stores.isLocked.set(false));
	await A.page.waitForTimeout(400);
	s = await state(A.page);
	h.check(s.camHelper === true && bit(s.markers[0].mask, 0) && !bit(s.markers[0].mask, HL), `leaving Play: layer back on, marker back on layer 0 (mask ${s.markers[0].mask})`);

	// ---- 6. a camera preview hides markers; stopping it restores them ------------------
	await A.page.evaluate((u) => window.__stores.cameraPreview.startCameraPreview(u), ids.marker);
	await A.page.waitForTimeout(500);
	s = await state(A.page);
	h.check(!bit(s.markers[0].mask, 0), `a camera preview hides the markers (mask ${s.markers[0].mask})`);
	const previewCam = await A.page.evaluate((HL) => { let c; window.__stores.globalCamera.subscribe((x) => (c = x))(); return c?.layers?.isEnabled?.(HL) ?? null; }, HL);
	h.check(previewCam === false, `the preview camera never renders the helper layer (${previewCam})`);
	await A.page.evaluate(() => window.__stores.cameraPreview.stopCameraPreview());
	await A.page.waitForTimeout(500);
	s = await state(A.page);
	h.check(bit(s.markers[0].mask, 0), `stopping the preview restores the marker (mask ${s.markers[0].mask})`);

	// ---- 7. a capture hides markers for its one render, then puts them back --------------
	const capture = await A.page.evaluate(({ u, HL }) => {
		let r;
		window.__stores.globalRenderer.subscribe((x) => (r = x))();
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const marker = g.getObjectByProperty('uuid', u);
		const seen = [];
		const original = r.render.bind(r);
		r.render = (scene, camera) => { seen.push({ mask: marker.layers.mask, camHelper: camera.layers.isEnabled(HL) }); return original(scene, camera); };
		try { window.__stores.cameraObjects.captureThroughCamera(u, 120); } catch (e) { seen.push({ error: e.message }); }
		r.render = original;
		return { seen, after: marker.layers.mask };
	}, { u: ids.marker, HL });
	const during = capture.seen.find((x) => x.mask !== undefined);
	h.check(!!during && !bit(during.mask, 0) && during.camHelper === false, `captureThroughCamera renders with the marker hidden and no helper layer (${JSON.stringify(capture.seen)})`);
	h.check(bit(capture.after, 0) && !bit(capture.after, HL), `...and restores the marker afterwards (mask ${capture.after})`);

	// ---- 8. peer B: ordinary mask outside Play; its own Play hides its own copy -------
	let b = await state(B.page);
	h.check(b.markers.length === 1 && bit(b.markers[0].mask, 0) && !bit(b.markers[0].mask, HL), `peer B's copy of the marker is on layer 0 (mask ${b.markers[0]?.mask})`);
	await B.page.evaluate(() => window.__stores.isLocked.set(true));
	await B.page.waitForTimeout(400);
	b = await state(B.page);
	h.check(b.camHelper === false && bit(b.markers[0].mask, HL) && !bit(b.markers[0].mask, 0), `B entering Play hides its own marker copy (mask ${b.markers[0].mask})`);
	// a snapshot taken by A mid-Play on B carries no hop for B's editor: A's copy is normal
	s = await state(A.page);
	h.check(bit(s.markers[0].mask, 0), "A's marker is unaffected by B's Play");
	await B.page.evaluate(() => window.__stores.isLocked.set(false));

	await h.finish(browser);
});
