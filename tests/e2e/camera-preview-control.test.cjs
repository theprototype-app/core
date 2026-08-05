// 16-P5 follow-up: the two Control bugs.
//  1. Pressing Control SNAPPED the view to the world origin — a fresh
//     OrbitControls targets (0,0,0) and its update() ends with
//     camera.lookAt(target), so mounting it rotated the camera. The controls are
//     now seated behind the camera first, so the pose survives.
//  2. After exiting the preview, dragging the transform gizmo also ORBITED the
//     camera: both sets of OrbitControls were bound to the same store, and the
//     preview's unmount could clear it after the editor's remounted — so every
//     `$orbitControls.enabled = false` suppression silently no-oped. The preview
//     now publishes its own `previewOrbit`, and Scene suppresses/steers through
//     the derived `activeOrbit`.
const h = require('./helpers.cjs');

const camQuat = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.globalCamera.subscribe((c) => r(c.quaternion.toArray()))()
			)
	);

const orbitState = (page) =>
	page.evaluate(
		() =>
			new Promise((r) => {
				let editor = null;
				let preview = null;
				let active = null;
				window.__stores.orbitControls.subscribe((v) => (editor = v))();
				window.__stores.cameraPreview.previewOrbit.subscribe((v) => (preview = v))();
				window.__stores.cameraPreview.activeOrbit.subscribe((v) => (active = v))();
				r({
					hasEditor: !!editor,
					editorEnabled: editor?.enabled ?? null,
					hasPreview: !!preview,
					activeIsEditor: !!active && active === editor,
					activeIsPreview: !!active && active === preview
				});
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// a camera aimed at the origin from an angle (aimed the CAMERA way: -Z forward)
	const uuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 2 2 2');
		w.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 300));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const cam = g.children[g.children.length - 1];
		cam.position.set(-5, 4, 7);
		const m = new w.THREE.Matrix4().lookAt(
			cam.position,
			new w.THREE.Vector3(0, 1, 0),
			new w.THREE.Vector3(0, 1, 0)
		);
		cam.quaternion.setFromRotationMatrix(m);
		cam.updateMatrix();
		w.objectsGroup.update((v) => v);
		return cam.uuid;
	});
	await A.page.waitForTimeout(300);

	// ---------- 1. Control must not move the view ----------
	await A.page.evaluate((u) => window.__stores.cameraPreview.startCameraPreview(u), uuid);
	await A.page.waitForTimeout(800);
	const beforeControl = await camQuat(A.page);
	await A.page.evaluate(() => window.__stores.cameraPreview.toggleCameraControl());
	await A.page.waitForTimeout(700);
	const afterControl = await camQuat(A.page);
	const drift = Math.max(...afterControl.map((v, i) => Math.abs(v - beforeControl[i])));
	h.check(drift < 0.02, `pressing Control keeps the view where it was (max component drift ${drift.toFixed(4)})`);

	// the preview owns the controls while controlling
	let state = await orbitState(A.page);
	h.check(state.hasPreview && state.activeIsPreview, `Control publishes its own controls (${JSON.stringify(state)})`);

	// the seated target sits in FRONT of the camera, not at the origin
	const targetInFront = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.cameraPreview.previewOrbit.subscribe((c) => {
					if (!c) return r(null);
					let cam = null;
					window.__stores.globalCamera.subscribe((v) => (cam = v))();
					const forward = new window.__stores.THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
					const toTarget = c.target.clone().sub(cam.position).normalize();
					r(forward.dot(toTarget));
				})()
			)
	);
	h.check(targetInFront !== null && targetInFront > 0.95, `the orbit target is seated straight ahead (dot ${targetInFront})`);

	// ---------- 2. exiting restores a LIVE editor controls object ----------
	await A.page.evaluate(() => window.__stores.cameraPreview.stopCameraPreview());
	await A.page.waitForTimeout(900);
	state = await orbitState(A.page);
	h.check(state.hasEditor, 'the editor controls are back');
	h.check(!state.hasPreview, 'the preview controls are released');
	h.check(state.activeIsEditor, 'suppression + navigation route back to the editor controls');

	// they are actually WIRED: attached to the CURRENT editor camera and listening on
	// the canvas (a stale instance left over from the preview would fail both)
	const wiring = await A.page.evaluate(
		() =>
			new Promise((r) => {
				let controls = null;
				let cam = null;
				window.__stores.orbitControls.subscribe((v) => (controls = v))();
				window.__stores.globalCamera.subscribe((v) => (cam = v))();
				r({
					attachedToActiveCamera: !!controls && controls.object === cam,
					listening: !!controls?.domElement,
					enabled: controls?.enabled === true
				});
			})
	);
	h.check(
		wiring.attachedToActiveCamera && wiring.listening && wiring.enabled,
		`the restored controls drive the live camera and listen for input (${JSON.stringify(wiring)})`
	);

	// ...and the gizmo suppression path can still switch them off (this is the
	// store write that used to hit nothing)
	const suppressed = await A.page.evaluate(async () => {
		let active = null;
		window.__stores.cameraPreview.activeOrbit.subscribe((v) => (active = v))();
		if (!active) return null;
		active.enabled = false;
		const off = active.enabled === false;
		active.enabled = true;
		return off;
	});
	h.check(suppressed === true, 'the gizmo-drag suppression reaches live controls');

	// a second preview cycle stays healthy (no accumulated stale refs)
	await A.page.evaluate((u) => window.__stores.cameraPreview.startCameraPreview(u), uuid);
	await A.page.waitForTimeout(700);
	await A.page.evaluate(() => window.__stores.cameraPreview.toggleCameraControl());
	await A.page.waitForTimeout(500);
	await A.page.evaluate(() => window.__stores.cameraPreview.stopCameraPreview());
	await A.page.waitForTimeout(900);
	state = await orbitState(A.page);
	h.check(
		state.hasEditor && !state.hasPreview && state.activeIsEditor,
		`a second preview+control cycle leaves the controls clean (${JSON.stringify(state)})`
	);


	// ---------- 16-Q6: exiting must not recentre your look-at on the origin --------
	const target = () =>
		A.page.evaluate(
			() =>
				new Promise((r) =>
					window.__stores.orbitControls.subscribe((c) =>
						r(c?.target ? c.target.toArray().map((n) => Math.round(n * 100) / 100) : null)
					)()
				)
		);
	// put the look-at somewhere distinctive
	await A.page.evaluate(() => {
		let c = null;
		window.__stores.orbitControls.subscribe((v) => (c = v))();
		c.target.set(6, 2, -3);
		c.update();
	});
	await A.page.waitForTimeout(300);
	const before = await target();
	await A.page.evaluate((u) => window.__stores.cameraPreview.startCameraPreview(u), uuid);
	await A.page.waitForTimeout(700);
	await A.page.evaluate(() => window.__stores.cameraPreview.toggleCameraControl());
	await A.page.waitForTimeout(700);
	await A.page.evaluate(() => window.__stores.cameraPreview.stopCameraPreview());
	await A.page.waitForTimeout(1200);
	const restored = await target();
	h.check(
		restored && before && Math.hypot(restored[0] - before[0], restored[1] - before[1], restored[2] - before[2]) < 0.05,
		`the look-at point survives preview + Control + exit (${JSON.stringify(before)} -> ${JSON.stringify(restored)})`
	);
	h.check(
		restored && Math.hypot(restored[0], restored[2]) > 1,
		'it did not snap back to the world origin'
	);

	await h.finish(browser);
});
