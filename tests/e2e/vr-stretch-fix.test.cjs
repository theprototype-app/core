// Phase 186: a SELECTED object can be stretched (entering stretch targets the
// selection) and the two-grip thumbstick-divergence gesture drives it. The
// grip+stick gesture is on-device; here we verify entry-on-selection, that the
// stretch actually bakes, and the divergence helper (opposite sticks grow,
// matching sticks cancel).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const vc = s.vrControls;
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		s.objectActions.selectObject(box.uuid);

		// 186.1: entering stretch targets the SELECTED object
		vc.executeVRMenuAction('edit:mode:stretch');
		const st = vc.stretchState();
		const targetsSelection = !!st && st.uuid === box.uuid;

		const width = () => {
			const p = box.geometry.attributes.position;
			let mn = 1e9;
			let mx = -1e9;
			for (let i = 0; i < p.count; i++) {
				mn = Math.min(mn, p.getX(i));
				mx = Math.max(mx, p.getX(i));
			}
			return mx - mn;
		};
		const w0 = width();
		vc.setStretch(0, 2); // width x2 (axis 0), preview
		const wPrev = width();
		vc.commitStretch();
		const wCommit = width();
		s.history.undo();
		const wUndo = width();

		// divergence helper: opposite stick Y = grow, matching = cancel
		const divApart = vc.stretchDivergence(-1, 1);
		const divTogether = vc.stretchDivergence(-1, -1);
		// with no grips held the two-grip gesture is inactive
		const notActive = vc.twoGripStretchActive() === false;
		return { targetsSelection, w0, wPrev, wCommit, wUndo, divApart, divTogether, notActive };
	});

	h.check(res.targetsSelection, 'entering stretch targets the selected object (186.1)');
	h.check(res.wPrev > res.w0 * 1.8, `setStretch previews a wider box (${res.w0.toFixed(2)}->${res.wPrev.toFixed(2)})`);
	h.check(res.wCommit > res.w0 * 1.8, 'commit bakes the stretch (a selected object CAN now be stretched)');
	h.check(Math.abs(res.wUndo - res.w0) < 0.02, 'the stretch is undoable');
	h.check(Math.abs(res.divApart) > 1.5 && Math.abs(res.divTogether) < 0.01, 'divergent sticks stretch, matching sticks cancel');
	h.check(res.notActive, 'the two-grip gesture is inactive with no grips held');

	await h.finish(browser);
});
