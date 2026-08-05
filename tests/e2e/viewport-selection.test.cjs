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

	// ---------- 16-P6: the viewport menu's "Selected" follows the SET ----------
	const menuLabels = async () => {
		await A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 220, y: 140, point: [0, 0, 0] }));
		await A.page.waitForTimeout(350);
		const labels = await A.page.evaluate(() =>
			[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((r) => r.textContent?.trim() ?? '')
		);
		await A.page.evaluate(() => window.__stores.viewportMenu.set(null));
		await A.page.waitForTimeout(150);
		return labels;
	};

	await A.page.evaluate(async () => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		w.objectActions.selectObject(g.children[0].uuid);
	});
	await A.page.waitForTimeout(200);
	const withSelection = await menuLabels();
	h.check(
		withSelection.some((l) => l.startsWith('Selected')),
		'right-clicking empty space WITH a selection still offers "Selected"'
	);

	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(200);
	const afterDeselect = await menuLabels();
	h.check(
		!afterDeselect.some((l) => l.startsWith('Selected')),
		`"Selected" is gone once nothing is selected (${afterDeselect.length} rows)`
	);

	// ---------- SHIFT-click multi-select, through the REAL mouse ----------
	// Regression guard (found while assembling the release): every
	// `if ($activeOrbit) $activeOrbit.enabled = ...` in Scene.svelte threw
	// "store.set is not a function" — activeOrbit is a DERIVED store, and svelte
	// compiles `$store.prop =` into store_mutate → store.set. The throw aborted the
	// rest of onPointerUp, so shift-click stopped ADDING to the selection while a
	// plain click (which never enters the marquee branch) kept working. This has to
	// drive REAL clicks: a store-level selectObject call never touches that path.
	const setOf = () =>
		A.page.evaluate(
			() => new Promise((r) => window.__stores.selectedObjects.subscribe((s) => r([...(s ?? [])]))())
		);
	const trio = await A.page.evaluate(() => {
		const w = window.__stores;
		const out = [];
		let g;
		for (const x of [-2.5, 0, 2.5]) {
			w.commandsHandler.sceneCommand('/create Box 1 1 1');
			w.objectsGroup.subscribe((v) => (g = v))();
			const box = g.children[g.children.length - 1];
			box.position.set(x, 0.5, 0);
			box.updateMatrixWorld(true);
			out.push(box.uuid);
		}
		w.objectActions.deselectObject();
		return out;
	});
	await A.page.evaluate(() => window.__stores.objectActions.flyTo([0, 4, 9], [0, 0.5, 0], 1));
	await A.page.waitForTimeout(900);
	let pageErrors = 0;
	A.page.on('pageerror', () => pageErrors++);
	/** @param {string} uuid @param {boolean} shift */
	const clickBox = async (uuid, shift) => {
		const at = await A.page.evaluate((u) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', u);
			return [o.position.x, o.position.y, o.position.z];
		}, uuid);
		const px = await h.projectPoint(A.page, at);
		if (shift) await A.page.keyboard.down('Shift');
		await A.page.mouse.click(px.x, px.y);
		if (shift) await A.page.keyboard.up('Shift');
		await A.page.waitForTimeout(400);
	};
	await clickBox(trio[0], false);
	h.check((await setOf()).length === 1, 'a plain click selects one object');
	await clickBox(trio[1], true);
	const two = await setOf();
	h.check(
		two.length === 2 && two.includes(trio[0]) && two.includes(trio[1]),
		`SHIFT-click ADDS to the selection (${two.length})`
	);
	await clickBox(trio[2], true);
	const three = await setOf();
	h.check(three.length === 3, `a third SHIFT-click adds again (${three.length})`);
	await clickBox(trio[1], true);
	const toggled = await setOf();
	h.check(
		toggled.length === 2 && !toggled.includes(trio[1]),
		`SHIFT-click on a member toggles it OUT (${toggled.length})`
	);
	await clickBox(trio[0], false);
	h.check((await setOf()).length === 1, 'a plain click collapses the set again');
	h.check(pageErrors === 0, `no page errors during the shift gestures (${pageErrors})`);
	// member tints are a live highlight, never baked material state
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(300);
	const emissives = await A.page.evaluate((list) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return list.map((u) => {
			const o = g.getObjectByProperty('uuid', u);
			return '#' + (o?.material?.emissive?.getHexString() ?? '??');
		});
	}, trio);
	h.check(
		emissives.every((hex) => hex === '#000000'),
		`multi-select tints are restored on deselect (${emissives.join(', ')})`
	);

	await h.finish(browser);
});
