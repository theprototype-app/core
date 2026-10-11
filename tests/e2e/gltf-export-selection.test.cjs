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
	// 41 G16: the question is a modal now (it blocks the export), not a toast
	const asked = await A.page.evaluate(() => document.querySelector('dialog[open]')?.textContent ?? '');
	h.check(/Nothing selected/.test(asked) && /Export all/.test(asked), 'no selection -> a modal asks (no silent whole-scene export)');
	await A.page.locator('#confirm-dialog-cancel').click();
	await A.page.waitForTimeout(300);

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
