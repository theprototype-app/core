// Phase 135 + 144: desktop mesh-edit toolbar — Vertices | Faces modes and the
// face op buttons apply through the shared faceEdit core (meshgeo, undoable)
// without a headset. 144 reworked the popup into a Draw-style pinned strip
// (active mode state, a Done button, Esc to exit). Face PICKING via viewport
// raycast is manual; the ops are driven via the highlight + op buttons here.
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
			rounded: el ? getComputedStyle(el).borderTopLeftRadius : null,
			hasVertices: !!document.querySelector('#mesh-mode-vertices'),
			hasFaces: !!document.querySelector('#mesh-mode-faces'),
			hasDone: !!document.querySelector('#mesh-edit-done'),
			verticesActive: document.querySelector('#mesh-mode-vertices')?.className.includes('bg-primary'),
			facesActive: document.querySelector('#mesh-mode-faces')?.className.includes('bg-primary')
		};
	});
	h.check(popup.present && popup.hasVertices && popup.hasFaces, 'toolbar shows on mesh edit with both modes');
	h.check(popup.hasDone, '144: the Draw-style toolbar has a Done button');
	h.check(popup.verticesActive && !popup.facesActive, 'vertices mode is the active toggle first');

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

	// --- pick a face, activate Extrude (reveals the 176 params row), Apply ---
	const extrude = await A.page.evaluate(async () => {
		const fe = window.__stores.faceEdit;
		fe.highlightFaceByTriangle(0); // stands in for the viewport click
		const before = fe.readTriangles(window.__box.geometry).length;
		document.querySelector('#mesh-op-extrude').click(); // activate the tool
		await new Promise((r) => setTimeout(r, 50));
		const paramsRow = !!document.querySelector('#mesh-op-params'); // 176: nested row appears
		document.querySelector('#mesh-op-amount').value = '0.4';
		document.querySelector('#mesh-op-amount').dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 50));
		document.querySelector('#mesh-op-apply').click(); // 176: Apply commits on the selected face
		await new Promise((r) => setTimeout(r, 50));
		const after = fe.readTriangles(window.__box.geometry).length;
		return { before, after, paramsRow };
	});
	h.check(extrude.paramsRow, '176: activating Extrude reveals the nested params row');
	h.check(extrude.before === 12 && extrude.after === 20, `Apply rebuilds the geometry (${extrude.before}->${extrude.after})`);

	// --- the edit is undoable through the shared meshgeo history ---
	const undone = await A.page.evaluate(() => {
		const before = window.__stores.faceEdit.readTriangles(window.__box.geometry).length;
		window.__stores.history.undo();
		const after = window.__stores.faceEdit.readTriangles(window.__box.geometry).length;
		return { before, after };
	});
	h.check(undone.before === 20 && undone.after === 12, 'the desktop face op is undoable');

	// --- 144: Esc exits (closes the toolbar + both modes) ---
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(300);
	const escaped = await A.page.evaluate(() => {
		let fe, ve;
		window.__stores.faceEdit.faceEditObject.subscribe((v) => (fe = v))();
		window.__stores.meshEdit.editingObject.subscribe((v) => (ve = v))();
		return { gone: !document.querySelector('#mesh-edit-popup'), fe, ve };
	});
	h.check(escaped.gone && escaped.fe === null && escaped.ve === null, 'Esc closes the toolbar and exits both modes');

	await h.finish(browser);
});
