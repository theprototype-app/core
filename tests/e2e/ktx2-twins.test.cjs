// 46 P1 — KTX2 TWINS (src/lib/ktx2Twins.js): a KTX2 texture in the scene is an ORDINARY texture
// (every serializer keeps working) whose compressed twin is what the GPU holds.
//   1 import a GLB whose textures carry KHR_texture_basisu + a plain fallback (what the
//     optimizer writes for an import): no CompressedTexture in any material, each texture has a
//     twin, the twin transcodes, and after a render the GL texture three holds is the compressed
//     one (its upload cache key) — and the picture is the same picture
//   2 the serializers: toJSON writes a real image; gltfBytesFor writes BOTH sources; a texture
//     edit (needsUpdate) drops the twin and the plain picture goes back up
//   3 a KTX2-ONLY file (the "For Quest / web" export, meshopt + MSFT_lod) loads back: the
//     transcoder runs, every compressed texture becomes an ordinary one + its twin, the meshopt
//     geometry decodes, and the LOD levels stay out of the tree
//   4 two peers: the wire carries the twin (the receiver re-forms it from the fallback file)
// Run: APP_URL=https://localhost:5461/ PEER_CONFIG='{...}' npm run e2e -- ktx2-twins
const h = require('./helpers.cjs');
const { buildOptimizeFixtures, esm } = require('./gltfOptimizeFixture.cjs');

h.run(async () => {
	const fixtures = await buildOptimizeFixtures();
	h.check(fixtures.reports.twin.textures.every((t) => t.after.ktx2Bytes > 0), '0.1 (premise) the import fixture carries a KTX2 twin per texture: ' + fixtures.reports.twin.textures.map((t) => t.slots.join('/') + ' ' + t.after.ktx2Bytes + ' B').join(', '));
	h.check(fixtures.quest.length < fixtures.plain.length, '0.2 (premise) the Quest/web fixture is smaller: ' + fixtures.plain.length + ' -> ' + fixtures.quest.length + ' B');

	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	await page.evaluate(() => {
		window.__k2 = {
			read: (store) => {
				let v;
				store.subscribe((x) => (v = x))();
				return v;
			},
			async place(arr, name, at) {
				const s = window.__tp?.test.v1;
				const file = new File([new Uint8Array(arr)], name + '.glb');
				return s.fileHandler.importFile(file, name, 'glb', at);
			},
			root(uuid) {
				return window.__k2.read(window.__tp.test.v1.objectsGroup).getObjectByProperty('uuid', uuid);
			},
			textures(uuid) {
				const out = [];
				window.__k2.root(uuid)?.traverse((o) => {
					if (!o.isMesh) return;
					for (const m of [o.material].flat()) for (const slot of ['map', 'normalMap']) if (m[slot]) out.push({ slot, t: m[slot] });
				});
				return out;
			},
			render(n = 3) {
				const r = window.__k2.read(window.__tp.test.v1.globalRenderer);
				const scene = window.__k2.read(window.__tp.test.v1.globalScene);
				const cam = window.__k2.read(window.__tp.test.v1.globalCamera);
				for (let i = 0; i < n; i++) r.render(scene, cam);
			}
		};
	});

	// ---- 1 the fallback file -------------------------------------------------------------------
	const uuid = await page.evaluate((arr) => window.__k2.place(arr, 'TwinBall', [0, 1, 0]), fixtures.twin);
	h.check(typeof uuid === 'string', '1.1 the GLB imported (' + uuid + ')');
	const first = await page.evaluate((uuid) => window.__k2.textures(uuid).map(({ slot, t }) => ({ slot, compressed: !!t.isCompressedTexture, image: t.image?.constructor?.name, w: t.image?.width, twin: !!window.__tp.test.v1.ktx2Twins.twinOf(t) })), uuid);
	h.check(first.length === 2 && first.every((t) => !t.compressed && t.w === 512), '1.2 no CompressedTexture in the scene: ' + JSON.stringify(first));
	h.check(first.every((t) => t.twin), '1.3 every texture has a KTX2 twin');
	await h.eventually(
		() => page.evaluate((uuid) => window.__k2.textures(uuid).map(({ t }) => window.__tp.test.v1.ktx2Twins.twinState(t)), uuid),
		(s) => s.every((x) => x?.ready),
		'1.4 the twins transcoded on the live renderer',
		20000
	);
	await page.evaluate(() => window.__tp.test.v1.objectActions.flyTo([0, 1.2, 3.2], [0, 1, 0], 200));
	await page.waitForTimeout(600);
	await page.evaluate(() => window.__k2.render(3));
	const states = await page.evaluate((uuid) => window.__k2.textures(uuid).map(({ slot, t }) => ({ slot, ...window.__tp.test.v1.ktx2Twins.twinState(t), plainGpu: t.image.width * t.image.height * 4 * 4 / 3 })), uuid);
	h.check(states.every((s) => s.uploadedCompressed), '1.5 THE PROPERTY: the GL texture three holds for each is the COMPRESSED one: ' + JSON.stringify(states.map((s) => ({ slot: s.slot, format: s.format, mips: s.mips, up: s.uploadedCompressed }))));
	h.check(states.every((s) => s.gpuBytes < s.plainGpu / 3), '1.6 GPU bytes per texture: ' + states.map((s) => s.slot + ' ' + s.gpuBytes + ' vs ' + Math.round(s.plainGpu) + ' as RGBA8').join(', '));
	const after = await page.evaluate((uuid) => window.__k2.textures(uuid).map(({ t }) => ({ compressed: !!t.isCompressedTexture, format: t.format, mips: t.mipmaps?.length ?? 0 })), uuid);
	h.check(after.every((t) => !t.compressed && t.format === 1023 && t.mips === 0), '1.7 outside the render the texture is plain again (RGBA, no mipmaps array): ' + JSON.stringify(after));
	const clip = await h.centeredClip(A, [0, 1, 0], 300);
	const twinShot = await h.grabFrame(A, clip);

	// ---- 2 the serializers ---------------------------------------------------------------------
	const json = await page.evaluate((uuid) => {
		const root = window.__k2.root(uuid);
		const j = root.toJSON();
		return { images: (j.images ?? []).map((i) => String(i.url ?? '').slice(0, 22)), n: (j.images ?? []).length };
	}, uuid);
	h.check(json.n >= 1 && json.images.every((u) => u.startsWith('data:image/')), '2.1 toJSON (undo, sessions, .tpscene) writes a real picture: ' + JSON.stringify(json.images));
	const glb = await page.evaluate(async (uuid) => {
		const bytes = await window.__tp.test.v1.fileHandler.gltfBytesFor(window.__k2.root(uuid), { binary: true });
		return Array.from(new Uint8Array(bytes));
	}, uuid);
	const glbPost = await esm('src/lib/gltfOptimize/glbPost.js');
	const written = glbPost.unpackGlb(new Uint8Array(glb));
	const twinsOut = glbPost.ktx2Textures(written.json, written.bin);
	h.check(twinsOut.size >= 2 && [...twinsOut.values()].every((t) => t.fallback), '2.2 gltfBytesFor writes BOTH sources per texture (KHR_texture_basisu + fallback): ' + twinsOut.size);
	h.check(!(written.json.extensionsRequired ?? []).includes('KHR_texture_basisu'), '2.3 …as USED, never REQUIRED (a plain viewer reads the fallback)');
	// the twin's picture vs the plain picture: same image, block-compressed
	const dropped = await page.evaluate((uuid) => {
		const k = window.__tp.test.v1.ktx2Twins;
		const before = k.twinStats().dropped;
		for (const { t } of window.__k2.textures(uuid)) t.needsUpdate = true;
		window.__k2.render(2);
		return { dropped: k.twinStats().dropped - before, still: window.__k2.textures(uuid).filter(({ t }) => k.twinOf(t)).length };
	}, uuid);
	h.check(dropped.dropped === 2 && dropped.still === 0, '2.4 a texture edit (needsUpdate) drops the twin — the edited picture goes up: ' + JSON.stringify(dropped));
	const plainShot = await h.grabFrame(A, clip);
	const diff = await h.frameDelta(page, twinShot, plainShot, 40);
	h.check(!diff.error && diff.changed < (clip.width * clip.height) * 0.05, '2.5 the compressed twin draws the same picture as the plain texture (pixels off by >40: ' + diff.changed + ' of ' + clip.width * clip.height + ')');
	await page.evaluate((uuid) => window.__tp.test.v1.objectActions.deleteObjectsByUuid([uuid]), uuid);

	// ---- 3 a KTX2-only file loads back ------------------------------------------------------------
	const qid = await page.evaluate((arr) => window.__k2.place(arr, 'QuestBall', [0, 1, 0]), fixtures.quest);
	h.check(typeof qid === 'string', '3.1 the Quest/web file (KTX2 only, meshopt, MSFT_lod) imported');
	const q = await page.evaluate((uuid) => {
		const k = window.__tp.test.v1.ktx2Twins;
		let tris = 0;
		let meshes = 0;
		window.__k2.root(uuid).traverse((o) => {
			if (!o.isMesh) return;
			meshes++;
			tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
		});
		return {
			meshes,
			tris,
			tex: window.__k2.textures(uuid).map(({ slot, t }) => ({ slot, compressed: !!t.isCompressedTexture, canvas: t.image?.constructor?.name, w: t.image?.width, twin: !!k.twinOf(t) })),
			decompressed: k.twinStats().decompressed
		};
	}, qid);
	h.check(q.tex.length === 2 && q.tex.every((t) => !t.compressed && t.w === 512 && t.twin), '3.2 every KTX2 texture became an ordinary texture with its twin: ' + JSON.stringify(q.tex));
	h.check(q.meshes === 1 && q.tris === fixtures.reports.quest.trianglesBefore, '3.3 the meshopt geometry decoded, and only LOD0 is in the tree (' + q.meshes + ' mesh, ' + q.tris + ' tris)');
	await page.evaluate(() => window.__k2.render(3));
	await h.eventually(
		() => page.evaluate((uuid) => window.__k2.textures(uuid).map(({ t }) => window.__tp.test.v1.ktx2Twins.twinState(t)), qid),
		(s) => s.every((x) => x?.ready),
		'3.4 the Quest file\'s twins are ready (the transcoder ran once per texture)',
		20000
	);
	await page.evaluate(() => window.__k2.render(2));
	const qStates = await page.evaluate((uuid) => window.__k2.textures(uuid).map(({ t }) => window.__tp.test.v1.ktx2Twins.twinState(t).uploadedCompressed), qid);
	h.check(qStates.every(Boolean), '3.5 …and the GPU holds them compressed');

	// ---- 4 two peers: the wire carries the twin ---------------------------------------------------
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);
	await B.page.evaluate(() => {
		window.__k2b = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
	});
	const wid = await page.evaluate((arr) => window.__k2.place(arr, 'WireBall', [3, 1, 0]), fixtures.twin);
	await h.eventually(
		() =>
			B.page.evaluate((uuid) => {
				const s = window.__tp?.test.v1;
				const root = window.__k2b(s.objectsGroup).getObjectByProperty('uuid', uuid);
				const out = [];
				root?.traverse((o) => {
					if (!o.isMesh) return;
					for (const m of [o.material].flat()) for (const slot of ['map', 'normalMap']) if (m[slot]) out.push({ slot, compressed: !!m[slot].isCompressedTexture, twin: !!s.ktx2Twins.twinOf(m[slot]) });
				});
				return out;
			}, wid),
		(t) => t.length === 2 && t.every((x) => x.twin && !x.compressed),
		'4.1 the peer received the object WITH its twins (KHR_texture_basisu + fallback on the wire)',
		30000
	);
	await h.finish(browser);
});
