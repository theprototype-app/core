// 16-Q4: the camera preview WINDOW (picture-in-picture).
// Selecting a camera object shows a small live view bottom-right; it parks clear
// of an open side panel, right-drags to anywhere on screen (clamped), hides while
// that camera fills the viewport as a full preview, and can be switched off per
// camera in Camera properties.
//
// The IMAGE is an inset scissored viewport drawn by the render loop, so the DOM
// part is only chrome — these checks cover the geometry contract (the rect the
// renderer is handed) plus the visibility rules; the picture itself was verified
// visually (a live view through the camera inside the frame).
const h = require('./helpers.cjs');

const pip = (page) => page.evaluate(() => window.__stores.cameraPip.pipDebug());

const frame = (page) =>
	page.evaluate(() => {
		const el = document.querySelector('.pip');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const uuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 2 2 2');
		w.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 350));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const cam = g.children[g.children.length - 1];
		cam.position.set(-5, 3, 6);
		w.objectsGroup.update((v) => v);
		return cam.uuid;
	});

	// ---------- selecting a camera shows it ----------
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), uuid);
	await A.page.waitForTimeout(600);
	let state = await pip(A.page);
	let box = await frame(A.page);
	h.check(state.target === uuid, `selecting a camera targets the window at it (${state.target === uuid})`);
	h.check(!!box, 'the frame is on screen');
	h.check(
		state.rect && Math.abs(state.rect.x - box.x) < 2 && Math.abs(state.rect.w - box.w) < 2,
		`the published rect matches the frame (${JSON.stringify(state.rect)} vs ${JSON.stringify(box)})`
	);
	const aspect = box.w / box.h;
	h.check(Math.abs(aspect - 16 / 9) < 0.25, `it uses the camera's framing aspect (${aspect.toFixed(2)})`);

	// bottom-right, and INSIDE the viewport
	const viewport = A.page.viewportSize();
	h.check(
		box.x + box.w <= viewport.width && box.y + box.h <= viewport.height,
		`parked fully on screen (${JSON.stringify(box)} in ${viewport.width}x${viewport.height})`
	);
	h.check(box.y > viewport.height / 2, 'parked towards the bottom');

	// ---------- it steps aside for an open panel ----------
	const withPanel = await A.page.evaluate(async (u) => {
		window.__stores.objectActions.selectObject(u, true); // opens Properties
		await new Promise((r) => setTimeout(r, 700));
		const el = document.querySelector('.pip');
		const panel = document.querySelector('#drawer-label')?.getBoundingClientRect();
		const r = el?.getBoundingClientRect();
		return r && panel ? { pipRight: Math.round(r.right), panelLeft: Math.round(panel.left) } : null;
	}, uuid);
	h.check(
		withPanel && withPanel.pipRight <= withPanel.panelLeft + 2,
		`it stays clear of the open panel (${JSON.stringify(withPanel)})`
	);

	// ---------- right-drag moves it ----------
	box = await frame(A.page);
	await A.page.mouse.move(box.x + box.w / 2, box.y + 8);
	await A.page.mouse.down({ button: 'right' });
	await A.page.mouse.move(box.x - 200, box.y - 120, { steps: 8 });
	await A.page.mouse.up({ button: 'right' });
	await A.page.waitForTimeout(400);
	const moved = await frame(A.page);
	h.check(moved && moved.x < box.x - 100, `a right-drag moves the window (${box.x} -> ${moved?.x})`);
	state = await pip(A.page);
	h.check(
		state.rect && Math.abs(state.rect.x - moved.x) < 2,
		'the renderer rect follows the drag'
	);

	// a drag towards the corner clamps instead of leaving the screen
	await A.page.mouse.move(moved.x + moved.w / 2, moved.y + 8);
	await A.page.mouse.down({ button: 'right' });
	await A.page.mouse.move(-400, -400, { steps: 6 });
	await A.page.mouse.up({ button: 'right' });
	await A.page.waitForTimeout(400);
	const clamped = await frame(A.page);
	h.check(clamped && clamped.x >= 0 && clamped.y >= 0, `it clamps on screen (${JSON.stringify(clamped)})`);

	// ---------- hidden while the camera fills the viewport ----------
	await A.page.evaluate((u) => window.__stores.cameraPreview.startCameraPreview(u), uuid);
	await A.page.waitForTimeout(600);
	h.check((await pip(A.page)).target === null, 'no window while you are already inside that camera');
	h.check((await frame(A.page)) === null, 'the frame is gone with it');
	await A.page.evaluate(() => window.__stores.cameraPreview.stopCameraPreview());
	await A.page.waitForTimeout(700);
	h.check((await pip(A.page)).target === uuid, 'it comes back when the preview ends');

	// ---------- per-camera off switch ----------
	await A.page.evaluate((u) => window.__stores.cameraObjects.setCameraFor(u, { pip: false }), uuid);
	await A.page.waitForTimeout(500);
	h.check((await frame(A.page)) === null, 'turning the camera preview off hides the window');
	h.check((await pip(A.page)).rect === null, 'and stops the renderer drawing it');
	await A.page.evaluate((u) => window.__stores.cameraObjects.setCameraFor(u, { pip: true }), uuid);
	await A.page.waitForTimeout(500);
	h.check(!!(await frame(A.page)), 'the setting brings it back');

	// ---------- deselecting hides it ----------
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(500);
	h.check((await frame(A.page)) === null, 'deselecting the camera hides the window');

	// ---------- the DOM→gl rect flip is right (y measured from the bottom) --------
	const flip = await A.page.evaluate(() =>
		window.__stores.cameraPip.glRect({ x: 10, y: 20, w: 100, h: 50 }, 500)
	);
	h.check(
		flip.x === 10 && flip.y === 430 && flip.w === 100 && flip.h === 50,
		`glRect flips the origin for WebGL (${JSON.stringify(flip)})`
	);

	await h.finish(browser);
});
