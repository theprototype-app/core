// Roadmap #7 N4: Explorer 3D model preview. A global toggle (off by default) gates
// a rotatable preview; opening an object item pops a ModelPreviewWindow with a
// live canvas + poly stats (tris/verts/meshes) top-right. Drag-to-rotate feel is
// manual; this asserts the toggle, the window, the loaded stats, and Esc-close.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const t0 = await A.page.evaluate(() => {
		let v;
		window.__stores.enable3dPreview.subscribe((x) => (v = x))();
		return v;
	});
	h.check(t0 === false, '3D preview defaults off');

	// build a box, export to glb, import it as an Explorer object item
	const item = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.enable3dPreview.set(true);
		const THREE = s.THREE;
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x88aa88 }));
		const exporter = new s.GLTFExporterModule.GLTFExporter();
		const glb = await new Promise((res, rej) => exporter.parse(mesh, (r) => res(r), (e) => rej(e), { binary: true }));
		const it = await s.explorer.addItemFromBytes(glb, 'testbox.glb', null);
		return { id: it.id, kind: it.kind };
	});
	h.check(item.kind === 'object', `imported glb is an object item (${item.kind})`);

	// open the popup -> window mounts, model loads, stats box fills in
	await A.page.evaluate(
		(it) => window.__stores.fileWindows.openModelPreview({ title: 'testbox', itemId: it.id, name: 'testbox.glb' }),
		item
	);
	await A.page.waitForTimeout(1000);
	h.check((await A.page.locator('#model-preview-window').count()) === 1, 'model preview window opens');
	const statsText = await A.page.evaluate(() => document.querySelector('#model-preview-stats')?.textContent || '');
	h.check(/tris/.test(statsText) && /verts/.test(statsText), `stats box shows polys (${statsText.replace(/\s+/g, ' ').trim()})`);
	h.check(/\b12\b/.test(statsText), 'a box reads 12 tris');

	// Esc closes + disposes (window auto-focused on open)
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(250);
	h.check((await A.page.locator('#model-preview-window').count()) === 0, 'Esc closes the preview window');

	const persisted = await A.page.evaluate(() => localStorage.getItem('enable3dPreview'));
	h.check(persisted === 'true', 'the 3D-preview toggle persists (localStorage)');

	await h.finish(browser);
});
