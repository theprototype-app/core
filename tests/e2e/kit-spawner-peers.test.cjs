// 78 F20 + F23 — THE SPAWNER ON EVERY PEER. Research round 1 (preview-55, the agent page is never the
// authority): "spawned never pulses on a non-authority peer, while despawned / emptied do", and round 2:
// "dead spawned entities are still counted (runtime.count 2 four seconds after both died)".
// Two peers; the Spawn node is pressed on the NON-authority (a replicated On Click), the entities are
// killed from code there too; every spawner/health event node is read back from BOTH peers' trigger
// logs, and the counts from both runtimes.
// Counterfactual on v1.63.0: 3.x (the dead stay stored) is red; the pulses are the measurement.
const h = require('./helpers.cjs');

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
	return !!(/** @type {any} */ (window).__kitApi?.kit?.spawner);
};

const EVENTS = ['kit-spawner-spawned', 'kit-spawner-despawned', 'kit-spawner-emptied', 'kit-health-died'];

/** per page: each event node's last stamp and how many times its stamp moved since armed */
const seen = (/** @type {any} */ p) => p.page.evaluate(() => /** @type {any} */ (window).__seenEv);
const arm = (/** @type {any} */ p) =>
	p.page.evaluate((events) => {
		const S = /** @type {any} */ (window).__stores;
		/** @type {Record<string, {n: number, last: number | null}>} */
		const out = Object.fromEntries(events.map((e) => [e, { n: 0, last: null }]));
		/** @type {any} */ (window).__seenEv = out;
		S.flowTriggers.subscribe((/** @type {any} */ m) => {
			for (const e of events) {
				const t = m?.['ev-' + e]?.lastT ?? null;
				if (t !== null && t !== out[e].last) {
					if (out[e].last !== null || /** @type {any} */ (window).__evArmed) out[e].n++;
					out[e].last = t;
				}
			}
		});
		/** @type {any} */ (window).__evArmed = true;
	}, EVENTS);
const ents = (/** @type {any} */ p) =>
	p.page.evaluate(() => {
		const d = /** @type {any} */ (window).__stores.kitEntities.kitEntitiesDebug();
		return { count: d.runtime?.living ?? null, stored: d.runtime?.stored ?? d.runtime?.count ?? null, node: /** @type {any} */ (window).__stores.kit.kit.evalNodeValue('kit-spawner-count', { kind: '' }) };
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) h.check(await p.page.evaluate(PROBE), 'premise: api.kit on ' + p.id);
	await h.connect(B, A);
	const auth = await A.page.evaluate(() => /** @type {any} */ (window).__stores.kit.kitDebug().authority);
	const host = auth === A.id ? A : B;
	const other = host === A ? B : A;
	console.log('  authority ' + host.id + ', presses on ' + other.id);

	const ids = await A.page.evaluate((events) => {
		const S = /** @type {any} */ (window).__stores;
		let g;
		S.commandsHandler.sceneCommand('/create box');
		S.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const tpl = g.children[g.children.length - 1];
		tpl.name = 'Lab enemy';
		tpl.position.set(-4, -5, -4);
		S.commandsHandler.sceneCommand('/create box');
		S.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const btn = g.children[g.children.length - 1];
		btn.name = 'btn spawn';
		btn.position.set(3, 0.5, 0);
		S.nodesHandler.createFlowNode({ id: 'sel', type: 'objectselector', position: { x: 0, y: 0 }, data: { type: 'objectselector', selected: btn.uuid } });
		S.nodesHandler.createFlowNode({ id: 'click', type: 'onclick', position: { x: 200, y: 0 }, data: { type: 'onclick' } });
		S.nodesHandler.createFlowNode({ id: 'spawn', type: 'kit-spawner-spawn', position: { x: 400, y: 0 }, data: { type: 'kit-spawner-spawn', kind: 'labfoe', template: tpl.uuid, at: [-3, 0.4, -3], count: 2, spread: 1, hp: 5, speed: 0, removeAfter: 1 } });
		S.nodesHandler.createFlowEdge({ id: 'e-click-sel', source: 'click', target: 'sel' });
		S.nodesHandler.createFlowEdge({ id: 'e-click-spawn.trigger', source: 'click', target: 'spawn', targetHandle: 'trigger' });
		events.forEach((/** @type {string} */ e, i) => S.nodesHandler.createFlowNode({ id: 'ev-' + e, type: e, position: { x: 700, y: i * 120 }, data: { type: e } }));
		S.objectActions.deselectObject();
		return { btn: btn.uuid };
	}, EVENTS);
	await h.eventually(
		() => Promise.all([A, B].map((p) => p.page.evaluate(() => /** @type {any} */ (window).__stores.nodesHandler.graphHash()))),
		(hs) => hs[0] === hs[1],
		'premise: both peers hold the graph',
		30000
	);
	for (const p of [A, B]) await arm(p);
	await A.page.waitForTimeout(1500);

	// ---- 1. spawn from a node pressed on the NON-authority: "spawned" pulses on both ----------
	await other.page.evaluate((u) => /** @type {any} */ (window).__stores.flowRuntime.fireObjectClick(u), ids.btn);
	await h.eventually(() => Promise.all([A, B].map(ents)), (v) => v.every((x) => x.count === 2 && x.node === 2), 'premise: 2 entities on both peers (Count node 2)', 10000);
	await h.eventually(() => Promise.all([A, B].map(seen)), (v) => v.every((s) => s['kit-spawner-spawned'].n >= 1), '1.1 "On spawned" pulsed on BOTH peers', 8000);

	// ---- 2. both die (code, on the non-authority): died + emptied on both, ONE emptied ---------
	await other.page.evaluate(() => {
		const k = /** @type {any} */ (window).__kitApi.kit;
		for (const e of k.spawner.extra?.list?.({ kind: 'labfoe' }) ?? /** @type {any} */ (window).__stores.kitEntities.kitEntitiesDebug().entities) k.health.damage(e.id, 999);
	});
	await h.eventually(() => Promise.all([A, B].map(ents)), (v) => v.every((x) => x.count === 0 && x.node === 0), '2.1 the dead stop counting at once on both peers (Count node 0)', 8000);
	await h.eventually(() => Promise.all([A, B].map(seen)), (v) => v.every((s) => s['kit-health-died'].n >= 1 && s['kit-spawner-emptied'].n >= 1), '2.2 "On died" and "On emptied" pulsed on BOTH peers', 8000);

	// ---- 3. after removeAfter (1 s) the dead are gone from every store; despawned pulses ------
	await h.eventually(() => Promise.all([A, B].map(ents)), (v) => v.every((x) => x.stored === 0), '3.1 1 s after death no peer still holds the dead', 8000);
	await h.eventually(() => Promise.all([A, B].map(seen)), (v) => v.every((s) => s['kit-spawner-despawned'].n >= 1), '3.2 "On despawned" pulsed on BOTH peers', 8000);
	await A.page.waitForTimeout(1500);
	const final = await Promise.all([A, B].map(seen));
	console.log('  pulses per peer: ' + JSON.stringify(final.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k.replace(/^kit-/, ''), v.n])))));
	h.check(final.every((s) => s['kit-spawner-emptied'].n === 1), '3.3 "On emptied" pulsed ONCE per peer (not again on the removals)');

	await h.finish(browser);
});
