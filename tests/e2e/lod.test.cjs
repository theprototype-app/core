// 31-perf P2 — AUTOMATIC LEVELS OF DETAIL (src/lib/lod.js; the rule is lodCore.js, unit-tested
// in tests/unit/lodCore.test.js). This suite proves the WIRING on a live page:
//   1 a dense mesh in objectsGroup is picked up by the auto scan and its levels are built in
//     the decimation worker (meshoptimizer), once
//   2 THE REPORT'S PROPERTY: rendered from far away the frame's triangles DROP; up close they
//     are the source's — measured from renderer.info around a real render() call
//   3 the tree is untouched: outside a render the mesh holds its SOURCE geometry, and toJSON
//     (what every serializer writes) carries the full vertex count
//   4 COUNTERFACTUAL: with LOD switched off the far render draws every triangle
//   5 a geometry swap (a meshgeo / an undo) stands the entry down at once — the new geometry
//     draws whole, never a stale level of the old one
//   6 one asset, one set of levels: a second mesh sharing the content reuses the cache
//   7 the quality bias: a governor step pulls the switch distance in
//   8 api.lod on module content (scene-root, not objectsGroup) + teardown on deactivate,
//     and api.quality's shape (level, max, onChange -> off)

// Run: APP_URL=https://theprototype.app:5263/ npm run e2e -- lod
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	// in-page helpers: a dense sphere, a manual render from an explicit camera distance
	await page.evaluate(() => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		window.__lodt = {
			read,
			/** a dense mesh in objectsGroup (a loaded model's shape: one indexed mesh) */
			addDense(name, detail = 48, at = [0, 1, 0]) {
				const THREE = s.THREE;
				const geometry = new THREE.SphereGeometry(1, detail * 2, detail);
				const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x88aa44 }));
				mesh.name = name;
				mesh.position.set(...at);
				read(s.objectsGroup).add(mesh);
				s.pokeScene?.();
				return { uuid: mesh.uuid, tris: geometry.index.count / 3 };
			},
			mesh(name) {
				return read(s.objectsGroup).getObjectByName(name);
			},
			/** render the real scene from `dist` metres in front of `target` and read the
			 * triangles that ONE render() drew (shadow pass included) */
			renderFrom(dist, target = [0, 1, 0]) {
				const THREE = s.THREE;
				const r = read(s.globalRenderer);
				const scene = read(s.globalScene);
				const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
				cam.position.set(target[0], target[1], target[2] + dist);
				cam.lookAt(...target);
				cam.updateMatrixWorld(true);
				const auto = r.info.autoReset;
				r.info.autoReset = true;
				r.render(scene, cam);
				const tris = r.info.render.triangles;
				r.info.autoReset = auto;
				return tris;
			}
		};
	});
	const stats = () => page.evaluate(() => window.__stores.lod.lodStats());
	const lodOf = async (name) => (await stats()).meshes.find((m) => m.name === name) ?? null;

	// ---- 1 the auto scan picks the dense mesh up and builds its levels ------------------------
	const dense = await page.evaluate(() => window.__lodt.addDense('LOD dense', 48));
	h.check(dense.tris > 3000, '1.0 (premise) the mesh is dense enough for auto LOD (' + dense.tris + ' tris)');
	await page.evaluate(() => window.__stores.lod.scanForLod());
	await h.eventually(() => lodOf('LOD dense'), (m) => !!m && Array.isArray(m.levels) && m.levels.length >= 2, '1.1 the auto scan registered it and the worker built its levels', 20000);
	const entry = await lodOf('LOD dense');
	h.check(entry.levels[0] < entry.triangles * 0.6 && entry.levels[entry.levels.length - 1] < entry.triangles * 0.2, '1.2 each level is really coarser: ' + entry.triangles + ' -> ' + entry.levels.join(' -> '));
	const small = await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
		m.name = 'LOD small box';
		window.__lodt.read(s.objectsGroup).add(m);
		s.lod.scanForLod();
		return s.lod.lodStats().meshes.some((e) => e.name === 'LOD small box');
	});
	h.check(!small, '1.3 a 12-triangle box is left alone (under minTriangles)');

	// ---- 2 far away the frame's triangles drop; near, they are the source's -------------------
	const near = await page.evaluate(() => window.__lodt.renderFrom(3));
	const far = await page.evaluate(() => window.__lodt.renderFrom(400));
	h.check(near >= dense.tris, '2.1 up close the render draws the full mesh (' + near + ' >= ' + dense.tris + ')');
	h.check(far < near - dense.tris * 0.8, '2.2 THE PROPERTY: from 400 m the frame draws the LOW level (' + far + ' tris vs ' + near + ' near)');
	const mid = await page.evaluate(() => window.__lodt.renderFrom(12));
	h.check(mid < near && mid > far, '2.3 a middle distance draws a middle level (' + far + ' < ' + mid + ' < ' + near + ')');

	// ---- 3 the tree is untouched ----------------------------------------------------------------
	const tree = await page.evaluate(() => {
		const m = window.__lodt.mesh('LOD dense');
		window.__lodt.renderFrom(400);
		const json = m.toJSON();
		const levels = window.__stores.lod.lodStats().meshes.find((e) => e.name === 'LOD dense');
		return {
			tris: m.geometry.index.count / 3,
			levelTag: m.geometry.userData?.lodLevel ?? null,
			jsonGeometry: json.object.geometry,
			sourceUuid: m.geometry.uuid,
			jsonGeometries: json.geometries.map((g) => g.type),
			hasLevels: !!levels?.levels?.length
		};
	});
	h.check(tree.tris === dense.tris && tree.levelTag === null, '3.1 after a far render the mesh holds its SOURCE geometry again (' + tree.tris + ' tris)');
	h.check(tree.hasLevels && tree.jsonGeometry === tree.sourceUuid && tree.jsonGeometries.join() === 'SphereGeometry', '3.2 toJSON writes the SOURCE geometry and nothing else (' + tree.jsonGeometries.join() + ') — no serializer can see a level');

	// ---- 4 counterfactual: LOD off -> the far render draws every triangle ------------------------
	const off = await page.evaluate(() => {
		const s = window.__stores;
		s.lod.lodEnabled.set(false);
		const t = window.__lodt.renderFrom(400);
		s.lod.lodEnabled.set(true);
		return { t, stored: localStorage.getItem('lodEnabled') };
	});
	h.check(off.t >= dense.tris, '4.1 COUNTERFACTUAL: with LOD switched off the far render draws the full mesh (' + off.t + ')');
	h.check(off.stored === 'true', '4.2 the opt-out is a LOCAL pref, written back on (lodEnabled=' + off.stored + ')');

	// ---- 5 a geometry swap stands the entry down at once ----------------------------------------
	const swap = await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const m = window.__lodt.mesh('LOD dense');
		m.geometry = new THREE.SphereGeometry(1, 64, 32);
		const fresh = m.geometry.index.count / 3;
		const t = window.__lodt.renderFrom(400);
		return { fresh, t, still: m.geometry.index.count / 3 };
	});
	h.check(swap.t >= swap.fresh && swap.still === swap.fresh, '5.1 a swapped geometry draws WHOLE on the next frame — never a stale level of the old one (' + swap.t + ' >= ' + swap.fresh + ')');
	await h.eventually(
		async () => {
			await page.evaluate(() => window.__lodt.renderFrom(400)); // the swap check runs per render
			return lodOf('LOD dense');
		},
		(m) => !!m && m.triangles === swap.fresh && Array.isArray(m.levels) && m.levels.length >= 1,
		'5.2 once it has held still, the new geometry gets levels of its own',
		15000
	);

	// ---- 6 one asset, one set of levels ----------------------------------------------------------
	const shared = await page.evaluate(async () => {
		const s = window.__stores;
		const before = s.lod.lodStats().cached;
		const a = window.__lodt.addDense('LOD twin A', 40, [5, 1, 0]);
		const b = window.__lodt.addDense('LOD twin B', 40, [-5, 1, 0]);
		s.lod.scanForLod();
		await new Promise((r) => setTimeout(r, 3000));
		const st = s.lod.lodStats();
		return { before, after: st.cached, twins: st.meshes.filter((m) => m.name.startsWith('LOD twin')).map((m) => !!m.levels), a: a.tris, b: b.tris };
	});
	h.check(shared.twins.length === 2 && shared.twins.every(Boolean), '6.1 both placements have levels');
	h.check(shared.after === shared.before + 1, '6.2 the two placements of one asset share ONE cached set (cache ' + shared.before + ' -> ' + shared.after + ')');

	// ---- 7 the quality bias pulls the switch distance in -----------------------------------------
	const bias = await page.evaluate(() => {
		const s = window.__stores;
		const edge0 = s.lod.lodStats().meshes.find((m) => m.name === 'LOD twin A').edges[0];
		const at = (edge0 - 1) * 1; // just inside level 0's edge at bias 1 (radius 1)
		const full = window.__lodt.renderFrom(at, [5, 1, 0]);
		s.lod.lodBias.set(0.5);
		const biased = window.__lodt.renderFrom(at, [5, 1, 0]);
		s.lod.lodBias.set(1);
		return { edge0, at, full, biased };
	});
	h.check(bias.biased < bias.full, '7.1 at ' + bias.at + ' radii a bias of 0.5 already draws a coarser level (' + bias.full + ' -> ' + bias.biased + ')');

	// ---- 8 api.lod on module content + teardown; api.quality's shape -----------------------------
	const mod = await page.evaluate(async () => {
		const s = window.__stores;
		const out = {};
		await s.moduleSDK.initModules([
			{
				id: 'lodtest',
				name: 'LOD test',
				version: '1.0.0',
				description: 'api.lod + api.quality',
				register(api) {
					const THREE = api.THREE;
					const group = new THREE.Group();
					group.name = 'lodtest-content';
					const m = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), new THREE.MeshStandardMaterial());
					m.name = 'lodtest-ball';
					m.position.set(0, 1, -30);
					group.add(m);
					api.scene().add(group);
					const handle = api.lod(group, { ratios: [0.3], distances: [4] });
					out.meshes = handle.meshes;
					out.readyIsPromise = typeof handle.ready?.then === 'function';
					out.q = { level: api.quality.level, max: api.quality.max, hasOnChange: typeof api.quality.onChange === 'function' };
					window.__lodq = [];
					out.off = typeof api.quality.onChange((level) => window.__lodq.push(level));
				}
			}
		]);
		await new Promise((r) => setTimeout(r, 2500));
		out.registered = s.lod.lodStats().meshes.find((m) => m.name === 'lodtest-ball') ?? null;
		const r = window.__lodt;
		// the module's ball is at z -30 at scene root: render from 60 m in front of it
		out.far = r.renderFrom(60, [0, 1, -30]);
		s.qualityGovernor.governorForTest.setLevel(2);
		s.qualityGovernor.governorForTest.setLevel(0);
		out.changes = window.__lodq.slice();
		s.moduleSDK.deactivateModule('lodtest');
		out.afterDeactivate = s.lod.lodStats().meshes.some((m) => m.name === 'lodtest-ball');
		return out;
	});
	h.check(mod.meshes === 1 && mod.readyIsPromise, '8.1 api.lod(group) registers the module mesh and returns {meshes, ready, remove}');
	h.check(!!mod.registered && mod.registered.explicit && Array.isArray(mod.registered.levels) && mod.registered.levels.length === 1, '8.2 the module mesh (scene-root, not objectsGroup) got its explicit level: ' + JSON.stringify(mod.registered));
	h.check(mod.q.level === 0 && mod.q.max >= 9 && mod.q.hasOnChange && mod.off === 'function', '8.3 api.quality: level 0 (best), max ' + mod.q.max + ', onChange returns off()');
	h.check(JSON.stringify(mod.changes) === '[2,0]', '8.4 api.quality.onChange heard the level move 2 then back to 0: ' + JSON.stringify(mod.changes));
	h.check(mod.afterDeactivate === false, '8.5 deactivating the module drops its LOD entries (the teardown journal)');


	h.check(h.pageErrors(A).length === 0, 'no page errors (' + JSON.stringify(h.pageErrors(A)) + ')');

	await h.finish(browser);
});
