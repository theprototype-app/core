// C1 (roadmap #13): physics discoverability — the Inspector scene-mode Physics
// section lists every object that gets a body at sim start (userData.physics +
// flow Mass overrides), row click selects, the quick action makes the selection
// dynamic (replicated objectParameters), and the no-physics sim fallback toast
// explains WHY and points at the Inspector.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();

	// throwaway page warms the vite dep-optimizer for the lazy rapier import
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}

	const A = await h.setupPage(browser, 'A');

	// three boxes: b1 gets userData physics, b2 a flow Mass node, b3 stays bare
	const uuids = await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create box');
		cmd('/create box');
		cmd('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const [b1, b2, b3] = group.children;
		b1.name = 'PropsBox';
		b2.name = 'FlowBox';
		b3.name = 'BareBox';
		// spread them out — overlapping colliders would explode the fallback sim
		b1.position.set(0, 0.5, 0);
		b2.position.set(3, 0.5, 0);
		b3.position.set(6, 0.5, 0);
		return [b1.uuid, b2.uuid, b3.uuid];
	});

	// fallback toast FIRST (while nothing has physics): select b3 and simulate
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid), uuids[2]);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() =>
			A.page.evaluate(
				() => new Promise((r) => window.__stores.toastStore.subscribe((t) => r(t.map((x) => x.message ?? x).join('|')))())
			),
		(msgs) => /No objects have physics yet/.test(msgs || '') && /Inspector/.test(msgs || ''),
		'fallback toast explains WHY and points at the Inspector'
	);
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'fallback still simulates the selected object'
	);
	await A.page.evaluate(() => window.__stores.physics.stopSimulation());

	// give b1 userData physics + wire a Mass node to b2
	await A.page.evaluate(([b1, b2]) => {
		let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		group.getObjectByProperty('uuid', b1).userData.physics = { mode: 'dynamic', mass: 3 };
		const nodes = [
			{ id: 'm1', type: 'mass', position: { x: 0, y: 0 }, data: { type: 'mass', kg: 2 }, class: 'w-[150px]' },
			{ id: 'sel1', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', selected: b2 }, class: 'w-[150px]' }
		];
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set([{ id: 'e1', source: 'm1', target: 'sel1' }]);
		window.__stores.objectsGroup.update((v) => v);
	}, uuids);

	// the list API sees both sources
	const rows = await A.page.evaluate(() => window.__stores.physics.listPhysicsObjects());
	h.check(rows.length === 2, 'two physics objects listed (' + rows.length + ')');
	const propsRow = rows.find((r) => r.name === 'PropsBox');
	const flowRow = rows.find((r) => r.name === 'FlowBox');
	h.check(!!propsRow && propsRow.mode === 'dynamic' && propsRow.mass === 3 && !propsRow.flow, 'userData row: dynamic mass 3');
	h.check(!!flowRow && flowRow.mode === 'dynamic' && flowRow.mass === 2 && flowRow.flow, 'flow row: dynamic mass 2, flagged flow');

	// the Inspector scene-mode section renders the rows; row click selects
	await A.page.evaluate(() => {
		window.__stores.inspectorKind.set('scene');
		window.__stores.inspectorClose.set(false);
	});
	await A.page.waitForSelector('#physics-objects', { timeout: 10000 });
	const rowCount = await A.page.locator('#physics-objects button').count();
	h.check(rowCount === 2, 'Inspector Physics section renders 2 rows');
	await A.page.locator('#physics-objects button', { hasText: 'PropsBox' }).click();
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.selectedObject.subscribe((o) => r(o?.uuid))())),
		(v) => v === uuids[0],
		'clicking a row selects the object'
	);

	// quick action on the bare box: capture the replicated objectParameters
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid), uuids[2]);
	const captured = await A.page.evaluate(async (bare) => {
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		const sent = [];
		const realSend = peer.send.bind(peer);
		peer.send = (m) => {
			sent.push(m);
			realSend(m);
		};
		document.querySelector('#physics-enable-selection').click();
		peer.send = realSend;
		let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const obj = group.getObjectByProperty('uuid', bare);
		return { sent: sent.filter((m) => m.type === 'objectParameters' && m.parameter === 'physics'), physics: obj.userData.physics };
	}, uuids[2]);
	h.check(
		captured.physics?.mode === 'dynamic' && captured.physics?.mass === 1,
		'quick action set userData.physics dynamic mass 1'
	);
	h.check(
		captured.sent.length === 1 && captured.sent[0].uuid === uuids[2] && captured.sent[0].physics?.mode === 'dynamic',
		'quick action broadcast one objectParameters physics message'
	);

	// the new row appears in the list (3 physics objects now)
	await h.eventually(
		() => A.page.locator('#physics-objects button').count(),
		(n) => n === 3,
		'bare box joined the Inspector list after the quick action'
	);

	// undo removes it again (props history entry recorded)
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.physics.listPhysicsObjects().length),
		(n) => n === 2,
		'undo reverts the quick action'
	);

	await h.finish(browser);
});
