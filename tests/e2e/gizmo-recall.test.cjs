// 24-B1: 1/2/3 recall the last selection. Pressing the active mode key with a gizmo
// attached HIDES the selection (deselect + detach — the long-standing "done"
// gesture); nothing remembered what was hidden, so a third press only set the mode
// (reported: "the gizmo should appear with latest selection, also for multiselect and
// edit modes"). Now every selection path records a memory, any mode key restores it
// (filtered to objects that still exist and are not peer-locked), a multi-select comes
// back with its hand-placed origin, and the face/edge/vertex sessions hide + restore
// their ELEMENT pick through the toolbox's own gizmo switch (meshGizmoEnabled).
const h = require('./helpers.cjs');

const read = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const get = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const controls = get(s.TControls);
		const o = controls?.object;
		return {
			mode: get(s.transformMode),
			selected: get(s.selectedObjects),
			attached: o ? (o.userData?.isMultiPivot ? 'pivot' : o.userData?.isFaceProxy ? 'face' : o.userData?.isVertexProxy ? 'vertex' : 'object') : null,
			pivotPos: get(s.multiTransform.pivotPose)?.pos ?? null,
			gizmoPref: get(s.faceEdit.meshGizmoEnabled),
			faceTris: get(s.faceEdit.faceEditSelectedTris),
			vertexAnchor: s.meshEdit.selectedVertexHandle(),
			vertexCount: get(s.meshEdit.vertexSelectionSize),
			locked: get(s.lockedObjects).map((l) => l[1]),
			memory: s.objectActions.lastSelectionMemory()?.uuids ?? null,
			toasts: get(s.notifications).slice(-3).map((n) => n.text)
		};
	});
const key = async (page, code) => {
	await page.keyboard.press(code);
	await page.waitForTimeout(180);
};
const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	// connect while both are EMPTY (no unsaved-work question at approval), then add
	await h.connect(B, A);

	const [u1, u2] = await A.page.evaluate(() => {
		const s = window.__stores;
		const a = s.addObjects.spawnAtPoint('/create Box 1 1 1', [2, 0.5, 0]);
		const b = s.addObjects.spawnAtPoint('/create Box 1 1 1', [-2, 0.5, 0]);
		return [a.uuid, b.uuid];
	});
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(400);
	await h.eventually(
		() => B.page.evaluate(([a, b]) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return !!g.getObjectByProperty('uuid', a) && !!g.getObjectByProperty('uuid', b); }, [u1, u2]),
		(ok) => ok,
		'B received both cubes',
		20000
	);

	// ---- 1. a multi-select: 1 (switch) · 1 (hide) · 1 (back) -------------------------
	await A.page.evaluate(([a, b]) => {
		window.__stores.objectActions.selectObject(a);
		window.__stores.objectActions.selectObject(b, false, true);
	}, [u1, u2]);
	await A.page.waitForTimeout(200);
	await key(A.page, 'Digit2'); // rotate, so the next 1 is a SWITCH
	let s = await read(A.page);
	h.check(same(s.selected, [u1, u2]) && s.attached === 'pivot' && s.mode === 'rotate', `premise: both cubes on the pivot in rotate (${s.attached}, ${s.mode})`);
	await key(A.page, 'Digit1');
	s = await read(A.page);
	h.check(s.mode === 'translate' && s.attached === 'pivot', `1 with another mode active only switches (${s.mode}, ${s.attached})`);
	await key(A.page, 'Digit1');
	s = await read(A.page);
	h.check(s.selected.length === 0 && s.attached === null, `1 on the active mode HIDES (selected ${s.selected.length}, attached ${s.attached})`);
	h.check(same(s.memory ?? [], [u1, u2]), 'the memory holds the hidden set');
	await key(A.page, 'Digit1');
	s = await read(A.page);
	h.check(same(s.selected, [u1, u2]) && s.attached === 'pivot' && s.mode === 'translate', `1 again brings the SAME set back on its pivot in Move (${s.selected.length}, ${s.attached}, ${s.mode})`);

	// ---- 2. 2 2 then 3: restored in the mode of the key that restored it ---------------
	await key(A.page, 'Digit2');
	await key(A.page, 'Digit2');
	s = await read(A.page);
	h.check(s.selected.length === 0, '2 2 = rotate, then hide');
	await key(A.page, 'Digit3');
	s = await read(A.page);
	h.check(same(s.selected, [u1, u2]) && s.mode === 'scale' && s.attached === 'pivot', `3 restores the set in Scale (${s.mode})`);

	// ---- 3. a hand-placed selection origin survives the hide ---------------------------
	await A.page.evaluate(() => window.__stores.multiTransform.setPivotOrigin([5, 1, 5]));
	await A.page.waitForTimeout(100);
	await key(A.page, 'Digit3'); // hide
	await key(A.page, 'Digit3'); // back
	s = await read(A.page);
	const p = s.pivotPos ?? [0, 0, 0];
	h.check(
		same(s.selected, [u1, u2]) && Math.hypot(p[0] - 5, p[1] - 1, p[2] - 5) < 0.01,
		`the set comes back about the origin the user placed (${p.map((n) => n.toFixed(2)).join(', ')})`
	);

	// ---- 4. a cube locked by a peer meanwhile stays out, and says so -------------------
	await key(A.page, 'Digit3'); // hide again
	await B.page.evaluate((u) => window.__stores.objectActions.selectObject(u), u1);
	await h.eventually(() => read(A.page), (r) => r.locked.includes(u1), 'A sees B holding cube 1', 15000);
	await key(A.page, 'Digit1');
	s = await read(A.page);
	h.check(same(s.selected, [u2]) && s.attached === 'object', `the recall brings back only the free cube (${s.selected.length}, ${s.attached})`);
	h.check(s.toasts.some((t) => /could not be reselected/.test(t)), `...and a toast says one was skipped (${JSON.stringify(s.toasts.at(-1))})`);
	await B.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await h.eventually(() => read(A.page), (r) => !r.locked.includes(u1), 'B let go of cube 1', 15000);

	// a cold press with nothing remembered is silent: fresh page state is not testable
	// here, but a memory whose objects are ALL gone is
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), u2);
	await A.page.waitForTimeout(150);
	await key(A.page, 'Digit1'); // hide the single cube (mode is translate)
	await A.page.evaluate((u) => window.__stores.objectActions.deleteObjectsByUuid([u]), u2);
	await A.page.waitForTimeout(300);
	await key(A.page, 'Digit1');
	s = await read(A.page);
	h.check(s.selected.length === 0 && s.toasts.some((t) => /Nothing to reselect/.test(t)), `a memory whose object is gone toasts "Nothing to reselect" (${JSON.stringify(s.toasts.at(-1))})`);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	await key(A.page, 'Digit1');
	s = await read(A.page);
	h.check(same(s.selected, [u2]), `...and after an undo the same memory brings it back (${s.selected.length})`);

	// ---- 5. Edit Mesh: the face pick hides with the gizmo and comes back with it -------
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.evaluate((u) => {
		const s = window.__stores;
		s.faceEdit.enterFaceEdit(u);
		s.faceEdit.pickFaceUnit(0);
		s.faceEdit.attachFaceGizmo();
	}, u2);
	await A.page.waitForTimeout(300);
	s = await read(A.page);
	const picked = s.faceTris.slice();
	h.check(picked.length > 0 && s.attached === 'face' && s.gizmoPref === true, `premise: a face is picked and the face gizmo is seated (${picked.length} tris, ${s.attached})`);
	await key(A.page, 'Digit1'); // mode is translate → hide
	s = await read(A.page);
	h.check(s.attached === null && s.faceTris.length === 0 && s.gizmoPref === false, `1 hides the face pick AND flips the toolbox's gizmo switch (${s.attached}, ${s.faceTris.length}, pref ${s.gizmoPref})`);
	await key(A.page, 'Digit1');
	s = await read(A.page);
	h.check(same(s.faceTris, picked) && s.attached === 'face' && s.gizmoPref === true, `1 brings the same face back with its gizmo (${s.faceTris.length}, ${s.attached}, pref ${s.gizmoPref})`);
	// the toolbox BUTTON restores too — one control
	await key(A.page, 'Digit1'); // hide
	await A.page.evaluate(() => window.__stores.faceEdit.meshGizmoEnabled.set(true));
	await A.page.waitForTimeout(200);
	s = await read(A.page);
	h.check(same(s.faceTris, picked) && s.attached === 'face', `the toolbox gizmo button restores the hidden pick as well (${s.faceTris.length}, ${s.attached})`);
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.waitForTimeout(200);

	// ---- 6. Vertex mode: same shape ------------------------------------------------------
	await A.page.evaluate((u) => {
		const s = window.__stores;
		s.meshEdit.enterEditMode(u);
		s.meshEdit.selectHandle(0);
	}, u2);
	await A.page.waitForTimeout(300);
	s = await read(A.page);
	h.check(s.vertexAnchor === 0 && s.attached === 'vertex', `premise: vertex 0 anchored, vertex proxy seated (${s.vertexAnchor}, ${s.attached})`);
	await key(A.page, 'Digit1');
	s = await read(A.page);
	h.check(s.attached === null && s.vertexAnchor === -1 && s.vertexCount === 0 && s.gizmoPref === false, `1 hides the vertex pick + gizmo (${s.attached}, anchor ${s.vertexAnchor}, pref ${s.gizmoPref})`);
	await key(A.page, 'Digit1');
	s = await read(A.page);
	h.check(s.vertexAnchor === 0 && s.attached === 'vertex' && s.gizmoPref === true, `1 restores the vertex and seats the proxy (anchor ${s.vertexAnchor}, ${s.attached})`);
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());

	await h.finish(browser);
});
