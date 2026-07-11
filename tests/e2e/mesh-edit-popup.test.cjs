// Phase 135: desktop mesh-edit popup — Vertices | Faces modes and the face op
// buttons apply through the shared faceEdit core (meshgeo, undoable) without a
// headset. Face PICKING via viewport raycast is manual; the ops are driven via
// the highlight + op buttons here.
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
	});
	await A.page.waitForTimeout(300);

	// --- entering vertex edit shows the popup with both modes ---
	await A.page.evaluate(() => window.__stores.meshEdit.enterEditMode(window.__box.uuid));
	await A.page.waitForTimeout(300);
	const popup = await A.page.evaluate(() => {
		const el = document.querySelector('#mesh-edit-popup');
		return {
			present: !!el,
			hasVertices: !!document.querySelector('#mesh-mode-vertices'),
			hasFaces: !!document.querySelector('#mesh-mode-faces'),
			verticesActive: document.querySelector('#mesh-mode-vertices')?.className.includes('bg-primary')
		};
	});
	h.check(popup.present && popup.hasVertices && popup.hasFaces, 'popup shows on mesh edit with both modes');
	h.check(popup.verticesActive, 'vertices mode is active first');

	// --- switching to Faces enters face-edit mode + shows op buttons ---
	await A.page.evaluate(() => document.querySelector('#mesh-mode-faces').click());
	await A.page.waitForTimeout(300);
	const faces = await A.page.evaluate(() => {
		let fe, ve;
		window.__stores.faceEdit.faceEditObject.subscribe((v) => (fe = v))();
		window.__stores.meshEdit.editingObject.subscribe((v) => (ve = v))();
		return {
			faceEditing: fe === window.__box.uuid,
			vertexExited: ve === null,
			ops: ['extrude', 'inset', 'move', 'delete'].map((o) => !!document.querySelector(`#mesh-op-${o}`))
		};
	});
	h.check(faces.faceEditing && faces.vertexExited, 'Faces mode enters face edit and leaves vertex mode');
	h.check(faces.ops.every(Boolean), 'the four face op buttons render');

	// --- pick a face (via the core) then Extrude through the button ---
	const extrude = await A.page.evaluate(async () => {
		const fe = window.__stores.faceEdit;
		fe.highlightFaceByTriangle(0); // stands in for the viewport click
		const before = fe.readTriangles(window.__box.geometry).length;
		document.querySelector('#mesh-op-amount').value = '0.4';
		document.querySelector('#mesh-op-amount').dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 50));
		document.querySelector('#mesh-op-extrude').click();
		await new Promise((r) => setTimeout(r, 50));
		const after = fe.readTriangles(window.__box.geometry).length;
		return { before, after };
	});
	h.check(extrude.before === 12 && extrude.after === 20, `Extrude button rebuilds the geometry (${extrude.before}→${extrude.after})`);

	// --- the edit is undoable through the shared meshgeo history ---
	const undone = await A.page.evaluate(() => {
		const before = window.__stores.faceEdit.readTriangles(window.__box.geometry).length;
		window.__stores.history.undo();
		const after = window.__stores.faceEdit.readTriangles(window.__box.geometry).length;
		return { before, after };
	});
	h.check(undone.before === 20 && undone.after === 12, 'the desktop face op is undoable');

	// --- finish closes the popup and exits both modes ---
	await A.page.evaluate(() => {
		window.__stores.meshEdit.exitEditMode();
		window.__stores.faceEdit.exitFaceEdit();
	});
	await A.page.waitForTimeout(300);
	const gone = await A.page.evaluate(() => !document.querySelector('#mesh-edit-popup'));
	h.check(gone, 'popup closes when editing ends');

	await h.finish(browser);
});
