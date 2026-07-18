// Phase 161: VR Stretch mode — a 3rd Edit-Mesh mode that non-uniformly scales
// an object's geometry per axis (joystick on-device). The pure helper + the
// begin/set/commit session are verified here; the stick feel is manual.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure: scale one axis about its centroid, leave the others ---
	const pure = await A.page.evaluate(() => {
		const f = window.__stores.faceEdit.stretchPositions;
		const out = f([-1, 0, 0, 1, 2, 3], 0, 2); // centroid x=0 -> -2 / 2
		return { x0: out[0], x1: out[3], y: out[4], z: out[5] };
	});
	h.check(pure.x0 === -2 && pure.x1 === 2, `stretchPositions scales the axis about its centroid (${pure.x0},${pure.x1})`);
	h.check(pure.y === 2 && pure.z === 3, 'the other axes are untouched');

	// --- session: begin -> set -> commit bakes ONE meshgeo; undo restores ---
	const session = await A.page.evaluate(() => {
		const s = window.__stores;
		const extentX = (b) => {
			const p = b.geometry.attributes.position;
			let mn = 1e9, mx = -1e9;
			for (let i = 0; i < p.count; i++) { mn = Math.min(mn, p.getX(i)); mx = Math.max(mx, p.getX(i)); }
			return mx - mn;
		};
		s.commandsHandler.sceneCommand('/create box');
		let grp; s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		window.__box = box;
		const before = extentX(box);
		s.vrControls.beginStretch(box.uuid);
		const active = s.vrControls.stretchState()?.uuid === box.uuid;
		s.vrControls.setStretch(0, 2); // double the width
		const previewed = extentX(box);
		const captured = []; let original;
		s.peers.subscribe((p) => (original = p))();
		s.peers.set({ ...(original ?? {}), peer: { id: 'me' }, send: (m) => captured.push(m) });
		s.vrControls.commitStretch();
		s.peers.set(original);
		const committed = extentX(box);
		const meshgeo = captured.filter((m) => m.type === 'meshgeo').length;
		s.history.undo();
		const undone = extentX(box);
		return { active, before, previewed, committed, meshgeo, undone };
	});
	h.check(session.active, 'beginStretch starts a session on the object');
	h.check(Math.abs(session.previewed - session.before * 2) < 1e-3, `setStretch previews the widened box (${session.before.toFixed(2)} -> ${session.previewed.toFixed(2)})`);
	h.check(session.meshgeo === 1, 'commit emits exactly ONE meshgeo snapshot');
	h.check(Math.abs(session.committed - session.before * 2) < 1e-3, 'the widened geometry persists after commit');
	h.check(Math.abs(session.undone - session.before) < 1e-3, 'undo restores the original width');

	// --- Edit menu flow: obj:editmesh -> Stretch enters; Done commits + exits ---
	const menu = await A.page.evaluate(() => {
		const s = window.__stores;
		s.objectActions.selectObject(window.__box.uuid);
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('obj:editmesh');
		s.vrControls.executeVRMenuAction('edit:mode:stretch');
		const inStretch = !!s.vrControls.stretchState();
		s.vrControls.executeVRMenuAction('edit:close');
		const afterClose = !!s.vrControls.stretchState();
		return { inStretch, afterClose };
	});
	h.check(menu.inStretch, 'Edit Mesh menu -> Stretch enters stretch mode');
	h.check(!menu.afterClose, 'Done commits + leaves stretch');

	await h.finish(browser);
});
