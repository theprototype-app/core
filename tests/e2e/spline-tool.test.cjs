// Phase 57 — spline tool: variable-radius tube builder (57.1), click placement
// from the draw toolbar (57.2), the control-point/radius edit session with
// insert + delete (57.3), the VR carry path (57.4) and the Properties rows
// (57.5). Two peers + a late joiner, because only the RECORD replicates.
const h = require('./helpers.cjs');

/** the live spline object on a page: uuid + record + geometry shape */
const splineInfo = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const mesh = g?.children.find((c) => c.name === 'Spline');
					resolve(
						mesh
							? {
									uuid: mesh.uuid,
									points: mesh.userData.spline?.points?.length ?? 0,
									radii: (mesh.userData.spline?.points ?? []).map((p) => p.radius),
									color: mesh.userData.spline?.color,
									closed: !!mesh.userData.spline?.closed,
									verts: mesh.geometry?.attributes?.position?.count ?? 0,
									indexed: !!mesh.geometry?.index,
									matColor: mesh.material?.color?.getHexString?.()
								}
							: null
					);
				})();
			})
	);

const undoDepth = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));

/** screen pixel of a world-space point on that page */
const project = (page, world) => h.projectPoint(page, world);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- 57.1 the pure builder ------------------------------------------
	const geo = await A.page.evaluate(() => {
		const { buildSplineGeometry, radiusAt, insertSplinePoint, removeSplinePoint, radiusFromDrag, normalizeSpline } =
			window.__stores.splineTube;
		// a straight run along X that fattens towards the end
		const record = {
			points: [
				{ pos: [0, 0, 0], radius: 0.1 },
				{ pos: [1, 0, 0], radius: 0.1 },
				{ pos: [2, 0, 0], radius: 0.5 },
				{ pos: [3, 0, 0], radius: 0.5 }
			],
			color: '#00ff88',
			closed: false
		};
		const g1 = buildSplineGeometry(record);
		const g2 = buildSplineGeometry(record);
		const p1 = Array.from(g1.attributes.position.array);
		const p2 = Array.from(g2.attributes.position.array);
		// ring radius near the start vs near the end (distance from the X axis)
		let thinMax = 0;
		let fatMax = 0;
		for (let i = 0; i < p1.length; i += 3) {
			const r = Math.hypot(p1[i + 1], p1[i + 2]);
			if (p1[i] < 0.3) thinMax = Math.max(thinMax, r);
			if (p1[i] > 2.7) fatMax = Math.max(fatMax, r);
		}
		const inserted = insertSplinePoint(record, 1);
		const refused = removeSplinePoint({ points: record.points.slice(0, 2) }, 0);
		return {
			deterministic: JSON.stringify(p1) === JSON.stringify(p2),
			hasNormals: !!g1.attributes.normal && !!g1.attributes.uv,
			indexed: !!g1.index,
			thinMax,
			fatMax,
			radiusStart: radiusAt([0.1, 0.1, 0.5, 0.5], 0, false),
			radiusEnd: radiusAt([0.1, 0.1, 0.5, 0.5], 1, false),
			insertedCount: inserted.points.length,
			insertedRadius: inserted.points[2].radius,
			refused,
			gainUp: radiusFromDrag(0.1, 60, 0.01),
			gainDown: radiusFromDrag(0.1, -60, 0.01),
			clamped: radiusFromDrag(0.1, 100000, 0.01),
			normalizedClosed: normalizeSpline({ points: record.points.slice(0, 2), closed: true }).closed
		};
	});
	h.check(geo.deterministic, 'builder is deterministic (same record -> same vertices)');
	h.check(geo.hasNormals && geo.indexed, 'tube carries normals + uvs and is indexed');
	h.check(
		Math.abs(geo.thinMax - 0.1) < 0.02 && Math.abs(geo.fatMax - 0.5) < 0.05,
		'radius VARIES along the spline (0.1 at the start, 0.5 at the end)'
	);
	h.check(geo.radiusStart === 0.1 && geo.radiusEnd === 0.5, 'radiusAt lands exactly on the end control points');
	h.check(geo.insertedCount === 5 && geo.insertedRadius > 0.09, 'insertSplinePoint adds a point with a blended radius');
	h.check(geo.refused === null, 'removeSplinePoint refuses to go below two points');
	h.check(geo.gainUp > 0.1 && geo.gainDown < 0.1 && geo.clamped <= 50, 'radiusFromDrag scales up/down and clamps');
	h.check(geo.normalizedClosed === false, 'a 2-point record can never be closed');

	// ---- 57.2 placement from the draw toolbar ---------------------------
	await A.page.evaluate(() => {
		window.__stores.drawMode.drawColor.set('#22aaff');
		window.__stores.drawMode.drawSize.set(0.08);
		window.__stores.drawMode.toggleDrawMode();
	});
	await A.page.waitForTimeout(400);
	h.check(await A.page.locator('#draw-toolbar').isVisible(), 'draw toolbar appears');
	await A.page.locator('#draw-tool-spline').click();
	await A.page.waitForTimeout(200);
	const toolIsSpline = await A.page.evaluate(
		() => new Promise((r) => window.__stores.drawMode.drawTool.subscribe((v) => r(v))())
	);
	h.check(toolIsSpline === 'spline', 'the toolbar switches the draw tool to Spline');

	// four clicks on the ground plane (real pixels, projected from world points)
	const worldPoints = [
		[-2, 0, -1],
		[-0.7, 0, 0.6],
		[0.8, 0, -0.6],
		[2.1, 0, 0.8]
	];
	for (const world of worldPoints) {
		const at = await project(A.page, world);
		await A.page.mouse.click(at.x, at.y);
		await A.page.waitForTimeout(250);
	}
	await h.eventually(
		() => A.page.locator('#draw-spline-count').textContent(),
		(text) => text?.trim() === '4 points',
		'four control points placed'
	);
	const previewLive = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.globalScene.subscribe((scene) => {
					const preview = scene.getObjectByName('spline-preview');
					r(!!preview && !!preview.getObjectByName('spline-preview-tube')?.visible);
				})()
			)
	);
	h.check(previewLive, 'a live tube preview follows the placed points');

	await A.page.locator('#draw-spline-finish').click();
	await A.page.waitForTimeout(600);
	const spline = await splineInfo(A.page);
	h.check(
		spline?.points === 4 && spline.verts > 0 && spline.indexed,
		'Finish creates a Spline mesh carrying its 4-point record'
	);
	h.check(spline?.color === '#22aaff' && spline?.matColor === '22aaff', 'the toolbar colour becomes the spline colour');
	h.check(
		Math.abs(spline.radii[0] - 0.08) < 1e-6,
		'the toolbar size becomes the initial per-point radius'
	);
	const previewGone = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.globalScene.subscribe((scene) => r(!scene.getObjectByName('spline-preview')))()
			)
	);
	h.check(previewGone, 'the preview is disposed on finish');
	await h.eventually(
		() => splineInfo(B.page),
		(s) => s?.uuid === spline.uuid && s.points === 4,
		'spline replicates to B with its record (same uuid)'
	);
	// draw mode stays armed so several splines can be placed in a row
	h.check(await A.page.locator('#draw-toolbar').isVisible(), 'draw mode stays armed after Finish');
	await A.page.evaluate(() => window.__stores.drawMode.toggleDrawMode());
	await A.page.waitForTimeout(300);

	// ---- 57.3 the edit session ------------------------------------------
	await A.page.evaluate((uuid) => window.__stores.splineEdit.enterSplineEdit(uuid), spline.uuid);
	await A.page.waitForTimeout(500);
	h.check(await A.page.locator('#spline-edit-toolbar').isVisible(), 'the spline edit toolbar appears');
	// 21-C2: it rides the SHARED ToolboxWindow shell now (key splineToolbox), which
	// is where the header-only drag, the width grip, windowSize clamping and the
	// <=640px bottom sheet come from. Assert the SHELL parts — an id alone would
	// pass for the old hand-rolled strip.
	const shell = await A.page.evaluate(() => {
		const root = document.querySelector('#spline-edit-toolbar');
		return {
			toolbox: !!root?.classList.contains('toolbox'),
			headerDrag: !!root?.querySelector('.toolbox-header.move-handle'),
			grip: !!root?.querySelector('.dw-resize'),
			status: !!root?.querySelector('.toolbox-status'),
			// every number is a DragRow (.dn-input), never a bare <input type=number>
			dragRows: root?.querySelectorAll('.dn-input').length ?? 0,
			numberInputs: root?.querySelectorAll('input[type="number"]').length ?? 0
		};
	});
	h.check(
		shell.toolbox && shell.headerDrag && shell.grip && shell.status,
		'the toolbar is a ToolboxWindow (header drag + width grip + status footer)'
	);
	h.check(
		shell.dragRows === 2 && shell.numberInputs === 0,
		`thickness + sides are DragRows, not number inputs (${shell.dragRows} rows, ${shell.numberInputs} number inputs)`
	);
	let debug = await A.page.evaluate(() => window.__stores.splineEdit.splineEditDebug());
	h.check(
		debug.handles?.point === 4 && debug.handles?.radius === 4 && debug.handles?.mid === 3,
		'handles: one per point, one radius dot per point, one insert marker per span'
	);
	await h.eventually(
		() =>
			B.page.evaluate(
				(uuid) =>
					new Promise((r) =>
						window.__stores.lockedObjects.subscribe((locks) => r(!!locks.find((l) => l[1] === uuid)))()
					),
				spline.uuid
			),
		(locked) => locked === true,
		'entering the session locks the spline for peers'
	);

	// pick a control point handle with a real click
	const handleWorld = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const mesh = g.children.find((c) => c.name === 'Spline');
					const p = mesh.userData.spline.points[1].pos;
					const v = new window.__stores.THREE.Vector3(p[0], p[1], p[2]);
					mesh.localToWorld(v);
					r([v.x, v.y, v.z]);
				})()
			)
	);
	const handleAt = await project(A.page, handleWorld);
	await A.page.mouse.click(handleAt.x, handleAt.y);
	await A.page.waitForTimeout(300);
	debug = await A.page.evaluate(() => window.__stores.splineEdit.splineEditDebug());
	h.check(debug.selected === 1, 'clicking a control-point handle selects it (gizmo seats on it)');
	const stillEditing = await A.page.evaluate(
		() => new Promise((r) => window.__stores.splineEdit.splineEditObject.subscribe((v) => r(v))())
	);
	h.check(stillEditing === spline.uuid, 'the click never falls through to object selection');

	// radius drag: grab the amber dot above point 1 and pull it UP
	const radiusWorld = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const mesh = g.children.find((c) => c.name === 'Spline');
					const point = mesh.userData.spline.points[1];
					const v = new window.__stores.THREE.Vector3(point.pos[0], point.pos[1], point.pos[2]);
					mesh.localToWorld(v);
					r([v.x, v.y + point.radius * 1.8, v.z]);
				})()
			)
	);
	const radiusDotAt = await project(A.page, radiusWorld);
	const beforeUndo = await undoDepth(A.page);
	await A.page.mouse.move(radiusDotAt.x, radiusDotAt.y);
	await A.page.mouse.down();
	for (let i = 1; i <= 6; i++) {
		await A.page.mouse.move(radiusDotAt.x, radiusDotAt.y - i * 12);
		await A.page.waitForTimeout(40);
	}
	await A.page.mouse.up();
	await A.page.waitForTimeout(500);
	const fattened = await splineInfo(A.page);
	h.check(fattened.radii[1] > spline.radii[1] * 1.5, 'dragging the radius dot up thickens THAT control point');
	h.check(
		Math.abs(fattened.radii[0] - spline.radii[0]) < 1e-6,
		'the other points keep their radius (per-point thickness)'
	);
	h.check((await undoDepth(A.page)) === beforeUndo + 1, 'the whole radius drag is ONE undo entry');
	await h.eventually(
		() => splineInfo(B.page),
		(s) => s && Math.abs(s.radii[1] - fattened.radii[1]) < 1e-6,
		'the radius edit replicates to B'
	);

	// insert a point by clicking a span marker
	const midWorld = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const mesh = g.children.find((c) => c.name === 'Spline');
					const curve = window.__stores.splineTube.splineCurve(mesh.userData.spline);
					const v = curve.getPoint(0.5 / 3); // the middle of span 0
					mesh.localToWorld(v);
					r([v.x, v.y, v.z]);
				})()
			)
	);
	const midAt = await project(A.page, midWorld);
	await A.page.mouse.click(midAt.x, midAt.y);
	await A.page.waitForTimeout(500);
	h.check((await splineInfo(A.page)).points === 5, 'clicking a span marker inserts a control point');
	await h.eventually(() => splineInfo(B.page), (s) => s?.points === 5, 'the insert replicates to B');
	debug = await A.page.evaluate(() => window.__stores.splineEdit.splineEditDebug());
	h.check(debug.handles?.point === 5 && debug.handles?.mid === 4, 'the handles regroup around the new point');

	// delete a point with a right-click on its handle
	const deleteWorld = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const mesh = g.children.find((c) => c.name === 'Spline');
					const p = mesh.userData.spline.points[2].pos;
					const v = new window.__stores.THREE.Vector3(p[0], p[1], p[2]);
					mesh.localToWorld(v);
					r([v.x, v.y, v.z]);
				})()
			)
	);
	const deleteAt = await project(A.page, deleteWorld);
	await A.page.mouse.click(deleteAt.x, deleteAt.y, { button: 'right' });
	await A.page.waitForTimeout(500);
	h.check((await splineInfo(A.page)).points === 4, 'right-clicking a control point deletes it');
	const menuOpened = await A.page.evaluate(
		() => new Promise((r) => window.__stores.objectContextMenu.subscribe((m) => r(!!m))())
	);
	h.check(!menuOpened, 'the object context menu never opens over an edit session');
	await h.eventually(() => splineInfo(B.page), (s) => s?.points === 4, 'the delete replicates to B');

	// undo/redo walks the record back and forward on BOTH peers
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => splineInfo(A.page), (s) => s?.points === 5, 'undo restores the deleted point');
	await h.eventually(() => splineInfo(B.page), (s) => s?.points === 5, 'undo replicates to B');
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => splineInfo(A.page), (s) => s?.points === 4, 'redo deletes it again');

	// ---- 57.4 VR: carry a handle with the trigger -----------------------
	// No headset in CI: fake a controller pose and drive the SAME hooks the
	// Scene dispatches (on-device feel stays the user's manual check).
	const vr = await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		const edit = window.__stores.splineEdit;
		const read = (store) => new Promise((r) => store.subscribe((v) => r(v))());
		return (async () => {
			const renderer = await read(window.__stores.globalRenderer);
			const group = await read(window.__stores.objectsGroup);
			const mesh = group.children.find((c) => c.name === 'Spline');
			const controller = renderer.xr.getController(0);
			// three's XR target-ray space has matrixAutoUpdate OFF (WebXRManager
			// writes its matrix per frame), so a hand-posed controller stays at the
			// origin unless we turn composition back on
			controller.matrixAutoUpdate = true;
			controller.userData.handedness = 'right';
			renderer.xr.getController(1).userData.handedness = 'left';
			window.__stores.vrMenuHand.set('left');
			window.__stores.isVRMode.set(true);

			/** aim the controller at a world point from 1m away along +X */
			const aim = (target) => {
				const from = target.clone().add(new THREE.Vector3(1, 0.5, 1));
				controller.position.copy(from);
				const dir = target.clone().sub(from).normalize();
				controller.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
				controller.updateMatrixWorld(true);
				return from;
			};

			const pointWorld = (index) => {
				const p = mesh.userData.spline.points[index].pos;
				return mesh.localToWorld(new THREE.Vector3(p[0], p[1], p[2]));
			};

			const target = pointWorld(1);
			aim(target);
			const started = edit.vrSplineTriggerStart(0);
			const carrying = edit.vrSplineCarryActive();
			// carry it 0.4 up: the controller moves, the frame hook follows
			controller.position.y += 0.4;
			controller.updateMatrixWorld(true);
			edit.tickVRSpline();
			const moved = pointWorld(1).y - target.y;
			const swallow = edit.vrSplineSwallowed();
			edit.vrSplineTriggerEnd();
			const released = edit.vrSplineCarryActive();

			// and the radius dot: carrying it up thickens the point
			const point = mesh.userData.spline.points[1];
			const dot = pointWorld(1).add(new THREE.Vector3(0, point.radius * 1.8, 0));
			aim(dot);
			const radiusBefore = mesh.userData.spline.points[1].radius;
			const startedRadius = edit.vrSplineTriggerStart(0);
			controller.position.y += 0.2;
			controller.updateMatrixWorld(true);
			edit.tickVRSpline();
			edit.vrSplineTriggerEnd();
			const radiusAfter = mesh.userData.spline.points[1].radius;
			window.__stores.isVRMode.set(false);
			return { started, carrying, moved, swallow, released, startedRadius, radiusBefore, radiusAfter };
		})();
	});
	h.check(vr.started && vr.carrying, 'a VR trigger on a control-point handle starts a carry');
	h.check(vr.moved > 0.3, 'the carried point rides the controller (moved with it)');
	h.check(vr.swallow, 'the pick swallows the trailing select click');
	h.check(!vr.released, 'releasing the trigger ends the carry');
	h.check(vr.startedRadius && vr.radiusAfter > vr.radiusBefore * 1.3, 'a VR carry on the radius dot thickens the point');
	const vrCommitted = await splineInfo(A.page);
	await h.eventually(
		() => splineInfo(B.page),
		(s) => s && Math.abs(s.radii[1] - vrCommitted.radii[1]) < 1e-6,
		'the VR edits replicate to B'
	);

	// ---- 57.5 Properties rows ------------------------------------------
	await A.page.evaluate(() => window.__stores.splineEdit.exitSplineEdit());
	await A.page.waitForTimeout(300);
	h.check(!(await A.page.locator('#spline-edit-toolbar').isVisible()), 'Done closes the session');
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid, true), spline.uuid);
	await A.page.waitForTimeout(700);
	h.check(await A.page.locator('#spline-thickness').isVisible(), 'the Properties panel grows a Spline section');
	await A.page.evaluate((uuid) => {
		window.__stores.splineTool.setSplineColor(uuid, '#ff00aa');
		window.__stores.splineTool.setSplineRadiusAll(uuid, 0.2);
		window.__stores.splineTool.setSplineClosed(uuid, true);
	}, spline.uuid);
	await A.page.waitForTimeout(600);
	const styled = await splineInfo(A.page);
	h.check(
		styled.color === '#ff00aa' && styled.matColor === 'ff00aa',
		'Properties colour updates the record AND the material'
	);
	h.check(styled.radii.every((r) => Math.abs(r - 0.2) < 1e-6), 'Properties thickness sets every control point');
	h.check(styled.closed, 'Properties closes the loop');
	await h.eventually(
		() => splineInfo(B.page),
		(s) => s?.color === '#ff00aa' && s.closed && Math.abs(s.radii[0] - 0.2) < 1e-6,
		'the Properties edits replicate to B'
	);

	// ---- 21-C2: nothing from the session may reach a SAVE ----------------
	// The plan expected the handles to need editOverlays parking (PR #133's bug: a
	// .tpscene saved mid-session baked the edit wireframe in) and registerEditProxy.
	// Both concerns are about CHILDREN of the edited object / objectsGroup lookups,
	// and these handles are SCENE-ROOT — so this measures whether that reasoning
	// holds, with the session OPEN, through the real serializer.
	await A.page.evaluate((uuid) => window.__stores.splineEdit.enterSplineEdit(uuid), spline.uuid);
	await A.page.waitForTimeout(400);
	const midSave = await A.page.evaluate(async () => {
		const live = window.__stores.splineEdit.splineEditDebug();
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g))());
		// the toJSON path .tpscene + sessions use
		const json = JSON.stringify(group.toJSON());
		let inTree = 0;
		group.traverse((n) => {
			if (/spline-handles|spline-point-handles|spline-radius-handles|spline-mid-handles/.test(n.name)) inTree++;
			if (n.userData?.isSplineProxy) inTree++;
		});
		return {
			sessionOpen: !!live.uuid,
			handlesLive: live.handles?.point ?? 0,
			inTree,
			inJson: /spline-(handles|point-handles|radius-handles|mid-handles)|isSplineProxy/.test(json),
			hasSpline: json.includes('"spline"')
		};
	});
	h.check(midSave.sessionOpen && midSave.handlesLive > 0, 'PREMISE: the session is open with live handles while saving');
	h.check(midSave.inTree === 0, 'no handle and no proxy is inside objectsGroup (golden rule 5)');
	h.check(!midSave.inJson, 'a save taken MID-SESSION carries no handle and no proxy (the PR #133 bug cannot happen here)');
	h.check(midSave.hasSpline, 'PREMISE: that same save does carry the spline record (so the check had something to find)');
	await A.page.evaluate(() => window.__stores.splineEdit.exitSplineEdit());
	await A.page.waitForTimeout(300);

	// ---- late joiner: the record survives the GLTF full-state sync -------
	// move A's selection off the spline first: the handshake advertises whatever A
	// holds as a LOCK, and a locked object legitimately refuses an edit session.
	// (deselectObject is not enough — selectedObject deliberately keeps its last
	// value, so it would still ride the handshake.)
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await A.page.waitForTimeout(800);
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(
		() => splineInfo(C.page),
		(s) => s?.points === styled.points && s.closed && Math.abs(s.radii[0] - 0.2) < 1e-6,
		'a late joiner receives the spline WITH its record (editable there too)'
	);
	const lateEditable = await C.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const mesh = g.children.find((c) => c.name === 'Spline');
					r(mesh ? window.__stores.splineEdit.enterSplineEdit(mesh.uuid) : false);
				})()
			)
	);
	h.check(lateEditable, 'the late joiner can open the spline editor on it');
	const lateDebug = await C.page.evaluate(() => window.__stores.splineEdit.splineEditDebug());
	h.check(lateDebug.handles?.point === styled.points, 'the late joiner builds the same handle set');

	await h.finish(browser);
});
