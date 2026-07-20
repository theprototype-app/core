// R-1: VR pointer ray + hover. Headless coverage of the emissive-independent
// hover shell (a scene-root Box3Helper that tracks the pointed object's world
// bounds and never enters objectsGroup). Read synchronously right after the
// call — the per-frame updateRaysAndHover(false) clears the hover when NOT in
// a VR session. The fat beam + hit reticle are visual; on-device feel is the
// user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// create an object, point the hover shell at it, read state synchronously
	const hovered = await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		window.__stores.commandsHandler.sceneCommand('/create Box 2 2 2');
		let box = null;
		let scene = null;
		window.__stores.objectsGroup.subscribe((g) => g?.children.forEach((c) => { if (c.name === 'Box') box = c; }))();
		window.__stores.globalScene.subscribe((s) => (scene = s))();
		box.updateMatrixWorld(true);
		window.__stores.vrControls.updateHoverBox(box);
		const shell = scene.getObjectByName('vr-hover-box');
		const size = shell.box.getSize(new THREE.Vector3());
		let inObjects = false;
		window.__stores.objectsGroup.subscribe((g) => g?.traverse((o) => { if (o.name === 'vr-hover-box') inObjects = true; }))();
		return { visible: shell.visible, inScene: shell.parent === scene, sizeX: +size.x.toFixed(2), inObjects };
	});
	h.check(hovered.visible === true, 'hover shell appears around the pointed object');
	h.check(hovered.inScene === true, 'hover shell lives at the scene root');
	h.check(hovered.sizeX >= 1.9 && hovered.sizeX <= 2.1, `hover shell matches the object bounds (${hovered.sizeX})`);
	h.check(hovered.inObjects === false, 'hover shell never leaks into GLTF sync (not under objectsGroup)');

	// clearing the hover hides the shell
	const cleared = await A.page.evaluate(() => {
		window.__stores.vrControls.updateHoverBox(null);
		let scene = null;
		window.__stores.globalScene.subscribe((s) => (scene = s))();
		return scene.getObjectByName('vr-hover-box').visible;
	});
	h.check(cleared === false, 'hover shell hides when nothing is pointed at');

	await h.finish(browser);
});
