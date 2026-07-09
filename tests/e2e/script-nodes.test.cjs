// Phase 32: script nodes run + live-edit + error badges; custom defs replicate + late-join.
const h = require('./helpers.cjs');

const objState = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					resolve(o ? { x: o.position.x, y: o.position.y, ry: o.rotation.y } : null);
				})();
			}),
		uuid
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((resolve) =>
			window.__stores.objectsGroup.subscribe((g) => resolve(g.children[g.children.length - 1].uuid))()
		);
	});
	await A.page.evaluate((uuid) => {
		const nodes = [
			{
				id: 'sc1',
				type: 'script',
				position: { x: 0, y: 0 },
				data: { type: 'script', code: 'object.position.x = base.pos[0] + Math.sin(time * 3);' },
				class: 'w-[150px]'
			},
			{
				id: 'sel1',
				type: 'objectselector',
				position: { x: 300, y: 0 },
				data: { type: 'objectselector', selected: uuid },
				class: 'w-[150px]'
			}
		];
		const edge = { id: 'e1', source: 'sc1', target: 'sel1' };
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set([edge]);
		return new Promise((resolve) => {
			window.__stores.peers.subscribe((peer) => {
				nodes.forEach((node) => peer.send({ type: 'nodecreate', node }));
				peer.send({ type: 'edgecreate', edge });
				resolve();
			})();
		});
	}, uuid);
	await A.page.waitForTimeout(2500);

	const a1 = await objState(A.page, uuid);
	await A.page.waitForTimeout(300);
	const a2 = await objState(A.page, uuid);
	h.check(a1 && a1.x !== a2.x, 'script animates on A');
	const b1 = await objState(B.page, uuid);
	await B.page.waitForTimeout(300);
	const b2 = await objState(B.page, uuid);
	h.check(b1 && b1.x !== b2.x, 'script animates on B');

	await A.page.evaluate(async () => {
		const { setNodeData } = await import('/src/lib/nodesHandler.js');
		setNodeData('sc1', { code: 'object.position.y = base.pos[1] + 1.5;' });
	});
	await A.page.waitForTimeout(2500);
	const bAfterEdit = await objState(B.page, uuid);
	h.check(bAfterEdit && Math.abs(bAfterEdit.y - 1.5) < 0.01, 'edited code runs on B');

	await A.page.evaluate(async () => {
		const { setNodeData } = await import('/src/lib/nodesHandler.js');
		setNodeData('sc1', { code: 'object.position.y = definitelyNotDefined;' });
	});
	await A.page.waitForTimeout(600);
	const err = await A.page.evaluate(
		() => new Promise((r) => window.__stores.scriptErrors.subscribe((m) => r(m['sc1']))())
	);
	h.check(!!err, 'script error reported');
	await A.page.evaluate(async () => {
		const { setNodeData } = await import('/src/lib/nodesHandler.js');
		setNodeData('sc1', { code: 'object.position.y = base.pos[1];' });
	});
	await A.page.waitForTimeout(600);
	const errAfter = await A.page.evaluate(
		() => new Promise((r) => window.__stores.scriptErrors.subscribe((m) => r(m['sc1']))())
	);
	h.check(!errAfter, 'script error cleared after fix');

	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(800);
	await A.page.getByRole('button', { name: 'Edit code' }).first().click();
	await A.page.waitForTimeout(1500);
	h.check((await A.page.locator('.cm-editor').count()) > 0, 'CodeMirror editor panel mounts');
	await A.page.locator('#script-panel-close').click();
	await A.page.locator('p[title="Node editor (N)"]').click();

	await A.page.evaluate(async () => {
		const { saveNodeDef, defDefaults, findNodeDef } = await import('/src/lib/customNodes.js');
		saveNodeDef({
			id: 'def-wobble',
			name: 'Wobble',
			params: [{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }],
			code: 'object.rotation.y = base.rot[1] + time * (data.speed ?? 1);'
		});
		const node = {
			id: 'cn1',
			type: 'customnode',
			position: { x: 0, y: 150 },
			data: { type: 'customnode', ...defDefaults(findNodeDef('def-wobble')), speed: 2 },
			class: 'w-[150px]'
		};
		const edge = { id: 'e2', source: 'cn1', target: 'sel1' };
		window.__stores.flowNodes.update((n) => [...n, node]);
		window.__stores.flowEdges.update((e) => [...e, edge]);
		await new Promise((resolve) => {
			window.__stores.peers.subscribe((peer) => {
				peer.send({ type: 'nodecreate', node });
				peer.send({ type: 'edgecreate', edge });
				resolve();
			})();
		});
	});
	await A.page.waitForTimeout(3000);

	const bDef = await B.page.evaluate(
		() => new Promise((r) => window.__stores.customNodeDefs.subscribe((d) => r(d.find((x) => x.id === 'def-wobble')))())
	);
	h.check(!!bDef, 'custom def replicated to B');
	const br1 = await objState(B.page, uuid);
	await B.page.waitForTimeout(400);
	const br2 = await objState(B.page, uuid);
	h.check(br1 && br1.ry !== br2.ry, 'custom node executes on B');

	await A.page.evaluate(async () => {
		const { saveNodeDef } = await import('/src/lib/customNodes.js');
		saveNodeDef({
			id: 'def-wobble',
			name: 'Wobble2',
			params: [{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }],
			code: 'object.rotation.y = base.rot[1];'
		});
	});
	await A.page.waitForTimeout(2000);
	const bDef2 = await B.page.evaluate(
		() => new Promise((r) => window.__stores.customNodeDefs.subscribe((d) => r(d.find((x) => x.id === 'def-wobble'))))
	);
	h.check(bDef2?.name === 'Wobble2', 'def edit replicated to B');

	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	const cDef = await C.page.evaluate(
		() => new Promise((r) => window.__stores.customNodeDefs.subscribe((d) => r(d.find((x) => x.id === 'def-wobble')))())
	);
	h.check(!!cDef, 'late joiner received custom defs');

	await h.finish(browser);
});
