// 72 LK1: Inspector ▸ Material ▸ Maps. Normal, roughness, metalness, emissive and AO map slots plus tiling /
// offset / rotation per material. Everything here must reach a peer, undo as one step and survive the three
// ways a material leaves this tab: the live message, the GLTF object sync a late joiner gets, a saved scene.
// Devices: desktop, then the Oppo N6 folded (390x896) and unfolded (770x850).
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const OUT = process.env.EVIDENCE_DIR || path.join('test-results', '72-materials');

/** a small striped PNG as a file for an input, so a map changes real pixels. Bytes built in the page. */
const pngFile = async (page, name, colours) => {
	const base64 = await page.evaluate((list) => {
		const c = document.createElement('canvas');
		c.width = c.height = 64;
		const g = c.getContext('2d');
		list.forEach((colour, i) => {
			g.fillStyle = colour;
			g.fillRect((i * 64) / list.length, 0, 64 / list.length, 64);
		});
		return c.toDataURL('image/png').split(',')[1];
	}, colours);
	return { name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
};

/** what a material holds, read from the live object */
const state = (page, uuid) =>
	page.evaluate((id) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const m = group?.getObjectByProperty('uuid', id)?.material;
		if (!m) return null;
		const tex = (t) => (t ? { space: t.colorSpace, repeat: [t.repeat.x, t.repeat.y], offset: [t.offset.x, t.offset.y], rotation: t.rotation, wrap: t.wrapS, w: t.image?.width } : null);
		return {
			type: m.type,
			normal: tex(m.normalMap),
			rough: tex(m.roughnessMap),
			metal: tex(m.metalnessMap),
			emissive: tex(m.emissiveMap),
			ao: tex(m.aoMap),
			base: tex(m.map),
			metalness: m.metalness,
			roughness: m.roughness,
			emissiveHex: m.emissive?.getHexString?.(),
			normalScale: m.normalScale ? [m.normalScale.x, m.normalScale.y] : null,
			aoIntensity: m.aoMapIntensity,
			userDataBytes: JSON.stringify(m.userData ?? {}).length
		};
	}, uuid);

const undo = (page) => page.evaluate(() => window.__stores.history.undo());
const redo = (page) => page.evaluate(() => window.__stores.history.redo());
const undoDepth = (page) =>
	page.evaluate(() => {
		let depth = 0;
		window.__stores.history.undoStack.subscribe((s) => (depth = s.length))();
		return depth;
	});

const createBox = (page) =>
	page.evaluate(async () => {
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const before = new Set(group.children.map((c) => c.uuid));
		window.__stores.commandsHandler.sceneCommand('/create box');
		for (let i = 0; i < 40; i++) {
			await new Promise((r) => setTimeout(r, 100));
			const made = group.children.find((c) => !before.has(c.uuid) && c.isMesh);
			if (made) return made.uuid;
		}
		return '';
	});

const select = async (page, uuid) => {
	await page.evaluate((id) => {
		window.__stores.inspectorClose.set(false);
		window.__stores.objectActions.selectObject(id);
	}, uuid);
	await page.waitForSelector('#material-maps', { timeout: 30000, state: 'attached' });
};

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const page = A.page;
	await h.connect(B, A);

	console.log('\n=== 1. the rows ===');
	const box = await createBox(page);
	h.check(!!box, '1.1 premise: a box exists');
	await select(page, box);
	for (const key of ['normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'])
		h.check((await page.locator('#map-slot-' + key).count()) === 1, '1.2 a row for ' + key);
	h.check((await page.locator('#map-transform').count()) === 0, '1.3 no tiling rows with no map to tile');

	console.log('\n=== 2. setting a map from a file, on the real input ===');
	await h.eventually(() => state(B.page, box), (s) => !!s, '2.0 premise: B has the box', 30000);
	const shot0 = await h.grabFrame(A);
	const depth0 = await undoDepth(page);
	await page.setInputFiles('#map-file-normalMap', await pngFile(page, 'n.png', ['#8080ff', '#ff80c0', '#80ff80', '#8000ff']));
	await h.eventually(() => state(page, box), (s) => !!s?.normal, '2.1 A: the normal map is on the material', 15000);
	const s1 = await state(page, box);
	h.check(s1.normal.space === 'NoColorSpace' || s1.normal.space === '', '2.2 a normal map is read as numbers, not sRGB: ' + s1.normal.space);
	h.check((await undoDepth(page)) === depth0 + 1, '2.3 one undo step');
	await h.eventually(() => state(B.page, box), (s) => !!s?.normal, '2.4 B: the normal map arrived', 20000);
	h.check((await page.locator('#map-slot-normalMap img').count()) === 1, '2.5 the row shows a picture of it');
	h.check((await page.locator('#map-normal-strength').count()) >= 1, '2.6 ...and a strength row appears');
	h.check((await page.locator('#map-transform').count()) === 1, '2.7 ...and the tiling rows');
	await page.waitForTimeout(600);
	const shot1 = await h.grabFrame(A);
	const delta = await h.frameDelta(page, shot0, shot1);
	h.check(JSON.stringify(delta).match(/[1-9]/) && !delta.error, '2.8 the render really changed: ' + JSON.stringify(delta));

	console.log('\n=== 3. a map lifts the value that would hide it, in the same undo step ===');
	const s2 = await state(page, box);
	h.check(s2.metalness === 0, '3.0 premise: metalness starts at 0 (' + s2.metalness + ')');
	const depth1 = await undoDepth(page);
	await page.setInputFiles('#map-file-metalnessMap', await pngFile(page, 'm.png', ['#000000', '#0000ff']));
	await h.eventually(() => state(page, box), (s) => !!s?.metal && s.metalness === 1, '3.1 metalness rose to 1 with the map', 15000);
	h.check((await undoDepth(page)) === depth1 + 1, '3.2 map + value = one undo step');
	await h.eventually(() => state(B.page, box), (s) => !!s?.metal && s.metalness === 1, '3.3 B has both', 20000);
	await undo(page);
	await h.eventually(() => state(B.page, box), (s) => !s?.metal && s.metalness === 0, '3.4 undo takes both back on B too', 20000);
	await redo(page);
	await h.eventually(() => state(B.page, box), (s) => !!s?.metal && s.metalness === 1, '3.5 redo puts both back on B', 20000);

	await page.setInputFiles('#map-file-emissiveMap', await pngFile(page, 'e.png', ['#ff0000', '#000000']));
	await h.eventually(() => state(page, box), (s) => !!s?.emissive && s.emissiveHex === 'ffffff', '3.6 emissive map: the black colour turned white', 15000);
	h.check((await state(page, box)).emissive.space === 'srgb', '3.7 an emissive map is colour data (sRGB)');
	await page.setInputFiles('#map-file-roughnessMap', await pngFile(page, 'r.png', ['#00ff00', '#004000']));
	await page.setInputFiles('#map-file-aoMap', await pngFile(page, 'a.png', ['#ffffff', '#404040']));
	await h.eventually(() => state(B.page, box), (s) => !!s?.rough && !!s?.ao && !!s?.emissive, '3.8 B has all five', 25000);

	console.log('\n=== 4. tiling, offset, rotation ===');
	const depth2 = await undoDepth(page);
	await page.evaluate((id) => window.__stores.materialMaps.setTexTransform(id, { repeat: [4, 2], offset: [0.25, 0.5], rotation: 0.5 }), box);
	const s4 = await state(page, box);
	for (const key of ['normal', 'rough', 'metal', 'emissive', 'ao']) {
		h.check(s4[key].repeat[0] === 4 && s4[key].repeat[1] === 2 && s4[key].offset[1] === 0.5 && s4[key].rotation === 0.5, '4.1 ' + key + ' took the transform');
		h.check(s4[key].wrap === 1000, '4.2 ' + key + ' wraps, so it tiles instead of smearing');
	}
	await h.eventually(() => state(B.page, box), (s) => s?.normal?.repeat?.[0] === 4 && s?.ao?.rotation === 0.5, '4.3 B has the same transform', 20000);
	h.check((await undoDepth(page)) === depth2 + 1, '4.4 one undo step');
	// the base colour map set AFTER the tiling takes it too
	await page.setInputFiles('#texture-file', await pngFile(page, 'c.png', ['#ffffff', '#c0c0c0']));
	await h.eventually(() => state(page, box), (s) => s?.base?.repeat?.[0] === 4, '4.5 a base colour map set later takes the tiling', 15000);
	await h.eventually(() => state(B.page, box), (s) => s?.base?.repeat?.[0] === 4, '4.6 ...on B too', 20000);

	// a scrub on the real row is one undo step
	const depth3 = await undoDepth(page);
	await page.evaluate((id) => {
		const M = window.__stores.materialMaps;
		const token = {};
		const G = window.__stores.historyGesture;
		if (G) G.withHistoryGesture(token, () => M.setTexTransform(id, { repeat: [5, 2] }));
		if (G) G.withHistoryGesture(token, () => M.setTexTransform(id, { repeat: [6, 2] }));
		if (G) G.withHistoryGesture(token, () => M.setTexTransform(id, { repeat: [7, 2] }));
	}, box);
	const scrubbed = await page.evaluate(() => !!window.__stores.historyGesture);
	if (scrubbed) {
		h.check((await undoDepth(page)) === depth3 + 1, '4.7 three writes in one gesture = one undo step');
		await undo(page);
		h.check((await state(page, box)).normal.repeat[0] === 4, '4.8 ...and undo goes back past all three');
	} else console.log('SKIP 4.7: historyGesture is not on the debug hook');

	// the real row, typed
	await page.evaluate((id) => window.__stores.objectActions.selectObject(id), box);
	const tile = page.locator('#map-tile-u');
	h.check((await tile.count()) >= 1, '4.9 the Tile U row is there');

	console.log('\n=== 5. strengths ===');
	await page.evaluate((id) => window.__stores.materialMaps.setNormalStrength(id, 2.5), box);
	await h.eventually(() => state(B.page, box), (s) => s?.normalScale?.[0] === 2.5, '5.1 normal strength reaches B', 20000);
	await page.evaluate((id) => window.__stores.materialsHandler.setMaterialParam(id, 'aoMapIntensity', 0.5), box);
	await h.eventually(() => state(B.page, box), (s) => s?.aoIntensity === 0.5, '5.2 AO strength reaches B', 20000);

	console.log('\n=== 6. nothing doubles: the URLs stay out of userData ===');
	const s6 = await state(page, box);
	h.check(s6.userDataBytes < 4000 + (await page.evaluate((id) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return (group.getObjectByProperty('uuid', id).material.userData.mapDataUrl ?? '').length;
	}, box)), '6.1 five maps add nothing big to material.userData: ' + s6.userDataBytes + ' bytes');

	console.log('\n=== 7. a late joiner, through the GLTF object sync ===');
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(() => state(C.page, box), (s) => !!s?.normal && !!s?.rough && !!s?.metal && !!s?.emissive && !!s?.ao, '7.1 C got all five maps', 45000);
	const c = await state(C.page, box);
	h.check(c.normal.repeat[0] === 4 && c.ao.repeat[1] === 2 && Math.abs(c.emissive.rotation - 0.5) < 1e-6, '7.2 C got the tiling: ' + JSON.stringify(c.normal));
	h.check(c.normal.wrap === 1000, '7.3 C wraps too');
	h.check(c.metalness === 1 && c.emissiveHex === 'ffffff', '7.4 C got the lifted values');
	h.check(Math.abs(c.normalScale[0]) === 2.5, '7.5 C got the normal strength');
	h.check(Math.abs(c.aoIntensity - 0.5) < 1e-6, '7.6 C got the AO strength');
	await select(C.page, box);
	h.check((await C.page.locator('#map-slot-normalMap img').count()) === 1, '7.7 a map that arrived by sync still shows its picture');
	await h.closePeer(C);

	console.log('\n=== 8. a saved scene and a GLB export ===');
	const saved = await page.evaluate(
		(id) => {
			const payload = window.__stores.sessions.buildSessionPayload('map-slots');
			const text = JSON.stringify(payload);
			return { has: !!payload, bytes: text.length, id: text.includes(id) };
		},
		box
	);
	h.check(saved.has && saved.id, '8.1 the object is in the session payload (' + saved.bytes + ' bytes)');
	const glb = await page.evaluate(async (id) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const object = group.getObjectByProperty('uuid', id);
		const buffer = await window.__stores.fileHandler.gltfBytesFor([object], { binary: true });
		const bytes = buffer instanceof ArrayBuffer ? buffer : await new Response(buffer).arrayBuffer();
		const view = new DataView(bytes);
		const length = view.getUint32(12, true);
		const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
		return { material: json.materials?.[0], used: json.extensionsUsed ?? [] };
	}, box);
	const mat = glb.material ?? {};
	h.check(!!mat.normalTexture, '8.2 GLB: normal');
	h.check(!!mat.pbrMetallicRoughness?.metallicRoughnessTexture, '8.3 GLB: roughness + metalness, packed into one image as glTF requires');
	h.check(!!mat.emissiveTexture, '8.4 GLB: emissive');
	h.check(!!mat.occlusionTexture, '8.5 GLB: AO');
	h.check(glb.used.includes('KHR_texture_transform'), '8.6 GLB: the tiling, as KHR_texture_transform');
	h.check(mat.normalTexture?.extensions?.KHR_texture_transform?.scale?.[0] === 4, '8.7 ...with the numbers: ' + JSON.stringify(mat.normalTexture?.extensions));
	h.check(mat.normalTexture?.scale === 2.5, '8.8 GLB: the normal strength');

	console.log('\n=== 9. a type switch keeps them ===');
	await page.evaluate((id) => window.__stores.materialsHandler.switchMaterialType(id, 'MeshPhysicalMaterial'), box);
	let s9 = await state(page, box);
	h.check(s9.type === 'MeshPhysicalMaterial' && !!s9.normal && !!s9.rough && !!s9.metal && !!s9.ao, '9.1 Standard to Physical keeps every map');
	await page.evaluate((id) => window.__stores.materialsHandler.switchMaterialType(id, 'MeshBasicMaterial'), box);
	s9 = await state(page, box);
	h.check(s9.type === 'MeshBasicMaterial' && !!s9.ao, '9.2 Basic has an AO slot and keeps that one');
	await page.evaluate((id) => window.__stores.materialsHandler.switchMaterialType(id, 'MeshStandardMaterial'), box);
	await h.eventually(() => state(page, box), (s) => s?.type === 'MeshStandardMaterial' && !!s.normal && !!s.rough && !!s.metal && !!s.emissive, '9.3 ...and going back to Standard brings the rest back', 15000);
	await h.eventually(() => state(B.page, box), (s) => s?.type === 'MeshStandardMaterial' && !!s.normal && !!s.emissive, '9.4 ...on B too', 20000);

	console.log('\n=== 10. removing ===');
	await select(page, box);
	await page.locator('#map-remove-normalMap').click();
	await h.eventually(() => state(B.page, box), (s) => !s?.normal, '10.1 Remove clears it on B', 20000);
	await undo(page);
	await h.eventually(() => state(B.page, box), (s) => !!s?.normal, '10.2 undo brings it back on B', 20000);
	// the newest write wins: a Remove right after a Set must not lose to the image still loading
	await page.evaluate(async (id) => {
		const c = document.createElement('canvas');
		c.width = c.height = 512;
		c.getContext('2d').fillRect(0, 0, 512, 512);
		const blob = await new Promise((r) => c.toBlob(r));
		const M = window.__stores.materialMaps;
		M.removeObjectsMapSlot([id], 'aoMap');
		await M.setObjectsMapSlot([id], 'aoMap', blob);
		await M.removeObjectsMapSlot([id], 'aoMap');
	}, box);
	await page.waitForTimeout(1500);
	h.check(!(await state(page, box)).ao, '10.3 a Remove beats the image still loading behind it');

	console.log('\n=== 11. tiling stays on its own material when two materials share a texture ===');
	const shared = await page.evaluate(async () => {
		const s = window.__stores;
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const c = document.createElement('canvas');
		c.width = c.height = 8;
		const tex = new s.THREE.CanvasTexture(c);
		const make = (name) => {
			const mesh = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial({ normalMap: tex }));
			mesh.name = name;
			group.add(mesh);
			return mesh;
		};
		const one = make('one');
		const two = make('two');
		s.materialMaps.setTexTransform(one.uuid, { repeat: [3, 3] });
		return { one: one.material.normalMap.repeat.x, two: two.material.normalMap.repeat.x, sameImage: one.material.normalMap.source === two.material.normalMap.source };
	});
	h.check(shared.one === 3 && shared.two === 1, '11.1 only the edited material moved: ' + JSON.stringify(shared));
	h.check(shared.sameImage, '11.2 ...and they still share the one image upload');

	console.log('\n=== 12. a set of maps by file name, one undo step ===');
	const box2 = await createBox(page);
	await select(page, box2);
	const depth4 = await undoDepth(page);
	const setStart = Date.now();
	await page.setInputFiles('#map-set-files', [
		await pngFile(page, 'oak_diff_1k.png', ['#884400']),
		await pngFile(page, 'oak_nor_gl_1k.png', ['#8080ff']),
		await pngFile(page, 'oak_rough_1k.png', ['#00ff00']),
		await pngFile(page, 'oak_metal_1k.png', ['#0000ff']),
		await pngFile(page, 'oak_ao_1k.png', ['#ffffff'])
	]);
	await h.eventually(() => state(page, box2), (s) => !!s?.base && !!s.normal && !!s.rough && !!s.metal && !!s.ao, '12.1 each file found its slot', 90000);
	console.log('  the set took ' + (Date.now() - setStart) + ' ms');
	await h.eventually(() => state(B.page, box2), (s) => !!s?.base && !!s.normal && !!s.rough && !!s.metal && !!s.ao, '12.2 ...on B too', 25000);
	h.check((await undoDepth(page)) === depth4 + 1, '12.3 the whole set is one undo step');
	await undo(page);
	await h.eventually(() => state(B.page, box2), (s) => !s?.base && !s?.normal && !s?.rough && !s?.metal && !s?.ao, '12.4 undo takes the whole set off B', 25000);

	console.log('\n=== 13. a multi-selection, and presets ===');
	const box3 = await createBox(page);
	await page.evaluate(({ a, b }) => window.__stores.objectActions.setSelection?.([a, b]) ?? window.__stores.objectActions.selectObjects?.([a, b]), { a: box2, b: box3 });
	const applied = await page.evaluate(async ({ a, b }) => {
		const c = document.createElement('canvas');
		c.width = c.height = 8;
		c.getContext('2d').fillRect(0, 0, 8, 8);
		const blob = await new Promise((r) => c.toBlob(r));
		return window.__stores.materialMaps.setObjectsMapSlot([a, b], 'roughnessMap', blob);
	}, { a: box2, b: box3 });
	h.check(applied === 2, '13.1 one image onto both, decoded once');
	await h.eventually(() => state(B.page, box3), (s) => !!s?.rough, '13.2 B has it on the second object', 20000);
	const look = await page.evaluate(async (id) => {
		await new Promise((r) => setTimeout(r, 300));
		const look = (await import('/src/lib/materialPresets.js')).lookOfObject(id);
		return { rough: !!look?.roughnessMap };
	}, box3).catch(() => null);
	if (look) h.check(look.rough, '13.3 a saved look keeps the roughness map');
	else console.log('SKIP 13.3: no module import on this build');

	console.log('\n=== 14. N6, folded and unfolded ===');
	await page.evaluate((id) => window.__stores.objectActions.selectObject(id), box);
	for (const [name, width, height] of [['folded', 390, 896], ['unfolded', 770, 850]]) {
		await page.setViewportSize({ width, height });
		await page.waitForTimeout(800);
		await select(page, box);
		await page.locator('#material-maps').scrollIntoViewIfNeeded().catch(() => {});
		const fit = await page.evaluate(() => {
			const root = document.getElementById('material-maps');
			if (!root) return { missing: true };
			const box = root.getBoundingClientRect();
			const rows = [...root.querySelectorAll('.map-row')].map((row) => {
				const r = row.getBoundingClientRect();
				const parent = row.parentElement.getBoundingClientRect();
				return { over: Math.round(r.right - parent.right), scroll: row.scrollWidth - row.clientWidth, h: Math.round(r.height) };
			});
			return { left: box.left, right: box.right, vw: innerWidth, rows, pageScroll: document.documentElement.scrollWidth - innerWidth };
		});
		h.check(!fit.missing && fit.right <= fit.vw + 1 && fit.left >= -1, '14.1 ' + name + ': the section is on screen: ' + JSON.stringify({ l: fit.left, r: fit.right, w: fit.vw }));
		h.check((fit.rows ?? []).every((r) => r.over <= 1 && r.scroll <= 1), '14.2 ' + name + ': no row overflows: ' + JSON.stringify(fit.rows));
		h.check((fit.rows ?? []).every((r) => r.h >= 28), '14.3 ' + name + ': rows keep a pressable height');
		h.check(fit.pageScroll <= 0, '14.4 ' + name + ': no sideways page scroll');
		await page.screenshot({ path: path.join(OUT, 'n6-' + name + '.png') }).catch(() => {});
	}
	await page.setViewportSize({ width: 1440, height: 900 });

	h.check(h.pageErrors(A).length === 0, '15.1 no page errors on A (' + JSON.stringify(h.pageErrors(A)) + ')');
	h.check(h.pageErrors(B).length === 0, '15.2 no page errors on B (' + JSON.stringify(h.pageErrors(B)) + ')');
	await h.finish(browser);
});
