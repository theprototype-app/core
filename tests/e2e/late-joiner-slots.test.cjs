// fix-late-joiners row 6 — A BIG MULTI-SLOT MESH REACHES A LATE JOINER WHOLE.
//
// The host holds a 20k-vertex mesh with 3 material slots (over the 45k-float toJSON cap, so it goes by glTF) and a
// small 3-slot box (the toJSON path, for contrast). B joins AFTER both exist. On B, for each:
//   - ONE mesh under the host's uuid (not a Group of per-slot meshes), 3 slots, the host's groups exactly;
//   - every triangle inside a group whose slot exists (nothing goes undrawn);
//   - each slot's colour as on the host.
// Counterfactual (v1.74.0, serve build-base): the big mesh arrives as a Group of three meshes, red.
// Run (built): LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' e2e-slot --dev <lane> 7204 -- env APP_URL=https://theprototype.app:7204/ node tests/e2e/late-joiner-slots.test.cjs
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const made = await A.page.evaluate(async () => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		const THREE = await s.THREE;
		let g;
		/** @type {any} */ (window).__stores.objectsGroup.subscribe((v) => (g = v))();
		const out = {};
		for (const [key, geo] of [
			['big', new THREE.SphereGeometry(1, 160, 124)],
			['small', new THREE.BoxGeometry(1, 1, 1, 4, 4, 4)]
		]) {
			const geometry = new THREE.BufferGeometry().copy(geo);
			const n = geometry.index.count;
			const a = 3 * Math.floor(n / 18);
			const b = 3 * Math.floor(n / 6);
			geometry.clearGroups();
			geometry.addGroup(0, a, 2);
			geometry.addGroup(a, b - a, 0);
			geometry.addGroup(b, n - b, 1);
			const mats = [0xff2020, 0x20ff20, 0x2020ff].map((c) => new THREE.MeshStandardMaterial({ color: c }));
			const mesh = new THREE.Mesh(geometry, mats);
			mesh.name = key === 'big' ? 'Statue three slots' : 'Crate three slots';
			mesh.position.set(key === 'big' ? -2 : 2, 1, 0);
			g.add(mesh);
			out[key] = { uuid: mesh.uuid, vertices: geometry.attributes.position.count, groups: geometry.groups.map((x) => ({ ...x })), colors: mats.map((m) => m.color.getHex()) };
		}
		s.commandsHandler.pokeScene?.();
		return out;
	});
	h.check(made.big.vertices > 15000, `premise: the big mesh has ${made.big.vertices} vertices (> 15k: the glTF path)`);

	const B = await h.setupPageQuiet(browser, 'B', [A]);
	await h.connect(B, A);
	const read = (uuid) =>
		B.page.evaluate((u) => {
			let g;
			/** @type {any} */ (window).__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', u);
			if (!o) return { found: false };
			const slots = Array.isArray(o.material) ? o.material.length : o.material ? 1 : 0;
			const geometry = o.geometry;
			const total = geometry ? (geometry.index ? geometry.index.count : geometry.attributes.position.count) : 0;
			// every triangle inside a group whose slot exists
			const spans = (geometry?.groups ?? []).filter((x) => (x.materialIndex || 0) < slots && x.count > 0).map((x) => [x.start, x.start + x.count]).sort((p, q) => p[0] - q[0]);
			let covered = 0;
			let gap = false;
			for (const [s0, e0] of spans) {
				if (s0 > covered) gap = true;
				covered = Math.max(covered, e0);
			}
			return {
				found: true,
				type: o.type,
				children: o.children.filter((c) => c.isMesh).length,
				slots,
				groups: (geometry?.groups ?? []).map((x) => ({ start: x.start, count: x.count, materialIndex: x.materialIndex || 0 })),
				drawn: !gap && covered >= total && total > 0,
				colors: Array.isArray(o.material) ? o.material.map((m) => m.color?.getHex?.()) : []
			};
		}, uuid);
	for (const key of ['small', 'big']) {
		const want = made[key];
		await h.eventually(() => read(want.uuid), (r) => r.found, `${key}: B holds the host's object`, 60000);
		await B.page.waitForTimeout(800);
		const r = await read(want.uuid);
		console.log(key, JSON.stringify({ ...r, groups: r.groups?.length }));
		h.check(r.type === 'Mesh' && r.children === 0, `${key}: ONE mesh on B, not a group of per-slot meshes (${r.type}, ${r.children} mesh children)`);
		h.check(r.slots === 3, `${key}: 3 material slots (${r.slots})`);
		h.check(JSON.stringify(r.groups) === JSON.stringify(want.groups.map((x) => ({ start: x.start, count: x.count, materialIndex: x.materialIndex || 0 }))), `${key}: the host's groups exactly`);
		h.check(r.drawn, `${key}: every triangle drawn (inside a group whose slot exists)`);
		h.check(JSON.stringify(r.colors) === JSON.stringify(want.colors), `${key}: the same material on each slot (${r.colors.map((c) => c?.toString(16)).join(', ')})`);
	}
	await h.finish(browser);
});
