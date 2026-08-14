// Phase 176: Extrude/Inset reveal a nested params row (amount / auto-apply /
// Apply) below the toolbar; amount lives only in that row (not row 1); Move and
// Delete have no nested row. Auto-apply (default on) commits the op on a face
// click; off = a face click only selects.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		window.__box = box;
		s.objectActions.selectObject(box.uuid);
		s.faceEdit.enterFaceEdit(box.uuid);
	});
	await A.page.waitForTimeout(300);

	const paramsVisible = () => A.page.evaluate(() => !!document.querySelector('#mesh-op-params'));
	const amountInParams = () =>
		A.page.evaluate(() => {
			const amt = document.querySelector('#mesh-op-amount');
			return amt ? !!amt.closest('#mesh-op-params') : false;
		});
	const autoState = () =>
		A.page.evaluate(() => {
			let v;
			window.__stores.faceEdit.faceAutoApply.subscribe((x) => (v = x))();
			return v;
		});

	// MOVE is the default op now (a plain click must not extrude the face), so
	// extrude has to be ARMED before its params row exists
	h.check(!(await paramsVisible()), 'the default Move op shows no amount row');
	await A.page.evaluate(() => window.__stores.faceEdit.setFaceOp('extrude'));
	h.check(await paramsVisible(), 'arming Extrude shows the nested params row');
	h.check(await amountInParams(), 'the amount input lives in the nested params row, not row 1');

	// Move hides the params row; Inset shows it again
	await A.page.locator('#mesh-op-move').click();
	await A.page.waitForTimeout(100);
	h.check(!(await paramsVisible()), 'Move has no nested params row');
	await A.page.locator('#mesh-op-inset').click();
	await A.page.waitForTimeout(100);
	h.check(await paramsVisible(), 'Inset shows the nested params row');

	// auto-apply checkbox toggles the store
	h.check((await autoState()) === true, 'auto-apply defaults on');
	await A.page.locator('#mesh-op-autoapply').click();
	// POLL, don't read in the click's own tick: a synthetic click races Svelte's
	// binding flush, and under machine load the fixed 100ms wait read the store
	// before bind:checked had written it (the check below it, which depends on
	// the same flip, kept PASSING — the flip was real, the read was early)
	await h.eventually(autoState, (v) => v === false, 'toggling the checkbox turns auto-apply off');
	await A.page.locator('#mesh-op-autoapply').click();
	await A.page.waitForTimeout(100);

	// auto-apply ON: a face click (autoApplyFaceOp, called by Scene) commits
	const applied = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.setFaceOp('extrude');
		fe.highlightFaceByTriangle(0);
		const before = fe.readTriangles(window.__box.geometry).length;
		const committed = fe.autoApplyFaceOp();
		const after = fe.readTriangles(window.__box.geometry).length;
		return { committed, before, after };
	});
	h.check(applied.committed && applied.after > applied.before, `auto-apply commits on a face click (${applied.before}->${applied.after})`);

	// auto-apply OFF: a face click does NOT commit
	const notApplied = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.faceAutoApply.set(false);
		fe.setFaceOp('extrude');
		fe.highlightFaceByTriangle(0);
		const before = fe.readTriangles(window.__box.geometry).length;
		const committed = fe.autoApplyFaceOp();
		const after = fe.readTriangles(window.__box.geometry).length;
		return { committed, before, after };
	});
	h.check(!notApplied.committed && notApplied.after === notApplied.before, 'with auto-apply off, a face click does not commit');

	await h.finish(browser);
});
