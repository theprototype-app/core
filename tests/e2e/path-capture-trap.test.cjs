// fix-batch-2 (1.45.1): the Path patrol capture trap. Capture used to end only through the
// card's own toggle, so after a deselect (the editor swaps to the scene graph and hides the
// card) every viewport click silently appended an invisible waypoint and the object could
// not be selected again. Counterfactual: §2 is red on 1.45.0 (the click on the box adds a
// point and selects nothing).
const h = require('./helpers.cjs');

const S = (page, fn, arg) => page.evaluate(fn, arg);
const capturing = (page) =>
	S(page, () => new Promise((r) => window.__stores.pathCapture.pathCaptureNode.subscribe(r)()));
const pointCount = (page, uuid) =>
	S(
		page,
		(uuid) =>
			new Promise((r) =>
				window.__stores.flowGraphs.subscribe((g) =>
					r(g[uuid]?.nodes.find((n) => n.id === 'pp1')?.data.points?.length ?? -1)
				)()
			),
		uuid
	);
const selection = (page) =>
	S(page, () => new Promise((r) => window.__stores.selectedObjects.subscribe((s) => r([...s]))()));
const boxPos = (page, uuid) =>
	S(
		page,
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r(g.getObjectByProperty('uuid', uuid).position.toArray()))()
			),
		uuid
	);
// a viewport spot well away from the box (on the ground plane)
const groundSpot = (page, dx) => h.projectPoint(page, [dx, 0, 3]);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// --- scaffold: a box whose OWN flow holds a Path patrol node (implicit owner) ---------
	const uuid = await S(page, async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		window.__stores.flowGraphsCtl.createObjectGraph(box.uuid);
		window.__stores.nodesHandler.createFlowNode(
			{ id: 'pp1', type: 'pathpatrol', position: { x: 40, y: 40 }, data: { type: 'pathpatrol', points: [], speed: 2, mode: 'loop' } },
			box.uuid
		);
		window.__stores.objectActions.applySelectionSet([]);
		return box.uuid;
	});
	await page.waitForTimeout(500);
	const boxCenter = async () => {
		const c = await S(
			page,
			(uuid) =>
				new Promise((r) =>
					window.__stores.objectsGroup.subscribe((g) => {
						const o = g.getObjectByProperty('uuid', uuid);
						o.updateMatrixWorld(true);
						const v = o.getWorldPosition(o.position.clone());
						r(v.toArray());
					})()
				),
			uuid
		);
		return h.projectPoint(page, c);
	};
	const click = async (pt) => {
		await page.mouse.click(pt.x, pt.y);
		await page.waitForTimeout(300);
	};

	// --- §1 capture adds points; the mode is visible; the object holds still -----------------
	await S(page, (id) => {
		window.__stores.objectActions.selectObject(id);
	}, uuid);
	await page.waitForTimeout(400);
	await S(page, () => window.__stores.pathCapture.togglePathCapture('pp1'));
	h.check((await capturing(page)) === 'pp1', '§1 capture is on');
	h.check(await page.locator('#path-capture-toolbar').isVisible(), '§1 the "Placing waypoints" toolbox is visible');
	await click(await groundSpot(page, -2));
	await click(await groundSpot(page, 2));
	h.check((await pointCount(page, uuid)) === 2, '§1 two ground clicks add two waypoints');
	await h.eventually(
		() => page.locator('#path-capture-count').textContent(),
		(t) => t?.trim() === '2',
		'§1 the toolbox counts 2 waypoints'
	);
	const p1 = await boxPos(page, uuid);
	await page.waitForTimeout(500);
	const p2 = await boxPos(page, uuid);
	h.check(Math.hypot(p1[0] - p2[0], p1[2] - p2[2]) < 1e-6, '§1 the patrolling object holds still while its points are placed');

	// --- §2 THE TRAP: deselect, then click the object -----------------------------------
	await S(page, () => window.__stores.objectActions.applySelectionSet([]));
	await page.waitForTimeout(300);
	h.check((await capturing(page)) === null, '§2 deselecting ends capture');
	h.check(!(await page.locator('#path-capture-toolbar').isVisible()), '§2 the toolbox is gone');
	await click(await boxCenter());
	h.check((await selection(page)).includes(uuid), '§2 a click on the object selects it again');
	h.check((await pointCount(page, uuid)) === 2, '§2 ... and adds no invisible waypoint');
	// the path now runs (capture off): the object patrols
	const q1 = await boxPos(page, uuid);
	await page.waitForTimeout(500);
	const q2 = await boxPos(page, uuid);
	h.check(Math.hypot(q1[0] - q2[0], q1[2] - q2[2]) > 1e-3, '§2 with capture off the object patrols again');

	// --- §3 Esc ends capture -----------------------------------------------------------------
	await S(page, () => window.__stores.objectActions.applySelectionSet([]));
	await S(page, () => window.__stores.pathCapture.togglePathCapture('pp1'));
	h.check((await capturing(page)) === 'pp1', '§3 capture on again');
	await page.mouse.move(10, 400);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	h.check((await capturing(page)) === null, '§3 Esc ends capture');

	// --- §4 a click on the patrolling object ends capture and selects it --------------------
	await S(page, () => window.__stores.pathCapture.togglePathCapture('pp1'));
	await page.waitForTimeout(600); // the object parks at its base pose
	await click(await boxCenter());
	h.check((await capturing(page)) === null, '§4 clicking the patrolling object ends capture');
	h.check((await selection(page)).includes(uuid), '§4 ... and selects it');
	h.check((await pointCount(page, uuid)) === 2, '§4 ... with no point added');

	// --- §5 a click on the node-editor pane ends capture ----------------------------------
	await S(page, () => window.__stores.flowGraphClose.set(false));
	await page.waitForTimeout(600);
	await S(page, () => window.__stores.pathCapture.togglePathCapture('pp1'));
	const pane = page.locator('.svelte-flow__pane').first();
	if (await pane.isVisible().catch(() => false)) {
		const box = await pane.boundingBox();
		// an empty spot of the pane (the node sits at the top-left; minimap + controls at the bottom)
		await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.45);
		await page.waitForTimeout(300);
		h.check((await capturing(page)) === null, '§5 a click on the node-editor pane ends capture');
	} else {
		h.check(false, '§5 the node-editor pane is visible');
		await S(page, () => window.__stores.pathCapture.endPathCapture());
	}

	// --- §6 Play ends capture; deleting the node ends it -------------------------------------
	await S(page, () => window.__stores.pathCapture.togglePathCapture('pp1'));
	await S(page, () => window.__stores.isLocked.set(true));
	await page.waitForTimeout(200);
	h.check((await capturing(page)) === null, '§6 entering Play ends capture');
	await S(page, () => window.__stores.isLocked.set(false));
	await page.waitForTimeout(300);
	await S(page, () => window.__stores.pathCapture.togglePathCapture('pp1'));
	await S(page, (id) => window.__stores.nodesHandler.setNodeData('pp1', { muted: true }, id), uuid);
	await page.waitForTimeout(200);
	h.check((await capturing(page)) === null, '§6 muting the node ends capture');

	h.check(h.pageErrors(A).length === 0, 'no page errors');
	await h.finish(browser);
});
