// T-1: Add > Terrain — a replicated subdivided ground plane under the meshgeo
// cap, stamped userData.terrain, appearing in the Add menu catalog.
const h = require('./helpers.cjs');

const terrainInfo = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					let t = null;
					g?.traverse((o) => {
						if (o.isMesh && o.name === 'Terrain') t = o;
					});
					if (!t) return resolve(null);
					t.geometry.computeBoundingBox();
					const size = t.geometry.boundingBox.getSize(new window.__stores.THREE.Vector3());
					resolve({
						uuid: t.uuid,
						tris: t.geometry.index ? t.geometry.index.count / 3 : t.geometry.attributes.position.count / 3,
						verts: t.geometry.attributes.position.count,
						terrainFlag: t.userData.terrain === true,
						sizeX: Math.round(size.x),
						sizeZ: Math.round(size.z),
						color: '#' + t.material.color.getHexString()
					});
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create Terrain 24 48'));
	await B.page.waitForTimeout(1200);

	const a = await terrainInfo(A.page);
	h.check(!!a, 'terrain created on A');
	h.check(a.tris === 4608, `terrain has 4608 tris (${a.tris}) — under the meshgeo cap`);
	h.check(a.verts === 2401, `terrain has 49x49 = 2401 vertices (${a.verts})`);
	h.check(a.terrainFlag === true, 'terrain stamped userData.terrain');
	h.check(a.sizeX === 24 && a.sizeZ === 24, `terrain spans 24x24 (${a.sizeX}x${a.sizeZ})`);
	h.check(a.color === '#81b29a', `terrain uses the sage color (${a.color})`);

	const b = await terrainInfo(B.page);
	h.check(!!b && b.uuid === a.uuid, 'terrain replicated to B with the same uuid');
	h.check(b && b.tris === a.tris && b.terrainFlag === true, 'B terrain matches geometry + flag');

	// segments clamp: a hand-typed over-cap count is limited to 48
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create Terrain 30 100'));
	await A.page.waitForTimeout(400);
	const clamped = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					let max = 0;
					g?.traverse((o) => {
						if (o.isMesh && o.name === 'Terrain') {
							const tris = o.geometry.index ? o.geometry.index.count / 3 : 0;
							max = Math.max(max, tris);
						}
					});
					resolve(max);
				})();
			})
	);
	h.check(clamped <= 4608, `segments clamp holds the tri count under the cap (max ${clamped})`);

	await h.finish(browser);
});
