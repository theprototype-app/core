// Display options in the mesh toolbox (user reports):
//  - the object SELECTION OUTLINE covered the vertices/edges being edited. It
//    is a postprocessing pass composited after the whole scene, so nothing the
//    in-scene overlays do with depthTest/renderOrder can beat it — it is now
//    suppressed while a session is open, with a Display toggle to bring it back.
//  - the edit wireframe drew every TRIANGLE edge, including the quad diagonals
//    that are deliberately NOT pickable. It draws the quad structure now, with
//    a "Show triangulation" toggle for the raw mesh.
const h = require('./helpers.cjs');

const outlineSize = (page) => page.evaluate(() => window.__outlineDebug().selected);

const wireSegments = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					let n = 0;
					g?.getObjectByProperty('uuid', window.__box.uuid)?.traverse((o) => {
						if (o.name === 'edit-overlay') n = o.geometry.attributes.position.count / 2;
					});
					r(n);
				})()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.objectActions.selectObject(window.__box.uuid);
	});
	await A.page.waitForTimeout(300);

	// ------------------------------------------------- 1. outline suppression
	const selectedOutline = await outlineSize(A.page);
	h.check(selectedOutline > 0, 'a selected object is outlined outside edit mode (premise)');

	await A.page.evaluate(() => window.__stores.faceEdit.enterFaceEdit(window.__box.uuid));
	await A.page.waitForTimeout(200);
	h.check((await outlineSize(A.page)) === 0, 'entering face edit drops the outline');

	await A.page.evaluate(() => window.__stores.faceEdit.meshEditOutline.set(true));
	await A.page.waitForTimeout(200);
	h.check((await outlineSize(A.page)) > 0, 'the Display toggle brings it back mid-session');

	await A.page.evaluate(() => window.__stores.faceEdit.meshEditOutline.set(false));
	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await A.page.waitForTimeout(200);
	h.check((await outlineSize(A.page)) > 0, 'leaving the session restores it');

	// vertex mode honours the same pref
	await A.page.evaluate(() => window.__stores.meshEdit.enterEditMode(window.__box.uuid));
	await A.page.waitForTimeout(200);
	h.check((await outlineSize(A.page)) === 0, 'vertex mode drops it too');
	await A.page.evaluate(() => window.__stores.meshEdit.exitEditMode());
	await A.page.waitForTimeout(200);

	// ------------------------------------------------- 2. quad wireframe
	const wire = await A.page.evaluate(async () => {
		const s = window.__stores;
		const fe = s.faceEdit;
		fe.meshEditTriWire.set(false); // quad view (the default)
		fe.enterFaceEdit(window.__box.uuid);
		const quadView = (() => {
			let n = 0;
			window.__box.traverse((o) => {
				if (o.name === 'edit-overlay') n = o.geometry.attributes.position.count / 2;
			});
			return n;
		})();
		fe.meshEditTriWire.set(true); // raw triangulation
		const triView = (() => {
			let n = 0;
			window.__box.traverse((o) => {
				if (o.name === 'edit-overlay') n = o.geometry.attributes.position.count / 2;
			});
			return n;
		})();
		fe.meshEditTriWire.set(false);
		return { quadView, triView };
	});
	// a box is 6 quads: 12 box edges, and 6 diagonals the triangulation adds
	h.check(wire.quadView === 12, 'quad view draws the 12 real box edges, no diagonals');
	h.check(wire.triView === 18, 'Show triangulation adds the 6 quad diagonals back');

	// the toggle must survive a geometry swap (the wire is rebuilt from scratch)
	const afterOp = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.pickFaceUnit(0);
		fe.commitFaceOp('extrude', 0.4);
		let n = 0;
		window.__box.traverse((o) => {
			if (o.name === 'edit-overlay') n = o.geometry.attributes.position.count / 2;
		});
		let diag = 0;
		// every drawn segment must be an edge of the quad topology
		const stray = fe.wireframeDebug();
		diag = stray.diagonals;
		return { n, diag };
	});
	h.check(afterOp.n > 12, 'an extrude adds edges to the quad wire (premise)');
	h.check(afterOp.diag === 0, '...and the rebuilt wire still draws no quad diagonals');

	await A.page.evaluate(() => window.__stores.faceEdit.exitFaceEdit());
	await h.finish(browser);
});
