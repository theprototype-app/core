// Phase 183: VR create-face — the Edit menu (vertices tab) has a Create face
// action that enters a select mode (a trigger tap adds the ray vertex to the
// selection instead of grabbing), then builds a tri/quad via the shared 177
// helper. Aiming at 3-4 distinct handles is on-device; here we drive selection
// by index and verify the state machine + commit.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(() => {
		const s = window.__stores;
		const me = s.meshEdit;
		const vc = s.vrControls;
		const fe = s.faceEdit;
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		const uuid = box.uuid;
		// put a corner handle on the controller -Z ray (as vr-vertex-trigger does)
		box.position.set(0.5, 0.5, -2);
		box.updateMatrixWorld(true);
		s.objectsGroup.update((v) => v);
		s.objectActions.selectObject(uuid);
		me.enterEditMode(uuid);

		const size = () => {
			let v;
			me.vertexSelectionSize.subscribe((x) => (v = x))();
			return v;
		};
		const creating = () => {
			let v;
			vc.vrFaceCreateMode.subscribe((x) => (v = x))();
			return v;
		};
		const tris = () => fe.readTriangles(box.geometry).length;

		const beforeTris = tris();
		vc.executeVRMenuAction('edit:createface'); // enter create-select mode
		const inCreate = creating();

		// a trigger click in create mode selects the ray vertex (does NOT grab)
		vc.vrVertexTrigger(0);
		const afterTap = size();
		const notGrabbing = vc.vertexTriggerActive() === false;

		// aiming at 3 distinct handles is on-device; select by index then build
		me.clearVertexSelection();
		me.toggleVertexSelection(0);
		me.toggleVertexSelection(1);
		me.toggleVertexSelection(2);
		const sel3 = size();
		vc.executeVRMenuAction('edit:createface'); // build
		const afterBuildTris = tris();
		const exitedCreate = creating();
		me.exitEditMode();
		return { beforeTris, inCreate, afterTap, notGrabbing, sel3, afterBuildTris, exitedCreate };
	});

	h.check(res.beforeTris === 12, `box starts at 12 tris (${res.beforeTris})`);
	h.check(res.inCreate === true, 'the Create face action enters create-select mode');
	h.check(res.afterTap === 1 && res.notGrabbing, 'a trigger tap in create mode selects the ray vertex (no grab)');
	h.check(res.sel3 === 3, 'three vertices selected');
	h.check(res.afterBuildTris === 13, `the Build action appends one triangle (${res.beforeTris}->${res.afterBuildTris})`);
	h.check(res.exitedCreate === false, 'building exits create-select mode');

	await h.finish(browser);
});
