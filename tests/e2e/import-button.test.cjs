// Release 1.0: the Sidebar Import button. Regression for the Svelte 5 delegation
// bug — the old {#key rerenderInput} recreate detached the <input> while the native
// picker was open, so the delegated oninput never fired and Import silently did
// nothing. Also covers the Load accept-list tidy (.scene/.gltf dropped) and the
// re-pick-same-file intent (value cleared before every open).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// open the logo/burger menu -> sidebar with the file rows
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForSelector('#sidebar70');

	const accepts = await A.page.evaluate(() => ({
		imp: document.getElementById('import-file')?.getAttribute('accept') || '',
		load: document.getElementById('load-file')?.getAttribute('accept') || ''
	}));
	h.check(accepts.imp.includes('.glb') && accepts.imp.includes('.fbx'), 'Import accepts model formats');
	h.check(
		accepts.load.includes('.tpscene') && !accepts.load.includes('.scene,') && !accepts.load.includes('.gltf'),
		'Load accept list tidied (.json/.tpscene only)'
	);

	// a tiny real GLB, exported in-page
	const glbArr = await A.page.evaluate(async () => {
		const s = window.__stores;
		const mesh = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial());
		const glb = await new Promise((res, rej) =>
			new s.GLTFExporterModule.GLTFExporter().parse(mesh, (r) => res(r), (e) => rej(e), { binary: true })
		);
		return Array.from(new Uint8Array(glb));
	});
	const file = { name: 'import-check.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(glbArr) };

	const countObjects = () =>
		A.page.evaluate(
			() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.children?.length ?? 0))())
		);
	const before = await countObjects();

	// drive the REAL button (this is the path the {#key} recreate used to break)
	const importRow = A.page.locator('#sidebar70 .side-row', { hasText: 'Import' }).first();
	const [chooser] = await Promise.all([A.page.waitForEvent('filechooser'), importRow.click()]);
	await chooser.setFiles(file);
	await h.eventually(countObjects, (n) => n === before + 1, 'Import button adds the picked object');

	// picking the SAME file again must still fire (value is cleared before .click())
	const [chooser2] = await Promise.all([A.page.waitForEvent('filechooser'), importRow.click()]);
	await chooser2.setFiles(file);
	await h.eventually(countObjects, (n) => n === before + 2, 're-picking the same file imports again');

	await h.finish(browser);
});
