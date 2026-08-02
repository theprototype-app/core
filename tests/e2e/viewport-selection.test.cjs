// Roadmap #15 batch K — viewport selection & outline:
//  K1 the outline follows the selection SET (deselect = no outline; the sticky
//     `selectedObject` can no longer leave a ghost outline behind)
//  K2 groups + multi-selections outline EVERY member mesh (the gizmo's real
//     payload is visible); peer-locked groups get the same traversal
//  K3 creating an object populates `selectedObjects` (it only set the primary,
//     so the set — and everything driven by it — disagreed with the gizmo)
//  K4 Ctrl+D with nothing selected toasts instead of duplicating the stale
//     last object (safe now that K3 makes the set authoritative)
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	// the outline effect lives in Outline.svelte — it exposes a debug probe
	await A.page.waitForFunction(() => typeof window.__outlineDebug === 'function', { timeout: 20000 });
	const outline = () => A.page.evaluate(() => window.__outlineDebug());

	// ---------- K3: creation populates the selection set ----------
	const created = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		window.__k = { box1: g.children[g.children.length - 1] };
		await new Promise((r) => setTimeout(r, 150));
		return {
			set: await new Promise((r) => w.selectedObjects.subscribe((v) => r([...v]))()),
			uuid: window.__k.box1.uuid
		};
	});
	h.check(
		created.set.length === 1 && created.set[0] === created.uuid,
		`/create populates the selection set (${created.set.length})`
	);
	await h.eventually(outline, (o) => o.selected === 1, 'a fresh creation is outlined');

	// ---------- K1: deselect clears the outline ----------
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await h.eventually(outline, (o) => o.selected === 0, 'deselect clears the outline');
	// the sticky primary is STILL the box (by design) — but no outline
	const sticky = await A.page.evaluate(
		() => new Promise((r) => window.__stores.selectedObject.subscribe((v) => r(v?.uuid))())
	);
	h.check(sticky === created.uuid, 'selectedObject still keeps the last object (inspector contract)');

	// ---------- K2: a multi-selection outlines every member ----------
	const multi = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Sphere 0.5');
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const [a, b, c] = g.children.slice(-3);
		window.__k.trio = [a.uuid, b.uuid, c.uuid];
		w.objectActions.applySelectionSet(window.__k.trio);
		await new Promise((r) => setTimeout(r, 150));
		return true;
	});
	h.check(multi, 'trio selected');
	await h.eventually(outline, (o) => o.selected === 3, 'a 3-object selection outlines 3 meshes');

	// ---------- K2: a GROUP outlines all child meshes ----------
	const grouped = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.objectActions.groupSelection();
		await new Promise((r) => setTimeout(r, 250));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const group = g.children.find((c) => c.type === 'Group');
		window.__k.group = group;
		return { type: group?.type, set: await new Promise((r) => w.selectedObjects.subscribe((v) => r([...v]))()) };
	});
	h.check(grouped.type === 'Group', 'grouping produced a Group');
	await h.eventually(
		outline,
		(o) => o.selected === 3,
		'selecting the group outlines its 3 child meshes (a Group alone outlined nothing)'
	);

	// ---------- K2: peer-locked GROUPS get the same traversal ----------
	const locked = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.objectActions.deselectObject();
		w.lockedObjects.set([['fake-peer', window.__k.group.uuid]]);
		await new Promise((r) => setTimeout(r, 150));
		return true;
	});
	h.check(locked, 'group peer-locked');
	await h.eventually(outline, (o) => o.locked === 3 && o.selected === 0, 'a locked group outlines its meshes too');
	await A.page.evaluate(() => window.__stores.lockedObjects.set([]));

	// ---------- K4 + K3: Ctrl+D right after create still duplicates ----------
	const dupAfterCreate = await A.page.evaluate(async () => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const before = g.children.length;
		w.commandsHandler.sceneCommand('/create Cone 0.5 1');
		await new Promise((r) => setTimeout(r, 150));
		w.objectActions.duplicateSelection();
		await new Promise((r) => setTimeout(r, 250));
		return { before, after: g.children.length };
	});
	h.check(
		dupAfterCreate.after === dupAfterCreate.before + 2,
		`duplicate right after create works (${dupAfterCreate.before} -> ${dupAfterCreate.after})`
	);

	// ---------- K4: Ctrl+D with nothing selected toasts, creates nothing ----------
	const dupEmpty = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.objectActions.deselectObject();
		await new Promise((r) => setTimeout(r, 150));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const before = g.children.length;
		w.toastStore.set([]);
		const result = w.objectActions.duplicateSelection();
		await new Promise((r) => setTimeout(r, 250));
		const toasts = await new Promise((r) => w.toastStore.subscribe((v) => r(v.map((t) => (typeof t === 'string' ? t : t.text))))());
		return { before, after: g.children.length, result, toasts };
	});
	h.check(dupEmpty.after === dupEmpty.before, 'no object was created');
	h.check(
		dupEmpty.toasts.some((t) => /Nothing selected/.test(t)),
		`the user is told why (${JSON.stringify(dupEmpty.toasts)})`
	);

	// viewing a peer-locked object may still duplicate (an editable copy) —
	// the deliberate empty-set-with-primary state
	const dupLockedView = await A.page.evaluate(async () => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const target = g.children[0];
		w.lockedObjects.set([['fake-peer', target.uuid]]);
		w.objectActions.selectObject(target.uuid); // locked-view: set stays empty
		await new Promise((r) => setTimeout(r, 150));
		const before = g.children.length;
		w.objectActions.duplicateSelection();
		await new Promise((r) => setTimeout(r, 250));
		w.lockedObjects.set([]);
		return { before, after: g.children.length };
	});
	h.check(
		dupLockedView.after === dupLockedView.before + 1,
		'viewing a locked object still allows duplicating a copy'
	);

	await h.finish(browser);
});
