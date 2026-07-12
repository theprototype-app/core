// Phase 194 + 210: after hands<->controllers the controller SLOT<->handedness
// can flip (in-headset the readout showed slot0 in:right stamp:left), so the
// three.js controller slot order and the session.inputSources order DIVERGE.
// controllerIndexFor resolves by the handedness stamped on each persistent
// controller object, so it follows the hand across a reorder (194). 210 routes
// the squeeze/grab loop + the grab/window/face axes through that same resolver
// so a grip drives the controller the acting hand actually holds. The real hand
// swap + grab feel are on-device; here we verify the resolver + the debug
// readout's composed indices follow userData.handedness, not the raw slot.
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

		// 210: the debug readout (which the grab loop's resolution mirrors) must
		// report the resolved slots by handedness after the swap. menuHand=right
		// -> menuIdx follows the RIGHT controller (now slot0), pointer the LEFT.
		let menuIdx = -1, pointerIdx = -1, snapLeft = -1, snapRight = -1;
		if (s.vrControls.vrDebugSnapshot) {
			s.vrMenuHand?.set?.('right');
			const snap = s.vrControls.vrDebugSnapshot();
			menuIdx = snap.menuIdx;
			pointerIdx = snap.pointerIdx;
			snapLeft = snap.leftIdx;
			snapRight = snap.rightIdx;
		}

		return { leftIdx, rightIdx, leftIdx2, rightIdx2, menuIdx, pointerIdx, snapLeft, snapRight };
	});

	h.check(!res.noRenderer, 'renderer is available');
	h.check(res.leftIdx === 0 && res.rightIdx === 1, 'resolves left->slot0, right->slot1 by handedness');
	h.check(res.leftIdx2 === 1 && res.rightIdx2 === 0, 'after a slot swap it FOLLOWS the hand (left->slot1, right->slot0), not the stale slot');
	h.check(res.snapLeft === 1 && res.snapRight === 0, 'debug readout leftIdx/rightIdx follow the swapped stamps');
	h.check(res.menuIdx === 0 && res.pointerIdx === 1, 'debug readout menu(right)->slot0 / pointer(left)->slot1 after the swap');

	await h.finish(browser);
});
