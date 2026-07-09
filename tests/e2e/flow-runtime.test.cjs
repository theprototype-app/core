// Phase 29: animation rebase on move/drag, slider/switcher wiring, nodesync drift heal.
const h = require('./helpers.cjs');

const getObjectState = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((group) => {
					const o = group?.getObjectByProperty('uuid', uuid);
					resolve(o ? { pos: o.position.toArray(), scale: o.scale.toArray(), geo: o.geometry?.type } : null);
				})();
			}),
		uuid
	);

const readGraph = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.flowNodes.subscribe((nodes) => {
					resolve(nodes.map((n) => ({ id: n.id, data: n.data })));
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((resolve) => {
			window.__stores.objectsGroup.subscribe((group) => {
				resolve(group?.children.find((c) => c.isMesh)?.uuid);
			})();
		});
	});

	await A.page.evaluate((uuid) => {
		window.__stores.flowNodes.set([
			{ id: 'n1', type: 'bounce', position: { x: 0, y: 0 }, data: { amplitude: 1, speed: 2 } },
			{ id: 'n2', type: 'objectselector', position: { x: 250, y: 0 }, data: { selected: uuid } }
		]);
		window.__stores.flowEdges.set([{ id: 'e1', source: 'n1', target: 'n2' }]);
	}, uuid);
	await A.page.waitForTimeout(400);
	const s1 = await getObjectState(A.page, uuid);
	await A.page.waitForTimeout(300);
	const s2 = await getObjectState(A.page, uuid);
	h.check(s1.pos[1] !== s2.pos[1] || s1.pos[1] > 0.001, 'bounce animates the cube');

	await A.page.evaluate(() => {
		window.__stores.flowNodes.update((nodes) => [
			...nodes,
			{ id: 'n3', type: 'slider', position: { x: 0, y: 150 }, data: { value: 40 } }
		]);
		window.__stores.flowEdges.update((edges) => [...edges, { id: 'e2', source: 'n3', target: 'n2' }]);
	});
	await A.page.waitForTimeout(300);
	const s3 = await getObjectState(A.page, uuid);
	h.check(Math.abs(s3.scale[0] - 2) < 0.001, `slider scales animated object (scale ${s3.scale[0]})`);

	await A.page.evaluate(() => {
		window.__stores.flowNodes.update((nodes) => [
			...nodes,
			{ id: 'n4', type: 'switcher', position: { x: 0, y: 300 }, data: { shape: 'pyramid' } }
		]);
		window.__stores.flowEdges.update((edges) => [...edges, { id: 'e3', source: 'n4', target: 'n2' }]);
	});
	await A.page.waitForTimeout(200);
	h.check((await getObjectState(A.page, uuid)).geo === 'ConeGeometry', 'switcher swaps to pyramid');
	await A.page.evaluate(() => {
		window.__stores.flowNodes.update((nodes) =>
			nodes.map((n) => (n.id === 'n4' ? { ...n, data: { shape: 'cube' } } : n))
		);
	});
	await A.page.waitForTimeout(200);
	h.check((await getObjectState(A.page, uuid)).geo === 'BoxGeometry', 'switcher swaps back to cube');

	await A.page.evaluate(async (uuid) => {
		const { moveGeometry } = await import('/src/lib/geometries.svelte.js');
		moveGeometry(uuid, [5, 0, 0], [0, 0, 0], [2, 2, 2]);
	}, uuid);
	await A.page.waitForTimeout(300);
	const s6 = await getObjectState(A.page, uuid);
	h.check(Math.abs(s6.pos[0] - 5) < 0.001, `remote move rebases animation (x ${s6.pos[0]})`);
	h.check(s6.pos[1] >= 0 && s6.pos[1] <= 1.01, `still bouncing around new base (y ${s6.pos[1]})`);

	const s7 = await A.page.evaluate(async (uuid) => {
		const rt = window.__stores.flowRuntime;
		rt.suspendAnimation(uuid);
		await new Promise((r) => setTimeout(r, 150));
		const group = await new Promise((resolve) => {
			window.__stores.objectsGroup.subscribe((g) => resolve(g))();
		});
		const o = group.getObjectByProperty('uuid', uuid);
		const parkedY = o.position.y;
		o.position.set(5, 0, 3);
		rt.resumeAnimation(uuid);
		await new Promise((r) => setTimeout(r, 300));
		return { parkedY, pos: o.position.toArray() };
	}, uuid);
	h.check(Math.abs(s7.parkedY) < 0.001, `suspend parks at base (y ${s7.parkedY})`);
	h.check(Math.abs(s7.pos[2] - 3) < 0.001 && s7.pos[1] >= 0, 'resume animates around dragged base');

	// drift heal between peers
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 10000);
	let bGraph = await readGraph(B.page);
	h.check(bGraph.length === 4, `B received graph via handshake (${bGraph.length} nodes)`);

	await B.page.evaluate(async () => {
		const { updateFlowNodeData } = await import('/src/lib/nodesHandler.js');
		updateFlowNodeData('n1', { amplitude: 9 });
	});
	h.check((await readGraph(B.page)).find((n) => n.id === 'n1').data.amplitude === 9, 'drift injected on B');

	console.log('waiting up to 50s for drift to heal...');
	let healed = false;
	for (let i = 0; i < 25 && !healed; i++) {
		await B.page.waitForTimeout(2000);
		const a = (await readGraph(A.page)).find((n) => n.id === 'n1');
		const b = (await readGraph(B.page)).find((n) => n.id === 'n1');
		healed = a && b && a.data.amplitude === b.data.amplitude;
	}
	h.check(healed, 'nodesync heals the drifted node data');

	await h.finish(browser);
});
