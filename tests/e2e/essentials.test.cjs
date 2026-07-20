// K-E: VR essentials — replicated interactable primitives; the Button pulses a
// wired flow counter on BOTH peers (nodetrigger), the Lever toggles + tilts on
// both (module op), the Spawner creates a replicated cube, the Teleport pad
// jumps the LOCAL camera only.
const h = require('./helpers.cjs');

const counterOn = (page, id) =>
	page.evaluate(
		(id) => new Promise((r) => window.__stores.flowTriggers.subscribe((t) => r(t[id]?.count ?? 0))()),
		id
	);

const objByName = (page, name) =>
	page.evaluate(
		(name) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					let hit = null;
					g?.children.forEach((c) => {
						if (c.name === name) hit = { uuid: c.uuid, rz: c.rotation.z };
					});
					resolve(hit);
				})();
			}),
		name
	);

// invoke the module click dispatch exactly like Scene does
const clickEssential = (page, uuid) =>
	page.evaluate((uuid) => {
		const group = window.__stores.moduleSDK ? null : null;
		let target = null;
		window.__stores.objectsGroup.subscribe((g) => (target = g?.getObjectByProperty('uuid', uuid)))();
		for (const handler of window.__stores.moduleSDK.moduleClickHandlers) {
			if (handler(target)) return true;
		}
		return false;
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const loaded = await A.page.evaluate(() =>
		window.__stores.moduleSDK.loadedModules.some((m) => m.id === 'essentials')
	);
	h.check(loaded === true, 'essentials module loads with the core set');

	// --- button: replicated create + click pulses a wired counter everywhere ---
	await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Essbutton');
		cmd('/create Esslever');
		cmd('/create Essspawner');
	});
	await B.page.waitForTimeout(1500);
	const bButton = await objByName(B.page, 'Essbutton');
	h.check(!!bButton, 'button replicated to B through the normal create path');

	const button = await objByName(A.page, 'Essbutton');
	await A.page.evaluate(async (uuid) => {
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		const nodes = [
			{ id: 'oc', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick' }, class: 'w-[150px]' },
			{ id: 'sel', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', selected: uuid }, class: 'w-[150px]' },
			{ id: 'cnt', type: 'counter', position: { x: 300, y: 200 }, data: { type: 'counter', op: 'up', step: 1 }, class: 'w-[150px]' }
		];
		const edges = [
			{ id: 'e1', source: 'oc', target: 'sel' },
			{ id: 'e2', source: 'oc', target: 'cnt' }
		];
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set(edges);
		nodes.forEach((node) => peer.send({ type: 'nodecreate', node }));
		edges.forEach((edge) => peer.send({ type: 'edgecreate', edge }));
	}, button.uuid);
	await B.page.waitForTimeout(1500);

	const consumed = await clickEssential(A.page, button.uuid);
	h.check(consumed === true, 'the click dispatch consumes the button');
	await h.eventually(() => counterOn(A.page, 'cnt'), (c) => c === 1, 'button pulse bumps the wired counter on A');
	await h.eventually(() => counterOn(B.page, 'cnt'), (c) => c === 1, 'pulse replicated to B (nodetrigger)');

	// --- lever: toggle tilts on both peers --------------------------------------
	const lever = await objByName(A.page, 'Esslever');
	await clickEssential(A.page, lever.uuid);
	const aLever = await objByName(A.page, 'Esslever');
	h.check(Math.abs(aLever.rz + 0.45) < 0.01, `lever tilts ON locally (rz=${aLever.rz.toFixed(2)})`);
	await h.eventually(
		() => objByName(B.page, 'Esslever'),
		(l) => l && Math.abs(l.rz + 0.45) < 0.01,
		'lever toggle replicated to B (module op)'
	);

	// --- spawner: click creates a replicated cube above the pad -----------------
	const countBefore = await A.page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))())
	);
	const spawner = await objByName(A.page, 'Essspawner');
	await clickEssential(A.page, spawner.uuid);
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))())),
		(c) => c === countBefore + 1,
		'spawner creates a cube on A'
	);
	await h.eventually(
		() => B.page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))())),
		(c) => c === countBefore + 1,
		'spawned cube replicated to B'
	);

	await h.finish(browser);
});
