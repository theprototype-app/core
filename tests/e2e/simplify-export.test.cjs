// 102 M1 / M2 — SIMPLIFY and EXPORT FOR 3D PRINT / AR, on the host (A) and a connected peer (B):
//  M1  a 50k-triangle imported model simplified to 25 % through the REAL dialog (Mesh ▸ Simplify…
//      opened by its menu row; the slider, Preview, Apply): the preview stays on A, the applied
//      result reaches B as ONE replace, its uv / normal channels survive, it is ONE undo step, and
//      undo puts the full model back on BOTH peers; redo brings the 25 % back on both.
//  M1  a still-parametric primitive is refused politely with the Bake offer; bake: true simplifies it.
//  M2  Export for 3D print: STL and 3MF downloaded through the dialog (a real download) parse and
//      round-trip the triangle count; 3MF is millimetres; the size line is in mm; an open plane
//      gets the manifold warning (not a block). USDZ builds, shows its size, and is a zip with a
//      USD layer inside.
//  SAVE/SYNC  the simplified scene is written as a .tpscene (test-results/simplify-export/, read by
//      simplify-file-compat in the newest release) and B reloads, rejoins and gets the 25 % back.
const h = require('./helpers.cjs');
const fs = require('fs');
const { unzipSync, strFromU8 } = require('fflate');

/** in-page: triangles of the object at uuid and its channel names */
const meshFacts = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__tp?.test.v1;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		let tris = 0;
		const channels = new Set();
		o.traverse((m) => {
			if (!m.isMesh || !m.geometry?.attributes?.position) return;
			const geo = m.geometry;
			tris += Math.floor((geo.index ? geo.index.count : geo.attributes.position.count) / 3);
			for (const k of Object.keys(geo.attributes)) channels.add(k);
		});
		return { tris, channels: [...channels].sort(), simplified: o.userData.simplified ?? null, name: o.name };
	}, uuid);

const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__tp.test.v1.history.undoStack.subscribe((s) => r(s.length))()));

/** read a binary STL's triangle count (node side) @param {Buffer} buf */
function stlTriangles(buf) {
	const n = buf.readUInt32LE(80);
	if (buf.length !== 84 + n * 50) throw new Error('bad STL size ' + buf.length + ' for ' + n);
	return n;
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---------- fixture: a 50k-triangle sphere with uvs and normals, as a .glb import ----------
	const glb = await A.page.evaluate(async () => {
		const THREE = window.__tp.test.v1.THREE;
		const { GLTFExporter } = window.__tp.test.v1.GLTFExporterModule;
		const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 251, 100), new THREE.MeshStandardMaterial({ color: 0x3366cc }));
		mesh.name = 'Ball';
		const bytes = await new Promise((res, rej) => new GLTFExporter().parse(mesh, res, rej, { binary: true }));
		return Array.from(new Uint8Array(bytes));
	});
	const uuid = await A.page.evaluate(async (bytes) => window.__tp.test.v1.fileHandler.importFile(new File([new Uint8Array(bytes)], 'ball.glb'), 'Ball'), glb);
	h.check(typeof uuid === 'string', 'the 50k ball imported on A');
	await h.eventually(() => meshFacts(A.page, uuid), (f) => f?.tris > 0, 'A holds the ball', 20000);
	const full = await meshFacts(A.page, uuid);
	h.check(full.tris >= 49000 && full.tris <= 51000, `the fixture is ~50k triangles (${full.tris})`);
	await h.eventually(() => meshFacts(B.page, uuid), (f) => f?.tris === full.tris, `B holds the same ${full.tris}-triangle ball`, 30000);

	// ---------- M1: the object menu row opens the dialog ----------
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u, true), uuid);
	const row = await A.page.evaluate((u) => {
		const s = window.__tp.test.v1;
		const item = s.objectMenu.findMenuItem(s.objectMenu.buildObjectMenuItems(u, { selection: [u] }), 'Simplify…');
		if (!item || item.disabled) return null;
		item.action();
		return { tooltip: item.tooltip };
	}, uuid);
	h.check(!!row && /Ctrl\+Alt\+D/.test(row.tooltip), 'Mesh ▸ Simplify… is offered, its tooltip names the key');
	await h.eventually(() => A.page.locator('#simplify-dialog').isVisible().catch(() => false), (v) => v, 'the Simplify dialog opened', 15000);
	h.check(Number(await A.page.locator('#simplify-dialog').getAttribute('data-before')) === full.tris, 'the dialog shows the live triangle count');

	// the slider to 25 %: the count line follows before anything runs
	await A.page.locator('#simplify-percent').fill('25');
	const planned = Number(await A.page.locator('#simplify-dialog').getAttribute('data-planned'));
	h.check(Math.abs(planned - Math.round(full.tris * 0.25)) <= 2, `25 % plans ~${Math.round(full.tris * 0.25)} triangles (${planned})`);

	// Preview: A's object shows it, B's does not (local), nothing recorded
	const depth0 = await undoDepth(A.page);
	await A.page.locator('#simplify-preview').click();
	await h.eventually(() => A.page.locator('#simplify-preview-count').isVisible().catch(() => false), (v) => v, 'Preview shows its count', 30000);
	const previewed = await meshFacts(A.page, uuid);
	h.check(previewed.tris <= planned && previewed.tris > planned * 0.85, `the preview is on A's object (${previewed.tris})`);
	await A.page.waitForTimeout(1500);
	h.check((await meshFacts(B.page, uuid)).tris === full.tris, 'B still holds the full ball while A previews');
	h.check((await undoDepth(A.page)) === depth0, 'a preview records nothing');

	// Apply: ONE undo step, B receives the replace
	await A.page.locator('#simplify-apply').click();
	await h.eventually(() => A.page.locator('#simplify-dialog').isVisible().catch(() => false), (v) => !v, 'Apply closed the dialog', 30000);
	const after = await meshFacts(A.page, uuid);
	h.check(after.tris <= Math.round(full.tris * 0.25) && after.tris > full.tris * 0.2, `A: 25 % (${after.tris} of ${full.tris})`);
	h.check(after.channels.includes('uv') && after.channels.includes('normal'), `A: uv + normal kept (${after.channels})`);
	h.check(after.simplified?.trianglesBefore === full.tris, 'A: the object carries its simplify stamp');
	h.check(after.name === 'Ball', 'A: the name is kept');
	h.check((await undoDepth(A.page)) === depth0 + 1, 'ONE undo step');
	await h.eventually(() => meshFacts(B.page, uuid), (f) => f?.tris === after.tris, `B: the same ${after.tris} triangles arrived (one replace)`, 30000);
	h.check((await meshFacts(B.page, uuid)).channels.includes('uv'), 'B: uv kept');

	// undo: the full model back on BOTH; redo: the 25 % back on both
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(() => meshFacts(A.page, uuid), (f) => f?.tris === full.tris, 'undo: A holds the full ball again', 20000);
	await h.eventually(() => meshFacts(B.page, uuid), (f) => f?.tris === full.tris, 'undo: B holds the full ball again', 30000);
	await A.page.evaluate(() => window.__tp.test.v1.history.redo());
	await h.eventually(() => meshFacts(B.page, uuid), (f) => f?.tris === after.tris, 'redo: B holds the 25 % again', 30000);

	// ---------- the save file + a reload (the 21 Nov rule for a lane that touches save and sync) ----------
	// A's whole scene as a .tpscene, for simplify-file-compat to open in the newest release
	const saveDir = require('path').join(process.cwd(), 'test-results', 'simplify-export');
	fs.mkdirSync(saveDir, { recursive: true });
	const sceneB64 = await A.page.evaluate(async () => {
		const ss = window.__tp.test.v1.sessions;
		const zip = await ss.exportSessionZip(ss.buildSessionPayload('Simplified ball'), { assets: true, packs: false, flow: true });
		let bin = '';
		for (let i = 0; i < zip.length; i += 32768) bin += String.fromCharCode(...zip.subarray(i, i + 32768));
		return btoa(bin);
	});
	fs.writeFileSync(require('path').join(saveDir, 'simplified.tpscene'), Buffer.from(sceneB64, 'base64'));
	fs.writeFileSync(require('path').join(saveDir, 'simplified.expect.json'), JSON.stringify({ uuid, tris: after.tris }));
	h.check(sceneB64.length > 1000, `the simplified scene saved as a .tpscene (${Math.round((sceneB64.length * 3) / 4 / 1024)} KB)`);
	// B reloads: a joiner reload re-dials on its own; the simplified mesh must come back, not the full one
	await h.freshReload(B);
	await h.answerRestore(B, 'dismiss', 3000).catch(() => {});
	await h.eventually(
		() => B.page.evaluate((id) => { let p; window.__tp.test.v1.peers.subscribe((v) => (p = v))(); return !!p?.openedPeers?.has(id); }, A.id),
		(v) => v,
		'B: rejoined after its reload',
		60000
	);
	await h.eventually(() => meshFacts(B.page, uuid), (f) => f?.tris === after.tris, `B after reload: the 25 % arrived (${after.tris})`, 60000);
	const bAfter = await meshFacts(B.page, uuid);
	h.check(!!bAfter?.channels?.includes('uv') && !!bAfter?.channels?.includes('normal'), `B after reload: uv + normal kept (${bAfter?.channels})`);

	// ---------- M1: a parametric primitive is refused politely, bake: true simplifies it ----------
	const prim = await A.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		const THREE = s.THREE;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 64, 32), new THREE.MeshStandardMaterial());
		m.name = 'Prim';
		m.userData.geometryParams = { gtype: 'Sphere', params: { radius: 0.5, widthSegments: 64, heightSegments: 32 } };
		m.position.set(3, 0, 0);
		g.add(m);
		const refused = await s.meshSimplifyAction.applySimplify(m.uuid, { percent: 50 });
		const baked = await s.meshSimplifyAction.applySimplify(m.uuid, { percent: 50 }, { bake: true, quiet: true });
		const live = g.getObjectByProperty('uuid', m.uuid);
		return { refused: refused.refused ?? '', baked: baked.after ?? 0, before: baked.before ?? 0, locked: !!live?.userData?.faceEdited };
	});
	h.check(/parametric/.test(prim.refused) && /Bake/.test(prim.refused), `a primitive is refused with the Bake offer ("${prim.refused}")`);
	h.check(prim.baked > 0 && prim.baked <= prim.before / 2 && prim.locked, `bake: true simplifies it and locks its Geometry rows (${prim.before} → ${prim.baked})`);

	// ---------- M2: Export for 3D print through the dialog, real downloads ----------
	const outDir = require('path').join(process.env.SHOTS_DIR || require('os').tmpdir(), 'simplify-export-' + Date.now());
	fs.mkdirSync(outDir, { recursive: true });
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u, true), uuid);
	await A.page.evaluate(() => window.__tp.test.v1.makerDialogs.openExport3d('stl', (() => { let u; window.__tp.test.v1.selectedObjects.subscribe((x) => (u = x))(); return u; })(), 'Ball'));
	await h.eventually(() => A.page.locator('#export3d-dialog').isVisible().catch(() => false), (v) => v, 'the export dialog opened', 15000);
	const sizeLine = await A.page.locator('#export3d-size').innerText();
	// a 1 m-radius ball: ~2000 mm a side (simplifying moves the silhouette in by a fraction of a mm)
	const sides = (/Prints at ([\d,.]+) × ([\d,.]+) × ([\d,.]+) mm/.exec(sizeLine) ?? []).slice(1).map((v) => Number(v.replace(/,/g, '')));
	h.check(sides.length === 3 && sides.every((v) => v > 1980 && v <= 2001), `the size line is in mm (${sizeLine})`);
	h.check(/Watertight/.test(await A.page.locator('#export3d-manifold').innerText()), 'a closed ball is watertight');
	let download = A.page.waitForEvent('download', { timeout: 20000 });
	await A.page.locator('#export3d-run').click();
	const stlPath = require('path').join(outDir, 'ball.stl');
	await (await download).saveAs(stlPath);
	const stlTris = stlTriangles(fs.readFileSync(stlPath));
	h.check(stlTris === after.tris, `the STL parses and holds the ${after.tris} triangles (${stlTris})`);

	await A.page.evaluate(() => window.__tp.test.v1.makerDialogs.openExport3d('3mf', (() => { let u; window.__tp.test.v1.selectedObjects.subscribe((x) => (u = x))(); return u; })(), 'Ball'));
	await h.eventually(() => A.page.locator('#export3d-dialog').getAttribute('data-format').catch(() => ''), (v) => v === '3mf', 'the dialog is on 3MF', 15000);
	await A.page.locator('#export3d-longest').fill('50');
	await A.page.locator('#export3d-longest').dispatchEvent('change');
	h.check(Number(await A.page.locator('#export3d-size').getAttribute('data-longest-mm')) === 50, 'the longest-side field sets the scale (50 mm)');
	download = A.page.waitForEvent('download', { timeout: 20000 });
	await A.page.locator('#export3d-run').click();
	const mfPath = require('path').join(outDir, 'ball.3mf');
	await (await download).saveAs(mfPath);
	const files = unzipSync(new Uint8Array(fs.readFileSync(mfPath)));
	const model = strFromU8(files['3D/3dmodel.model'] ?? new Uint8Array());
	h.check(/unit="millimeter"/.test(model) && !!files['[Content_Types].xml'], 'the 3MF is a millimetre package');
	h.check((model.match(/<triangle /g) ?? []).length >= after.tris * 0.99, `the 3MF holds the triangles (${(model.match(/<triangle /g) ?? []).length})`);
	h.check(/displaycolor="#3366CC"/.test(model), 'the 3MF carries the object colour');

	// an open plane: the warning, and the export is still offered
	const openUuid = await A.page.evaluate(() => {
		const s = window.__tp.test.v1;
		const THREE = s.THREE;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
		g.add(m);
		return m.uuid;
	});
	await A.page.evaluate((u) => window.__tp.test.v1.makerDialogs.openExport3d('stl', [u], 'Plane'), openUuid);
	await h.eventually(() => A.page.locator('#export3d-dialog').getAttribute('data-open-edges').catch(() => '0'), (v) => Number(v) === 4, 'an open plane counts 4 open edges', 15000);
	h.check(/Not watertight/.test(await A.page.locator('#export3d-manifold').innerText()) && (await A.page.locator('#export3d-run').isEnabled()), 'the manifold warning shows and does not block');

	// ---------- M2 step 3: USDZ builds, shows its size, and is a zip with a USD layer ----------
	await A.page.locator('#export3d-format-usdz').click();
	await A.page.locator('#export3d-scope-scene').click();
	await A.page.locator('#export3d-run').click();
	await h.eventually(() => A.page.locator('#export3d-usdz-size').getAttribute('data-bytes').catch(() => null), (v) => Number(v) > 1000, 'USDZ built and its size is shown', 60000);
	download = A.page.waitForEvent('download', { timeout: 20000 });
	await A.page.locator('#export3d-run').click();
	const usdzPath = require('path').join(outDir, 'scene.usdz');
	await (await download).saveAs(usdzPath);
	const usdz = unzipSync(new Uint8Array(fs.readFileSync(usdzPath)));
	const layer = Object.keys(usdz).find((n) => /\.usda$/.test(n));
	h.check(!!layer && /#usda/.test(strFromU8(usdz[layer])), `the USDZ holds a USD layer (${Object.keys(usdz).slice(0, 4)})`);

	// the cloud seam for "View in your room"
	const ar = await A.page.evaluate(async () => {
		const m = window.__tp.test.v1.cloudPlugin?.makeCloudApi?.();
		const r = m?.buildArModel ? await m.buildArModel() : null;
		return r ? { bytes: r.bytes, type: r.blob.type } : null;
	});
	h.check(!ar || (ar.bytes > 1000 && ar.type === 'model/vnd.usdz+zip'), `cloudApi.buildArModel returns the scene's USDZ (${ar ? ar.bytes + ' B' : 'api not reachable here'})`);

	await browser.close();
});
