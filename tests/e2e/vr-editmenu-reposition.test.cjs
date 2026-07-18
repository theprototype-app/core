// Phase 158: the Edit Mesh + Snap side-menus can be grip-grabbed and placed
// like the radial ring, and stay where you put them. The grip-detection fix
// (face-edit mode used to swallow the grip before the window grab) is on-device
// manual; here we verify the pose path: a saved anchor-local offset for the
// editmenu / snapmenu ids is applied every frame (not clobbered by the
// per-frame controller pose) and Reset positions clears it.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const W = window.__stores.vrWindowPoses;
		const THREE = window.__stores.THREE;
		const out = {};
		for (const id of ['editmenu', 'snapmenu']) {
			W.resetWindowPoses();
			const group = new THREE.Group();
			const anchor = { position: new THREE.Vector3(1, 1, -2), quaternion: new THREE.Quaternion() };
			// no offset -> the menu sits exactly at its controller anchor
			W.applyWindowPose(group, id, anchor);
			const atAnchor = group.position.distanceTo(anchor.position) < 1e-6;
			// "place" it: save an anchor-local offset 0.3 to the right
			W.saveWindowPose(id, { pos: [0.3, 0, 0], quat: [0, 0, 0, 1], scale: 1 });
			W.applyWindowPose(group, id, anchor); // re-pose (as every frame does)
			const placedX = group.position.x; // 1 + 0.3 with an identity anchor
			// Reset positions -> back to the anchor
			W.resetWindowPoses();
			W.applyWindowPose(group, id, anchor);
			const reset = group.position.distanceTo(anchor.position) < 1e-6;
			out[id] = { atAnchor, placedX, reset };
		}
		return out;
	});

	for (const id of ['editmenu', 'snapmenu']) {
		h.check(res[id].atAnchor, `${id}: with no offset it sits at the controller anchor`);
		h.check(
			Math.abs(res[id].placedX - 1.3) < 1e-6,
			`${id}: a placed offset is applied + survives re-pose (x=${res[id].placedX})`
		);
		h.check(res[id].reset, `${id}: Reset positions snaps it back to the anchor`);
	}

	await h.finish(browser);
});
