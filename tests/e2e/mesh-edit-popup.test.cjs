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

	// ---- D2 (15): an outside click clears the pick but keeps the session ----
	// find a real canvas point whose ray misses the box (overlays excluded).
	// Recomputed PER PHASE (M0): the toolbox is taller in face mode than in
	// vertex mode, so a point that was canvas in one phase can sit under the
	// window in the next — and a click ON the toolbox rightly keeps the pick.
	const findMiss = () =>
		A.page.evaluate(() => {
			const cands = [
				[Math.round(innerWidth * 0.1), Math.round(innerHeight * 0.55)],
				[Math.round(innerWidth * 0.9), Math.round(innerHeight * 0.6)],
				[Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.92)]
			];
			for (const [x, y] of cands) {
				const el = document.elementFromPoint(x, y);
				if (el && el.tagName === 'CANVAS') return { x, y };
			}
			return null;
		});
	const miss = await findMiss();
	h.check(!!miss, 'found an empty canvas point for the miss click');

	await A.page.evaluate(() => {
		const s = window.__stores;
		s.meshEdit.enterEditMode(window.__box.uuid);
		s.meshEdit.selectHandle(0); // D5: a plain pick IS the selection
	});
	await A.page.waitForTimeout(200);
	const selCount = await A.page.evaluate(
		() => document.querySelector('#mesh-sel-count')?.textContent
	);
	h.check(selCount === '1 sel', `the counter includes the gizmo pick — no more "0 sel" ("${selCount}")`);
	await A.page.evaluate(() => window.__stores.meshEdit.toggleVertexSelection(1));
	await A.page.mouse.click(miss.x, miss.y);
	await A.page.waitForTimeout(200);
	const vtxMiss = await A.page.evaluate(() => {
		const s = window.__stores;
		let size, editing;
		s.meshEdit.vertexSelectionSize.subscribe((v) => (size = v))();
		s.meshEdit.editingObject.subscribe((v) => (editing = v))();
		return { size, stillEditing: editing === window.__box.uuid };
	});
	h.check(vtxMiss.size === 0, `outside click clears the vertex multi-pick (${vtxMiss.size} left)`);
	h.check(vtxMiss.stillEditing, 'the vertex session survives the outside click');

	await A.page.evaluate(() => {
		const s = window.__stores;
		s.meshEdit.exitEditMode();
		s.faceEdit.enterFaceEdit(window.__box.uuid);
		s.faceEdit.toggleFaceMulti(); // ON
		s.faceEdit.toggleFaceSelection(0);
	});
	const faceMissPoint = await findMiss(); // the face-mode toolbox covers more
	h.check(!!faceMissPoint, 'found an empty canvas point for the face-phase miss click');
	await A.page.mouse.click(faceMissPoint.x, faceMissPoint.y);
	await A.page.waitForTimeout(200);
	const faceMiss = await A.page.evaluate(() => {
		const s = window.__stores;
		let sel, fe, multi;
		s.faceEdit.faceEditSelectedTris.subscribe((v) => (sel = v))();
		s.faceEdit.faceEditObject.subscribe((v) => (fe = v))();
		s.faceEdit.faceEditMulti.subscribe((v) => (multi = v))();
		return { sel: sel.length, stillEditing: fe === window.__box.uuid, multi };
	});
	h.check(faceMiss.sel === 0, `outside click clears the face multi-pick (${faceMiss.sel} left)`);
	h.check(faceMiss.stillEditing && faceMiss.multi, 'the face session (and Multi mode) survive the outside click');

	// ---- D3 (15): hotkeys toggle + fly guard + "?" bindings popover ----
	await A.page.evaluate(() => window.__stores.faceEdit.toggleFaceMulti()); // OFF again
	const camPos = () =>
		A.page.evaluate(
			() =>
				new Promise((r) =>
					window.__stores.globalCamera.subscribe((c) =>
						r([c.position.x, c.position.y, c.position.z])
					)()
				)
		);
	const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

	// hotkeys default ON: I arms Inset from the keyboard
	await A.page.keyboard.press('i');
	await A.page.waitForTimeout(100);
	const armedOn = await A.page.evaluate(
		() => new Promise((r) => window.__stores.faceEdit.faceEditOp.subscribe(r)())
	);
	h.check(armedOn === 'inset', `hotkeys ON: I arms inset (${armedOn})`);

	// fly guard: holding W while a session owns the keys must not move the camera
	const flyBefore = await camPos();
	await A.page.keyboard.down('w');
	await A.page.waitForTimeout(700);
	await A.page.keyboard.up('w');
	const flyAfter = await camPos();
	h.check(
		dist(flyBefore, flyAfter) < 1e-3,
		`W does not fly the camera during mesh edit (moved ${dist(flyBefore, flyAfter).toFixed(5)})`
	);

	// "?" opens the bindings popover
	await A.page.evaluate(() => document.querySelector('#mesh-keys-help').click());
	await A.page.waitForTimeout(200);
	const popover = await A.page.evaluate(() => {
		const el = document.querySelector('#mesh-keys-popover');
		return { present: !!el, mentionsWeld: el ? el.textContent.includes('Weld') : false };
	});
	h.check(popover.present && popover.mentionsWeld, 'the "?" popover lists the bindings');

	// toggle hotkeys OFF: keys stop arming ops and the camera flies again
	await A.page.evaluate(() => document.querySelector('#mesh-hotkeys-toggle').click());
	await A.page.waitForTimeout(100);
	await A.page.keyboard.press('g');
	await A.page.waitForTimeout(100);
	const armedOff = await A.page.evaluate(
		() => new Promise((r) => window.__stores.faceEdit.faceEditOp.subscribe(r)())
	);
	h.check(armedOff === 'inset', `hotkeys OFF: G leaves the armed op alone (${armedOff})`);
	const flyBefore2 = await camPos();
	await A.page.keyboard.down('w');
	await A.page.waitForTimeout(700);
	await A.page.keyboard.up('w');
	const flyAfter2 = await camPos();
	h.check(
		dist(flyBefore2, flyAfter2) > 0.05,
		`hotkeys OFF returns the fly keys (moved ${dist(flyBefore2, flyAfter2).toFixed(3)})`
	);

	// ---- D4 (15): contrast-aware edit wireframe ----
	const contrast = await A.page.evaluate(() => {
		const s = window.__stores;
		s.faceEdit.exitFaceEdit();
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		const wireHex = () => box.children.find((c) => c.name === 'edit-overlay').material.color.getHexString();
		box.material.color.setRGB(1, 1, 1); // light material -> dark wire
		s.meshEdit.enterEditMode(box.uuid);
		const onWhite = wireHex();
		s.meshEdit.exitEditMode();
		box.material.color.setRGB(0.02, 0.02, 0.02); // dark material -> light wire
		s.meshEdit.enterEditMode(box.uuid);
		const onDark = wireHex();
		s.meshEdit.exitEditMode();
		return { onWhite, onDark };
	});
	h.check(
		contrast.onWhite === '1f2937' && contrast.onDark !== contrast.onWhite,
		`the edit wire contrasts with the material (white->#${contrast.onWhite}, dark->#${contrast.onDark})`
	);

	// ---- D3: the hotkeys pref persists across a reload (it is OFF right now) ----
	await h.freshReload(A);
	const persisted = await A.page.evaluate(
		() => new Promise((r) => window.__stores.faceEdit.meshEditHotkeys.subscribe(r)())
	);
	h.check(persisted === false, 'the hotkeys pref persists across a reload');

	await h.finish(browser);
});
