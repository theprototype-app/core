// Phase 164: once a primitive is mesh-edited (vertex/face), the Inspector hides
// its parametric geometry controls (a stray slider tweak would rebuild the
// shape + discard the edits) and shows a lock note instead.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		window.__box = g.children[g.children.length - 1];
		window.__stores.objectActions.selectObject(window.__box.uuid, true); // open inspector
	});
	await A.page.waitForTimeout(600);

	const fresh = await A.page.evaluate(() => ({
		sliders: !!document.querySelector('#inspector-geometry'),
		locked: !!document.querySelector('#geometry-locked')
	}));
	h.check(fresh.sliders && !fresh.locked, 'a fresh primitive shows its geometry parameter controls');

	// flag it mesh-edited (what a face/vertex edit sets) + refresh the inspector
	await A.page.evaluate(() => {
		window.__box.userData.faceEdited = true;
		window.__stores.selectedObject.update((v) => v);
	});
	await A.page.waitForTimeout(300);

	const edited = await A.page.evaluate(() => ({
		sliders: !!document.querySelector('#inspector-geometry'),
		locked: !!document.querySelector('#geometry-locked')
	}));
	h.check(!edited.sliders, 'after a mesh edit the geometry sliders are gone (cannot reset the shape)');
	h.check(edited.locked, 'a lock note explains why the parameters are hidden');

	await h.finish(browser);
});
