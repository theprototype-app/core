// Phase 31: button module — viewport click on the button slides the door on both peers.
const h = require('./helpers.cjs');

const doorY = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					resolve(g?.getObjectByProperty('uuid', uuid)?.position.y ?? null);
				})();
			}),
		uuid
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const untilY = (uuid, target, label, timeout = 9000) =>
		h.eventually(
			() => Promise.all([A.page, B.page].map((p) => doorY(p, uuid))),
			(ys) => ys.every((y) => y !== null && Math.abs(y - target) < 0.15),
			label,
			timeout
		);

	const { buttonUuid, doorUuid } = await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Button');
		cmd('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return {
			buttonUuid: group.children.find((c) => c.name === 'Button')?.uuid,
			doorUuid: group.children.find((c) => c.name === 'Box')?.uuid
		};
	});
	h.check(!!buttonUuid, 'Button primitive created via /create Button');

	await A.page.evaluate(async (doorUuid) => {
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		group.getObjectByProperty('uuid', doorUuid).position.set(3, 0, 0);
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		peer.send({ type: 'move', uuid: doorUuid, pos: [3, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] });
	}, doorUuid);

	await A.page.evaluate(({ buttonUuid, doorUuid }) => {
		const nodes = [
			{
				id: 't1',
				type: 'buttontrigger',
				position: { x: 0, y: 0 },
				data: { button: buttonUuid, mode: 'toggle', height: 2, pressed: false, at: 0 }
			},
			{ id: 's1', type: 'objectselector', position: { x: 300, y: 0 }, data: { selected: doorUuid } }
		];
		const edge = { id: 'e1', source: 't1', target: 's1' };
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set([edge]);
		return new Promise((resolve) => {
			window.__stores.peers.subscribe((peer) => {
				nodes.forEach((node) => peer.send({ type: 'nodecreate', node }));
				peer.send({ type: 'edgecreate', edge });
				resolve();
			})();
		});
	}, { buttonUuid, doorUuid });
	await A.page.waitForTimeout(3000);

	const pixel = await h.projectPoint(A.page, await A.page.evaluate(
		(buttonUuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(g.getObjectByProperty('uuid', buttonUuid).position.toArray())
				)()
			),
		buttonUuid
	));
	await A.page.mouse.click(pixel.x, pixel.y);
	await untilY(doorUuid, 2, 'door slides up on both peers after clicking the button');

	const selected = await A.page.evaluate(
		() => new Promise((r) => window.__stores.selectedObject.subscribe((s) => r(s?.uuid))())
	);
	h.check(selected !== buttonUuid, 'button click was consumed (no selection)');

	await A.page.mouse.click(pixel.x, pixel.y);
	await untilY(doorUuid, 0, 'door slides back down on both peers');

	await h.finish(browser);
});
