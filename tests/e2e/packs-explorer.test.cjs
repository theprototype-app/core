// Roadmap #7 N6b: Explorer Packs UI — an expandable Packs section (mirrors Scene)
// lists packs; opening one shows its items as cards; a .zip import adds a local
// pack; a pack item drags out / places into the scene; attribution reads from the
// manifest. Default packs come from libraryList.json (served from /library on this
// machine). On-device drag feel is manual; this drives the DOM + store.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open the Explorer
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	h.check(await A.page.locator('#explorer-list').isVisible(), 'Explorer opens');

	// expand the Packs section -> default pack rows appear
	await A.page.locator('#packs-folder').click();
	await A.page.waitForTimeout(400);
	const packRows = await A.page.locator('#explorer-list [data-pack]').count();
	h.check(packRows >= 1, `Packs expands to per-pack rows (${packRows})`);

	// open a default pack -> its items render as grid cards
	const firstPack = await A.page.locator('#explorer-list [data-pack]').first().getAttribute('data-pack');
	await A.page.locator(`#explorer-list [data-pack="${firstPack}"]`).click();
	await A.page.waitForTimeout(700);
	const cards = await A.page.locator('#explorer-list .explorer-card').count();
	h.check(cards > 0, `opening a pack shows its item cards (${firstPack}: ${cards})`);

	// import a .zip pack (box glb) — build the glb in the page, zip in Node
	const glbArr = await A.page.evaluate(async () => {
		const s = window.__stores;
		const mesh = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial());
		const glb = await new Promise((res, rej) =>
			new s.GLTFExporterModule.GLTFExporter().parse(mesh, (r) => res(r), (e) => rej(e), { binary: true })
		);
		return Array.from(new Uint8Array(glb));
	});
	const { zipSync, strToU8 } = require('fflate');
	const manifest = {
		id: 'testpack', name: 'Test Pack', author: 'Me', license: 'CC-BY-4.0',
		items: [{ id: 'box', name: 'Box', file: 'assets/box/model.glb' }]
	};
	const zipBytes = zipSync(
		{ 'manifest.json': strToU8(JSON.stringify(manifest)), 'assets/box/model.glb': new Uint8Array(glbArr) },
		{ level: 6 }
	);
	const attrib = await A.page.evaluate(async (zipArr) => {
		const pack = await window.__stores.packs.importPackZip(new File([new Uint8Array(zipArr)], 'testpack.zip'));
		return pack.attributionHtml;
	}, Array.from(zipBytes));
	h.check(/Creative Commons Attribution 4\.0/.test(attrib), 'imported pack attribution maps the SPDX license to a label');

	await A.page.waitForTimeout(300);
	h.check((await A.page.locator('#explorer-list [data-pack="testpack"]').count()) === 1, 'the imported pack appears as a row');

	// open it -> the box item is a card; then place it via the drop path
	await A.page.locator('#explorer-list [data-pack="testpack"]').click();
	await A.page.waitForTimeout(400);
	h.check((await A.page.locator('#explorer-list .explorer-card').count()) === 1, 'the imported pack shows its one item');

	const placed = await A.page.evaluate(async () => {
		const s = window.__stores;
		let items;
		s.packs.openPackItems.subscribe((x) => (items = x))();
		const before = (() => {
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			return g.children.length;
		})();
		// imported pack item is a real Explorer item (has an id) -> normal drop path
		await s.explorerDrop.dropExplorerItem({ id: items[0].id, kind: 'object', name: items[0].name }, 400, 300);
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		return { before, after: g.children.length };
	});
	h.check(placed.after === placed.before + 1, `placing a pack item adds it to the scene (${placed.before}->${placed.after})`);

	await h.finish(browser);
});
