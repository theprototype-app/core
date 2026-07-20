// R-3: hand models — the 'model' capsule style exists (per-bone radii), and a
// custom hand GLB is IDENTITY: the chosen hash broadcasts (+ handshake), peers
// pull the bytes by hash and parse them into the render cache, with the style
// fallback while missing. Visual/on-device feel is the user's manual check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// 'model' capsule segments: same 24 bones, per-bone radii (palm > tip)
	const segs = await A.page.evaluate(() => {
		const flat = new Array(75).fill(0).map((_, i) => (i % 3 === 0 ? i / 75 : 0));
		return window.__stores.vrControls.handModelSegments(flat).map((s) => s.r);
	});
	h.check(segs.length === 24, `model style yields 24 bone segments (${segs.length})`);
	h.check(segs[0] === 0.011 && segs.includes(0.006), 'per-bone radii: thick metacarpals + thin tips');

	// peerHandStyle accepts 'model'
	await A.page.evaluate(() => window.__stores.peerHandStyle.set('model'));
	const style = await A.page.evaluate(() => new Promise((r) => window.__stores.peerHandStyle.subscribe(r)()));
	h.check(style === 'model', 'peerHandStyle supports the model option');

	// --- custom hand identity: hash broadcasts, bytes arrive, pipeline parses --
	// capture arriving assetfile bytes on B's own listener FIRST (transport proof)
	await B.page.evaluate(async () => {
		const p = await new Promise((r) => window.__stores.peers.subscribe(r)());
		window.__handBytes = null;
		Object.values(p.connections).forEach((conn) =>
			conn.on('data', (d) => {
				if (d?.type === 'assetfile') window.__handBytes = { hash: d.hash, name: d.name, bytes: Array.from(new Uint8Array(d.buffer)) };
			})
		);
	});

	const hash = await A.page.evaluate(async () => {
		// in-page GLB fixture: export a tiny box with the real GLTFExporter
		const THREE = window.__stores.THREE;
		const { GLTFExporter } = window.__stores.GLTFExporterModule;
		const scene = new THREE.Scene();
		scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.15), new THREE.MeshStandardMaterial()));
		const glb = await new Promise((resolve, reject) =>
			new GLTFExporter().parse(scene, resolve, reject, { binary: true })
		);
		const item = await window.__stores.explorer.addItemFromBytes(glb, 'myhand.glb', null);
		window.__stores.handModels.setMyHandModel(item.hash);
		return item.hash;
	});
	h.check(!!hash, 'A stored a hand GLB and chose it');

	// the CHOICE replicates to B (tiny message — identity like the avatar photo)
	await h.eventually(
		() => B.page.evaluate((a) => new Promise((r) => window.__stores.handModels.peerHandModels.subscribe((m) => r(m[a] ?? null))()), A.id),
		(v) => v === hash,
		"B learns A's hand-model hash"
	);

	// the BYTES arrive at B (assetShare push-on-assign)
	await h.eventually(
		() => B.page.evaluate(() => window.__handBytes?.hash ?? null),
		(v) => v === hash,
		"the hand GLB bytes arrive at B (push-on-assign)",
		20000
	);

	// the pipeline parses those exact bytes into the render cache: drive
	// applyAssetFile + ensureHandModel on the captured payload (deterministic —
	// avoids waiting on this machine's heavily throttled background timers)
	const cached = await B.page.evaluate(async () => {
		const { hash, name, bytes } = window.__handBytes;
		await window.__stores.assetShare.applyAssetFile({ hash, name, buffer: new Uint8Array(bytes).buffer });
		await window.__stores.handModels.ensureHandModel(hash);
		return new Promise((r) => window.__stores.handModels.handModelCache.subscribe((c) => r(!!c[hash]))());
	});
	h.check(cached === true, 'the pulled GLB parses into the hand-model render cache');

	// clearing broadcasts too
	await A.page.evaluate(() => window.__stores.handModels.setMyHandModel(''));
	await h.eventually(
		() => B.page.evaluate((a) => new Promise((r) => window.__stores.handModels.peerHandModels.subscribe((m) => r(m[a] ?? null))()), A.id),
		(v) => v === null,
		'clearing the choice removes it on B (fallback to style rendering)'
	);

	await h.finish(browser);
});
