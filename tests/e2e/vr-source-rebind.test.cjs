// Phase 188: on hands<->controllers or a controller reconnect, WebXR reissues
// inputsourceschange and the controller slot<->handedness can flip. Per-slot
// button state + in-progress grabs are keyed by slot, so a survivor would drive
// the WRONG controller's ray. onInputSourcesChange resets that state + drops the
// transient gesture (edit MODE stays). The real slot-flip is on-device; here we
// verify the reset drops a live gesture but keeps the mode.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const vc = s.vrControls;
		const g1 = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		box.position.set(0.5, 0.5, -2); // a corner on the controller -Z ray
		box.updateMatrixWorld(true);
		s.objectsGroup.update((v) => v);
		s.objectActions.selectObject(box.uuid);
		s.meshEdit.enterEditMode(box.uuid);
		s.vrVertexHold.set(false); // toggle style so vrVertexTrigger grabs
		vc.vrVertexTrigger(0);
		const grabbedBefore = vc.vertexTriggerActive();
		s.vrGrabbedHand.set('left');
		const handBefore = g1(s.vrGrabbedHand);

		// simulate a hands<->controllers / reconnect source change
		vc.onInputSourcesChange();

		const grabbedAfter = vc.vertexTriggerActive();
		const handAfter = g1(s.vrGrabbedHand);
		const modeStillOn = g1(s.meshEdit.editingObject) === box.uuid;
		s.meshEdit.exitEditMode();
		return { grabbedBefore, handBefore, grabbedAfter, handAfter, modeStillOn };
	});

	h.check(res.grabbedBefore === true, 'a vertex grab is active before the source change');
	h.check(res.handBefore === 'left', 'a grabbed-hand binding is set before the source change');
	h.check(res.grabbedAfter === false, 'inputsourceschange drops the in-progress grab (no stale slot binding)');
	h.check(res.handAfter === null, 'inputsourceschange clears the grabbed-hand binding');
	h.check(res.modeStillOn, 'the edit MODE survives the source change (only the transient gesture drops)');

	await h.finish(browser);
});
