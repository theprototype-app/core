// Roadmap #17 batch D follow-up 4 — per-object transform ORIGIN.
//
// A single object's origin is its local (0,0,0): the point its position refers to
// and the point rotate/scale happen around. It is stored as a LOCAL offset on
// `userData.origin`, which makes it scene data — replicated, saved, undoable, and
// remembered per object when the selection changes.
//
// Not baked into vertices on purpose: that route goes through meshgeo, which
// stamps faceEdited and would LOCK a primitive's width/height sliders forever.
// The trade is that a GLTF export has to bake it (bakeOriginForExport), since
// glTF nodes carry only TRS.
const h = require('./helpers.cjs');

/** read what the app knows about an object's origin */
const originOf = (page, key) =>
	page.evaluate((key) => {
		const w = window.__stores;
		const object = window.__oo.group.getObjectByProperty('uuid', window.__oo[key]);
		return {
			local: object?.userData?.origin ?? null,
			world: w.objectOrigin.originWorld(object).toArray().map((n) => +n.toFixed(4)),
			pos: object.position.toArray().map((n) => +n.toFixed(4))
		};
	}, key);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.objectOrigin, { timeout: 20000 });

	// a 2x1x1 box at a known place, plus a second object to switch to
	await A.page.evaluate(async () => {
		const w = window.__stores;
		localStorage.setItem('inspector:sec:Transform', 'open');
		w.commandsHandler.sceneCommand('/create Box 2 1 1');
		await new Promise((r) => setTimeout(r, 300));
		w.commandsHandler.sceneCommand('/create Sphere 0.5');
		await new Promise((r) => setTimeout(r, 300));
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const [box, sphere] = group.children.slice(-2);
		box.position.set(0, 0, 0);
		sphere.position.set(4, 0, 0);
		window.__oo = { group, box: box.uuid, sphere: sphere.uuid };
		w.objectActions.selectObject(box.uuid, true);
	});
	await A.page.waitForTimeout(800);

	// ---------- the panel offers it, and it starts at the default ----------
	const ui = await A.page.evaluate(() => ({
		block: !!document.querySelector('#object-origin'),
		rows: document.querySelectorAll('#inspector-origin .dn-input').length,
		presets: ['#origin-bottom', '#origin-center', '#origin-median', '#origin-world'].filter(
			(id) => !!document.querySelector(id)
		).length,
		mode: !!document.querySelector('#origin-mode-single')
	}));
	h.check(ui.block, 'the Transform section offers an Origin block for a single object');
	h.check(ui.rows === 3, `with X/Y/Z rows (${ui.rows})`);
	h.check(ui.presets === 4, `and the presets (${ui.presets}/4)`);
	h.check(ui.mode, 'plus a Move origin toggle');
	const start = await originOf(A.page, 'box');
	h.check(start.local === null, `no offset by default (${JSON.stringify(start.local)})`);

	// ---------- Bottom: the pivot lands on the footprint ----------
	await A.page.locator('#origin-bottom').click();
	await A.page.waitForTimeout(400);
	const bottom = await originOf(A.page, 'box');
	h.check(
		Math.abs(bottom.local?.[1] + 0.5) < 0.001,
		`Bottom puts the origin on the base (local y ${bottom.local?.[1]})`
	);
	h.check(
		Math.abs(bottom.world[1] + 0.5) < 0.001 && Math.abs(bottom.world[0]) < 0.001,
		`and the world readout agrees (${bottom.world.join(', ')})`
	);
	// PREMISE: the mesh itself must NOT have moved — this is a pivot, not a nudge
	h.check(
		bottom.pos.every((n) => Math.abs(n) < 0.001),
		`the object stayed exactly where it was (${bottom.pos.join(', ')})`
	);

	// ---------- rotate/scale now happen ABOUT the origin ----------
	// with the pivot on the bottom face, a 90-degree turn about Z must swing the
	// box up around that edge instead of spinning in place
	const swung = await A.page.evaluate(async () => {
		const w = window.__stores;
		const before = window.__oo.group.getObjectByProperty('uuid', window.__oo.box).position.toArray();
		const moved = w.multiTransform.applyPivotTransform((pivot) => {
			pivot.rotation.z = Math.PI / 2;
		});
		await new Promise((r) => setTimeout(r, 250));
		const object = window.__oo.group.getObjectByProperty('uuid', window.__oo.box);
		return { moved, before, after: object.position.toArray().map((n) => +n.toFixed(4)) };
	});
	h.check(swung.moved === true, 'a single object with an origin gets the pivot gizmo path');
	// pivot at (0,-0.5,0); the centre sits 0.5 above it, so a +90d turn about Z
	// sends the centre to (-0.5, -0.5, 0)
	h.check(
		Math.abs(swung.after[0] + 0.5) < 0.05 && Math.abs(swung.after[1] + 0.5) < 0.05,
		`the object swings around the origin, not its centre (${swung.after.join(', ')})`
	);

	// ---------- each object keeps its OWN origin across a selection switch ----------
	await A.page.evaluate(() => {
		const w = window.__stores;
		w.objectActions.selectObject(window.__oo.sphere, false);
	});
	await A.page.waitForTimeout(600);
	const sphereOrigin = await originOf(A.page, 'sphere');
	h.check(sphereOrigin.local === null, 'the other object still has its default origin');
	await A.page.locator('#origin-world').click();
	await A.page.waitForTimeout(400);
	const sphereWorld = await originOf(A.page, 'sphere');
	h.check(
		Math.abs(sphereWorld.world[0]) < 0.001,
		`World 0 puts the sphere's origin at the scene origin (${sphereWorld.world.join(', ')})`
	);
	// back to the box: its bottom origin must still be there
	await A.page.evaluate(() => window.__stores.objectActions.selectObject(window.__oo.box, false));
	await A.page.waitForTimeout(600);
	const boxAgain = await originOf(A.page, 'box');
	h.check(
		Math.abs(boxAgain.local?.[1] + 0.5) < 0.001,
		`switching objects brings each one's own origin back (box local y ${boxAgain.local?.[1]})`
	);
	const sphereKept = await originOf(A.page, 'sphere');
	h.check(sphereKept.local !== null, 'and the sphere kept its own, independently');

	// ---------- replicated + undoable, like any other userData write ----------
	const wire = await A.page.evaluate(async () => {
		const w = window.__stores;
		const peer = await new Promise((r) => w.peers.subscribe(r)());
		window.__sent = [];
		const orig = peer.send.bind(peer);
		peer.send = (m) => {
			if (m?.parameter === 'origin') window.__sent.push(m.origin);
			return orig(m);
		};
		w.objectOrigin.originPreset(window.__oo.box, 'center');
		await new Promise((r) => setTimeout(r, 200));
		const afterPreset = window.__oo.group.getObjectByProperty('uuid', window.__oo.box).userData.origin;
		w.history.undo();
		await new Promise((r) => setTimeout(r, 300));
		const afterUndo = window.__oo.group.getObjectByProperty('uuid', window.__oo.box).userData.origin;
		return { sent: window.__sent.length, afterPreset, afterUndo };
	});
	h.check(wire.sent >= 1, `an origin change replicates (${wire.sent} message(s))`);
	h.check(
		Math.abs(wire.afterUndo?.[1] + 0.5) < 0.001,
		`and undo restores the previous origin (${JSON.stringify(wire.afterUndo)})`
	);

	// ---------- the Spin flow node turns about the origin (the hinge case) ----------
	// asserts the runtime's OWN exported math (the computeMoveOffset pattern), so a
	// regression in flowRuntime shows up here rather than in a hand-rolled formula
	const hinged = await A.page.evaluate(async () => {
		const w = window.__stores;
		// origin on the box's -x face: spinning about Y swings it like a door
		w.objectOrigin.setOriginFor(window.__oo.box, [-1, 0, 0]);
		await new Promise((r) => setTimeout(r, 200));
		const object = window.__oo.group.getObjectByProperty('uuid', window.__oo.box);
		object.position.set(0, 0, 0);
		object.rotation.set(0, 0, 0);
		const base = { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
		const pivot = w.flowRuntime.originPivotOf(object, base).toArray().map((n) => +n.toFixed(3));
		const quarter = w.flowRuntime
			.spinPositionAbout(base.pos, w.flowRuntime.originPivotOf(object, base), 'y', Math.PI / 2)
			.map((n) => +n.toFixed(3));
		// and with NO origin the body must not travel at all
		w.objectOrigin.resetOrigin(window.__oo.sphere);
		const plain = window.__oo.group.getObjectByProperty('uuid', window.__oo.sphere);
		const plainSpin = w.flowRuntime
			.spinPositionAbout([4, 0, 0], w.flowRuntime.originPivotOf(plain, { pos: [4, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }), 'y', Math.PI / 2)
			.map((n) => +n.toFixed(3));
		return { pivot, quarter, plainSpin };
	});
	h.check(
		Math.abs(hinged.pivot[0] + 1) < 0.01,
		`the runtime places the spin pivot on the origin (${hinged.pivot.join(', ')})`
	);
	h.check(
		Math.abs(hinged.quarter[0] + 1) < 0.01 && Math.abs(hinged.quarter[2] + 1) < 0.01,
		`a 90d spin swings the body a quarter circle around it (${hinged.quarter.join(', ')})`
	);
	h.check(
		Math.abs(hinged.plainSpin[0] - 4) < 0.01 && Math.abs(hinged.plainSpin[2]) < 0.01,
		`an object with NO origin still spins in place, unchanged (${hinged.plainSpin.join(', ')})`
	);
	// and the joint anchor follows the origin (the "hinge it" half)
	const anchored = await A.page.evaluate(async () => {
		const w = window.__stores;
		const joint = w.joints.createJoint('revolute', window.__oo.sphere, window.__oo.box, 'y');
		return joint ? { anchorB: joint.anchorB.map((n) => +n.toFixed(3)) } : null;
	});
	h.check(
		!!anchored && Math.abs(anchored.anchorB[0] + 1) < 0.01,
		`a hinge anchors on the origin, not the centre (anchorB ${anchored?.anchorB?.join(', ')})`
	);

	// ---------- REPORTED: the gizmo must survive every preset ----------
	// Centre on an already-centred primitive yields a ZERO offset, which clears the
	// origin — so no pivot is warranted and the OBJECT has to take the gizmo back.
	// It used to end up detached, and only a deselect/reselect brought it back.
	const gizmoKept = await A.page.evaluate(async () => {
		const w = window.__stores;
		const attached = async () => {
			const controls = await new Promise((r) => w.TControls.subscribe(r)());
			return !!controls?.object;
		};
		w.objectActions.selectObject(window.__oo.box, true);
		await new Promise((r) => setTimeout(r, 400));
		const out = { start: await attached(), steps: [] };
		for (const id of ['#origin-bottom', '#origin-center', '#origin-median', '#origin-world', '#origin-clear']) {
			document.querySelector(id)?.click();
			await new Promise((r) => setTimeout(r, 350));
			out.steps.push({ id, gizmo: await attached() });
		}
		return out;
	});
	h.check(gizmoKept.start, 'a selected object starts with a gizmo');
	for (const step of gizmoKept.steps)
		h.check(step.gizmo, `the gizmo survives ${step.id.replace('#origin-', '')}`);

	// ---------- REPORTED: Move origin must let the GIZMO move the origin ----------
	// re-seating used to reset pivotOnly, cancelling the mode the instant it was
	// pressed, so the gizmo dragged the object instead of its origin
	const modeHeld = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.objectActions.selectObject(window.__oo.box, true);
		await new Promise((r) => setTimeout(r, 350));
		document.querySelector('#origin-mode-single')?.click();
		await new Promise((r) => setTimeout(r, 400));
		const mode = await new Promise((r) => w.multiTransform.pivotOnly.subscribe(r)());
		const controls = await new Promise((r) => w.TControls.subscribe(r)());
		const onPivot = !!controls?.object?.userData?.isMultiPivot;
		// what a gizmo drag does in origin mode: move the pivot, then drop it
		const object = window.__oo.group.getObjectByProperty('uuid', window.__oo.box);
		const posBefore = object.position.toArray();
		if (controls?.object) controls.object.position.set(2, 1, 0);
		const committed = w.multiTransform.commitOriginDrag();
		await new Promise((r) => setTimeout(r, 300));
		return {
			mode,
			onPivot,
			committed,
			posBefore,
			posAfter: object.position.toArray(),
			origin: w.objectOrigin.originWorld(object).toArray().map((n) => +n.toFixed(3))
		};
	});
	h.check(modeHeld.mode === true, 'Move origin stays ON after the re-seat');
	h.check(modeHeld.onPivot, 'and the gizmo is attached to the PIVOT, so dragging it moves the origin');
	h.check(modeHeld.committed === true, 'the drag-end commit runs');
	h.check(
		Math.abs(modeHeld.origin[0] - 2) < 0.01 && Math.abs(modeHeld.origin[1] - 1) < 0.01,
		`a gizmo drag in origin mode WRITES the origin (${modeHeld.origin.join(', ')})`
	);
	h.check(
		modeHeld.posAfter.every((n, i) => Math.abs(n - modeHeld.posBefore[i]) < 0.001),
		`and leaves the object alone (${modeHeld.posAfter.join(', ')})`
	);

	// ---------- the HINGE point: origin from picked vertices ----------
	const hinge = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.objectOrigin.resetOrigin(window.__oo.box);
		const object = window.__oo.group.getObjectByProperty('uuid', window.__oo.box);
		object.position.set(0, 0, 0);
		object.rotation.set(0, 0, 0);
		w.objectActions.selectObject(window.__oo.box, true);
		w.meshEdit.enterEditMode(window.__oo.box);
		await new Promise((r) => setTimeout(r, 500));
		// the button is offered for the WHOLE edit session (a plain click selects a
		// handle without joining the multi-selection set, so a count-gated button
		// hid while a vertex was visibly picked) — with nothing picked it must
		// TOAST rather than move anything
		const before = {
			offered: !!document.querySelector('#origin-hinge'),
			point: w.meshEdit.vertexSelectionWorldPoint()
		};
		// select everything through the real API, as a sanity read of the centroid
		w.meshEdit.selectAllVerts();
		await new Promise((r) => setTimeout(r, 200));
		const all = w.meshEdit.vertexSelectionWorldPoint();
		return {
			before,
			allSelected: all ? all.toArray().map((n) => +n.toFixed(3)) : null,
			size: await new Promise((r) => w.meshEdit.vertexSelectionSize.subscribe(r)())
		};
	});
	h.check(hinge.before.offered, 'Set origin here is offered for the whole edit session');
	h.check(hinge.before.point === null, 'and reads no point while nothing is picked');
	h.check(hinge.size > 0, `selecting vertices reports a selection (${hinge.size})`);
	h.check(
		!!hinge.allSelected && Math.abs(hinge.allSelected[0]) < 0.01,
		`the whole-mesh selection centres on the box (${hinge.allSelected?.join(', ')})`
	);

	// now pick ONE corner and snap the origin to it through the button
	const cornered = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.meshEdit.clearVertexSelection();
		await new Promise((r) => setTimeout(r, 150));
		// pressing it with NOTHING picked must not move the origin
		document.querySelector('#origin-hinge')?.click();
		await new Promise((r) => setTimeout(r, 250));
		const object0 = window.__oo.group.getObjectByProperty('uuid', window.__oo.box);
		const noPick = object0.userData.origin ?? null;
		w.meshEdit.toggleVertexSelection(0); // a single corner handle
		await new Promise((r) => setTimeout(r, 250));
		const point = w.meshEdit.vertexSelectionWorldPoint();
		const offered = !!document.querySelector('#origin-hinge');
		document.querySelector('#origin-hinge')?.click();
		await new Promise((r) => setTimeout(r, 400));
		const object = window.__oo.group.getObjectByProperty('uuid', window.__oo.box);
		return {
			offered,
			noPick,
			picked: point ? point.toArray().map((n) => +n.toFixed(3)) : null,
			origin: w.objectOrigin.originWorld(object).toArray().map((n) => +n.toFixed(3)),
			pos: object.position.toArray().map((n) => +n.toFixed(3))
		};
	});
	h.check(cornered.noPick === null, 'pressing it with nothing picked changes no origin');
	h.check(cornered.offered, 'the button is there once a vertex is picked');
	h.check(
		!!cornered.picked &&
			cornered.origin.every((n, i) => Math.abs(n - cornered.picked[i]) < 0.01),
		`the origin lands exactly on the picked vertex (${cornered.origin.join(', ')} vs ${cornered.picked?.join(', ')})`
	);
	h.check(
		cornered.pos.every((n) => Math.abs(n) < 0.01),
		`and the mesh still has not moved (${cornered.pos.join(', ')})`
	);
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	await A.page.waitForTimeout(300);

	// ---------- a GLTF export bakes the origin (glTF has no pivot) ----------
	const baked = await A.page.evaluate(() => {
		const w = window.__stores;
		const THREE = w.THREE;
		// a 2-unit-wide box at the world origin with its pivot on the -x face
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), new THREE.MeshStandardMaterial());
		mesh.position.set(0, 0, 0);
		mesh.userData.origin = [-1, 0, 0];
		const clone = w.objectOrigin.bakeOriginForExport(mesh.clone(true));
        clone.geometry.computeBoundingBox();
		return {
			position: clone.position.toArray().map((n) => +n.toFixed(3)),
			// the vertices shift the OTHER way, so the box still occupies the same space
			boxMin: clone.geometry.boundingBox.min.toArray().map((n) => +n.toFixed(3)),
			cleared: clone.userData.origin === undefined,
			liveUntouched: mesh.userData.origin?.[0] === -1
		};
	});
	h.check(
		Math.abs(baked.position[0] + 1) < 0.01,
		`baking moves the node onto the pivot (${baked.position.join(', ')})`
	);
	h.check(
		Math.abs(baked.boxMin[0]) < 0.01,
		`and shifts the vertices the other way, so it occupies the same space (min x ${baked.boxMin[0]})`
	);
	h.check(baked.cleared, 'the baked clone carries no origin any more');
	h.check(baked.liveUntouched, 'and the LIVE object was not baked (its parametric rows survive)');

	// ---------- Reset goes back to the default ----------
	await A.page.evaluate(() => window.__stores.objectOrigin.resetOrigin(window.__oo.box));
	await A.page.waitForTimeout(300);
	const reset = await originOf(A.page, 'box');
	h.check(reset.local === null, `Reset clears the origin (${JSON.stringify(reset.local)})`);

	await h.finish(browser);
});
