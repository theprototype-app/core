// PFX-B: the `particle` flow node. It's in the catalog (palette/search), outputs
// the 'effect' channel into an Object Selector, the runtime builds an emitter
// keyed by the NODE id, wired `count` overrides the particle count, and a wired
// event fires a burst-mode emitter on its rising edge. Single-page (the flow
// runtime + particle runtime are local); replication is covered by particles.test.
const h = require('./helpers.cjs');

const entriesOn = (page) =>
	page.evaluate(() => window.__stores.particleRuntime.particleEntries());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// catalog wiring: the node exists and outputs the effect channel
	const catalog = await A.page.evaluate(() => ({
		spec: !!window.__stores.nodeCatalog.findNodeSpec('particle'),
		group: window.__stores.nodeCatalog.groupOf('particle'),
		out: window.__stores.flowSockets.outputType('particle'),
		trigger: window.__stores.flowSockets.inputType('particle', 'trigger'),
		count: window.__stores.flowSockets.inputType('particle', 'count')
	}));
	h.check(
		catalog.spec && catalog.group === 'Effects' && catalog.out === 'effect' && catalog.trigger === 'event' && catalog.count === 'number',
		`catalog: Effects/effect, count=number, trigger=event (${JSON.stringify(catalog)})`
	);

	// build: particle(sparkles) -> objectselector(box)
	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		const preset = window.__stores.particlePresets.particlePreset('sparkles');
		window.__stores.flowNodes.set([
			{ id: 'pfx1', type: 'particle', position: { x: 20, y: 20 }, data: { ...preset, type: 'particle', label: 'Particles' }, class: 'w-[150px]' },
			{ id: 'sel1', type: 'objectselector', position: { x: 320, y: 20 }, data: { type: 'objectselector', label: 'Object Selector', selected: window.__box.uuid }, class: 'w-[150px]' }
		]);
		window.__stores.flowEdges.set([{ id: 'e1', source: 'pfx1', target: 'sel1' }]);
		return window.__box.uuid;
	});
	await h.eventually(
		() => entriesOn(A.page),
		(e) => e.length === 1 && e[0].key === 'pfx1' && e[0].uuid === uuid && e[0].space === 'local',
		'runtime builds an emitter keyed by the NODE id, targeting the wired object'
	);

	// wire a Number(200) into `count` — resolveInputs overrides, runtime rebuilds
	await A.page.evaluate(() => {
		window.__stores.flowNodes.update((ns) => [
			...ns,
			{ id: 'num1', type: 'number', position: { x: 20, y: 260 }, data: { type: 'number', label: 'Number', value: 200 }, class: 'w-[150px]' }
		]);
		window.__stores.flowEdges.update((es) => [...es, { id: 'e2', source: 'num1', target: 'pfx1', targetHandle: 'count' }]);
	});
	await h.eventually(
		() => entriesOn(A.page),
		(e) => e.find((x) => x.key === 'pfx1')?.count === 200,
		'wired count input rebuilds the emitter to 200 particles'
	);

	// burst-mode + a wired event: the trigger fires a burst on its rising edge
	await A.page.evaluate(() => {
		window.__stores.flowNodes.update((ns) =>
			ns
				.map((n) => (n.id === 'pfx1' ? { ...n, data: { ...n.data, mode: 'burst' } } : n))
				.concat([{ id: 'clk1', type: 'onclick', position: { x: 20, y: 420 }, data: { type: 'onclick', label: 'On Click', pulse: 0.5 } }])
		);
		window.__stores.flowEdges.update((es) => [...es, { id: 'e3', source: 'clk1', target: 'pfx1', targetHandle: 'trigger' }]);
	});
	await A.page.waitForTimeout(300);
	const beforeBurst = (await entriesOn(A.page)).find((x) => x.key === 'pfx1')?.burstT;
	// fire the wired event (replicated pulse; here local is enough)
	await A.page.evaluate(() => {
		const t = (Date.now() % 86400000) / 1000;
		window.__stores.flowRuntime.applyNodeTrigger('clk1', t, false);
	});
	await h.eventually(
		() => entriesOn(A.page),
		(e) => (e.find((x) => x.key === 'pfx1')?.burstT ?? -1) >= 0,
		`a wired event triggers a burst (was ${beforeBurst})`
	);

	// implicit owner: a particle node in an OBJECT graph with no selector targets
	// its owner (H1 rule, shared with sound)
	const sphereUuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const uuid = g.children[g.children.length - 1].uuid;
		window.__stores.flowGraphs.update((graphs) => ({
			...graphs,
			[uuid]: {
				nodes: [{ id: 'opfx', type: 'particle', position: { x: 20, y: 20 }, data: { ...window.__stores.particlePresets.particlePreset('fire'), type: 'particle', label: 'Particles' } }],
				edges: []
			}
		}));
		return uuid;
	});
	await h.eventually(
		() => entriesOn(A.page),
		(e) => e.some((x) => x.key === 'opfx' && x.uuid === sphereUuid),
		'particle node in an object graph targets its owner (implicit)'
	);

	await h.finish(browser);
});
