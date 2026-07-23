// D9 (roadmap 13): stick navigation must stand down while a manipulation
// gesture owns the sticks/reference space — mesh-edit gestures (vertex carry,
// face live-adjust, face grab, stretch slider), world pan (right grip on
// air), two-grip world grab and two-hand object scale; the teleport/snap gate
// additionally suppresses while EITHER grip is held. vrNavigationSuppressed
// is the single predicate wired into updateVRControls (right stick) and
// VRControls.svelte (left stick). Here we drive the headlessly-reachable
// gesture states through their REAL entry points; grips/world-pan need a live
// squeeze loop, so their in-headset feel is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const sup = (opts) => s.vrControls.vrNavigationSuppressed(opts);

		s.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.position.set(0, 0, 0);
		box.updateMatrixWorld(true);

		const baseline = { plain: sup(), grips: sup({ grips: true }) };

		// --- face live-adjust (extrude/inset gesture) suppresses ---
		s.faceEdit.enterFaceEdit(box.uuid);
		s.faceEdit.beginFaceAdjust(0, 'extrude', 0.15);
		const duringFaceAdjust = sup();
		s.faceEdit.cancelFaceAdjust();
		const afterFaceAdjust = sup();
		s.faceEdit.exitFaceEdit();

		// --- vertex carry (hold-style trigger grab) suppresses ---
		s.vrVertexHold.set(true);
		s.meshEdit.enterEditMode(box.uuid);
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		const c1 = r.xr.getController(1);
		// aim slot 1 straight at the (0.5, 0.5, 0.5) corner handle
		c1.matrix.makeTranslation(0.5, 0.5, 5);
		c1.updateMatrixWorld(true);
		s.vrControls.vrVertexGrabStart(1);
		const carryActive = s.vrControls.vertexTriggerActive();
		const duringCarry = sup();
		s.vrControls.vrVertexGrabEnd();
		const afterCarry = { sup: sup(), active: s.vrControls.vertexTriggerActive() };
		s.meshEdit.exitEditMode();

		return { baseline, duringFaceAdjust, afterFaceAdjust, carryActive, duringCarry, afterCarry };
	});

	h.check(
		res.baseline.plain === false && res.baseline.grips === false,
		'idle: navigation is not suppressed'
	);
	h.check(
		res.duringFaceAdjust === true && res.afterFaceAdjust === false,
		`a live face adjust suppresses navigation, cancel releases it (${res.duringFaceAdjust}/${res.afterFaceAdjust})`
	);
	h.check(res.carryActive === true, 'the trigger vertex carry actually engaged');
	h.check(
		res.duringCarry === true && res.afterCarry.sup === false && res.afterCarry.active === false,
		`a vertex carry suppresses navigation, release restores it (${res.duringCarry}/${res.afterCarry.sup})`
	);

	await h.finish(browser);
});
