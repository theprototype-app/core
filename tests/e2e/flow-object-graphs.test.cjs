// Roadmap #13 H1 — per-object flow graphs.
//   - flowGraphs is the source of truth ('scene' + objectUuid documents); the
//     editor view mirrors the ACTIVE graph
//   - selecting an object (with the editor open) switches scope; no-flow objects
//     show the empty state with a one-click Create flow; delete asks to confirm
//   - an effect node inside an object graph implicitly animates its OWNER
//   - object graphs replicate: graphcreate + graph-tagged node edits reach peers
//   - undo restores a deleted flow (the 'flowgraph' history kind)
const h = require('./helpers.cjs');

const graphsOf = (peer) =>
	peer.page.evaluate(() => new Promise((r) => window.__stores.flowGraphs.subscribe((g) => r(Object.keys(g)))()));
const activeOf = (peer) =>
	peer.page.evaluate(() => new Promise((r) => window.__stores.activeGraphId.subscribe((v) => r(v))()));
const nodesIn = (peer, graphId) =>
	peer.page.evaluate(
		(id) => new Promise((r) => window.__stores.flowGraphs.subscribe((g) => r(g[id]?.nodes?.length ?? -1))()),
		graphId
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- baseline: the scene graph exists and is active -----------------------
	h.check((await graphsOf(A)).includes('scene'), 'scene graph document exists at boot');
	h.check((await activeOf(A)) === 'scene', 'editor scope starts on the scene graph');

	// --- create a box + open the flow editor ----------------------------------
	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		window.__stores.flowGraphClose.set(false); // open the docked flow editor
		return box.uuid;
	});
	await A.page.waitForTimeout(600);

	// --- selecting the object switches scope + shows the empty state ----------
	await A.page.evaluate((id) => window.__stores.objectActions.selectObject(id), uuid);
	await A.page.waitForTimeout(400);
	h.check((await activeOf(A)) === uuid, 'selecting the object switches the editor scope to it');
	h.check(await A.page.locator('#flow-empty-state').first().isVisible(), 'no-flow object shows the empty state');

	// --- one-click create ------------------------------------------------------
	await A.page.locator('#flow-create-btn').click();
	await A.page.waitForTimeout(300);
	h.check((await graphsOf(A)).includes(uuid), 'Create flow makes the object graph document');
	h.check((await A.page.locator('#flow-empty-state').count()) === 0, 'empty state clears after create');
	const chip = await A.page.locator('#flow-scope-chip').innerText();
	h.check(chip.includes('object flow'), 'scope chip labels the object flow');

	// --- an effect node in the object graph drives the OWNER implicitly -------
	await A.page.evaluate((id) => {
		window.__stores.nodesHandler.createFlowNode(
			{ id: 'spin-h1', type: 'spin', position: { x: 0, y: 0 }, data: { type: 'spin', axis: 'y', speed: 3 } },
			id
		);
	}, uuid);
	await h.eventually(
		() => A.page.evaluate((id) => window.__stores.flowRuntime.isAnimatedTarget(id), uuid),
		(v) => v === true,
		'implicit-owner: a spin node in the object graph animates the object (no selector wired)'
	);

	// --- deselect returns to the scene graph ----------------------------------
	// the REAL empty-click path: deselectObject clears the selectedObjects SET but
	// keeps selectedObject (inspector/outline gotcha) — scope must still return
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(400);
	h.check((await activeOf(A)) === 'scene', 'empty-click deselect returns the editor to the scene graph');

	// --- explicit "Scene" chip button switches scope AND deselects -------------
	await A.page.evaluate((id) => window.__stores.objectActions.selectObject(id), uuid);
	await A.page.waitForTimeout(400);
	h.check((await activeOf(A)) === uuid, 'reselecting scopes back to the object');
	await A.page.locator('#flow-scope-scene').click();
	await A.page.waitForTimeout(400);
	h.check((await activeOf(A)) === 'scene', 'the Scene chip button returns to the scene flow');
	const setAfter = await A.page.evaluate(
		() => new Promise((r) => window.__stores.selectedObjects.subscribe((s) => r(s.length))())
	);
	h.check(setAfter === 0, 'the Scene chip button also deselects the object');

	// --- two-peer: the object graph replicates --------------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);
	await h.eventually(
		() => nodesIn(B, uuid),
		(n) => n === 1,
		'late joiner receives the object graph (handshake full-state)'
	);

	// a graph-tagged live edit reaches the peer
	await A.page.evaluate((id) => {
		const node = { id: 'spin-h1-b', type: 'spin', position: { x: 40, y: 40 }, data: { type: 'spin', axis: 'y', speed: 1 } };
		window.__stores.nodesHandler.createFlowNode(node, id);
		let peer; window.__stores.peers.subscribe((p) => (peer = p))();
		peer.send({ type: 'nodecreate', node, graphId: id });
	}, uuid);
	await h.eventually(
		() => nodesIn(B, uuid),
		(n) => n === 2,
		'graph-tagged nodecreate lands in the peer object graph'
	);

	// --- delete flow with confirmation + undo restores ------------------------
	await A.page.evaluate((id) => window.__stores.objectActions.selectObject(id), uuid);
	await A.page.waitForTimeout(300);
	await A.page.locator('#flow-scope-delete').click();
	await A.page.waitForTimeout(300);
	h.check(await A.page.getByRole('button', { name: 'Delete flow' }).first().isVisible(), 'delete asks for confirmation');
	await A.page.getByRole('button', { name: 'Delete flow' }).click();
	await A.page.waitForTimeout(400);
	h.check(!(await graphsOf(A)).includes(uuid), 'confirming removes the object graph');
	await h.eventually(
		() => graphsOf(B).then((g) => g.includes(uuid)),
		(v) => v === false,
		'graph deletion replicates to the peer'
	);

	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(400);
	h.check((await graphsOf(A)).includes(uuid), 'undo restores the deleted flow');
	h.check((await nodesIn(A, uuid)) === 2, 'undo restores the flow CONTENT');
	await h.eventually(
		() => nodesIn(B, uuid),
		(n) => n === 2,
		'restored flow replicates back to the peer'
	);

	await h.finish(browser);
});
