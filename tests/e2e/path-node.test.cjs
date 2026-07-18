// Phase 36: path patrol — captured waypoints replicate, identical patrol both peers.
const h = require('./helpers.cjs');

const boxState = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					resolve(o ? { pos: o.position.toArray(), ry: o.rotation.y } : null);
				})();
			}),
		uuid
	);

const nodePoints = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.flowNodes.subscribe((nodes) => {
					resolve(nodes.find((n) => n.id === 'pp1')?.data.points ?? null);
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((resolve) => {
			window.__stores.objectsGroup.subscribe((g) => {
				const box = g.children[g.children.length - 1];
				const nodes = [
					{
						id: 'pp1',
						type: 'pathpatrol',
						position: { x: 0, y: 0 },
						data: { type: 'pathpatrol', points: [], speed: 2, mode: 'loop' },
						class: 'w-[150px]'
					},
					{
						id: 'sel1',
						type: 'objectselector',
						position: { x: 300, y: 0 },
						data: { type: 'objectselector', selected: box.uuid },
						class: 'w-[150px]'
					}
				];
				const edge = { id: 'e1', source: 'pp1', target: 'sel1' };
				window.__stores.flowNodes.set(nodes);
				window.__stores.flowEdges.set([edge]);
				window.__stores.peers.subscribe((peer) => {
					nodes.forEach((node) => peer.send({ type: 'nodecreate', node }));
					peer.send({ type: 'edgecreate', edge });
					resolve(box.uuid);
				})();
			})();
		});
	});
	await A.page.waitForTimeout(2000);

	await A.page.evaluate(() => window.__stores.pathCapture.togglePathCapture('pp1'));
	for (const [x, y] of [[420, 500], [700, 480], [600, 620]]) {
		await A.page.mouse.click(x, y);
		await A.page.waitForTimeout(250);
	}
	await A.page.evaluate(() => window.__stores.pathCapture.togglePathCapture('pp1'));

	h.check((await nodePoints(A.page))?.length === 3, '3 waypoints captured on A');
	await h.eventually(() => nodePoints(B.page), (p) => p?.length === 3, 'waypoints replicated to B');

	const a1 = await boxState(A.page, uuid);
	await A.page.waitForTimeout(400);
	const a2 = await boxState(A.page, uuid);
	h.check(a1 && a2 && (a1.pos[0] !== a2.pos[0] || a1.pos[2] !== a2.pos[2]), 'box patrols on A');
	const [aNow, bNow] = await Promise.all([boxState(A.page, uuid), boxState(B.page, uuid)]);
	const drift = Math.hypot(aNow.pos[0] - bNow.pos[0], aNow.pos[2] - bNow.pos[2]);
	h.check(drift < 0.5, `identical patrol on both peers (drift ${drift.toFixed(3)})`);
	h.check(Math.abs(aNow.ry) > 0.0001 || Math.abs(bNow.ry) > 0.0001, 'object faces along the path');

	await A.page.evaluate(async () => {
		const { setNodeData } = await import('/src/lib/nodesHandler.js');
		setNodeData('pp1', { points: [] });
	});
	await h.eventually(() => nodePoints(B.page), (p) => p?.length === 0, 'clearing waypoints replicates to B');

	await h.finish(browser);
});
