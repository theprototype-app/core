// Texture tools: size readout, resize, and the UV test grid.
//
// The grid is the interesting one. It is driven through `scene.overrideMaterial`,
// following viewMode's wireframe precedent, because a per-material `map` swap would
// LEAK: the object sync and autosave both serialize `material.map`, so a peer joining
// (or an autosave taken) while the grid was on would bake the grid into the scene,
// while `userData.mapDataUrl` still claimed the real texture — a silent, confusing
// corruption of someone's asset. The trade is that the grid is scene-wide.
const h = require('./helpers.cjs');

const texturedBox = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'texBox';
		// a 256x128 canvas texture: NON-square, so a resize that ignores aspect shows
		const c = document.createElement('canvas');
		c.width = 256;
		c.height = 128;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#2288ff';
		ctx.fillRect(0, 0, 256, 128);
		ctx.fillStyle = '#ffaa00';
		ctx.fillRect(0, 0, 128, 64);
		const url = c.toDataURL('image/png');
		w.materialsHandler.applyMap(box, url, 0);
		w.objectActions.selectObject(box.uuid);
		w.uvEditorClose.set(false);
		w.bottomDock.activateDock('uv');
		return box.uuid;
	});

const texState = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.getObjectByProperty('uuid', uuid);
		const info = w.uvEditor.textureInfo(o, 0);
		return {
			info,
			readout: document.getElementById('uv-tex-size')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
			hasUrl: !!o.material.userData?.mapDataUrl
		};
	}, uuid);

const undoDepth = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const uuid = await texturedBox(A.page);
	await A.page.waitForTimeout(900);
	// open the Settings panel where the texture tools live
	await A.page.evaluate(async () => {
		document.querySelector('[data-ws-mode="settings"]')?.click();
		await new Promise((r) => setTimeout(r, 300));
	});

	// ---------- size readout ----------
	const start = await texState(A.page, uuid);
	h.check(
		start.info?.w === 256 && start.info?.h === 128,
		`premise: a 256x128 texture (${start.info?.w}x${start.info?.h})`
	);
	h.check(
		(start.readout ?? '').includes('256') && (start.readout ?? '').includes('128'),
		`THE FEATURE: the panel shows the texture's real size (${start.readout})`
	);
	h.check((start.readout ?? '').includes('MB'), '...and an estimated GPU cost');

	// ---------- resize keeps the aspect, replicates, undoes ----------
	const depth0 = await undoDepth(A.page);
	await A.page.evaluate(async () => {
		document.getElementById('uv-tex-half').click();
		await new Promise((r) => setTimeout(r, 900));
	});
	const halved = await texState(A.page, uuid);
	h.check(
		halved.info?.w === 128 && halved.info?.h === 64,
		`THE FEATURE: Half halves BOTH sides, keeping 2:1 (${halved.info?.w}x${halved.info?.h})`
	);
	const depth1 = await undoDepth(A.page);
	h.check(depth1 === depth0 + 1, `a resize records ONE undo entry (${depth0}->${depth1})`);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(800);
	const restored = await texState(A.page, uuid);
	h.check(
		restored.info?.w === 256 && restored.info?.h === 128,
		`undo restores the original size (${restored.info?.w}x${restored.info?.h})`
	);

	await A.page.evaluate(async () => {
		document.getElementById('uv-tex-512').click();
		await new Promise((r) => setTimeout(r, 900));
	});
	const upsized = await texState(A.page, uuid);
	h.check(
		upsized.info?.w === 512 && upsized.info?.h === 256,
		`resizing to 512 scales the LONGEST side and carries the other (${upsized.info?.w}x${upsized.info?.h})`
	);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(700);

	// ---------- the UV test grid ----------
	const gridOn = await A.page.evaluate(async () => {
		const w = window.__stores;
		document.getElementById('uv-checker').click();
		await new Promise((r) => setTimeout(r, 400));
		const scene = await new Promise((r) => w.globalScene.subscribe(r)());
		return {
			pressed: document.getElementById('uv-checker')?.getAttribute('aria-pressed'),
			override: !!scene.overrideMaterial,
			hasMap: !!scene.overrideMaterial?.map,
			repeatWrap:
				scene.overrideMaterial?.map?.wrapS === w.THREE.RepeatWrapping &&
				scene.overrideMaterial?.map?.wrapT === w.THREE.RepeatWrapping
		};
	});
	h.check(gridOn.pressed === 'true', 'the grid toggle reports pressed');
	h.check(
		gridOn.override && gridOn.hasMap,
		'THE FEATURE: the grid is a scene.overrideMaterial, the viewMode precedent'
	);
	h.check(
		gridOn.repeatWrap,
		'...with RepeatWrapping, so UVs outside 0..1 TILE instead of smearing (CanvasTexture defaults to clamp)'
	);

	// THE LEAK CHECK: with the grid on, what a save or a peer would receive must
	// still be the REAL texture, never the grid.
	const leak = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.getObjectByProperty('uuid', uuid);
		const json = o.toJSON();
		const images = json.images ?? [];
		return {
			materialMapUntouched: !!o.material.userData?.mapDataUrl,
			// the serialized form must carry an image (the real texture), and the
			// override never appears in it because it is not on any material
			serializedImages: images.length,
			manifest: await new Promise((r) =>
				w.sceneAssets.sceneAssets.subscribe((list) => r(list.filter((a) => a.group === 'textures').length))()
			)
		};
	}, uuid);
	h.check(
		leak.materialMapUntouched,
		'THE LEAK CHECK: the grid never touches userData.mapDataUrl'
	);
	h.check(
		leak.serializedImages > 0,
		`...and toJSON (what the wire + autosave use) still carries the real texture (${leak.serializedImages} image(s))`
	);
	h.check(leak.manifest > 0, `...and the scene-asset manifest still lists it (${leak.manifest})`);

	// closing the editor must not leave the whole scene wearing the grid
	const cleared = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.uvEditorClose.set(true);
		await new Promise((r) => setTimeout(r, 500));
		const scene = await new Promise((r) => w.globalScene.subscribe(r)());
		let on;
		w.uvEditor.uvCheckerOn.subscribe((v) => (on = v))();
		return { override: !!scene.overrideMaterial, on };
	});
	h.check(
		!cleared.override && cleared.on === false,
		'closing the editor turns the scene-wide grid OFF (it is not the editor that renders it)'
	);

	await h.finish(browser);
});
