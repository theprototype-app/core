// Phase 160: move vertices with the TRIGGER (click a handle to carry it, move,
// click to drop) — the same pick + drag core the grip uses (113). The drag
// follows the controller, so on-device motion is the manual check; here we
// verify the click-to-grab/drop state machine + the drag core moves a vertex.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- the drag core the trigger drives: begin -> drag -> end moves a vertex ---
	const core = await A.page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		s.commandsHandler.sceneCommand('/create box');
		const g = s.objectsGroup; let grp; g.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		window.__box = box;
		s.meshEdit.enterEditMode(box.uuid);
		const start = s.meshEdit.vrBeginHandleDrag(0);
		s.meshEdit.vrDragHandleTo(new THREE.Vector3(start.x, start.y + 0.5, start.z));
		s.meshEdit.vrEndHandleDrag();
		const p = box.geometry.attributes.position;
		let movedUp = false;
		for (let i = 0; i < p.count; i++) if (Math.abs(p.getY(i) - (start.y + 0.5)) < 1e-3) movedUp = true;
		s.meshEdit.exitEditMode();
		return { movedUp };
	});
	h.check(core.movedUp, 'the vertex drag core (trigger uses it) moves a vertex');

	// --- trigger click-to-grab / click-to-drop, with a handle on the ray axis ---
	const grab = await A.page.evaluate(() => {
		const s = window.__stores;
		const box = window.__box;
		// put a corner handle on the controller's -Z ray (origin, dir 0,0,-1):
		// box centre (0.5,0.5,-2) -> local corner (-0.5,-0.5,-0.5) at world (0,0,-2.5)
		box.position.set(0.5, 0.5, -2);
		box.updateMatrixWorld(true);
		s.objectsGroup.update((v) => v);
		s.objectActions.selectObject(box.uuid);
		s.meshEdit.enterEditMode(box.uuid);
		const before = s.vrControls.vertexTriggerActive();
		s.vrControls.vrVertexTrigger(0); // click a handle -> carry it
		const grabbed = s.vrControls.vertexTriggerActive();
		s.vrControls.vrVertexTrigger(0); // click again -> drop
		const dropped = s.vrControls.vertexTriggerActive();
		s.meshEdit.exitEditMode();
		return { before, grabbed, dropped };
	});
	h.check(grab.before === false, 'no trigger carry before the first click');
	h.check(grab.grabbed === true, 'a trigger click grabs the vertex under the ray');
	h.check(grab.dropped === false, 'a second trigger click drops it');

	// --- guard: the trigger is a no-op when not in vertex edit ---
	const guard = await A.page.evaluate(() => {
		window.__stores.vrControls.vrVertexTrigger(0);
		return window.__stores.vrControls.vertexTriggerActive();
	});
	h.check(guard === false, 'the trigger does nothing outside vertex edit');

	await h.finish(browser);
});
