// 78 F16 — A LATE JOINER SEES THE PICKUPS THE ROOM ALREADY TOOK. Reported from the 3-peer gem
// test (preview-55): the host took all 3 gems (kit doc rev 3, taken{} full) and a PC joining later
// still SHOWED all 3 and could not take them. The cause: a joiner that had loaded or cleared a
// scene on its own reset its kit document with a FRESH stamp, so the host's (older) document lost
// latest-wins on arrival — and the joiner's own push wiped the host's on the way back.
// A local reset (a scene loaded alone, a travel, a boot restore) now outranks nobody.
// Shape: gems hidden by kit-pickups-available -> Visibility -> Object Selector (the agent's graph).
// Counterfactual on v1.63.0: 2.x and 3.x are red.
const h = require('./helpers.cjs');

/** a probe module: an api handle on window */
const PROBE = () => {
	const s = /** @type {any} */ (window).__stores;
	s.moduleSDK.initModules([
		{
			id: 'kitprobe',
			name: 'Kit probe',
			version: '1.0.0',
			register(/** @type {any} */ api) {
				/** @type {any} */ (window).__kitApi = api;
			}
		}
	]);
	return !!(/** @type {any} */ (window).__kitApi?.kit?.pickups);
};

/** per page: is each gem there to take (kit), and is its object visible (the graph)? */
const view = (/** @type {any} */ p, /** @type {string[]} */ gems) =>
	p.page.evaluate((ids) => {
		const S = /** @type {any} */ (window).__stores;
		let g;
		S.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const k = /** @type {any} */ (window).__kitApi.kit.pickups;
		return {
			available: ids.map((id) => k.available(id)),
			visible: ids.map((id) => g?.getObjectByProperty('uuid', id)?.visible ?? null),
			taken: k.taken(),
			doc: S.kit.kitDebug().doc
		};
	}, gems);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	h.check(await A.page.evaluate(PROBE), 'premise: api.kit.pickups on the host');

	// ---- 1. the host builds three gems, each hidden by "Pickup available?" -> Visibility ----------
	const gems = await A.page.evaluate(() => {
		const S = /** @type {any} */ (window).__stores;
		/** @type {string[]} */
		const ids = [];
		for (let i = 0; i < 3; i++) {
			S.commandsHandler.sceneCommand('/create box');
			let g;
			S.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
			const box = g.children[g.children.length - 1];
			box.name = 'Gem ' + i;
			box.position.set(i * 1.5 - 1.5, 0.5, 0);
			ids.push(box.uuid);
		}
		S.objectActions.deselectObject();
		ids.forEach((uuid, i) => {
			const av = 'av' + i, vis = 'vis' + i, sel = 'sel' + i;
			S.nodesHandler.createFlowNode({ id: av, type: 'kit-pickups-available', position: { x: 0, y: i * 140 }, data: { type: 'kit-pickups-available', pickup: uuid } });
			S.nodesHandler.createFlowNode({ id: vis, type: 'visibility', position: { x: 220, y: i * 140 }, data: { type: 'visibility', on: true } });
			S.nodesHandler.createFlowNode({ id: sel, type: 'objectselector', position: { x: 440, y: i * 140 }, data: { type: 'objectselector', selected: uuid } });
			S.nodesHandler.createFlowEdge({ id: 'e-' + av + '-' + vis + '.on', source: av, target: vis, targetHandle: 'on' });
			S.nodesHandler.createFlowEdge({ id: 'e-' + vis + '-' + sel, source: vis, target: sel });
		});
		return ids;
	});
	await h.eventually(() => view(A, gems), (v) => v.visible.every((x) => x === true), 'premise: three gems, shown while there to take', 10000);

	// ---- 2. the host takes all three -----------------------------------------------------------
	await A.page.evaluate((ids) => ids.forEach((id) => /** @type {any} */ (window).__kitApi.kit.pickups.collect(id, 1, 0)), gems);
	await h.eventually(() => view(A, gems), (v) => v.taken === 3 && v.visible.every((x) => x === false), 'the host took all 3: hidden on the host (kit doc taken{} full)', 10000);
	const hostDoc = (await view(A, gems)).doc;
	console.log('  host kit doc: rev ' + hostDoc.rev + ', at ' + hostDoc.at + ', by ' + hostDoc.by);

	// ---- 3. a LATER joiner that cleared a scene of its own first --------------------------------
	await A.page.waitForTimeout(1500); // the joiner's own reset lands well after the host's last write
	const B = await h.setupPage(browser, 'B');
	h.check(await B.page.evaluate(PROBE), 'premise: api.kit.pickups on the joiner');
	await B.page.evaluate(() => /** @type {any} */ (window).__stores.commandsHandler.sceneCommand('/clear all'));
	const bDoc = await B.page.evaluate(() => /** @type {any} */ (window).__stores.kit.kitDebug().doc);
	console.log('  joiner kit doc before joining: rev ' + bDoc.rev + ', at ' + bDoc.at);
	h.check(bDoc.at === 0, '3.0 a clear made ALONE is a local reset: stamp 0 (outranks nobody; ' + bDoc.at + ')');
	await h.connect(B, A);
	await h.eventually(
		() => Promise.all([A, B].map((p) => p.page.evaluate(() => /** @type {any} */ (window).__stores.nodesHandler.graphHash()))),
		(hs) => hs[0] === hs[1],
		'premise: the joiner holds the host\'s graph',
		30000
	);
	await h.eventually(() => view(B, gems), (v) => v.taken === 3 && v.available.every((x) => x === false), '3.1 the late joiner holds the room\'s kit document: all 3 taken', 15000);
	await h.eventually(() => view(B, gems), (v) => v.visible.every((x) => x === false), '3.2 …and its gems are HIDDEN (the value nodes read the landed document)', 10000);
	const hostAfter = await view(A, gems);
	h.check(hostAfter.taken === 3 && hostAfter.visible.every((x) => x === false), '3.3 the joiner\'s reset did not wipe the host (still 3 taken, hidden)');

	// ---- 4. not collectable on the joiner ------------------------------------------------------
	const before = await A.page.evaluate(() => /** @type {any} */ (window).__stores.kit.kitDebug().stats.refused);
	await B.page.evaluate((id) => /** @type {any} */ (window).__kitApi.kit.pickups.collect(id, 1, 0), gems[0]);
	await h.eventually(() => A.page.evaluate(() => /** @type {any} */ (window).__stores.kit.kitDebug().stats.refused), (n) => n > before, '4.1 the joiner\'s take is REFUSED by the authority (already taken)', 10000);
	const by = await A.page.evaluate((id) => /** @type {any} */ (window).__stores.kit.kitDebug().doc.slices.pickups.taken[id]?.by, gems[0]);
	h.check(by === A.id, '4.2 the gem stays the host\'s (' + by + ')');

	await h.finish(browser);
});
