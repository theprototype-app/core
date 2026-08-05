// 16-P6: deselecting must RELEASE the lock for peers.
// A `lock` message only ever REPLACES the sender's lock set (lockGeometry
// ignores an empty list), so before this fix clicking empty space left the
// object highlighted + "locked by X" on every other peer until the deselecting
// peer happened to select something else.
const h = require('./helpers.cjs');

/** the uuids B currently thinks are locked */
const locksOn = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.lockedObjects.subscribe((v) => r(v.map((lock) => lock[1])))()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// A creates two boxes (creation selects the new object, 15-K3)
	const ids = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		w.commandsHandler.sceneCommand('/create Sphere 0.5');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const [box, sphere] = g.children.slice(-2);
		return [box.uuid, sphere.uuid];
	});
	await B.page.waitForTimeout(1500);

	// --- selecting locks it for B -------------------------------------------
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid), ids[0]);
	await h.eventually(() => locksOn(B.page), (l) => l.includes(ids[0]), 'B sees A\'s selection as locked');

	// --- selecting something else REPLACES the lock (regression) ------------
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid), ids[1]);
	await h.eventually(
		() => locksOn(B.page),
		(l) => l.includes(ids[1]) && !l.includes(ids[0]),
		'a new selection replaces the old lock, not adds to it'
	);

	// --- deselecting RELEASES it (the fix) ----------------------------------
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await h.eventually(() => locksOn(B.page), (l) => l.length === 0, 'deselect releases the lock for peers');

	// A keeps its sticky primary (inspector contract) even though the lock is gone
	const sticky = await A.page.evaluate(
		() => new Promise((r) => window.__stores.selectedObject.subscribe((v) => r(v?.uuid))())
	);
	h.check(sticky === ids[1], 'the deselecting peer still keeps its sticky primary');

	// --- a SET releases every member ---------------------------------------
	await A.page.evaluate((ids) => window.__stores.objectActions.applySelectionSet(ids), ids);
	await h.eventually(() => locksOn(B.page), (l) => l.length === 2, 'a multi-selection locks both objects');
	// clearing through applySelectionSet([]) must release too (not just deselectObject)
	await A.page.evaluate(() => window.__stores.objectActions.applySelectionSet([]));
	await h.eventually(
		() => locksOn(B.page),
		(l) => l.length === 0,
		'clearing the set through applySelectionSet([]) releases both'
	);

	// --- viewing a peer-locked object releases what WE held -----------------
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid), ids[0]);
	await h.eventually(() => locksOn(B.page), (l) => l.includes(ids[0]), 'A holds a lock again');
	const viewLocked = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		// pretend a third peer locked the other object, then VIEW it (locked-view:
		// the set empties, no gizmo, no lock of our own)
		w.lockedObjects.update((locks) => [...locks, ['ghost-peer', uuid]]);
		w.objectActions.selectObject(uuid);
		await new Promise((r) => setTimeout(r, 200));
		return await new Promise((r) => w.selectedObjects.subscribe((v) => r([...v]))());
	}, ids[1]);
	h.check(viewLocked.length === 0, 'locked-view keeps the set empty');
	await h.eventually(
		() => locksOn(B.page),
		(l) => !l.includes(ids[0]),
		'switching to a locked-view released the lock we were holding'
	);

	await h.finish(browser);
});
