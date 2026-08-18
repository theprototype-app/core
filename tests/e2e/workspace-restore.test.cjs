// #20 P5 — the workspace: panels restored locally, selection + edit mode in the file.
//
// The split IS the design, so the checks assert both halves AND the boundary between
// them: a .tpscene must carry the selection and the edit session, and must NOT carry
// panel layout (that would rearrange the screen of whoever opens it).
//
// The most valuable check here is the negative one: a scene saved with no selection and
// no session must have NO `workspace` field at all, which is what keeps every file
// written before this commit loading exactly as it did.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- 1. a plain reload is a CLEAN SLATE ------------------------------------
	// The user's call, revising the original fork: reloading must NOT bring windows back.
	// The layout returns only on an explicit Restore, the auto-restore setting, or a file
	// load — so it rides the SAVED PAYLOAD, with no localStorage copy and no boot apply.
	const opened = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.flowGraphClose.set(false);
		w.animationClose.set(false);
		w.inspectorClose.set(false);
		w.bottomDock.bottomDockActive.set('animation');
		await new Promise((r) => setTimeout(r, 500));
		return {
			snapshot: w.workspace.snapshotWorkspace(),
			stored: localStorage.getItem('workspaceLayout')
		};
	});
	h.check(
		opened.snapshot.open.flow === true && opened.snapshot.open.animation === true,
		`the snapshot records panels as OPEN, not as the inverted *Close flag (${JSON.stringify(opened.snapshot.open)})`
	);
	h.check(opened.snapshot.dockTab === 'animation', `and the active dock tab (${opened.snapshot.dockTab})`);
	h.check(
		opened.stored === null,
		`nothing is written to localStorage — the layout is not a boot-time preference (${opened.stored})`
	);

	await h.freshReload(A);
	const afterReload = await A.page.evaluate(() => {
		const w = window.__stores;
		let flow, anim, inspector;
		w.flowGraphClose.subscribe((v) => (flow = v))();
		w.animationClose.subscribe((v) => (anim = v))();
		w.inspectorClose.subscribe((v) => (inspector = v))();
		return { flowOpen: !flow, animOpen: !anim, inspectorOpen: !inspector };
	});
	h.check(
		!afterReload.flowOpen && !afterReload.animOpen && !afterReload.inspectorOpen,
		`a plain reload comes up with everything CLOSED (${JSON.stringify(afterReload)})`
	);

	// ---- 2. applying a record opens what it names, and only that ---------------
	// A record from an older or newer build must only ever restore LESS — it must never
	// close a panel it has never heard of.
	const partial = await A.page.evaluate(async () => {
		const w = window.__stores;
		// NOT the Explorer: bottomDock closes it whenever a Flow-family panel becomes the
		// visible dock tab, so it could never stay open beside `flow` and the check would be
		// measuring that rule instead of this one. The object list shares nothing with the dock.
		w.objectListClose.set(false); // open, and absent from the record below
		await new Promise((r) => setTimeout(r, 200));
		w.workspace.applyWorkspace({ open: { flow: true }, dockTab: 'flow' });
		await new Promise((r) => setTimeout(r, 300));
		let flow, explorer, tab;
		w.flowGraphClose.subscribe((v) => (flow = v))();
		w.objectListClose.subscribe((v) => (explorer = v))();
		w.bottomDock.bottomDockActive.subscribe((v) => (tab = v))();
		return { flowOpen: !flow, listOpen: !explorer, tab };
	});
	h.check(
		partial.flowOpen === true && partial.tab === 'flow',
		`applying a record opens what it names (${JSON.stringify(partial)})`
	);
	h.check(
		partial.listOpen === true,
		`and leaves a panel it does not mention alone (${JSON.stringify(partial)})`
	);

	// ---- 3. a scene with nothing to resume carries NO workspace field ----------
	const bare = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 900));
		w.objectActions.deselectObject();
		await new Promise((r) => setTimeout(r, 400));
		// close everything, so there is genuinely nothing to resume
		w.workspace.closeWorkspace();
		await new Promise((r) => setTimeout(r, 400));
		const payload = w.sessions.buildSessionPayload('bare');
		return { has: 'workspace' in payload, value: payload.workspace };
	});
	h.check(
		bare.value === null || bare.value === undefined,
		`nothing selected and no session means no resume state (${JSON.stringify(bare.value)})`
	);

	// ---- 4. the SELECTION rides the file ---------------------------------------
	const withSelection = await A.page.evaluate(async () => {
		const w = window.__stores;
		// section 3 closed everything to prove the empty case, so open something again —
		// a layout is only recorded when there IS one
		w.objectListClose.set(false);
		await new Promise((r) => setTimeout(r, 300));
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 800));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const a = g.children[g.children.length - 2];
		const b = g.children[g.children.length - 1];
		w.objectActions.applySelectionSet([a.uuid, b.uuid]);
		await new Promise((r) => setTimeout(r, 400));
		const payload = w.sessions.buildSessionPayload('with selection');
		return { uuids: [a.uuid, b.uuid], saved: payload.workspace, payload };
	});
	h.check(
		withSelection.saved?.selection?.length === 2,
		`a two-object selection is saved (${JSON.stringify(withSelection.saved?.selection?.length)})`
	);
	// the layout rides the payload now (the user revision) - under its own layout key,
	// so selection / edit / layout stay separable rather than one flat blob
	h.check(
		!!withSelection.saved?.layout && typeof withSelection.saved.layout.open === "object",
		`and the payload carries the panel layout (${JSON.stringify(Object.keys(withSelection.saved ?? {}))})`
	);

	// ---- 5. the EDIT SESSION and its picks ride the file ----------------------
	const withSession = await A.page.evaluate(async () => {
		const w = window.__stores;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.children[g.children.length - 1];
		w.objectActions.applySelectionSet([object.uuid]);
		await new Promise((r) => setTimeout(r, 300));
		w.faceEdit.enterFaceEdit(object.uuid);
		await new Promise((r) => setTimeout(r, 500));
		let entered;
		w.faceEdit.faceEditObject.subscribe((v) => (entered = v))();
		if (!entered) return { entered: false };
		w.faceEdit.faceEditSelectedTris.set([0, 1, 2]);
		await new Promise((r) => setTimeout(r, 300));
		const payload = w.sessions.buildSessionPayload('mid edit');
		return { entered: true, uuid: object.uuid, saved: payload.workspace, payload };
	});
	h.check(withSession.entered, 'a face session opened on the box (premise)');
	h.check(
		withSession.saved?.edit?.kind === 'mesh' && withSession.saved?.edit?.uuid === withSession.uuid,
		`the open session is saved against its object (${JSON.stringify(withSession.saved?.edit?.kind)})`
	);
	h.check(
		JSON.stringify(withSession.saved?.edit?.tris) === JSON.stringify([0, 1, 2]),
		`with its element picks (${JSON.stringify(withSession.saved?.edit?.tris)})`
	);

	// ---- 6. loading that payload RESUMES the session ---------------------------
	// The point of carrying picks at all: they come back.
	const resumed = await A.page.evaluate(async (payload) => {
		const w = window.__stores;
		// leave the session and clear everything first, so a resume cannot be confused
		// with "it was never closed"
		w.faceEdit.exitFaceEdit();
		w.objectActions.deselectObject();
		await new Promise((r) => setTimeout(r, 500));
		let beforeObject;
		w.faceEdit.faceEditObject.subscribe((v) => (beforeObject = v))();

		const done = w.editResume.applyEditResume(payload.workspace);
		await new Promise((r) => setTimeout(r, 700));
		let object, tris, selection;
		w.faceEdit.faceEditObject.subscribe((v) => (object = v))();
		w.faceEdit.faceEditSelectedTris.subscribe((v) => (tris = v))();
		w.selectedObjects.subscribe((v) => (selection = v))();
		return {
			wasClosed: !beforeObject,
			done,
			reopened: !!object,
			// faceEditObject holds a UUID STRING, not an object
			uuid: object ?? null,
			tris: (tris ?? []).slice(),
			selection: (selection ?? []).slice()
		};
	}, withSession.payload);
	h.check(resumed.wasClosed, 'the session really was closed before the resume (premise)');
	h.check(
		resumed.reopened && resumed.uuid === withSession.uuid,
		`the resume re-entered the session on the same object (${resumed.uuid})`
	);
	h.check(
		JSON.stringify(resumed.tris) === JSON.stringify([0, 1, 2]),
		`and restored the picks (${JSON.stringify(resumed.tris)})`
	);
	h.check(resumed.selection.length === 1, `and the selection (${resumed.selection.length})`);

	// ---- 7. a resume naming a MISSING object is harmless ----------------------
	// The commonest real case: the file outlives the object.
	const missing = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.faceEdit.exitFaceEdit();
		await new Promise((r) => setTimeout(r, 300));
		let threw = null;
		let done = null;
		try {
			done = w.editResume.applyEditResume({
				selection: ['no-such-uuid'],
				edit: { kind: 'mesh', uuid: 'no-such-uuid', submode: 'faces', tris: [0] }
			});
		} catch (e) {
			threw = String(e);
		}
		await new Promise((r) => setTimeout(r, 300));
		let object;
		w.faceEdit.faceEditObject.subscribe((v) => (object = v))();
		return { threw, done, session: !!object };
	});
	h.check(missing.threw === null, `a resume for a gone object does not throw (${missing.threw})`);
	h.check(
		missing.done?.selection === 0 && missing.done?.edit === null,
		`it reports that it restored nothing (${JSON.stringify(missing.done)})`
	);
	h.check(!missing.session, 'and opens no session');

	const errs = h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs.slice(0, 2))})`);

	await h.finish(browser);
});
