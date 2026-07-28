// Roadmap #7 N6a + RP: pack data model — default packs come from the remote CDN
// index (mocked here; bundled libraryList.json is the offline fallback), item
// lists may carry ABSOLUTE glb/screenshot URLs (khronos upstream), a .zip pack
// imports as a LOCAL pack whose items become real Explorer items, SPDX ids map
// to labels, and packs expose a Source link.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// hermetic CDN: mock the packs index + one remote item list
	await A.page.route('**/cdn.jsdelivr.net/**', async (route) => {
		const url = route.request().url();
		if (url.endsWith('/index.json') && !url.includes('mock-remote'))
			return route.fulfill({
				json: [
					{ name: 'mockpack', title: 'Mock Pack', value: 'mockpack/default.json', attribution: 'mockpack/attribution.html', license: 'CC0-1.0', source: 'https://github.com/theprototype-app/packs' },
					{ name: 'mock-remote', title: 'Mock Remote', value: 'mock-remote/index.json', license: 'CC-BY-4.0', source: 'https://github.com/KhronosGroup/glTF-Sample-Assets' }
				]
			});
		if (url.includes('mock-remote/index.json'))
			return route.fulfill({
				json: [
					{
						name: 'Duck',
						label: 'Duck',
						screenshot: 'https://upstream.example/Models/Duck/screenshot/screenshot.png',
						variants: { 'glTF-Binary': 'https://upstream.example/Models/Duck/glTF-Binary/Duck.glb' }
					}
				]
			});
		return route.continue();
	});

	const defaults = await A.page.evaluate(async () => {
		const p = window.__stores.packs;
		await p.loadPacks();
		let list;
		p.packs.subscribe((x) => (list = x))();
		const mock = list.find((x) => x.name === 'mockpack');
		const remote = list.find((x) => x.name === 'mock-remote');
		const remoteItems = remote ? await p.loadPackItems(remote) : [];
		const cands = mock ? p.thumbCandidates(mock, { name: 'Cat', screenshot: 'screenshot/screenshot.png' }) : [];
		return {
			names: list.map((x) => x.name),
			listUrl: mock?.listUrl,
			attributionUrl: mock?.attributionUrl,
			sourceUrl: mock?.sourceUrl,
			license: remote?.license,
			remoteGlb: remoteItems[0]?.glbUrl,
			remoteThumbs: remoteItems[0]?.thumbs,
			cands
		};
	});
	h.check(
		defaults.names.includes('mockpack') && defaults.names.includes('mock-remote'),
		`default packs load from the CDN index (${defaults.names.join(',')})`
	);
	h.check(
		/^https:\/\/cdn\.jsdelivr\.net\/.*\/mockpack\/default\.json$/.test(defaults.listUrl || '') &&
			/^https:\/\/cdn\.jsdelivr\.net\/.*\/mockpack\/attribution\.html$/.test(defaults.attributionUrl || ''),
		'index-relative listUrl/attributionUrl are prefixed with PACKS_BASE'
	);
	h.check(defaults.sourceUrl === 'https://github.com/theprototype-app/packs', 'the Source url survives normalization');
	h.check(
		defaults.remoteGlb === 'https://upstream.example/Models/Duck/glTF-Binary/Duck.glb' &&
			defaults.remoteThumbs?.length === 1 &&
			defaults.remoteThumbs[0].startsWith('https://upstream.example/'),
		'absolute item URLs (khronos upstream) pass through untouched'
	);
	h.check(
		defaults.cands[0]?.endsWith('screenshot/screenshot.png') && defaults.cands[1]?.endsWith('thumb.webp'),
		'relative thumbnails lead with the committed screenshot (no 404 probing)'
	);
	h.check(defaults.license === 'CC-BY-4.0', `default pack keeps its license (${defaults.license})`);

	// Source button renders in the pack Properties panel
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	await A.page.locator('#packs-folder').dblclick();
	await A.page.waitForTimeout(400);
	await A.page.locator('#explorer-list [data-pack="mockpack"]').click();
	await A.page.waitForTimeout(600);
	await A.page.locator('#bottom-dock [data-ws-mode="props"], [data-ws-mode="props"]').first().click();
	await A.page.waitForTimeout(300);
	const srcBtn = A.page.locator('#pack-source');
	h.check(
		(await srcBtn.count()) === 1 && (await srcBtn.getAttribute('href')) === 'https://github.com/theprototype-app/packs',
		'pack Properties shows the Source button with the repo link'
	);
	h.check((await srcBtn.innerText()).includes('theprototype-app/packs'), 'Source button is labelled with the repo slug');

	// offline fallback: CDN unreachable -> the bundled starter list loads
	await A.page.unroute('**/cdn.jsdelivr.net/**');
	await A.page.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
	const fallback = await A.page.evaluate(async () => {
		const p = window.__stores.packs;
		await p.loadPacks();
		let list;
		p.packs.subscribe((x) => (list = x))();
		const starter = list.find((x) => x.name === 'default');
		return { names: list.map((x) => x.name), base: starter?.base, listUrl: starter?.listUrl };
	});
	h.check(
		fallback.names.includes('default') && fallback.base === '/library/default' && fallback.listUrl === '/library/default/default.json',
		`CDN down -> bundled starter fallback (${fallback.names.join(',')})`
	);
	await A.page.unroute('**/cdn.jsdelivr.net/**');

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
