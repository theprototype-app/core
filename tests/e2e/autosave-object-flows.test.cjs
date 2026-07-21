// Roadmap #13 H1 follow-up — object flows must survive the autosave restore.
// The autosave scene round-trips through GLTF (exporter -> loader), and
// GLTFLoader assigns NEW uuids on parse; graphs are keyed by object uuid, so a
// restored object must come back with its ORIGINAL uuid or its flow orphans
// (the user-reported bug). Annotations share the same uuid-keying.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- author: box + object flow with one node, then snapshot ----------------
	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'FlowBox';
		window.__stores.flowGraphsCtl.createObjectGraph(box.uuid);
		window.__stores.nodesHandler.createFlowNode(
			{ id: 'spin-saved', type: 'spin', position: { x: 0, y: 0 }, data: { type: 'spin', axis: 'y', speed: 2 } },
			box.uuid
		);
		await window.__stores.autosave.saveNow();
		return box.uuid;
	});
	h.check(!!uuid, 'authored a box with an object flow and saved a snapshot');

	// --- reload + restore -------------------------------------------------------
	await h.freshReload(A);
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.autosave.restoreAvailable.subscribe((v) => r(!!v))())),
		(v) => v === true,
		'the restore offer appears after reload'
	);
	await A.page.evaluate(() => window.__stores.autosave.restoreSnapshot());
	await A.page.waitForTimeout(1500);

	const state = await A.page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children.find((c) => c.name === 'FlowBox');
		let graphs; window.__stores.flowGraphs.subscribe((v) => (graphs = v))();
		return {
			boxUuid: box?.uuid ?? null,
			graphKeys: Object.keys(graphs).filter((k) => k !== 'scene'),
			nodesUnderBox: box ? (graphs[box.uuid]?.nodes?.length ?? -1) : -1
		};
	});
	h.check(!!state.boxUuid, 'the box came back from the snapshot');
	h.check(state.boxUuid === uuid, 'the restored box keeps its ORIGINAL uuid (GLTF round-trip)');
	h.check(state.nodesUnderBox === 1, 'the restored box still owns its flow (1 node)');

	// selecting it scopes the editor to a real graph, not the empty state
	await A.page.evaluate(async (id) => {
		window.__stores.flowGraphClose.set(false);
		window.__stores.objectActions.selectObject(id);
	}, state.boxUuid);
	await A.page.waitForTimeout(500);
	h.check((await A.page.locator('#flow-empty-state').count()) === 0, 'no empty state — the flow is attached');

	await h.finish(browser);
});
