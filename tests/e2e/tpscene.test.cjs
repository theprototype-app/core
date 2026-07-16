// Roadmap #9 B3: the .tpscene format — session bundle + include-checkboxes
// (assets/packs/flow) + pack restore with item-id remap, and the Sidebar
// export-settings cog UI (Scene primary, JSON demoted).
const h = require('./helpers.cjs');
const { unzipSync, strFromU8 } = require('fflate');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// scene: one box + a flow node + an imported pack (box glb)
	const glbArr = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		s.flowNodes.set([{ id: 'n1', type: 'slider', position: { x: 0, y: 0 }, data: { value: 5 } }]);
		const mesh = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial());
		const glb = await new Promise((res, rej) =>
			new s.GLTFExporterModule.GLTFExporter().parse(mesh, (r) => res(r), (e) => rej(e), { binary: true })
		);
		return Array.from(new Uint8Array(glb));
	});
	const { zipSync, strToU8 } = require('fflate');
	const packZip = zipSync(
		{
			'manifest.json': strToU8(JSON.stringify({ id: 'tp-pack', name: 'TP Pack', items: [{ id: 'b', name: 'B', file: 'assets/b/model.glb' }] })),
			'assets/b/model.glb': new Uint8Array(glbArr)
		},
		{ level: 6 }
	);
	await A.page.evaluate(async (zipArr) => {
		await window.__stores.packs.importPackZip(new File([new Uint8Array(zipArr)], 'tp-pack.zip'));
	}, Array.from(packZip));

	// export with everything ON, and once with flow OFF
	const zips = await A.page.evaluate(async () => {
		const s = window.__stores.sessions;
		const payload = s.buildSessionPayload('t');
		const all = await s.exportSessionZip(payload, { assets: true, packs: true, flow: true });
		const noFlow = await s.exportSessionZip(payload, { assets: true, packs: true, flow: false });
		return { all: Array.from(all), noFlow: Array.from(noFlow) };
	});
	const allEntries = unzipSync(new Uint8Array(zips.all));
	const sessionAll = JSON.parse(strFromU8(allEntries['session.json']));
	h.check(sessionAll.objects.length >= 1 && sessionAll.nodes.length === 1, 'bundle carries objects + flow');
	h.check(!!allEntries['packs/index.json'], 'packs checkbox bundles a packs section');
	const packIdx = JSON.parse(strFromU8(allEntries['packs/index.json']));
	h.check(packIdx.packs.some((p) => p.name === 'tp-pack') && packIdx.items.length === 1, 'imported pack + item blob included');
	const noFlowSession = JSON.parse(strFromU8(unzipSync(new Uint8Array(zips.noFlow))['session.json']));
	h.check(noFlowSession.nodes.length === 0 && noFlowSession.edges.length === 0, 'flow OFF strips nodes/edges');

	// wipe local state, re-import the bundle -> objects + flow + pack restored
	const restored = await A.page.evaluate(async (zipArr) => {
		const s = window.__stores;
		s.packs.removeImportedPack('tp-pack');
		s.commandsHandler.sceneCommand('/clear all');
		s.flowNodes.set([]);
		const payload = await s.sessions.importSessionZip(new Uint8Array(zipArr).buffer);
		await s.sessions.applySession(payload); // the Load path (requestLoadSession) confirms first
		await new Promise((r) => setTimeout(r, 600));
		let g, nodes, packs;
		s.objectsGroup.subscribe((x) => (g = x))();
		s.flowNodes.subscribe((x) => (nodes = x))();
		s.packs.packs.subscribe((x) => (packs = x))();
		const pack = packs.find((p) => p.name === 'tp-pack');
		const blob = pack?.items?.[0]?.id ? await s.explorer.itemBlob(pack.items[0].id) : null;
		return { objects: g.children.length, nodes: nodes.length, packBack: !!pack, blobBack: !!blob };
	}, zips.all);
	h.check(restored.objects >= 1 && restored.nodes === 1, `import restores objects + flow (${restored.objects}/${restored.nodes})`);
	h.check(restored.packBack && restored.blobBack, 'imported pack re-registers with a resolvable item blob');

	// Sidebar UI: Scene is primary, JSON hidden until enabled via the cog
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('#format-tpscene').count()) === 1, 'Scene format segment present');
	h.check((await A.page.getByText('JSON', { exact: true }).count()) === 0, 'JSON hidden by default');
	await A.page.locator('#export-settings-cog').click();
	await A.page.waitForTimeout(200);
	h.check((await A.page.locator('#export-settings-modal').count()) === 1, 'cog opens the export settings');
	h.check((await A.page.locator('#tpscene-packs').count()) === 1, 'include-packs checkbox present');

	await h.finish(browser);
});
