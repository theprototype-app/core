// 46 P3 — EXPORT PRESETS ("Full quality" / "For Quest / web") for GLTF and .tpscene
// (fileHandler.exportGltfQuest, sessions.exportSessionZip `preset`, sceneOptimize.js), the last
// choice remembered on this device (saveOptions.exportPreset), and the Quest/web files LOADING
// BACK (the KTX2 transcoder, meshopt, the twins).
//   1 Save options: the "Optimize for" row; a choice is stored LOCAL and the Publish / Export
//     settings show the same choice (the deferred "Compress textures" row became it)
//   2 GLTF: Full quality = today's .gltf; For Quest / web = a .glb with KTX2 only, meshopt,
//     MSFT_lod — smaller — and it imports back with its twins on the GPU
//   3 .tpscene: For Quest / web resizes the 4096 px texture to 2048, writes a KTX2 sidecar per
//     texture and an LOD group on the heavy object; it is smaller than Full quality; loading it
//     back gives each texture its twin and the object its LOD chain
// Run: APP_URL=https://localhost:5461/ npm run e2e -- export-presets
const h = require('./helpers.cjs');
const fs = require('fs');
const { buildHeavyImport, esm } = require('./gltfOptimizeFixture.cjs');

h.run(async () => {
	const heavy = await buildHeavyImport();
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 }, acceptDownloads: true } });
	const page = A.page;
	const { unzipSync, strFromU8 } = require('fflate');
	const glbPost = await esm('src/lib/gltfOptimize/glbPost.js');
	const evidence = process.env.EVIDENCE_DIR || '/tmp';
	/** run `fn` in the page and capture the download it triggers */
	page.on('console', (m) => {
		if (m.type() === 'error') console.log('[page error] ' + m.text().slice(0, 400));
	});
	async function download(fn, arg) {
		const waiting = page.waitForEvent('download', { timeout: 180000 }).catch(async (error) => {
			const why = await page.evaluate(() => {
				let t;
				window.__tp.test.v1.toastStore.subscribe((x) => (t = x))();
				return t.map((x) => (typeof x === 'string' ? x : x.text));
			});
			console.log('download never came; toasts: ' + JSON.stringify(why));
			throw error;
		});
		const [dl] = await Promise.all([waiting, page.evaluate(fn, arg)]);
		const file = await dl.path();
		return { name: dl.suggestedFilename(), bytes: fs.readFileSync(file) };
	}

	// ---- 1 the choice --------------------------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.saveOptions.saveOptionsOpen.set(true));
	await h.eventually(() => page.locator('#save-options-modal #export-preset-quest').count(), (n) => n > 0, '1.1 Save options shows "Optimize for"', 15000);
	await page.locator('#export-preset-quest').click();
	await page.locator('#save-options-cancel').click();
	const cancelled = await page.evaluate(() => localStorage.getItem('exportPreset'));
	h.check(cancelled !== 'quest', '1.2 Cancel forgets the draft (stored: ' + cancelled + ')');
	// the modal's Save would also save a file: remember the choice through the store's own writer
	await page.evaluate(() => window.__tp.test.v1.saveOptions.setSaveOptions({ exportPreset: 'quest', showGltf: true }));
	h.check((await page.evaluate(() => localStorage.getItem('exportPreset'))) === 'quest', '1.3 the choice is stored on this device (exportPreset = quest)');
	await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.settingsSection.set('export');
		s.settingsOpen.set(true);
	});
	await h.eventually(() => page.locator('#export-optimize-quest').count(), (n) => n > 0, '1.4 Settings ▸ Export has the same "Optimize for" row', 15000);
	h.check((await page.locator('#export-optimize-quest').getAttribute('aria-checked')) === 'true', '1.5 …showing the same choice (For Quest / web)');
	h.check((await page.locator('#export-compress-textures').count()) === 0, '1.6 the deferred "Compress textures (not available yet)" row is gone');
	await page.evaluate(() => window.__tp.test.v1.settingsOpen.set(false));

	// ---- the scene: a heavy model kept heavy (auto-optimize off for this run) -------------------
	await page.evaluate(() => window.__tp.test.v1.importOptimize.setImportSettings({ auto: false }));
	const uuid = await page.evaluate(async (b64) => {
		const raw = atob(b64);
		const bytes = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
		return window.__tp.test.v1.fileHandler.importFile(new File([bytes], 'Heavy.glb'), 'Heavy', 'glb', [0, 1, 0]);
	}, heavy);
	const premise = await page.evaluate((u) => {
		let v;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (v = x))();
		const root = v.getObjectByProperty('uuid', u);
		let w = 0;
		root.traverse((o) => o.isMesh && (w = o.material.map?.image?.width ?? 0));
		return { w, lod: !!root.userData.lod };
	}, uuid);
	h.check(premise.w === 4096 && !premise.lod, '0.1 (premise) the scene holds the heavy model as it came (4096 px, no LOD group)');
	await page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), uuid);

	// ---- 2 GLTF ----------------------------------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.saveOptions.setSaveOptions({ exportPreset: 'full' }));
	const full = await download(() => window.__tp.test.v1.fileHandler.save('gltf'));
	h.check(/\.gltf$/.test(full.name), '2.1 Full quality writes today\'s .gltf (' + full.name + ', ' + full.bytes.length + ' B)');
	await page.evaluate(() => window.__tp.test.v1.saveOptions.setSaveOptions({ exportPreset: 'quest' }));
	const quest = await download(() => window.__tp.test.v1.fileHandler.save('gltf'));
	h.check(/-quest\.glb$/.test(quest.name), '2.2 For Quest / web writes a .glb (' + quest.name + ')');
	// the report is set right after the download starts: wait for it
	const readReport = (kind) =>
		page.evaluate((k) => {
			let v;
			window.__tp.test.v1.fileHandler.lastExportReport.subscribe((x) => (v = x))();
			return v?.kind === k ? v : null;
		}, kind);
	await h.eventually(() => readReport('gltf'), (v) => !!v, '2.2b the GLTF export reported its numbers', 30000);
	const rep = await readReport('gltf');
	h.check(quest.bytes.length < rep.report.bytesBefore / 2 && quest.bytes.length < full.bytes.length / 2, '2.3 it is SMALLER: ' + rep.report.bytesBefore + ' B as a plain GLB, ' + full.bytes.length + ' B as .gltf, ' + quest.bytes.length + ' B for Quest / web');
	const q = glbPost.unpackGlb(new Uint8Array(quest.bytes));
	h.check(['KHR_texture_basisu', 'EXT_meshopt_compression'].every((e) => (q.json.extensionsRequired ?? []).includes(e)) && (q.json.extensionsUsed ?? []).includes('MSFT_lod'), '2.4 KTX2 + meshopt required, MSFT_lod used: ' + JSON.stringify(q.json.extensionsUsed));
	h.check(q.json.images.every((i) => i.mimeType === 'image/ktx2'), '2.5 every image is KTX2');
	fs.writeFileSync(evidence + '/export-gltf-report.json', JSON.stringify({ full: full.bytes.length, quest: quest.bytes.length, report: rep.report }, null, 2));
	const back = await page.evaluate(async (arr) => {
		const s = window.__tp?.test.v1;
		const u = await s.fileHandler.importFile(new File([new Uint8Array(arr)], 'Back.glb'), 'Back', 'glb', [4, 1, 0]);
		let v;
		s.objectsGroup.subscribe((x) => (v = x))();
		const root = v.getObjectByProperty('uuid', u);
		let tris = 0;
		const maps = [];
		root.traverse((o) => {
			if (!o.isMesh) return;
			tris += o.geometry.index.count / 3;
			if (o.material.map) maps.push(o.material.map);
		});
		const r = (st) => {
			let x;
			st.subscribe((y) => (x = y))();
			return x;
		};
		const end = performance.now() + 20000;
		while (performance.now() < end && !maps.every((m) => s.ktx2Twins.twinState(m)?.ready)) await new Promise((res) => setTimeout(res, 200));
		r(s.globalRenderer).render(r(s.globalScene), r(s.globalCamera));
		return { tris, maps: maps.map((m) => ({ w: m.image.width, ...s.ktx2Twins.twinState(m) })), uuid: u };
	}, Array.from(quest.bytes));
	h.check(back.tris === 65024 && back.maps.length === 1 && back.maps[0].w === 2048 && back.maps[0].ready && back.maps[0].uploadedCompressed, '2.6 the Quest/web .glb LOADS BACK: meshopt decoded (65024 tris), the KTX2 texture transcoded and on the GPU compressed: ' + JSON.stringify(back.maps));
	await page.evaluate((u) => window.__tp.test.v1.objectActions.deleteObjectsByUuid([u]), back.uuid);

	// ---- 3 .tpscene --------------------------------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.saveOptions.setSaveOptions({ exportPreset: 'full' }));
	const sceneFull = await download(() => window.__tp.test.v1.fileHandler.save('tpscene'));
	await page.evaluate(() => window.__tp.test.v1.saveOptions.setSaveOptions({ exportPreset: 'quest' }));
	const sceneQuest = await download(() => window.__tp.test.v1.fileHandler.save('tpscene'));
	h.check(/-quest\.tpscene$/.test(sceneQuest.name) && sceneQuest.bytes.length < sceneFull.bytes.length, '3.1 the Quest/web .tpscene is smaller: ' + sceneFull.bytes.length + ' -> ' + sceneQuest.bytes.length + ' B (' + sceneQuest.name + ')');
	const zip = unzipSync(new Uint8Array(sceneQuest.bytes));
	const session = JSON.parse(strFromU8(zip['session.json']));
	const sidecars = Object.keys(zip).filter((k) => k.startsWith('ktx2/'));
	h.check(session.ktx2 && Object.keys(session.ktx2).length >= 1 && sidecars.length >= 1 && Object.values(session.ktx2).every((f) => zip[f]), '3.2 a KTX2 sidecar per texture, indexed by texture uuid: ' + JSON.stringify(session.ktx2));
	const el = session.objects.find((o) => o.object?.uuid === uuid);
	h.check(!!el?.object?.userData?.lod && el.object.userData.lod.levels.length === 4, '3.3 the heavy object carries an LOD group in the file');
	const imgUrl = el.images?.[0]?.url ?? '';
	const sizeOf = await page.evaluate(
		(url) =>
			new Promise((res) => {
				const i = new Image();
				i.onload = () => res([i.width, i.height]);
				i.src = url;
			}),
		imgUrl
	);
	h.check(sizeOf[0] === 2048, '3.4 the picture in session.json is resized to 2048 px (' + sizeOf.join('x') + ')');
	const sRep = await readReport('tpscene');
	fs.writeFileSync(evidence + '/export-tpscene-report.json', JSON.stringify({ full: sceneFull.bytes.length, quest: sceneQuest.bytes.length, report: sRep.report }, null, 2));
	// load it back
	const loaded = await page.evaluate(async (arr) => {
		const s = window.__tp?.test.v1;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false, replicate: false });
		let v;
		s.objectsGroup.subscribe((x) => (v = x))();
		const maps = [];
		let lod = null;
		v.traverse((o) => {
			if (o.userData?.lod && !lod) lod = o.userData.lod.levels.length;
			if (o.isMesh && o.material?.map) maps.push(o.material.map);
		});
		const end = performance.now() + 20000;
		while (performance.now() < end && !maps.every((m) => s.ktx2Twins.twinState(m)?.ready)) await new Promise((res) => setTimeout(res, 200));
		const r = (st) => {
			let x;
			st.subscribe((y) => (x = y))();
			return x;
		};
		r(s.globalRenderer).render(r(s.globalScene), r(s.globalCamera));
		return { lod, maps: maps.map((m) => ({ w: m.image.width, ...s.ktx2Twins.twinState(m) })) };
	}, Array.from(sceneQuest.bytes));
	h.check(loaded.lod === 4 && loaded.maps.length >= 1 && loaded.maps.every((m) => m.w === 2048 && m.ready && m.uploadedCompressed), '3.5 the Quest/web .tpscene LOADS BACK: the LOD chain, and each texture\'s KTX2 twin on the GPU: ' + JSON.stringify(loaded));
	await h.finish(browser);
});
