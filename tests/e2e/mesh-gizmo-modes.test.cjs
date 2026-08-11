// The gizmo across ELEMENT MODES, driven the way a user drives it: REAL mouse clicks in
// the viewport, not store calls. The edge gizmo's first suite drove `pickEdge` directly,
// which proves the seating math but not that clicking an edge in the viewport reaches it —
// and "edges still do not have a gizmo" was the report that followed.
//
// Also here: the space (Local/World) control and the on/off switch, which used to live
// inside the faces-only branch of the toolbar, so vertices and edges had neither.
const h = require('./helpers.cjs');

/** the seated gizmo target's kind, or null */
const seated = (page) =>
	page.evaluate(() => {
		let controls;
		window.__stores.TControls.subscribe((c) => (controls = c))();
		const object = controls?.object;
		if (!object) return null;
		if (object.userData?.isFaceProxy) return 'face';
		if (object.userData?.isVertexProxy) return 'vertex';
		return 'object';
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// a box at the origin, big enough that its faces cover plenty of pixels
	const uuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		window.__box = box;
		return box.uuid;
	});

	// --- REAL click on an edge seats the EDGE gizmo ---------------------------
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.faceEdit.enterFaceEdit(uuid);
		s.faceEdit.setFaceSubmode('edges');
	}, uuid);
	const before = await seated(A.page);
	h.check(before === null, 'entering edge mode with nothing picked leaves no gizmo');

	// aim just inside the top-front edge of the box (y/z = +0.94): the helper projects a
	// world point to a screen pixel through the LIVE camera, so this is a real pick ray
	const target = await h.projectPoint(A.page, [0, 0.94, 0.94]);
	await A.page.mouse.click(Math.round(target.x), Math.round(target.y));
	await A.page.waitForTimeout(300);
	const picked = await A.page.evaluate(() => window.__stores.faceEdit.edgeSelectionSize());
	h.check(picked === 1, `a real viewport click picked one edge (${picked})`);
	const afterClick = await seated(A.page);
	h.check(afterClick === 'face', 'that click SEATS the gizmo (the proxy is the shared face proxy)');
	const onEdge = await A.page.evaluate(() => {
		const s = window.__stores;
		const target = s.faceEdit.edgeGrabTarget();
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		if (!target || !controls?.object) return null;
		window.__box.updateMatrixWorld(true);
		const expect = window.__box.localToWorld(target.centroid.clone());
		return controls.object.position.distanceTo(expect);
	});
	h.check(onEdge !== null && onEdge < 1e-6, `...on the EDGE, not a face (off by ${onEdge})`);

	// --- the space control reaches the edge gizmo ----------------------------
	const space = await A.page.evaluate(() => {
		const s = window.__stores;
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		s.faceEdit.faceGizmoSpace.set('world');
		const asWorld = controls.space;
		s.faceEdit.faceGizmoSpace.set('local');
		const asLocal = controls.space;
		return { asWorld, asLocal };
	});
	h.check(space.asWorld === 'world', 'switching to World reaches the seated edge gizmo');
	h.check(space.asLocal === 'local', '...and back to Local');

	// --- the on/off switch works in EVERY mode ------------------------------
	const off = await A.page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.meshGizmoEnabled.set(false);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const inEdges = !!controls?.object;
		// re-seat attempts while OFF must stay off
		s.faceEdit.attachFaceGizmo();
		const afterAttempt = !!controls?.object;
		// and in FACE mode
		s.faceEdit.setFaceSubmode('faces');
		s.faceEdit.setFaceGranularity('face');
		const faces = s.faceEdit.currentFaces();
		const yi = faces.findIndex((f) => f.normal.y > 0.9);
		s.faceEdit.highlightFaceByTriangle(faces[yi].triIndices[0]);
		s.faceEdit.setFaceOp('move');
		const inFaces = !!controls?.object;
		return { inEdges, afterAttempt, inFaces };
	});
	h.check(!off.inEdges, 'switching the gizmo OFF drops it in edge mode');
	h.check(!off.afterAttempt, '...and a re-seat attempt keeps it off');
	h.check(!off.inFaces, '...and no gizmo seats in face mode either');
	const backOn = await A.page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.meshGizmoEnabled.set(true);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		return !!controls?.object;
	});
	h.check(backOn, 'switching it back ON re-seats it immediately, with no re-pick');

	// --- VERTEX mode: the same switch, and the space pref applies ------------
	const vertex = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.faceEdit.exitFaceEdit();
		s.meshEdit.enterEditMode(uuid);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		s.meshEdit.selectHandle(0);
		const seatedOn = controls?.object?.userData?.isVertexProxy === true;
		s.faceEdit.faceGizmoSpace.set('world');
		const spaceApplied = controls.space === 'world';
		s.faceEdit.meshGizmoEnabled.set(false);
		const gone = !controls?.object;
		s.faceEdit.meshGizmoEnabled.set(true);
		const back = controls?.object?.userData?.isVertexProxy === true;
		s.faceEdit.faceGizmoSpace.set('local');
		return { seatedOn, spaceApplied, gone, back };
	}, uuid);
	h.check(vertex.seatedOn, 'a vertex pick seats the vertex gizmo (premise)');
	h.check(vertex.spaceApplied, 'the space pref reaches the VERTEX gizmo too (it was faces-only)');
	h.check(vertex.gone, 'the switch drops the vertex gizmo');
	h.check(vertex.back, '...and brings it back');

	// --- the vertex SELECTION survives a trip through another mode ----------
	const stash = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const me = s.meshEdit;
		// build a real multi-selection
		me.selectHandle(0);
		me.toggleVertexSelection(1);
		me.toggleVertexSelection(2);
		let size;
		me.vertexSelectionSize.subscribe((v) => (size = v))();
		const built = size;
		// Vertices -> Faces -> Vertices, exactly what the mode buttons do
		me.exitEditMode();
		s.faceEdit.enterFaceEdit(uuid);
		s.faceEdit.exitFaceEdit();
		me.enterEditMode(uuid);
		me.vertexSelectionSize.subscribe((v) => (size = v))();
		return { built, restored: size };
	}, uuid);
	h.check(stash.built === 3, `built a 3-vertex selection (${stash.built})`);
	h.check(
		stash.restored === stash.built,
		`the whole SET came back through Faces (${stash.restored}/${stash.built} — only the anchor used to)`
	);

	// --- handle size: adjustable, live, and ADAPTIVE (constant screen size) --
	// The size lives in the instance MATRICES now, not in the sphere geometry, which is
	// what lets one slider mean "x bigger" in fixed mode and "x more pixels" in adaptive
	// mode — with the multiplier baked into the geometry it cancelled itself out.
	const dots = await A.page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const handleMesh = () => {
			let mesh = null;
			let scene;
			s.globalScene.subscribe((v) => (scene = v))();
			scene.traverse((n) => {
				if (n.name === 'vertex-handles') mesh = n;
			});
			return mesh;
		};
		/** the DRAWN world radius of handle 0 = sphere radius x its instance scale */
		const drawn = () => {
			const mesh = handleMesh();
			if (!mesh) return null;
			const matrix = new THREE.Matrix4();
			mesh.getMatrixAt(0, matrix);
			const scale = new THREE.Vector3().setFromMatrixScale(matrix);
			return mesh.geometry.parameters.radius * scale.x;
		};
		s.meshEdit.vertexHandleAdaptive.set(false);
		s.meshEdit.vertexHandleScale.set(1);
		const fixed1x = drawn();
		s.meshEdit.vertexHandleScale.set(0.4);
		const fixedSmall = drawn();
		s.meshEdit.vertexHandleScale.set(2);
		const fixedBig = drawn();
		// ADAPTIVE: the drawn size must FOLLOW THE CAMERA distance
		s.meshEdit.vertexHandleScale.set(1);
		s.meshEdit.vertexHandleAdaptive.set(true);
		const near = drawn();
		let camera;
		s.globalCamera.subscribe((c) => (camera = c))();
		const back = camera.position.clone();
		camera.position.multiplyScalar(4); // zoom OUT along the same view direction
		s.meshEdit.tickMeshEdit();
		const far = drawn();
		camera.position.copy(back);
		s.meshEdit.tickMeshEdit();
		const backAgain = drawn();
		// and the slider still means something in adaptive mode
		s.meshEdit.vertexHandleScale.set(2);
		const adaptiveBig = drawn();
		s.meshEdit.vertexHandleScale.set(1);
		let size;
		s.meshEdit.vertexSelectionSize.subscribe((v) => (size = v))();
		return { fixed1x, fixedSmall, fixedBig, near, far, backAgain, adaptiveBig, keptSelection: size };
	});
	h.check(dots.fixed1x > 0, `the handles have a drawn radius to start with (${dots.fixed1x?.toFixed(4)})`);
	h.check(
		dots.fixedSmall < dots.fixed1x * 0.6 && dots.fixedBig > dots.fixed1x * 1.5,
		`the slider scales them in fixed mode (${dots.fixedSmall.toFixed(4)} / ${dots.fixed1x.toFixed(4)} / ${dots.fixedBig.toFixed(4)})`
	);
	h.check(
		dots.far > dots.near * 3,
		`ADAPTIVE: zooming out 4x grows the world size ~4x, keeping the SCREEN size constant (${dots.near.toFixed(4)} -> ${dots.far.toFixed(4)})`
	);
	h.check(
		Math.abs(dots.backAgain - dots.near) < 1e-6,
		`...and coming back restores it exactly (${dots.backAgain.toFixed(4)})`
	);
	h.check(
		dots.adaptiveBig > dots.near * 1.5,
		`the slider still means something in adaptive mode — it scales the PIXEL size (${dots.adaptiveBig.toFixed(4)})`
	);
	h.check(dots.keptSelection === 3, 'resizing the dots does not disturb the selection');
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	await h.finish(browser);
});
