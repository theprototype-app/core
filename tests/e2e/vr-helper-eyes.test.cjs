// 30b P0: THE ONE-EYE LIGHT HELPER. A Quest user saw the light-source helper in the
// middle of Towers / Stars Room / Football "with one eye" while playing. The cause is a
// layer number: helpers lived on render layer 1, and three's WebXRManager renders the two
// eyes through sub-cameras whose masks it rewrites EVERY FRAME from the user camera's:
//   cameraL.mask = (camera.mask | 0b110) & ~0b100   -> layer 1 ALWAYS on for the left eye
//   cameraR.mask = (camera.mask | 0b110) & ~0b010   -> layer 1 always OFF for the right eye
// so a layer-1 helper was drawn by the left eye whatever the editor camera enabled, and
// never by the right one. Headless Chromium cannot present WebXR, so this suite computes
// the two eye masks with three's own formula (and first asserts the installed three still
// SAYS that formula, so a three upgrade that changes it turns this red instead of lying).
//
// The contract (C1): helpers draw in BOTH eyes in Edit and in NEITHER in Interact/Play.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const XR_SOURCE = path.join(__dirname, '..', '..', 'node_modules', 'three', 'src', 'renderers', 'webxr', 'WebXRManager.js');

/** what each eye camera would see of the scene-root light helper and its pick proxy */
const eyes = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		const THREE = s.THREE;
		const cam = get(s.editorCam) || get(s.globalCamera);
		const scene = get(s.globalScene);
		const helper = scene.children.find((c) => /LightHelper$/.test(c.type || ''));
		const proxy = scene.getObjectByName('light-proxy');
		// WebXRManager.updateCamera, verbatim in bit form
		const xrMask = cam.layers.mask | 0b110;
		const left = new THREE.Layers();
		left.mask = xrMask & ~0b100;
		const right = new THREE.Layers();
		right.mask = xrMask & ~0b010;
		const sees = (eye, node) => !!node && eye.test(node.layers);
		return {
			layer: s.helperLayer.HELPER_LAYER,
			helper: !!helper,
			proxy: !!proxy,
			leftHelper: sees(left, helper),
			rightHelper: sees(right, helper),
			leftProxy: sees(left, proxy),
			rightProxy: sees(right, proxy),
			desktop: !!helper && cam.layers.test(helper.layers),
			mode: get(s.editorMode),
			vr: get(s.isVRMode),
			locked: get(s.isLocked)
		};
	});

h.run(async () => {
	// ---- 0. the premise: three still reserves layers 1/2 for the eyes -----------------
	const src = fs.readFileSync(XR_SOURCE, 'utf8');
	h.check(
		/cameraL\.layers\.mask\s*=\s*cameraXR\.layers\.mask\s*&\s*~\s*0b100/.test(src) &&
			/cameraR\.layers\.mask\s*=\s*cameraXR\.layers\.mask\s*&\s*~\s*0b010/.test(src) &&
			/cameraXR\.layers\.mask\s*=\s*camera\.layers\.mask\s*\|\s*0b110/.test(src),
		'premise: three WebXRManager still gives the left eye layer 1 and the right eye layer 2'
	);

	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/light point');
		window.__stores.objectActions.deselectObject();
	});
	await h.eventually(() => eyes(A.page), (e) => e.helper && e.proxy, 'a point light has its helper + pick proxy', 10000);

	// ---- 1. Edit on the desktop --------------------------------------------------------
	let e = await eyes(A.page);
	h.check(e.layer !== 1 && e.layer !== 2, `the helper layer is not an XR eye layer (${e.layer})`);
	h.check(e.mode === 'edit' && e.desktop, `Edit: the desktop editor camera draws the helper (${JSON.stringify(e)})`);
	h.check(e.leftHelper && e.rightHelper, `Edit: BOTH eyes draw the light helper (L ${e.leftHelper} R ${e.rightHelper})`);
	h.check(e.leftProxy && e.rightProxy, `Edit: BOTH eyes draw its pick proxy (L ${e.leftProxy} R ${e.rightProxy})`);

	// ---- 2. Edit in VR (the headset keeps the editor camera, so the same answer) -------
	await A.page.evaluate(() => window.__stores.isVRMode.set(true));
	await A.page.waitForTimeout(200);
	e = await eyes(A.page);
	h.check(e.vr && e.leftHelper && e.rightHelper, `VR Edit: both eyes draw the helper (L ${e.leftHelper} R ${e.rightHelper})`);

	// ---- 3. Interact in VR: neither eye ---------------------------------------------------
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await A.page.waitForTimeout(200);
	e = await eyes(A.page);
	h.check(e.mode === 'interact' && !e.leftHelper && !e.rightHelper, `VR Interact: NEITHER eye draws the helper (L ${e.leftHelper} R ${e.rightHelper})`);
	h.check(!e.leftProxy && !e.rightProxy, `VR Interact: neither eye draws the pick proxy (L ${e.leftProxy} R ${e.rightProxy})`);

	// ---- 4. back to Edit in VR ------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await A.page.waitForTimeout(200);
	e = await eyes(A.page);
	h.check(e.leftHelper && e.rightHelper, `VR back to Edit: both eyes again (L ${e.leftHelper} R ${e.rightHelper})`);
	await A.page.evaluate(() => window.__stores.isVRMode.set(false));

	// ---- 5. Interact on the desktop and desktop Play hide it too ---------------------------
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await A.page.waitForTimeout(200);
	e = await eyes(A.page);
	h.check(!e.desktop, 'desktop Interact: the editor camera no longer draws the helper');
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(200);
	e = await eyes(A.page);
	h.check(!e.leftHelper && !e.rightHelper, `Play: neither eye (L ${e.leftHelper} R ${e.rightHelper})`);
	await A.page.evaluate(() => window.__stores.isLocked.set(false));
	await A.page.waitForTimeout(400);
	e = await eyes(A.page);
	h.check(e.desktop && e.leftHelper && e.rightHelper, 'leaving Play: the helper is back for both eyes');

	await h.finish(browser);
});
