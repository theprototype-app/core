// 101 F2 step 6: with the object schema in front of every loader, two peers editing every object and
// material kind see the same scene, and a late joiner (the full handshake sync: the `object`
// messages) gets the same scene too. And the load check changes nothing on real edits: its totals
// stay 0 on every receiving page.
//
//   A builds: every Add-menu item, every switchable material type, a textured map, a normal map slot
//   with tiling, material params, a multi-slot material (the `materials` message), a group, a
//   duplicate of the group. B is connected the whole time; C joins at the end.
//
// Run: APP_URL=https://theprototype.app:7022/ node tests/e2e/schema-two-peers.test.cjs
const h = require('./helpers.cjs');

/** a comparable summary of a page's scene, keyed by uuid. `types: false` leaves the material TYPE out:
 * the handshake sync sends a mesh as glTF, and glTF carries PBR materials only, so a late joiner has
 * always received a Phong / Lambert / Toon / ... material as MeshStandardMaterial (measured the same on
 * the v1.65.1 base, before this lane) @param {any} page @param {boolean} [types] */
const sceneOf = (page, types = true) =>
	page.evaluate(async (types) => {
		const s = window.__stores;
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		/** @type {Record<string, string>} */
		const out = {};
		g.traverse((o) => {
			if (o === g || o.userData?.__helper) return;
			const mats = [].concat(o.material ?? []).map((m) => (types ? m.type : 'material') + (m.map ? '+map' : '') + (m.normalMap ? '+normal' : ''));
			const verts = o.geometry?.attributes?.position?.count ?? 0;
			out[o.uuid] = [o.type, o.name, mats.join(','), verts, o.parent === g ? 'root' : o.parent?.uuid].join(' | ');
		});
		return out;
	}, types);
/** @param {any} page */
const totalsOf = (page) => page.evaluate(() => window.__stores.loadGuard?.loadGuardTotals?.() ?? null);
/** @param {Record<string, string>} a @param {Record<string, string>} b */
const diff = (a, b) => {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k] ?? '(missing)'} vs ${b[k] ?? '(missing)'}`);
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.loadGuard?.resetLoadGuard?.());

	// ---- A builds every kind, B watching -----------------------------------------------------------
	const built = await A.page.evaluate(async () => {
		const s = window.__stores;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const { primitivesCatalog } = await import('/src/lib/primitivesCatalog.js');
		const cmds = primitivesCatalog.flatMap((g) => g.items.map((i) => i.command));
		for (const c of cmds) {
			s.commandsHandler.sceneCommand(c);
			await wait(80);
		}
		await wait(1500);
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const meshes = g.children.filter((o) => o.isMesh && !Array.isArray(o.material));
		const M = s.materialsHandler;
		const types = ['MeshBasicMaterial', 'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshPhongMaterial', 'MeshLambertMaterial', 'MeshToonMaterial', 'MeshMatcapMaterial', 'MeshNormalMaterial', 'MeshDepthMaterial', 'ShadowMaterial'];
		types.forEach((t, k) => meshes[k] && M.switchMaterialType(meshes[k].uuid, t, true));
		const cv = document.createElement('canvas');
		cv.width = cv.height = 16;
		const c2 = cv.getContext('2d');
		c2.fillStyle = '#c84';
		c2.fillRect(0, 0, 16, 16);
		const url = cv.toDataURL('image/png');
		const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
		const textured = meshes[10];
		M.applyMap(textured, url, 0, null);
		const pc = await new Promise((r) => s.peers.subscribe(r)());
		pc.send({ type: 'objectParameters', parameter: 'map', uuid: textured.uuid, map: url });
		const slotted = meshes[11];
		await s.materialMaps.setObjectsMapSlot([slotted.uuid], 'normalMap', new File([blob], 'n_normal.png', { type: 'image/png' }), 0);
		s.materialMaps.setTexTransform(slotted.uuid, { repeat: [2, 3], offset: [0.1, 0.2], rotation: 0.3 }, 0);
		for (const [k, v] of [['roughness', 0.3], ['metalness', 0.7], ['opacity', 0.6], ['transparent', true], ['emissive', '#223344']]) M.setMaterialParam(meshes[12].uuid, k, v, true);
		const multi = meshes.find((o) => o.geometry?.type === 'BoxGeometry' && !Array.isArray(o.material) && o.material.type === 'MeshStandardMaterial') ?? meshes[13];
		M.addMaterialSlot(multi.uuid);
		await wait(500);
		s.selectedObjects.set([meshes[14].uuid, meshes[15].uuid]);
		const groupUuid = s.objectActions.groupSelection();
		await wait(500);
		const grp = g.getObjectByProperty('uuid', groupUuid);
		if (grp) {
			s.selectedObjects.set([grp.uuid]);
			await s.objectActions.duplicateSelection();
		}
		await wait(500);
		return { cmds: cmds.length, group: !!grp, multi: Array.isArray(multi.material) ? multi.material.length : 1 };
	});
	h.check(built.cmds >= 40 && built.multi === 2 && built.group, `premise: A built every kind (${JSON.stringify(built)})`);

	let a = {};
	let b = {};
	await h.eventually(
		async () => {
			a = await sceneOf(A.page);
			b = await sceneOf(B.page);
			return diff(a, b);
		},
		(d) => d.length === 0,
		'B sees the same scene as A',
		60000
	);
	const dAB = diff(a, b);
	h.check(dAB.length === 0, `B (connected) has the same ${Object.keys(a).length} objects, kinds and materials as A` + (dAB.length ? ': ' + dAB.slice(0, 5).join(' ; ') : ''));
	const bt = await totalsOf(B.page);
	h.check(!!bt && Object.values(bt).every((v) => v === 0), `the load check changed nothing on B (${JSON.stringify(bt)})`);

	// ---- C joins late: the whole scene arrives through the handshake sync ---------------------------
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await C.page.evaluate(() => window.__stores.loadGuard?.resetLoadGuard?.());
	await h.connect(C, A);
	let c = {};
	await h.eventually(
		async () => {
			a = await sceneOf(A.page, false);
			c = await sceneOf(C.page, false);
			return diff(a, c);
		},
		(d) => d.length === 0,
		'C (late joiner) sees the same scene as A',
		120000
	);
	const dAC = diff(a, c);
	h.check(dAC.length === 0, `C (late joiner) has the same ${Object.keys(a).length} objects, kinds, slots and maps as A` + (dAC.length ? ': ' + dAC.slice(0, 5).join(' ; ') : ''));
	const ct = await totalsOf(C.page);
	h.check(!!ct && Object.values(ct).every((v) => v === 0), `the load check changed nothing on C (${JSON.stringify(ct)})`);
	await h.finish(browser);
});
