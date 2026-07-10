// Phase 13: multi-select — shift-click set + marquee, pivot drag moves every
// member (replicated live + final), one undo restores all, set duplicate and
// delete, whole set locked for peers.
const h = require('./helpers.cjs');

const positionsOf = (page, uuids) =>
	page.evaluate(
		(uuids) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(uuids.map((u) => g?.getObjectByProperty('uuid', u)?.position.toArray() ?? null))
				)()
			),
		uuids
	);
const setOf = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.selectedObjects.subscribe(r)()));
const objectCount = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.children.length ?? 0))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// two boxes, then shift-click both into a set
	const uuids = await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create box');
		cmd('/create sphere 1');
		await new Promise((r) => setTimeout(r, 300));
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const ids = g.children.map((c) => c.uuid);
		window.__stores.objectActions.selectObject(ids[0]);
		window.__stores.objectActions.selectObject(ids[1], false, true); // shift
		return ids;
	});
	let set = await setOf(A.page);
	h.check(set.length === 2, 'shift-click built a 2-object set');
	const pivotAttached = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.TControls.subscribe((c) => r(!!c?.object?.userData?.isMultiPivot))()
			)
	);
	h.check(pivotAttached, 'gizmo attached to the multi pivot');

	// the whole set is locked for B
	await h.eventually(
		() =>
			B.page.evaluate(
				() => new Promise((r) => window.__stores.lockedObjects.subscribe((l) => r(l.length))())
			),
		(n) => n === 2,
		'B sees both members locked'
	);
	const bSelected = await B.page.evaluate(async (uuid) => {
		window.__stores.objectActions.selectObject(uuid, false, true);
		return new Promise((r) => window.__stores.selectedObjects.subscribe((s) => r(s.length))());
	}, uuids[0]);
	h.check(bSelected === 0, 'B cannot add locked members to a set');

	// drive a pivot drag exactly like the gizmo does
	const before = await positionsOf(A.page, uuids);
	await A.page.evaluate(async () => {
		const controls = await new Promise((r) => window.__stores.TControls.subscribe(r)());
		controls.dispatchEvent({ type: 'dragging-changed', value: true });
		controls.object.position.x += 2;
		controls.object.updateMatrixWorld(true);
		controls.dispatchEvent({ type: 'objectChange' });
		controls.dispatchEvent({ type: 'dragging-changed', value: false });
	});
	const after = await positionsOf(A.page, uuids);
	h.check(
		Math.abs(after[0][0] - before[0][0] - 2) < 0.01 && Math.abs(after[1][0] - before[1][0] - 2) < 0.01,
		'pivot drag moved every member by the same delta'
	);
	await h.eventually(
		() => positionsOf(B.page, uuids),
		(p) => p[0] && p[1] && Math.abs(p[0][0] - after[0][0]) < 0.01 && Math.abs(p[1][0] - after[1][0]) < 0.01,
		'member transforms replicated to B'
	);

	// ONE undo restores both members (transformSet batch), replicated
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(
		() => Promise.all([positionsOf(A.page, uuids), positionsOf(B.page, uuids)]),
		([a, b]) =>
			Math.abs(a[0][0] - before[0][0]) < 0.01 &&
			Math.abs(a[1][0] - before[1][0]) < 0.01 &&
			Math.abs(b[0][0] - before[0][0]) < 0.01 &&
			Math.abs(b[1][0] - before[1][0]) < 0.01,
		'one undo restored both members on both peers'
	);

	// Ctrl+D duplicates the whole set
	await A.page.evaluate(() => window.__stores.objectActions.duplicateSelection());
	await h.eventually(
		() => Promise.all([objectCount(A.page), objectCount(B.page)]),
		([a, b]) => a === 4 && b === 4,
		'set duplicate created copies on both peers'
	);
	set = await setOf(A.page);
	h.check(set.length === 2 && !set.includes(uuids[0]), 'clones became the new selection');

	// delete the selection (the two clones)
	await A.page.evaluate(() => window.__stores.objectActions.deleteSelection());
	await h.eventually(
		() => Promise.all([objectCount(A.page), objectCount(B.page)]),
		([a, b]) => a === 2 && b === 2,
		'set delete removed the clones on both peers'
	);

	// marquee: shift-drag a box over the viewport selects what is inside
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.keyboard.down('Shift');
	await A.page.mouse.move(420, 220);
	await A.page.mouse.down();
	await A.page.mouse.move(1100, 700, { steps: 8 });
	await A.page.mouse.up();
	await A.page.keyboard.up('Shift');
	await A.page.waitForTimeout(300);
	set = await setOf(A.page);
	h.check(set.length === 2, `marquee selected both objects (${set.length})`);

	await h.finish(browser);
});
