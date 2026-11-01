// 55 (1.48.1, Q1): a DELETED object's flow graph stops running on every peer, a joiner does not receive it, and
// undoing the delete brings it back to life. The graph stays in flowGraphs on purpose (undo finds it intact; the
// savers prune it) — what changed is that nothing reads it as live: flowRuntime skips it (dormant), and the nodes
// reply / nodesync hash leave it out. Both delete paths: the person's Delete (deleteSelection + its undo) and the
// AI tools' delete_objects.
const h = require('./helpers.cjs');

/** what one page's runtime evaluates @param {any} page */
const runtime = (page) => page.evaluate(() => window.__stores.flowRuntime.runtimeGraphDebug());
/** the flow graph ids one page holds @param {any} page */
const graphIds = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.flowGraphs.subscribe((g) => r(Object.keys(g || {})))()));

/** @param {any} page @param {string} name */
async function boxWithSpin(page, name) {
	return page.evaluate(async (nm) => {
		const t = window.__stores.aiTools;
		const made = await t.executeAiTool('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: nm, position: [0, 0.5, 0] }] });
		const uuid = made?.created?.[0]?.uuid;
		const flow = await t.executeAiTool('create_flow_nodes', { graph: uuid, nodes: [{ type: 'spin' }] });
		return { uuid, spin: flow?.created?.[0]?.id };
	}, name);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 8000);

	// ---- 1. the person's Delete
	const one = await boxWithSpin(A.page, 'OrphanOne');
	h.check(!!one.uuid && !!one.spin, 'premise: a box with a Spin in its own flow: ' + JSON.stringify(one));
	for (const [P, n] of [[A, 'A'], [B, 'B']])
		await h.eventually(() => runtime(P.page), (r) => r && r.nodeIds.includes(one.spin), n + ' runs the box\'s Spin', 30000);

	await A.page.evaluate((u) => {
		window.__stores.objectActions.applySelectionSet([u]);
		window.__stores.objectActions.deleteSelection();
	}, one.uuid);
	for (const [P, n] of [[A, 'A'], [B, 'B']]) {
		await h.eventually(
			() => runtime(P.page),
			(r) => r && !r.nodeIds.includes(one.spin) && r.dormant.includes(one.uuid),
			n + ': the deleted box\'s flow is DORMANT (its Spin is not evaluated)',
			30000
		);
	}
	h.check((await graphIds(A.page)).includes(one.uuid), 'A keeps the graph itself (an undo finds it intact)');

	// ---- 2. a late joiner gets no orphan
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await h.connect(C, A, 8000);
	await h.eventually(() => graphIds(C.page), (ids) => ids.length > 0, 'C received the session\'s graphs', 30000);
	await C.page.waitForTimeout(3000);
	h.check(!(await graphIds(C.page)).includes(one.uuid), 'C did not receive the deleted box\'s flow');

	// ---- 3. Ctrl+Z: the box and its flow come back, and the Spin runs again — on the peers that kept it
	await A.page.evaluate(() => window.__stores.history.undo());
	for (const [P, n] of [[A, 'A'], [B, 'B']])
		await h.eventually(
			() => runtime(P.page),
			(r) => r && r.nodeIds.includes(one.spin) && !r.dormant.includes(one.uuid),
			n + ': after the undo the Spin runs again',
			30000
		);

	// ---- 4. the AI tools' delete_objects (the agent's path), from the other peer
	const two = await boxWithSpin(B.page, 'OrphanTwo');
	for (const [P, n] of [[A, 'A'], [B, 'B']])
		await h.eventually(() => runtime(P.page), (r) => r && r.nodeIds.includes(two.spin), n + ' runs the second box\'s Spin', 30000);
	const del = await B.page.evaluate((u) => window.__stores.aiTools.executeAiTool('delete_objects', { uuids: [u] }), two.uuid);
	h.check(del?.deleted === 1, 'delete_objects deleted it: ' + JSON.stringify(del));
	for (const [P, n] of [[A, 'A'], [B, 'B']])
		await h.eventually(
			() => runtime(P.page),
			(r) => r && !r.nodeIds.includes(two.spin) && r.dormant.includes(two.uuid),
			n + ': delete_objects leaves its flow dormant too',
			30000
		);

	await h.finish(browser);
});
