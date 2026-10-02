// 33 (K2) — REAL pack LOD files (33-pack-fix-lod's offline levels) through the loader. The
// pack files are served from a local checkout of that branch:
//   LOD_PACKS_DIR=<dir holding architecture-kit/, default/, cube_diorama/>
// (absent = SKIP, never fail). For each item: placed through the real list + import path, every
// level builds as a name-matched SWAP covering every mesh, far away the frame draws the level's
// triangles (measured from renderer.info with the piece shown vs hidden), and it has no page
// errors. Near/far shots (plain + "Show LOD level") go to LOD_SHOTS when set.
// Run: LOD_PACKS_DIR=... APP_URL=https://theprototype.app:5283/ npm run e2e -- lod-real-packs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const DIR = process.env.LOD_PACKS_DIR;
const SHOTS = process.env.LOD_SHOTS;
const ITEMS = [
	['architecture-kit', 'Gate'],
	['architecture-kit', 'WallStone'],
	['default', 'Duck'],
	['cube_diorama', 'Cat']
];

h.run(async () => {
	if (!DIR || !fs.existsSync(DIR)) {
		console.log('SKIP: LOD_PACKS_DIR not set / missing — nothing to check');
		console.log('ALL PASS');
		process.exit(0);
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const base = (await page.evaluate(() => window.__stores.packs.PACKS_BASE)).replace(/\/+$/, '');
	await page.route(base + '/**', (route) => {
		const rel = decodeURIComponent(route.request().url().slice(base.length + 1).split('?')[0]);
		const file = path.join(DIR, rel);
		if (!file.startsWith(DIR) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
		const type = file.endsWith('.json') ? 'application/json' : file.endsWith('.glb') ? 'model/gltf-binary' : 'application/octet-stream';
		route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
	});
	if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

	let x = -12;
	for (const [pack, name] of ITEMS) {
		x += 6;
		const res = await page.evaluate(
			async ({ base, pack, name, x }) => {
				const s = window.__stores;
				const read = (st) => {
					let v;
					st.subscribe((q) => (v = q))();
					return v;
				};
				const items = await s.packs.loadPackItems({ name: pack, base: base + '/' + pack, listUrl: base + '/' + pack + '/default.json', source: 'default' });
				const item = items.find((i) => i.name === name);
				if (!item) return { error: 'no row' };
				const r = await fetch(item.glbUrl);
				const uuid = await s.fileHandler.importFile(new File([await r.blob()], name + '.glb'), name, 'glb', [x, 0, 0], undefined, {
					packRef: s.packRefs.packRefFromUrl(item.glbUrl, { pack, item: name }),
					lod: s.lodGroup.placementGroupFor(item.glbUrl, item.lods)
				});
				const root = read(s.objectsGroup).getObjectByProperty('uuid', uuid);
				s.lodGroup.scanLodGroups();
				s.lodGroup.buildAllLevels(uuid);
				const end = performance.now() + 20000;
				let st;
				while (performance.now() < end) {
					st = s.lodGroup.lodGroupStats().find((g) => g.uuid === uuid);
					if (st && st.levels.every((l) => l.status === 'ready' || l.status === 'failed')) break;
					await new Promise((q) => setTimeout(q, 150));
				}
				// triangles the piece adds to ONE render from `d` m (shown minus hidden)
				const box = new s.THREE.Box3().setFromObject(root);
				const c = box.getCenter(new s.THREE.Vector3());
				const renderer = read(s.globalRenderer);
				const scene = read(s.globalScene);
				const drawn = (d) => {
					const cam = new s.THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
					cam.position.set(c.x, c.y, c.z + d);
					cam.lookAt(c);
					cam.updateMatrixWorld(true);
					const auto = renderer.info.autoReset;
					renderer.info.autoReset = true;
					renderer.render(scene, cam);
					const on = renderer.info.render.triangles;
					root.visible = false;
					renderer.render(scene, cam);
					const off = renderer.info.render.triangles;
					root.visible = true;
					renderer.info.autoReset = auto;
					return on - off;
				};
				const radius = st.radius;
				const near = drawn(radius * 2.5);
				const far = drawn(radius * 60);
				let meshes = 0;
				root.traverse((o) => o.isMesh && !o.isSkinnedMesh && meshes++);
				return { uuid, lods: item.lods, levels: st.levels, meshes, near, far, radius };
			},
			{ base, pack, name, x }
		);
		if (res.error) {
			h.check(false, pack + '/' + name + ': ' + res.error);
			continue;
		}
		const tag = pack + '/' + name;
		const lv = res.levels.slice(1);
		h.check(lv.length === res.lods.length && lv.every((l) => l.status === 'ready' && l.kind === 'swap'), tag + ': every level file builds as a SWAP (' + JSON.stringify(lv.map((l) => [l.status, l.kind, l.error])) + ')');
		h.check(lv.every((l) => l.paired === res.meshes), tag + ': each level matched ALL ' + res.meshes + ' meshes by name (' + lv.map((l) => l.paired) + ')');
		const coarse = lv[lv.length - 1];
		h.check(res.far > 0 && res.far < res.near * 0.75, tag + ': far away the frame draws fewer triangles (' + res.near + ' near -> ' + res.far + ' far; coarsest level ' + coarse.tris + ', LOD0 ' + res.levels[0].tris + ')');
		if (SHOTS) {
			for (const [label, dist, overlay] of [['near', 2.5, false], ['far', 12, false], ['far-overlay', 12, true]]) {
				await page.evaluate(
					({ uuid, dist, overlay }) => {
						const s = window.__stores;
						let g;
						s.objectsGroup.subscribe((v) => (g = v))();
						const root = g.getObjectByProperty('uuid', uuid);
						const box = new s.THREE.Box3().setFromObject(root);
						const c = box.getCenter(new s.THREE.Vector3());
						const r = s.lodGroup.lodGroupStats().find((x) => x.uuid === uuid).radius;
						s.lod.lodShowLevels.set(overlay);
						s.objectActions.flyTo([c.x, c.y + r * 0.6, c.z + r * dist], [c.x, c.y, c.z], 0);
					},
					{ uuid: res.uuid, dist, overlay }
				);
				await page.waitForTimeout(700);
				await page.screenshot({ path: path.join(SHOTS, name + '-' + label + '.png') });
			}
			await page.evaluate(() => window.__stores.lod.lodShowLevels.set(false));
		}
	}
	h.check(h.pageErrors(A).length === 0, 'no page errors (' + JSON.stringify(h.pageErrors(A)) + ')');
	await h.finish(browser);
});
