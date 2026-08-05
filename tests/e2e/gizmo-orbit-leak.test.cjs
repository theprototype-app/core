// 16-Q5: the reported regression, reproduced with a REAL mouse drag on the REAL
// gizmo arrow: preview a camera → Control → Exit → drag an object by its gizmo. The
// view must not rotate, and the object must still move.
//
// The measurement is an A/B — the same drag runs BEFORE the preview cycle and after
// it — so normal viewport behaviour (a left-drag that MISSES the gizmo orbits) can
// never be mistaken for the bug. The bug was a ZOMBIE OrbitControls: threlte does
// not dispose the editor's controls when they unmount (Scene gates them on the
// preview store), so the dropped instance kept its DOM listeners and went on
// rotating the camera — invisible to the suppression path, which only knows about
// the fresh instance that mounts once the preview ends.
const h = require('./helpers.cjs');

const camQuat = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.globalCamera.subscribe((c) => r(c.quaternion.toArray()))())
	);

const objectX = (page, uuid) =>
	page.evaluate(
		(u) =>
			new Promise((r) => {
				let g = null;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				r(g.getObjectByProperty('uuid', u)?.position.x ?? null);
			}),
		uuid
	);

/** screen point on the gizmo's +X translate arrow (the real picker, not a guess) */
const arrowPoint = (page) =>
	page.evaluate(() => {
		let controls = null;
		let cam = null;
		window.__stores.TControls.subscribe((v) => (controls = v))();
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		const helper = controls?.getHelper?.() ?? controls;
		if (!helper || !cam) return null;
		let pick = null;
		helper.traverse((n) => {
			if (!pick && n.isMesh && n.name === 'X') pick = n;
		});
		if (!pick) return null;
		const v = new window.__stores.THREE.Vector3();
		pick.getWorldPosition(v);
		v.project(cam);
		return [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const ids = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 2 2 2');
		w.commandsHandler.sceneCommand('/create Camera');
		await new Promise((r) => setTimeout(r, 400));
		let g = null;
		w.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children.find((c) => c.name === 'Box');
		const cam = g.children[g.children.length - 1];
		box.position.set(0, 1, 0);
		cam.position.set(-5, 3, 6);
		w.objectsGroup.update((v) => v);
		return { box: box.uuid, cam: cam.uuid };
	});
	await A.page.waitForTimeout(400);

	/** select the box, drag its gizmo arrow, report what actually moved */
	async function dragGizmo(label) {
		await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), ids.box);
		await A.page.waitForTimeout(600);
		const point = await arrowPoint(A.page);
		if (!point) return { label, found: false };
		const quatBefore = await camQuat(A.page);
		const xBefore = await objectX(A.page, ids.box);
		await A.page.mouse.move(point[0], point[1]);
		await A.page.mouse.down();
		await A.page.mouse.move(point[0] + 90, point[1] + 6, { steps: 10 });
		await A.page.mouse.up();
		await A.page.waitForTimeout(400);
		const quatAfter = await camQuat(A.page);
		const xAfter = await objectX(A.page, ids.box);
		return {
			label,
			found: true,
			rotated: Math.max(...quatAfter.map((v, i) => Math.abs(v - quatBefore[i]))),
			moved: Math.abs((xAfter ?? 0) - (xBefore ?? 0))
		};
	}

	// ---------- baseline: the same drag before any preview ----------
	const baseline = await dragGizmo('baseline');
	h.check(baseline.found, 'found the gizmo arrow on screen');
	h.check(baseline.moved > 0.1, `the baseline drag moves the object (${baseline.moved?.toFixed(2)})`);
	h.check(baseline.rotated < 0.002, `and does not rotate the view (${baseline.rotated?.toFixed(5)})`);

	// ---------- preview → Control → Exit ----------
	await A.page.evaluate((u) => window.__stores.cameraPreview.startCameraPreview(u), ids.cam);
	await A.page.waitForTimeout(800);
	await A.page.evaluate(() => window.__stores.cameraPreview.toggleCameraControl());
	await A.page.waitForTimeout(800);
	await A.page.evaluate(() => window.__stores.cameraPreview.stopCameraPreview());
	await A.page.waitForTimeout(1000);

	const state = await A.page.evaluate(
		() =>
			new Promise((r) => {
				let editor = null;
				let preview = null;
				window.__stores.orbitControls.subscribe((v) => (editor = v))();
				window.__stores.cameraPreview.previewOrbit.subscribe((v) => (preview = v))();
				r({ hasEditor: !!editor, editorEnabled: editor?.enabled ?? null, previewLive: !!preview });
			})
	);
	h.check(state.hasEditor && state.editorEnabled === true, 'the editor controls are back and enabled');
	h.check(!state.previewLive, 'the preview controls are released');

	// ---------- the same drag AFTER the cycle ----------
	const after = await dragGizmo('after');
	h.check(after.found, 'the gizmo is still reachable after the preview');
	h.check(after.moved > 0.1, `the drag still moves the object (${after.moved?.toFixed(2)})`);
	h.check(
		after.rotated < 0.002,
		`and STILL does not rotate the view — no zombie controls (${after.rotated?.toFixed(5)} vs baseline ${baseline.rotated?.toFixed(5)})`
	);

	// ---------- navigation still works (right-drag PANS in OrbitControls) --------
	const camPos = () =>
		A.page.evaluate(
			() => new Promise((r) => window.__stores.globalCamera.subscribe((c) => r(c.position.toArray()))())
		);
	const beforeNav = await camPos();
	await A.page.mouse.move(250, 520);
	await A.page.mouse.down({ button: 'right' });
	await A.page.mouse.move(360, 470, { steps: 8 });
	await A.page.mouse.up({ button: 'right' });
	await A.page.waitForTimeout(500);
	const afterNav = await camPos();
	const navDelta = Math.max(...afterNav.map((v, i) => Math.abs(v - beforeNav[i])));
	h.check(navDelta > 0.05, `the controls still drive the view after all of that (moved ${navDelta.toFixed(3)})`);

	await h.finish(browser);
});
