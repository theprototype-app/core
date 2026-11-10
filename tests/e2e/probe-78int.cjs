// 78-int scratch probe (not in the battery): why objectNameOf / the collect node read null
const h = require('./helpers.cjs');
h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const p = A.page;
	const out = await p.evaluate(async () => {
		const st = window.__stores;
		const g0 = await new Promise((r) => st.objectsGroup.subscribe(r)());
		const before = g0.children.map((c) => c.uuid + ' ' + c.name);
		st.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => st.objectsGroup.subscribe(r)());
		const after = g.children.map((c) => c.uuid + ' ' + c.name);
		const box = g.children[g.children.length - 1];
		box.name = 'Gem';
		st.restoreGraphs({ scene: { nodes: [], edges: [] }, [box.uuid]: { nodes: [{ id: 'collect', type: 'kit-pickups-collect', position: { x: 0, y: 0 }, data: { type: 'kit-pickups-collect', label: 'c', score: 1, respawn: 0, touch: false } }], edges: [] } });
		await new Promise((r) => setTimeout(r, 800));
		const graphs = Object.keys(await new Promise((r) => st.flowGraphs.subscribe(r)()));
		const whyCollect = st.flowRuntime.triggerWhyOf('collect');
		// an On Click on the named box, through a selector in the scene graph
		st.restoreGraphs({ scene: { nodes: [
			{ id: 'click', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', label: 'click', pulse: 0.3 } },
			{ id: 'sel', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', label: 'sel', selected: box.uuid } }
		], edges: [{ id: 'e1', source: 'click', target: 'sel' }] }, [box.uuid]: { nodes: [{ id: 'collect', type: 'kit-pickups-collect', position: { x: 0, y: 0 }, data: { type: 'kit-pickups-collect', label: 'c', score: 1, respawn: 0, touch: false } }], edges: [] } });
		await new Promise((r) => setTimeout(r, 800));
		st.editorMode.set('interact');
		await new Promise((r) => setTimeout(r, 300));
		const fired = st.flowRuntime.fireObjectClick(box.uuid);
		return { before, after, graphs, uuid: box.uuid, name: box.name, byProp: g.getObjectByProperty('uuid', box.uuid)?.name, whyCollect, whyCollect2: st.flowRuntime.triggerWhyOf('collect'), fired, whyClick: st.flowRuntime.triggerWhyOf('click') };
	});
	console.log(JSON.stringify(out, null, 1));
	h.check(true, 'probe ran');
});
