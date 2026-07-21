// D1 (roadmap 13): the teleport arc must anchor to the RIGHT hand resolved by
// the handedness STAMP on the persistent controller objects, not the raw
// session.inputSources index — the two diverge after a hands<->controllers
// swap (the 194/210 class of bug; updateTeleport was the last raw-slot
// holdout). We stamp the slots both ways and check teleportArcPose() follows
// the stamp. Arc feel/blink stay on-device checks.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		if (!r) return { noRenderer: true };
		const c0 = r.xr.getController(0);
		const c1 = r.xr.getController(1);
		// XR controller groups have matrixAutoUpdate=false (WebXRManager composes
		// their matrix from poses) — write the matrix directly
		c0.matrix.makeTranslation(-0.5, 1.2, 0);
		c1.matrix.makeTranslation(0.5, 1.2, 0);
		c0.updateMatrixWorld(true);
		c1.updateMatrixWorld(true);

		// normal order: slot 1 is the right hand
		c0.userData.handedness = 'left';
		c1.userData.handedness = 'right';
		const normal = s.vrControls.teleportArcPose();

		// reordered (hands<->controllers swap): slot 0 becomes the right hand
		c0.userData.handedness = 'right';
		c1.userData.handedness = 'left';
		const swapped = s.vrControls.teleportArcPose();

		// no right hand at all -> no arc pose
		c0.userData.handedness = 'left';
		const missing = s.vrControls.teleportArcPose();

		return {
			normal: normal && { index: normal.index, x: normal.origin.x },
			swapped: swapped && { index: swapped.index, x: swapped.origin.x },
			missing
		};
	});

	h.check(!res.noRenderer, 'renderer is available');
	h.check(
		res.normal?.index === 1 && Math.abs(res.normal.x - 0.5) < 1e-6,
		`normal order: arc rides slot 1 at x=0.5 (${JSON.stringify(res.normal)})`
	);
	h.check(
		res.swapped?.index === 0 && Math.abs(res.swapped.x + 0.5) < 1e-6,
		`after a slot swap the arc FOLLOWS the right hand to slot 0 at x=-0.5 (${JSON.stringify(res.swapped)})`
	);
	h.check(res.missing === null, 'no right hand -> no arc pose');

	await h.finish(browser);
});
