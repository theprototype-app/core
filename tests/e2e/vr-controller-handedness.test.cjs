// Phase 194: after hands<->controllers the controller SLOT<->handedness can
// flip, and the radial/menus (which resolved the menu hand by inputSources
// index) landed on the wrong controller. controllerIndexFor now resolves by the
// handedness stamped on each persistent controller object, so it follows the
// hand across a reorder. The real hand swap is on-device; here we verify the
// resolver follows userData.handedness, not the slot.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		if (!r) return { noRenderer: true };
		const cif = s.vrControls.controllerIndexFor;
		const c0 = r.xr.getController(0);
		const c1 = r.xr.getController(1);

		// normal: slot 0 = left, slot 1 = right
		c0.userData.handedness = 'left';
		c1.userData.handedness = 'right';
		const leftIdx = cif('left');
		const rightIdx = cif('right');

		// reorder (hands<->controllers): slot 0 becomes right, slot 1 becomes left
		c0.userData.handedness = 'right';
		c1.userData.handedness = 'left';
		const leftIdx2 = cif('left');
		const rightIdx2 = cif('right');

		return { leftIdx, rightIdx, leftIdx2, rightIdx2 };
	});

	h.check(!res.noRenderer, 'renderer is available');
	h.check(res.leftIdx === 0 && res.rightIdx === 1, 'resolves left->slot0, right->slot1 by handedness');
	h.check(res.leftIdx2 === 1 && res.rightIdx2 === 0, 'after a slot swap it FOLLOWS the hand (left->slot1, right->slot0), not the stale slot');

	await h.finish(browser);
});
