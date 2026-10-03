// 34 B4 — VR-EYE SCREENSHOTS, proved. `vrEyes.cjs` renders the two headset eyes off-screen the
// way three's WebXRManager does (layer masks by its formula, an XR-flagged sRGB target, the EYE
// camera through every onBeforeRender seam). This suite proves the pictures tell the two things
// they exist for, each with its counterfactual in the same run:
//
// 1 WHICH EYE SEES IT — a point light's helper: BOTH eyes in Edit, NEITHER in Interact (the C1
//   contract vr-helper-eyes computes from masks — here it is pixels), and the 30b bug PLANTED
//   (the helper put back on layer 1): the LEFT eye only. A harness that rendered both eyes with
//   one mask would pass 1a/1b and fail 1c.
// 2 IS IT OCCLUDED — a red box parked between the eyes and (a) a plain mesh: hidden in both
//   eyes; (b) the same mesh registered as a VR panel (api.vrPanel, 31 K2 on-top overlay): fully
//   visible in both. Without the overlay seam running for the eye cameras, 2b reads as 2a.
// 3 THE PAIR IS A PAIR — the two pictures differ (parallax at the IPD), and the masks are three's.
//
// EYE_SHOTS_DIR=<dir> keeps the PNGs (left / right / side-by-side pair) for a human to look at.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
const eyes = require('./vrEyes.cjs');

const XR_SOURCE = path.join(__dirname, '..', '..', 'node_modules', 'three', 'src', 'renderers', 'webxr', 'WebXRManager.js');
const OUT = process.env.EYE_SHOTS_DIR || null;

h.run(async () => {
	// ---- 0. the premise: three still reserves layers 1/2 for the eyes (the masks copy it) ------
	const src = fs.readFileSync(XR_SOURCE, 'utf8');
	h.check(
		/cameraL\.layers\.mask\s*=\s*cameraXR\.layers\.mask\s*&\s*~\s*0b100/.test(src) &&
			/cameraR\.layers\.mask\s*=\s*cameraXR\.layers\.mask\s*&\s*~\s*0b010/.test(src) &&
			/cameraXR\.layers\.mask\s*=\s*camera\.layers\.mask\s*\|\s*0b110/.test(src),
		'premise: three WebXRManager still gives the left eye layer 1 and the right eye layer 2'
	);
	h.check(/newRenderTarget\.isXRRenderTarget\s*=\s*true/.test(src), 'premise: three still renders a headset into an isXRRenderTarget-flagged target');

	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	if (OUT) fs.mkdirSync(OUT, { recursive: true });
	const keep = async (name) => {
		if (OUT) console.log('  saved ' + (await eyes.save(page, path.join(OUT, name))).pair);
	};
	await page.evaluate(async () => {
		const s = window.__stores;
		s.viewMode.set('shaded');
		await s.moduleSDK.initModules([{ id: 'eyes34', name: 'Eyes', version: '1.0.0', description: '34 B4', register(api) { window.__api = api; } }]);
	});
	await xr.install(page);
	// controllers far off, aiming up: their rays must not cross the pictures
	await xr.pose(page, 'left', [-20, 30, 20], { pitch: 1.4 });
	await xr.pose(page, 'right', [20, 30, 20], { pitch: 1.4 });

	// ---- 1. which eye sees the light helper ---------------------------------------------------
	console.log('\n=== 1 which eye sees the helper ===');
	const lightAt = await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/light point');
		s.objectActions.deselectObject();
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		let light = null;
		g.traverse((o) => {
			if (!light && o.isPointLight) light = o;
		});
		return light ? light.getWorldPosition(new s.THREE.Vector3()).toArray() : null;
	});
	h.check(!!lightAt, `a point light was made (${JSON.stringify(lightAt)})`);
	await h.eventually(
		() => page.evaluate(() => {
			let sc;
			window.__stores.globalScene.subscribe((v) => (sc = v))();
			return sc.children.some((c) => /LightHelper$/.test(c.type || ''));
		}),
		(v) => v,
		'the light has its helper',
		10000
	);
	await page.evaluate((at) => window.__stores.objectActions.flyTo([at[0], at[1], at[2] + 1.6], at, 0), lightAt);
	await page.waitForTimeout(500);
	const helperType = await page.evaluate(() => {
		let sc;
		window.__stores.globalScene.subscribe((v) => (sc = v))();
		return sc.children.find((c) => /LightHelper$/.test(c.type || '')).type;
	});

	let v = await eyes.visibility(page, helperType);
	h.check(!v.error, `the helper is found by type ${helperType} (${v.error ?? 'ok'})`);
	h.check(v.left.visiblePx > 40 && v.right.visiblePx > 40, `1a Edit: BOTH eyes draw the helper (L ${v.left.visiblePx} px, R ${v.right.visiblePx} px)`);
	await keep('1a-edit-both-eyes');

	await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await page.waitForTimeout(400);
	v = await eyes.visibility(page, helperType);
	h.check(v.left.visiblePx === 0 && v.right.visiblePx === 0, `1b Interact: NEITHER eye draws it (L ${v.left.visiblePx} px, R ${v.right.visiblePx} px)`);
	await keep('1b-interact-no-eye');
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await page.waitForTimeout(400);

	// the 30b bug, planted: the helper on layer 1 (three's LEFT-eye layer)
	const was = await page.evaluate((type) => {
		let sc;
		window.__stores.globalScene.subscribe((x) => (sc = x))();
		const hlp = sc.children.find((c) => c.type === type);
		const mask = hlp.layers.mask;
		hlp.traverse((o) => o.layers.set(1));
		return mask;
	}, helperType);
	v = await eyes.visibility(page, helperType);
	h.check(v.left.visiblePx > 40 && v.right.visiblePx === 0, `1c the 30b bug planted (layer 1): the LEFT eye only (L ${v.left.visiblePx} px, R ${v.right.visiblePx} px)`);
	await keep('1c-layer1-left-eye-only');
	await page.evaluate(
		({ type, mask }) => {
			let sc;
			window.__stores.globalScene.subscribe((x) => (sc = x))();
			sc.children.find((c) => c.type === type).traverse((o) => (o.layers.mask = mask));
		},
		{ type: helperType, mask: was }
	);
	await page.evaluate(() => {
		const s = window.__stores;
		let sc;
		s.globalScene.subscribe((x) => (sc = x))();
		for (const c of sc.children.filter((c) => /LightHelper$/.test(c.type || ''))) c.visible = false;
	});

	// ---- 2. is it occluded --------------------------------------------------------------------
	console.log('\n=== 2 is it occluded ===');
	const AT = [6, 1.5, -2];
	await page.evaluate((at) => {
		const api = window.__api;
		const THREE = api.THREE;
		const mk = (name, color, geo) => {
			const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, toneMapped: false }));
			m.name = name;
			api.scene().add(m);
			return m;
		};
		const target = mk('b4-target', 0x00ff66, new THREE.PlaneGeometry(0.6, 0.3));
		target.position.set(...at);
		const box = mk('b4-blocker', 0xff0000, new THREE.BoxGeometry(1.2, 1.2, 0.1));
		box.position.set(at[0], at[1], at[2] + 1);
		target.updateMatrixWorld(true);
		box.updateMatrixWorld(true);
		window.__stores.objectActions.flyTo([at[0], at[1], at[2] + 2], at, 0);
	}, AT);
	await page.waitForTimeout(500);
	v = await eyes.visibility(page, 'b4-target');
	h.check(v.left.footprintPx > 500 && v.right.footprintPx > 500, `the target covers pixels in both eyes when drawn alone (L ${v.left.footprintPx}, R ${v.right.footprintPx})`);
	h.check(v.left.fraction < 0.05 && v.right.fraction < 0.05, `2a a plain mesh behind the box: hidden in both eyes (L ${v.left.fraction}, R ${v.right.fraction})`);
	await keep('2a-plain-mesh-occluded');

	const panel = await page.evaluate(() => {
		const api = window.__api;
		let sc;
		window.__stores.globalScene.subscribe((x) => (sc = x))();
		const t = sc.getObjectByName('b4-target');
		window.__b4off = api.vrPanel(t);
		return { order: t.renderOrder, off: typeof window.__b4off };
	});
	await page.waitForTimeout(300);
	v = await eyes.visibility(page, 'b4-target');
	h.check(v.left.fraction > 0.9 && v.right.fraction > 0.9, `2b the same mesh as a VR panel (order ${panel.order}): over the box in both eyes (L ${v.left.fraction}, R ${v.right.fraction})`);
	await keep('2b-vr-panel-on-top');

	// ---- 3. the pair is a pair -------------------------------------------------------------------
	console.log('\n=== 3 the pair ===');
	const shot = await eyes.shoot(page, { size: 256 });
	h.check(shot.left.length > 1000 && shot.right.length > 1000 && shot.pair.length > shot.left.length, `PNGs: left ${shot.left.length} B, right ${shot.right.length} B, pair ${shot.pair.length} B`);
	h.check(!shot.left.equals(shot.right), 'the two eyes are different pictures (parallax at the IPD)');
	const cam = await page.evaluate(() => {
		let c;
		window.__stores.globalCamera.subscribe((x) => (c = x))();
		return c.layers.mask;
	});
	h.check(shot.masks.left === ((cam | 0b110) & ~0b100) && shot.masks.right === ((cam | 0b110) & ~0b010), `the eye masks are three's (L ${shot.masks.left.toString(2)}, R ${shot.masks.right.toString(2)})`);

	await h.finish(browser);
});
