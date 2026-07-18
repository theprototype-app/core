// Phase 113: VR Edit ▸ Vertices — the eligibility gate (VR vertex cap), the
// handle-drag write path (world position → local vertex → verts message +
// history), the locked-object refuse, and clean exit. The in-headset grip
// feel is the user's manual check; the drag is verified by driving the
// meshEdit VR functions directly with world positions.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- eligibility: simple mesh yes, over-cap no ---
	const eligible = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__box = box;
		s.objectActions.selectObject(box.uuid);
		// a dense sphere is over the 500-vertex cap
		s.commandsHandler.sceneCommand('/create Sphere 1');
		const dense = group.children[group.children.length - 1];
		return {
			cap: s.meshEdit.VR_VERTEX_CAP,
			boxOk: s.meshEdit.vrVertexEditable(box),
			boxVerts: box.geometry.attributes.position.count,
			denseOk: s.meshEdit.vrVertexEditable(dense),
			denseVerts: dense.geometry.attributes.position.count
		};
	});
	h.check(eligible.cap === 500, 'VR vertex cap is 500');
	h.check(eligible.boxOk === true, `a box is editable (${eligible.boxVerts} verts)`);
	h.check(eligible.denseOk === false, `a dense sphere is refused (${eligible.denseVerts} verts)`);

	// --- Edit Mesh ▸ Vertices enters edit mode; handles render at the scene root
	// (137: obj:editmesh opens the side-menu defaulting to Faces, then
	// edit:mode:vertices switches to vertex editing) ---
	const entered = await A.page.evaluate(() => {
		const s = window.__stores;
		s.objectActions.selectObject(window.__box.uuid);
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('obj:editmesh');
		s.vrControls.executeVRMenuAction('edit:mode:vertices');
		let editing;
		s.meshEdit.editingObject.subscribe((v) => (editing = v))();
		let scene;
		s.globalScene.subscribe((x) => (scene = x))();
		return {
			editing: editing === window.__box.uuid,
			handles: !!scene?.getObjectByName('vertex-handles'),
			menuClosed: (() => {
				let v;
				s.vrMenuOpen.subscribe((x) => (v = x))();
				return v === false;
			})()
		};
	});
	h.check(entered.editing && entered.handles, 'Vertices enters edit mode and builds handles');
	h.check(entered.menuClosed, 'entering vertex edit closes the ring');

	// --- drag handle 0 to a world position → local vertex + verts broadcast ---
	const dragged = await A.page.evaluate(() => {
		const s = window.__stores;
		const m = s.meshEdit;
		const THREE = s.THREE;
		const captured = [];
		let original;
		s.peers.subscribe((p) => (original = p))();
		s.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (msg) => captured.push(msg) });

		const startWorld = m.vrBeginHandleDrag(0); // returns the handle's world pos
		// pull it +0.5 in x (box sits at origin, so world≈local here)
		const target = new THREE.Vector3(startWorld.x + 0.5, startWorld.y, startWorld.z);
		m.vrDragHandleTo(target); // throttled stream
		m.vrEndHandleDrag(); // final + history

		const vertsMsgs = captured.filter((c) => c.type === 'verts');
		const last = vertsMsgs[vertsMsgs.length - 1];
		// the box's vertex attribute moved
		const pos = window.__box.geometry.attributes.position;
		const movedX = Math.max(pos.getX(last.indices[0]));
		s.peers.set(original);
		return {
			start: [startWorld.x, startWorld.y, startWorld.z],
			vertsCount: vertsMsgs.length,
			lastPos: last?.position,
			indices: last?.indices?.length,
			movedX
		};
	});
	h.check(dragged.vertsCount >= 1, `handle drag broadcasts verts messages (${dragged.vertsCount})`);
	h.check(
		Math.abs(dragged.lastPos[0] - (dragged.start[0] + 0.5)) < 1e-4,
		`the vertex moved +0.5 in x (${dragged.lastPos?.[0]?.toFixed(3)})`
	);
	h.check(dragged.indices >= 1 && Math.abs(dragged.movedX - dragged.lastPos[0]) < 1e-4, 'the geometry attribute updated');

	// --- history: the drag is one undoable entry ---
	const undone = await A.page.evaluate(() => {
		const s = window.__stores;
		const before = s.THREE ? window.__box.geometry.attributes.position.getX(0) : null;
		s.history.undo();
		const after = window.__box.geometry.attributes.position.getX(0);
		return { before, after };
	});
	h.check(undone.before !== undone.after, 'undo reverts the vertex pull');

	// --- exit restores state ---
	const exited = await A.page.evaluate(() => {
		const s = window.__stores;
		s.meshEdit.exitEditMode();
		let editing;
		s.meshEdit.editingObject.subscribe((v) => (editing = v))();
		let scene;
		s.globalScene.subscribe((x) => (scene = x))();
		return { editing, handlesGone: !scene?.getObjectByName('vertex-handles') };
	});
	h.check(exited.editing === null && exited.handlesGone, 'exit clears edit mode and removes the handles');

	// --- locked objects refuse ---
	const locked = await A.page.evaluate(() => {
		const s = window.__stores;
		s.objectActions.selectObject(window.__box.uuid);
		s.lockedObjects.set([['peerX', window.__box.uuid]]);
		s.vrControls.executeVRMenuAction('obj:editmesh'); // 137: refuses a locked object
		s.vrControls.executeVRMenuAction('edit:mode:vertices');
		let editing;
		s.meshEdit.editingObject.subscribe((v) => (editing = v))();
		s.lockedObjects.set([]);
		return editing;
	});
	h.check(locked === null, 'a peer-locked object refuses vertex editing');

	await h.finish(browser);
});
