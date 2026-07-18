// Roadmap #9 B1.1: dropping files into the Explorer Packs view — a pack .zip
// imports; a non-zip is rejected (not orphaned with a bogus folderId); a
// supported file dropped in the Library root still imports (regression).
const h = require('./helpers.cjs');
const { zipSync, strToU8 } = require('fflate');

const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const dropFile = (page, name, type, arr) =>
	page.evaluate(
		({ name, type, arr }) => {
			const file = new File([new Uint8Array(arr)], name, { type });
			const dt = new DataTransfer();
			dt.items.add(file);
			document
				.querySelector('#explorer-list')
				.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
		},
		{ name, type, arr }
	);

const itemCount = (page) =>
	page.evaluate(() => {
		let it;
		window.__stores.explorer.explorerItems.subscribe((x) => (it = x))();
		return it.length;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// a real pack .zip (a box glb), built in Node (bare fflate import fails in the page)
	const glbArr = await A.page.evaluate(async () => {
		const s = window.__stores;
		const mesh = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial());
		const glb = await new Promise((res, rej) =>
			new s.GLTFExporterModule.GLTFExporter().parse(mesh, (r) => res(r), (e) => rej(e), { binary: true })
		);
		return Array.from(new Uint8Array(glb));
	});
	const zipBytes = zipSync(
		{
			'manifest.json': strToU8(JSON.stringify({ id: 'dropped', name: 'Dropped Pack', items: [{ id: 'box', name: 'Box', file: 'assets/box/model.glb' }] })),
			'assets/box/model.glb': new Uint8Array(glbArr)
		},
		{ level: 6 }
	);

	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(500);
	await A.page.locator('#packs-folder').click(); // single-click -> packs grid view
	await A.page.waitForTimeout(400);

	// drop the pack zip into the Packs view -> imported
	await dropFile(A.page, 'dropped.zip', 'application/zip', Array.from(zipBytes));
	await A.page.waitForTimeout(700);
	const registered = await A.page.evaluate(() => {
		let list;
		window.__stores.packs.packs.subscribe((x) => (list = x))();
		return list.some((p) => p.name === 'dropped');
	});
	h.check(registered, 'dropping a pack .zip into the Packs view imports it');

	// drop a non-zip into Packs -> rejected, NOT imported into the library
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set('packs'));
	await A.page.waitForTimeout(200);
	const before = await itemCount(A.page);
	await dropFile(A.page, 'foo.png', 'image/png', Array.from(Uint8Array.from(atob(TINY_PNG), (c) => c.charCodeAt(0))));
	await A.page.waitForTimeout(500);
	h.check((await itemCount(A.page)) === before, 'a non-zip dropped into Packs is rejected (not imported)');

	// drop a supported file in the Library root -> still imports (regression)
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(200);
	await dropFile(A.page, 'lib.png', 'image/png', Array.from(Uint8Array.from(atob(TINY_PNG), (c) => c.charCodeAt(0))));
	await A.page.waitForTimeout(700);
	const libImported = await A.page.evaluate(() => {
		let it;
		window.__stores.explorer.explorerItems.subscribe((x) => (it = x))();
		return it.some((i) => i.name === 'lib.png');
	});
	h.check(libImported, 'a supported file dropped in the Library root still imports');

	await h.finish(browser);
});
