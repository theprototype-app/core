// Roadmap #7 N6a: pack data model — default packs normalize from libraryList.json,
// thumbnail candidates resolve webp -> png -> screenshot, a .zip pack imports as a
// LOCAL pack whose items become real Explorer items, SPDX ids map to labels.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const defaults = await A.page.evaluate(async () => {
		const p = window.__stores.packs;
		await p.loadPacks();
		let list;
		p.packs.subscribe((x) => (list = x))();
		const khronos = list.find((x) => x.name === 'KhronosGroupSampleAssets');
		const cands = khronos
			? p.thumbCandidates(khronos, { name: 'Duck', screenshot: 'screenshot/screenshot.jpg' })
			: [];
		return { count: list.length, names: list.map((x) => x.name), license: khronos?.license, cands };
	});
	h.check(
		defaults.count >= 1 && defaults.names.includes('KhronosGroupSampleAssets'),
		`default packs load from libraryList (${defaults.names.join(',')})`
	);
	h.check(
		defaults.cands[0]?.endsWith('thumb.webp') &&
			defaults.cands[1]?.endsWith('thumb.png') &&
			defaults.cands[2]?.endsWith('screenshot/screenshot.jpg'),
		'thumbnail candidates resolve webp -> png -> screenshot'
	);
	h.check(defaults.license === 'CC-BY 4.0 International', `default pack keeps its license (${defaults.license})`);

	const lbl = await A.page.evaluate(() => window.__stores.packs.licenseLabel('CC-BY-4.0'));
	h.check(/Creative Commons/.test(lbl), `SPDX id maps to a human label (${lbl})`);

	// a box glb from the page (bare 'fflate' won't resolve in a raw page eval, so
	// the zip is assembled in Node from these bytes)
	const glbArr = await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		const glb = await new Promise((res, rej) =>
			new s.GLTFExporterModule.GLTFExporter().parse(mesh, (r) => res(r), (e) => rej(e), { binary: true })
		);
		return Array.from(new Uint8Array(glb));
	});
	const { zipSync, strToU8 } = require('fflate');
	const manifest = {
		id: 'testpack', name: 'Test Pack', author: 'Me', license: 'CC-BY-4.0',
		items: [{ id: 'box', name: 'Box', file: 'assets/box/model.glb', license: 'MIT', author: 'Me', source: 'https://example.com' }]
	};
	const zipBytes = zipSync(
		{ 'manifest.json': strToU8(JSON.stringify(manifest)), 'assets/box/model.glb': new Uint8Array(glbArr) },
		{ level: 6 }
	);
	const imported = await A.page.evaluate(async (zipArr) => {
		const s = window.__stores;
		const file = new File([new Uint8Array(zipArr)], 'testpack.zip');
		const pack = await s.packs.importPackZip(file);
		let list;
		s.packs.packs.subscribe((x) => (list = x))();
		const items = await s.packs.loadPackItems(pack);
		const blob = await s.explorer.itemBlob(items[0].id);
		return {
			registered: list.some((x) => x.name === 'testpack'),
			source: pack.source,
			itemCount: items.length,
			kind: items[0]?.kind,
			hasBlob: !!blob,
			itemLicense: items[0]?.license
		};
	}, Array.from(zipBytes));
	h.check(imported.registered && imported.source === 'imported', 'zip import registers a local pack');
	h.check(
		imported.itemCount === 1 && imported.kind === 'object' && imported.hasBlob,
		'the pack item is stored as a real Explorer object item'
	);
	h.check(imported.itemLicense === 'MIT', 'per-item license override is kept');

	// P2: thumbnail cache round-trips + is dropped on remove
	const thumb = await A.page.evaluate(() => {
		const p = window.__stores.packs;
		p.rememberThumb('testpack', 'box', 'https://x/thumb.png');
		const before = p.cachedThumb('testpack', 'box');
		p.removeImportedPack('testpack');
		return { before, after: p.cachedThumb('testpack', 'box') };
	});
	h.check(thumb.before === 'https://x/thumb.png', 'rememberThumb/cachedThumb round-trip');
	h.check(thumb.after === null, 'removeImportedPack drops the pack thumbnail cache (P2)');

	const afterRemove = await A.page.evaluate(() => {
		let list;
		window.__stores.packs.packs.subscribe((x) => (list = x))();
		return list.some((x) => x.name === 'testpack');
	});
	h.check(!afterRemove, 'removeImportedPack drops it from the list');

	// P3: a .zip wrapped in ONE top-level folder (GitHub "Download ZIP" shape) still imports
	const wrapZip = zipSync(
		{
			'mypack-main/manifest.json': strToU8(JSON.stringify({ id: 'wrapped', name: 'Wrapped', items: [{ id: 'b', name: 'B', file: 'assets/b/model.glb' }] })),
			'mypack-main/assets/b/model.glb': new Uint8Array(glbArr)
		},
		{ level: 6 }
	);
	const wrapped = await A.page.evaluate(async (zipArr) => {
		const pack = await window.__stores.packs.importPackZip(new File([new Uint8Array(zipArr)], 'mypack-main.zip'));
		const items = await window.__stores.packs.loadPackItems(pack);
		return { name: pack.name, title: pack.title, itemCount: items.length };
	}, Array.from(wrapZip));
	h.check(
		wrapped.name === 'wrapped' && wrapped.itemCount === 1,
		`a single-wrapper-folder .zip descends into it (${wrapped.name}, ${wrapped.itemCount} item)`
	);

	await h.finish(browser);
});
