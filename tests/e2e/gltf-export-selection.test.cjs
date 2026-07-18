// Roadmap #9 B1.2: GLTF export is selection-only (it used to export the whole
// scene). No selection -> a warning toast + "Export all" escape hatch.
const h = require('./helpers.cjs');
const fs = require('fs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const uuids = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create sphere');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		return g.children.slice(-2).map((c) => c.uuid);
	});

	// no selection -> warning toast, no download
	await A.page.evaluate(() => {
		window.__stores.selectedObject.set([]);
		window.__stores.selectedObjects.set([]);
		window.__stores.fileHandler.save('gltf');
	});
	await A.page.waitForTimeout(400);
	const toasts = await A.page.evaluate(() => {
		let t;
		window.__stores.toastStore.subscribe((x) => (t = x))();
		return JSON.stringify(t);
	});
	h.check(/Nothing selected/.test(toasts), 'no selection -> warning toast (no silent whole-scene export)');

	// select ONE object -> the exported GLTF has exactly one mesh
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u), uuids[0]);
	await A.page.waitForTimeout(200);
	const download = await Promise.all([
		A.page.waitForEvent('download', { timeout: 15000 }),
		A.page.evaluate(() => window.__stores.fileHandler.save('gltf'))
	]).then(([d]) => d);
	const json = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
	h.check((json.meshes?.length ?? 0) === 1, `selection-only export has exactly 1 mesh (${json.meshes?.length})`);
	h.check(/\.gltf$/.test(download.suggestedFilename()), `downloads a .gltf file (${download.suggestedFilename()})`);

	await h.finish(browser);
});
