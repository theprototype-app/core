// 16-P5: scene CAMERA objects.
// A camera is a replicated marker MESH carrying `userData.camera` (the
// userData.physics trick), so create/replicate/undo/sessions come for free.
// Checks: creation + defaults, replication to a peer, Inspector writes (props
// history + objectParameters), frustum proxies at the SCENE root, PREVIEW as a
// true camera swap (an ortho camera really renders orthographic), Control
// writing the pose back with ONE undo entry, Capture, and peers seeing the
// preview state.
const h = require('./helpers.cjs');

const camerasOn = (page) =>
	page.evaluate(() =>
		new Promise((r) =>
			window.__stores.objectsGroup.subscribe((g) => {
				const found = [];
				g?.traverse((n) => {
					if (n.userData?.camera) found.push({ uuid: n.uuid, name: n.name, ...n.userData.camera });
				});
				r(found);
			})()
		)
	);

const activeCamera = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.globalCamera.subscribe((c) =>
					r({
						ortho: !!c?.isOrthographicCamera,
						fov: c?.fov ?? null,
						pos: c?.position?.toArray().map((n) => Math.round(n * 100) / 100) ?? null
					})
				)()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---------- creation + defaults ----------
	await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Camera');
		window.__stores.commandsHandler.sceneCommand('/create CameraOrtho');
	});
	await A.page.waitForTimeout(400);
	let cams = await camerasOn(A.page);
	h.check(cams.length === 2, `two camera objects created (${cams.length})`);
	const persp = cams.find((c) => c.kind === 'perspective');
	const ortho = cams.find((c) => c.kind === 'orthographic');
	h.check(!!persp && persp.fov === 50 && persp.near === 0.1, `perspective defaults (${JSON.stringify(persp)})`);
	h.check(!!ortho && ortho.orthoSize === 5, `orthographic defaults (${JSON.stringify(ortho)})`);
	h.check(persp.aspect === '16:9' && persp.guide === true, 'framing defaults to 16:9 with the guide on');

	// a camera marker must not be a physics body or a shadow caster
	const flags = await A.page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g.getObjectByProperty('uuid', uuid);
					r({ physics: !!o?.userData?.physics, shadow: o?.userData?.shadow, cast: o?.castShadow });
				})()
			),
		persp.uuid
	);
	h.check(!flags.physics && flags.shadow === false && flags.cast === false, `markers stay scenery-free (${JSON.stringify(flags)})`);

	// ---------- replication ----------
	await B.page.waitForTimeout(1500);
	let peerCams = await camerasOn(B.page);
	h.check(peerCams.length === 2, `both cameras replicated to the peer (${peerCams.length})`);
	h.check(
		peerCams.some((c) => c.uuid === persp.uuid && c.kind === 'perspective'),
		'userData.camera rode the create message'
	);

	// ---------- Inspector write: history + replication ----------
	await A.page.evaluate((uuid) => window.__stores.cameraObjects.setCameraFor(uuid, { fov: 80 }), persp.uuid);
	await A.page.waitForTimeout(600);
	h.check((await camerasOn(A.page)).find((c) => c.uuid === persp.uuid).fov === 80, 'FOV write applies locally');
	await h.eventually(
		() => camerasOn(B.page),
		(list) => list.find((c) => c.uuid === persp.uuid)?.fov === 80,
		'the FOV write replicated'
	);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(500);
	h.check((await camerasOn(A.page)).find((c) => c.uuid === persp.uuid).fov === 50, 'undo restores the previous FOV');
	await h.eventually(
		() => camerasOn(B.page),
		(list) => list.find((c) => c.uuid === persp.uuid)?.fov === 50,
		'the undo replicated too'
	);

	// ---------- frustum viz lives at the SCENE root ----------
	const viz = await A.page.evaluate(() => window.__stores.cameraHelpers.cameraHelpersDebug());
	h.check(viz.length === 2, `a frustum proxy per camera (${viz.length})`);
	const vizPlacement = await A.page.evaluate(
		() =>
			new Promise((r) => {
				let scene = null;
				let objects = null;
				window.__stores.globalScene.subscribe((s) => (scene = s))();
				window.__stores.objectsGroup.subscribe((g) => (objects = g))();
				const root = scene.getObjectByName('camera-frustums');
				let underObjects = false;
				let parent = root?.parent;
				while (parent) {
					if (parent === objects) underObjects = true;
					parent = parent.parent;
				}
				r({ exists: !!root, underObjects, children: root?.children.length ?? 0 });
			})
	);
	h.check(
		vizPlacement.exists && !vizPlacement.underObjects && vizPlacement.children === 2,
		`frustums are scene-root only (${JSON.stringify(vizPlacement)})`
	);
	// the frustum follows its marker
	await A.page.evaluate((uuid) => {
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		g.getObjectByProperty('uuid', uuid).position.set(4, 2, -6);
	}, persp.uuid);
	await A.page.waitForTimeout(400);
	const followed = await A.page.evaluate(() => window.__stores.cameraHelpers.cameraHelpersDebug());
	h.check(
		followed.some((v) => v.position[0] === 4 && v.position[2] === -6),
		`the frustum follows the marker (${JSON.stringify(followed.map((v) => v.position))})`
	);

	// ---------- PREVIEW = a real camera swap ----------
	const editorBefore = await activeCamera(A.page);
	h.check(!editorBefore.ortho, 'the editor camera is perspective to begin with');
	await A.page.evaluate((uuid) => window.__stores.cameraPreview.startCameraPreview(uuid), ortho.uuid);
	await A.page.waitForTimeout(900);
	const previewing = await activeCamera(A.page);
	h.check(previewing.ortho === true, 'previewing an ORTHO camera really renders orthographic (true swap)');
	const bannerText = await A.page.evaluate(() => document.querySelector('.preview-banner')?.textContent?.trim() ?? '');
	h.check(/Previewing/.test(bannerText), `the mode banner shows what you're in (${bannerText.slice(0, 40)})`);
	// its own frustum is hidden while you're inside it
	const insideViz = await A.page.evaluate(() => window.__stores.cameraHelpers.cameraHelpersDebug());
	h.check(
		insideViz.find((v) => v.uuid === ortho.uuid)?.visible === false,
		'the previewed camera hides its own frustum'
	);

	// peers see the preview
	await h.eventually(
		() =>
			B.page.evaluate(
				() => new Promise((r) => window.__stores.cameraPreview.cameraPreviews.subscribe((m) => r(Object.values(m)))())
			),
		(list) => list.includes(ortho.uuid),
		'peers see which camera is being previewed'
	);

	// ---------- Control: WASD flying writes back, ONE undo entry ----------
	const undoDepth = () =>
		A.page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));
	await A.page.evaluate(() => window.__stores.cameraPreview.toggleCameraControl());
	await A.page.waitForTimeout(300);
	const before = await A.page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(g.getObjectByProperty('uuid', uuid).position.toArray())
				)()
			),
		ortho.uuid
	);
	// fly: hold W for a moment (the nav runs against the ACTIVE camera, which is
	// the preview camera now)
	await A.page.mouse.move(600, 400);
	await A.page.keyboard.down('w');
	await A.page.waitForTimeout(700);
	await A.page.keyboard.up('w');
	await A.page.waitForTimeout(300);
	const after = await A.page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(g.getObjectByProperty('uuid', uuid).position.toArray())
				)()
			),
		ortho.uuid
	);
	const flew = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
	h.check(flew > 0.2, `flying the camera moved the MARKER (${flew.toFixed(2)} units)`);
	await h.eventually(
		() => camerasOn(B.page),
		() => true,
		'peer state still readable'
	);
	const peerPos = await B.page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g.getObjectByProperty('uuid', uuid);
					r(o ? o.position.toArray() : null);
				})()
			),
		ortho.uuid
	);
	h.check(
		peerPos && Math.hypot(peerPos[0] - after[0], peerPos[2] - after[2]) < 0.6,
		`the flight replicated (peer ${JSON.stringify(peerPos?.map((n) => Math.round(n * 10) / 10))})`
	);

	// stopping control leaves exactly ONE undo entry for the whole ride
	const stacksBefore = await undoDepth();
	await A.page.evaluate(() => window.__stores.cameraPreview.toggleCameraControl());
	await A.page.waitForTimeout(300);
	const stacksAfter = await undoDepth();
	if (stacksBefore === null || stacksAfter === null) {
		// no debug accessor: fall back to asserting a single undo restores the pose
		await A.page.evaluate(() => window.__stores.history.undo());
		await A.page.waitForTimeout(400);
		const restored = await A.page.evaluate(
			(uuid) =>
				new Promise((r) =>
					window.__stores.objectsGroup.subscribe((g) =>
						r(g.getObjectByProperty('uuid', uuid).position.toArray())
					)()
				),
			ortho.uuid
		);
		h.check(
			Math.hypot(restored[0] - before[0], restored[1] - before[1], restored[2] - before[2]) < 0.05,
			`ONE undo restores the pre-flight pose (${restored.map((n) => Math.round(n * 100) / 100)})`
		);
	} else {
		h.check(stacksAfter - stacksBefore === 1, `the ride recorded exactly one undo entry (+${stacksAfter - stacksBefore})`);
	}

	// ---------- exiting the preview restores your own view ----------
	await A.page.evaluate(() => window.__stores.cameraPreview.stopCameraPreview());
	await A.page.waitForTimeout(900);
	const back = await activeCamera(A.page);
	h.check(back.ortho === false, 'exiting returns to your own perspective camera');
	const bannerGone = await A.page.evaluate(() => !document.querySelector('.preview-banner'));
	h.check(bannerGone, 'the banner goes with it');
	await h.eventually(
		() =>
			B.page.evaluate(
				() => new Promise((r) => window.__stores.cameraPreview.cameraPreviews.subscribe((m) => r(Object.keys(m)))())
			),
		(keys) => keys.length === 0,
		'peers see the preview end'
	);

	// ---------- Capture renders through the camera ----------
	const capture = await A.page.evaluate(
		(uuid) => window.__stores.cameraObjects.captureThroughCamera(uuid, 360),
		persp.uuid
	);
	h.check(
		capture && capture.height === 360 && capture.width === 640,
		`Capture renders at the framing aspect (${JSON.stringify(capture)})`
	);

	await h.finish(browser);
});
