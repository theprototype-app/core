// 46 P2 — IMPORT AUTO-OPTIMIZE (src/lib/importOptimize.js + fileHandler.importFile's hook),
// Settings ▸ Import, the Explorer's per-asset Import settings + Reimport, and the per-scene LOD
// distance in Configure Scene (environment.lodBias, replicated).
//   1 Settings ▸ Import: the section renders under its deep link, a row writes the LOCAL store
//     and survives into localStorage, Reset puts the defaults back
//   2 a >50k-triangle GLB with a 4096 px texture: optimized in the worker — texture 2048 px with
//     a KTX2 twin, an LOD group of generated levels, the original AND the optimized copy in the
//     Library (linked both ways), the report toast with "Keep original only"
//   3 "Keep original only": the placed object is the original again (4096 px, no LOD group, same
//     uuid), the optimized copy leaves the Library, and one undo brings the optimized one back
//   4 per-asset override + Reimport: the panel renders for the original; an override (Always,
//     2 levels, 1024 px) + Reimport swaps the placed copy and replaces the optimized item; Never
//     makes a re-import leave the file as it is; under the thresholds nothing happens
//   5 two peers: the LOD group replicates, levels switch by distance on the RECEIVER, and the
//     scene's LOD distance (Configure Scene) replicates and moves the switch
// Run: APP_URL=https://localhost:5461/ PEER_CONFIG='{...}' npm run e2e -- import-optimize
const h = require('./helpers.cjs');
const { buildHeavyImport, buildOptimizeFixtures } = require('./gltfOptimizeFixture.cjs');

/** page helpers shared by both peers */
function install(page) {
	return page.evaluate(() => {
		const s = window.__tp?.test.v1;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const bytesOf = (b64) => {
			const raw = atob(b64);
			const out = new Uint8Array(raw.length);
			for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
			return out;
		};
		window.__io = {
			read,
			async place(b64, name, at) {
				const file = new File([bytesOf(b64)], name + '.glb');
				return s.fileHandler.importFile(file, name, 'glb', at);
			},
			root: (uuid) => read(s.objectsGroup).getObjectByProperty('uuid', uuid),
			byName: (name) => read(s.objectsGroup).getObjectByName(name),
			facts(uuid) {
				const root = window.__io.root(uuid);
				if (!root) return null;
				const maps = [];
				let tris = 0;
				root.traverse((o) => {
					if (!o.isMesh) return;
					tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
					if (o.material?.map) maps.push({ w: o.material.map.image?.width, twin: !!s.ktx2Twins.twinOf(o.material.map) });
				});
				return {
					uuid: root.uuid,
					tris,
					maps,
					lod: root.userData?.lod ? root.userData.lod.levels.map((l) => l.ratio ?? 1) : null,
					optimized: root.userData?.optimized ? { source: root.userData.optimized.source, item: root.userData.optimized.item } : null
				};
			},
			items: () => read(s.explorer.explorerItems).map((i) => ({ id: i.id, name: i.name, hash: i.hash, optimizedFrom: i.optimizedFrom ?? null, optimizedHash: i.optimizedHash ?? null, importSettings: i.importSettings ?? null })),
			toasts: () => read(s.toastStore).map((t) => (typeof t === 'string' ? { text: t, actions: [] } : { text: t.text ?? '', actions: (t.actions ?? []).map((a) => a.label) })),
			renderFrom(dist, target) {
				const THREE = s.THREE;
				const r = read(s.globalRenderer);
				const scene = read(s.globalScene);
				const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
				cam.position.set(target[0], target[1], target[2] + dist);
				cam.lookAt(...target);
				cam.updateMatrixWorld(true);
				r.render(scene, cam);
				r.render(scene, cam);
			},
			level(uuid) {
				return s.lodGroup.lodGroupStats().find((g) => g.uuid === uuid) ?? null;
			}
		};
	});
}

h.run(async () => {
	const heavy = await buildHeavyImport();
	const light = await buildOptimizeFixtures({ segments: [32, 16], texture: [256, 256], normalMap: false });
	const lightB64 = Buffer.from(Uint8Array.from(light.plain)).toString('base64');
	h.check(heavy.length > 1000, '0.1 (premise) the heavy fixture: ' + Math.round((heavy.length * 3) / 4 / 1024) + ' KB, 65k triangles, a 4096 px texture');

	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	await install(page);

	// ---- 1 Settings ▸ Import ------------------------------------------------------------------
	await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.settingsSection.set('import');
		s.settingsOpen.set(true);
	});
	await h.eventually(() => page.locator('#import-settings-section #import-auto').count(), (n) => n > 0, '1.1 Settings ▸ Import renders under its deep link', 15000);
	const rows = await page.evaluate(() => [...document.querySelectorAll('#import-settings-section .setting-row .sr-name')].map((e) => e.textContent.trim()));
	h.check(rows.includes('Triangle threshold') && rows.includes('Max texture size') && rows.includes('LOD levels') && rows.includes('Compress textures (KTX2)'), '1.2 the rows: ' + rows.join(' | '));
	await page.locator('#import-lod-levels-2').click();
	const after = await page.evaluate(() => ({ store: window.__io.read(window.__tp.test.v1.importOptimize.importSettings), stored: JSON.parse(localStorage.getItem('import:settings') || 'null') }));
	h.check(after.store.lodLevels === 2 && after.store.lodRatios.length === 2 && after.stored?.lodLevels === 2, '1.3 a row writes the LOCAL store and localStorage: ' + JSON.stringify(after.store.lodRatios));
	await page.locator('#import-reset').click();
	const reset = await page.evaluate(() => window.__io.read(window.__tp.test.v1.importOptimize.importSettings));
	h.check(reset.lodLevels === 3 && reset.triangleThreshold === 50000 && reset.textureThreshold === 2048 && reset.maxTextureSize === 2048 && reset.compress, '1.4 Reset puts the defaults back (50k / 2048 / 2048 / 3 levels / KTX2)');
	await page.evaluate(() => window.__tp.test.v1.settingsOpen.set(false));

	// ---- 2 the heavy import ---------------------------------------------------------------------
	const t0 = Date.now();
	const uuid = await page.evaluate((b64) => window.__io.place(b64, 'Heavy', [0, 1, 0]), heavy);
	const ms = Date.now() - t0;
	h.check(typeof uuid === 'string', '2.1 the heavy GLB imported (' + ms + ' ms, worker included)');
	const f = await page.evaluate((u) => window.__io.facts(u), uuid);
	h.check(f.maps.length === 1 && f.maps[0].w === 2048 && f.maps[0].twin, '2.2 its texture was resized to 2048 px and carries a KTX2 twin: ' + JSON.stringify(f.maps));
	h.check(JSON.stringify(f.lod) === JSON.stringify([1, 0.5, 0.25, 0.1]), '2.3 an LOD GROUP of generated levels (the Settings ratios): ' + JSON.stringify(f.lod));
	h.check(f.tris === 65024, '2.4 LOD0 keeps full detail (' + f.tris + ' tris)');
	const lib = await page.evaluate(() => window.__io.items());
	const original = lib.find((i) => i.name === 'Heavy.glb');
	const copy = lib.find((i) => i.optimizedFrom);
	h.check(!!original && !!copy && copy.name === 'Heavy (optimized).glb', '2.5 the Library holds the ORIGINAL and the optimized copy: ' + lib.map((i) => i.name).join(', '));
	h.check(original?.optimizedHash === copy?.hash && copy?.optimizedFrom === original?.hash, '2.6 …linked both ways (original.optimizedHash, copy.optimizedFrom)');
	h.check(f.optimized?.source === original?.hash && f.optimized?.item === copy?.hash, '2.7 the placed root names its original and its optimized copy');
	const report = await page.evaluate(() => window.__io.read(window.__tp.test.v1.importOptimize.lastOptimizedImport));
	h.check(report?.report?.bytesAfter < report?.report?.bytesBefore && report.summary.gpuAfter < report.summary.gpuBefore / 10, '2.8 the report: file ' + report?.report?.bytesBefore + ' -> ' + report?.report?.bytesAfter + ' B, texture memory ' + report?.summary?.gpuBefore + ' -> ' + report?.summary?.gpuAfter + ' B, ' + report?.report?.ms + ' ms in the worker');
	const toasts = await page.evaluate(() => window.__io.toasts());
	const toast = toasts.find((t) => t.text.startsWith('Optimized "Heavy"'));
	h.check(!!toast && toast.actions.includes('Keep original only'), '2.9 the toast: ' + (toast?.text ?? JSON.stringify(toasts)));
	require('fs').writeFileSync(require('path').join(process.env.EVIDENCE_DIR || '/tmp', 'import-optimize-report.json'), JSON.stringify(report, null, 2));

	// ---- 3 Keep original only -------------------------------------------------------------------
	await page.evaluate((u) => window.__tp.test.v1.importOptimize.keepOriginalOnly(u, window.__io.items().find((i) => i.optimizedFrom)?.id), uuid);
	const kept = await page.evaluate((u) => window.__io.facts(u), uuid);
	h.check(kept && kept.maps[0]?.w === 4096 && !kept.maps[0].twin && kept.lod === null && kept.optimized === null, '3.1 Keep original only: the SAME uuid now holds the original (4096 px, no twin, no LOD group, no stamp): ' + JSON.stringify(kept));
	const lib3 = await page.evaluate(() => window.__io.items());
	h.check(lib3.some((i) => i.name === 'Heavy.glb') && !lib3.some((i) => i.optimizedFrom), '3.2 the optimized copy left the Library; the original stays');
	await page.evaluate(() => window.__tp.test.v1.history.undo());
	const undone = await page.evaluate((u) => window.__io.facts(u), uuid);
	h.check(undone?.maps[0]?.w === 2048 && JSON.stringify(undone.lod) === JSON.stringify([1, 0.5, 0.25, 0.1]), '3.3 one undo brings the optimized object back (2048 px + its LOD group)');
	await page.evaluate((u) => window.__tp.test.v1.objectActions.deleteObjectsByUuid([u]), uuid);

	// ---- 4 per-asset override + Reimport ----------------------------------------------------------
	const uuid2 = await page.evaluate((b64) => window.__io.place(b64, 'Heavy', [0, 1, 0]), heavy);
	const orig = await page.evaluate(() => window.__io.items().find((i) => i.name === 'Heavy.glb'));
	// the panel, the user's way: open the Explorer, right-click the original's card ▸ Properties
	await page.evaluate(() => window.__tp.test.v1.closeMenu?.set?.(true));
	if ((await page.locator('.explorer-card').count()) === 0) await page.locator('#explorer-slot').click();
	await page.evaluate(() => window.__tp.test.v1.explorer.activeFolder.set(null));
	await page.locator('.explorer-card[title="Heavy.glb"]').first().click({ button: 'right' });
	await page.waitForTimeout(350);
	await page.locator('[role="menu"]').getByText('Properties', { exact: true }).first().click();
	await h.eventually(() => page.locator('#import-settings-panel #isp-mode').count(), (n) => n > 0, '4.1 the original\'s Properties show Import settings', 15000);
	await page.locator('#isp-mode-always').click();
	await page.locator('#isp-lod-levels-2').click();
	await page.locator('#isp-max-texture-1024').click();
	const ov = await page.evaluate(() => window.__io.items().find((i) => i.name === 'Heavy.glb').importSettings);
	h.check(ov?.mode === 'always' && ov?.lodLevels === 2 && ov?.maxTextureSize === 1024, '4.2 the panel writes the asset OVERRIDE on the original\'s record: ' + JSON.stringify(ov));
	const oldCopy = await page.evaluate(() => window.__io.items().find((i) => i.optimizedFrom)?.hash);
	await page.locator('#isp-reimport').click();
	await h.eventually(
		() => page.evaluate((u) => window.__io.facts(u), uuid2),
		(x) => x?.maps?.[0]?.w === 1024 && JSON.stringify(x.lod) === JSON.stringify([1, 0.5, 0.25]),
		'4.3 Reimport swapped the placed copy (same uuid): 1024 px, two LOD levels',
		120000
	);
	const lib4 = await page.evaluate(() => window.__io.items());
	const copies = lib4.filter((i) => i.optimizedFrom);
	h.check(copies.length === 1 && copies[0].hash !== oldCopy && lib4.find((i) => i.name === 'Heavy.glb')?.optimizedHash === copies[0].hash, '4.4 the optimized item was REPLACED (one copy, a new hash, the original points at it)');
	// Never: the file comes in as it is
	await page.locator('#isp-mode-never').click();
	const before4 = await page.evaluate(() => window.__io.read(window.__tp.test.v1.importOptimize.lastOptimizedImport)?.uuid);
	const uuid3 = await page.evaluate((b64) => window.__io.place(b64, 'Heavy', [4, 1, 0]), heavy);
	const never = await page.evaluate((u) => window.__io.facts(u), uuid3);
	h.check(never.maps[0].w === 4096 && never.lod === null && never.optimized === null, '4.5 override Never: a re-import comes in untouched (4096 px, no LOD group)');
	h.check((await page.evaluate(() => window.__io.read(window.__tp.test.v1.importOptimize.lastOptimizedImport)?.uuid)) === before4, '4.6 …and no optimize ran');
	const lightUuid = await page.evaluate((b64) => window.__io.place(b64, 'Light', [-4, 1, 0]), lightB64);
	const lightF = await page.evaluate((u) => window.__io.facts(u), lightUuid);
	h.check(lightF.lod === null && lightF.optimized === null && lightF.maps[0].w === 256, '4.7 under the thresholds (2k tris, 256 px) nothing is optimized');
	await page.evaluate((ids) => window.__tp.test.v1.objectActions.deleteObjectsByUuid(ids), [uuid2, uuid3, lightUuid]);
	await page.evaluate((id) => window.__tp.test.v1.importOptimize.setAssetOverride(id, null), orig.id);

	// ---- 5 two peers: LOD by distance + the scene's LOD distance ----------------------------------
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await install(B.page);
	await h.connect(B, A);
	const shared = await page.evaluate((b64) => window.__io.place(b64, 'Shared', [0, 1, 0]), heavy);
	await h.eventually(
		() => B.page.evaluate((u) => window.__io.facts(u), shared),
		(x) => !!x && JSON.stringify(x.lod) === JSON.stringify([1, 0.5, 0.25, 0.1]) && x.maps[0]?.twin,
		'5.1 the peer received the object with its LOD group AND its texture twin',
		60000
	);
	const levels = await B.page.evaluate(async (u) => {
		const s = window.__tp?.test.v1;
		s.lodGroup.scanLodGroups();
		s.lodGroup.buildAllLevels(u);
		const end = performance.now() + 30000;
		while (performance.now() < end) {
			const info = s.lodGroup.lodGroupInfo(u);
			if (info && info.levels.every((l) => l.status === 'ready' || l.status === 'failed')) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		const out = {};
		for (const d of [3, 20, 60, 400]) {
			window.__io.renderFrom(d, [0, 1, 0]);
			window.__io.renderFrom(d, [0, 1, 0]);
			out[d] = window.__io.level(u)?.current;
		}
		return { out, tris: window.__io.level(u)?.levels.map((l) => l.tris) };
	}, shared);
	h.check(levels.out[3] === 0 && levels.out[20] >= 1 && levels.out[60] > levels.out[20] && levels.out[400] === 3, '5.2 on the RECEIVER the level follows distance: ' + JSON.stringify(levels.out) + ' (level tris ' + JSON.stringify(levels.tris) + ')');
	await page.evaluate(() => window.__tp.test.v1.environment.setSceneLodBias(3));
	await h.eventually(() => B.page.evaluate(() => window.__tp.test.v1.environment.lodBiasOf(window.__io.read(window.__tp.test.v1.environment.environment))), (v) => v === 3, '5.3 the scene\'s LOD distance replicated (3)', 20000);
	const biased = await B.page.evaluate((u) => {
		window.__io.renderFrom(400, [0, 1, 0]);
		window.__io.renderFrom(60, [0, 1, 0]);
		window.__io.renderFrom(60, [0, 1, 0]);
		return window.__io.level(u)?.current;
	}, shared);
	h.check(biased < levels.out[60], '5.4 …and moved the switch: at 60 m the peer now draws level ' + biased + ' (was ' + levels.out[60] + ')');
	const saved = await page.evaluate(() => window.__tp.test.v1.environment.environmentSnapshot());
	h.check(saved?.lodBias === 3, '5.5 the scene save carries it (environmentSnapshot.lodBias = ' + saved?.lodBias + ')');
	await page.evaluate(() => window.__tp.test.v1.environment.setSceneLodBias(1));
	h.check((await page.evaluate(() => window.__tp.test.v1.environment.environmentSnapshot())) === null, '5.6 back at 1 a stock scene saves no environment block at all');
	await h.finish(browser);
});
