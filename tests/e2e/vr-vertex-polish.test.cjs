// Phase 119: VR vertex edit polish — the selection indicator hides while
// editing, the handle dots follow the object when it moves, and the pointer
// ray hover tints a handle. In-headset feel is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__box = box;
		window.__stores.objectActions.selectObject(box.uuid);
		window.__stores.isVRMode.set(true);
	});
	await A.page.waitForTimeout(600);

	// --- the selection indicator hides once vertex editing starts ---
	const readIndicator = () =>
		A.page.evaluate(() => {
			let s;
			window.__stores.globalScene.subscribe((x) => (s = x))();
			return s?.getObjectByName('vr-selection-shell')?.visible;
		});
	const before = await readIndicator();
	await A.page.evaluate(() => window.__stores.meshEdit.enterEditMode(window.__box.uuid));
	await A.page.waitForTimeout(300); // let the shell's useTask re-evaluate visibility
	const whileEditing = await readIndicator();
	h.check(before === true, 'selection indicator shows for a VR selection');
	h.check(whileEditing === false, 'indicator hides once vertex editing starts');

	// --- the handle dots follow the object when it moves ---
	const follow = await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		const handles = scene.getObjectByName('vertex-handles');
		const m0 = new THREE.Matrix4();
		handles.getMatrixAt(0, m0);
		const before = new THREE.Vector3().setFromMatrixPosition(m0);
		// move the edited object, then tick
		window.__box.position.x += 3;
		window.__box.updateMatrixWorld(true);
		window.__stores.meshEdit.tickMeshEdit();
		const m1 = new THREE.Matrix4();
		handles.getMatrixAt(0, m1);
		const after = new THREE.Vector3().setFromMatrixPosition(m1);
		return { dx: after.x - before.x };
	});
	h.check(Math.abs(follow.dx - 3) < 1e-4, `handles follow a moved object (+${follow.dx.toFixed(2)} x)`);

	// --- hover tints a handle; change is reported once ---
	const hover = await A.page.evaluate(() => {
		const m = window.__stores.meshEdit;
		const changed1 = m.setHoveredHandle(2);
		const changedAgain = m.setHoveredHandle(2); // same → no change
		const cleared = m.setHoveredHandle(-1);
		// the instance color of a hovered handle differs from the base blue
		m.setHoveredHandle(1);
		const THREE = window.__stores.THREE;
		let scene;
		window.__stores.globalScene.subscribe((x) => (scene = x))();
		const handles = scene.getObjectByName('vertex-handles');
		const c = new THREE.Color();
		handles.getColorAt(1, c);
		const hoveredHex = '#' + c.getHexString();
		handles.getColorAt(3, c);
		const baseHex = '#' + c.getHexString();
		m.setHoveredHandle(-1);
		return { changed1, changedAgain, cleared, hoveredHex, baseHex };
	});
	h.check(hover.changed1 && !hover.changedAgain && hover.cleared, 'hover change is reported once per change');
	h.check(hover.hoveredHex !== hover.baseHex, `hovered handle tints differently (${hover.hoveredHex} vs ${hover.baseHex})`);

	// --- exit restores the indicator ---
	const editing = await A.page.evaluate(() => {
		window.__stores.meshEdit.exitEditMode();
		let v;
		window.__stores.meshEdit.editingObject.subscribe((x) => (v = x))();
		return v;
	});
	await A.page.waitForTimeout(300); // let the shell's useTask re-evaluate
	const indicatorBack = await readIndicator();
	h.check(editing === null, 'exit clears edit mode');
	h.check(indicatorBack === true, 'the selection indicator comes back after exit');

	await h.finish(browser);
});
