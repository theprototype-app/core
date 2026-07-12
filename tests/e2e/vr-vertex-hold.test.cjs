// Phase 182: vertex move defaults to HOLD-the-trigger (grab on press, drop on
// release) with a Settings toggle back to the press/press TOGGLE style. The
// grab gesture needs a headset; here we verify the setting default/persist, the
// Settings UI, and that the hold handlers are wired.
const h = require('./helpers.cjs');

const store = (page, name) =>
	page.evaluate((n) => {
		let v;
		window.__stores[n].subscribe((x) => (v = x))();
		return v;
	}, name);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	h.check((await store(A.page, 'vrVertexHold')) === true, 'vrVertexHold defaults on (hold to move)');

	const fns = await A.page.evaluate(() => ({
		start: typeof window.__stores.vrControls.vrVertexGrabStart === 'function',
		end: typeof window.__stores.vrControls.vrVertexGrabEnd === 'function'
	}));
	h.check(fns.start && fns.end, 'vrControls exposes the hold grab/drop handlers');

	// hold-style state machine: press (selectstart) grabs, release (selectend)
	// drops, and a full select must NOT toggle-drop while holding
	const hold = await A.page.evaluate(() => {
		const s = window.__stores;
		s.vrVertexHold.set(true);
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		// put a corner handle on the controller -Z ray (as vr-vertex-trigger does)
		box.position.set(0.5, 0.5, -2);
		box.updateMatrixWorld(true);
		s.objectsGroup.update((v) => v);
		s.objectActions.selectObject(box.uuid);
		s.meshEdit.enterEditMode(box.uuid);
		const before = s.vrControls.vertexTriggerActive();
		s.vrControls.vrVertexGrabStart(0);
		const grabbed = s.vrControls.vertexTriggerActive();
		s.vrControls.vrVertexTrigger(0); // a 'select' must not toggle-drop in hold mode
		const stillHeld = s.vrControls.vertexTriggerActive();
		s.vrControls.vrVertexGrabEnd();
		const dropped = s.vrControls.vertexTriggerActive();
		s.meshEdit.exitEditMode();
		return { before, grabbed, stillHeld, dropped };
	});
	h.check(hold.before === false, 'no carry before pressing the trigger');
	h.check(hold.grabbed === true, 'holding the trigger (selectstart) grabs the vertex');
	h.check(hold.stillHeld === true, 'a select does NOT toggle-drop while holding');
	h.check(hold.dropped === false, 'releasing the trigger (selectend) drops it');

	// Settings VR toggle
	await A.page.evaluate(() => window.__stores.settingsOpen.set(true));
	await A.page.waitForTimeout(400);
	await A.page.getByText('VR', { exact: true }).first().click();
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#vr-vertex-hold').count() > 0, 'Settings VR has a Hold-to-move-vertex toggle');
	h.check((await A.page.evaluate(() => document.querySelector('#vr-vertex-hold')?.checked)) === true, 'the toggle is on by default');

	// uncheck -> toggle style + persisted
	await A.page.evaluate(() => document.querySelector('#vr-vertex-hold').click());
	await A.page.waitForTimeout(200);
	const off = await A.page.evaluate(() => ({
		ls: localStorage.getItem('vrVertexHold'),
		store: (() => {
			let v;
			window.__stores.vrVertexHold.subscribe((x) => (v = x))();
			return v;
		})()
	}));
	h.check(off.ls === 'false' && off.store === false, 'unchecking switches to the toggle style + persists');

	// re-check -> hold again
	await A.page.evaluate(() => document.querySelector('#vr-vertex-hold').click());
	await A.page.waitForTimeout(200);
	h.check((await store(A.page, 'vrVertexHold')) === true, 're-checking restores hold mode');

	await h.finish(browser);
});
