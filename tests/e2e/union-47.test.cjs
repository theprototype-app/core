// 47-int — the roadmap 47 lanes wired to roadmap 46 (the union's own touch points), one desktop page.
//   C  a CC0 model (recorded fixtures) placed under 46's import auto-optimize: the optimized copy in the
//      Library names the same CC0 source, and so does the placed object (the engine rewrote its file)
//   T1 the budget meter counts a terrain's scatter (a scene-root holder) on the terrain's row
//   T2 46's LOD reaches a dense scatter model: its instances are split into cells, each cell takes levels
//      and picks one by its NEAREST instance (near cell full detail, far cell coarse); a light model
//      (a primitive) stays ONE draw call per set
const h = require('./helpers.cjs');
const { makeCc0Network } = require('./cc0Fixtures.cjs');

/** read a store off the debug hook @param {any} page @param {string} expr */
const store = (page, expr) =>
	page.evaluate((e) => {
		const s = e.split('.').reduce((o, k) => o?.[k], window.__tp?.test.v1);
		let v;
		s.subscribe((x) => (v = x))();
		return JSON.parse(JSON.stringify(v ?? null, (k, val) => (k === 'thumbnail' ? undefined : val)));
	}, expr);

/** @param {any} page @param {number[]} pos @param {number[]} target */
async function look(page, pos, target) {
	await page.evaluate(
		([p, t]) => {
			let cam, orbit;
			window.__tp.test.v1.editorCam.subscribe((v) => (cam = v))();
			window.__tp.test.v1.orbitControls.subscribe((v) => (orbit = v))();
			cam.position.set(p[0], p[1], p[2]);
			orbit?.target?.set(t[0], t[1], t[2]);
			orbit?.update?.();
			cam.lookAt(t[0], t[1], t[2]);
			window.__tp.test.v1.pokeScene?.();
		},
		[pos, target]
	);
}

/** one scatter stroke at each local (x, z) @param {any} page @param {string} uuid @param {any} source @param {number[][]} spots */
const scatter = (page, uuid, source, spots) =>
	page.evaluate(
		async ([u, src, pts]) => {
			const s = window.__tp?.test.v1;
			s.terrainSculpt.enterSculpt(u);
			s.terrainSculpt.sculptOp.set('scatter');
			s.terrainSculpt.sculptRadius.set(3);
			s.terrainPaint.scatterSource.set(src);
			s.terrainPaint.scatterDensity.set(0.5);
			s.terrainPaint.scatterErase.set(false);
			for (const [x, z] of pts) {
				s.terrainSculpt.beginStroke(u);
				for (let i = 0; i < 8; i++) s.terrainSculpt.strokeMove(u, x, z, 0.05);
				s.terrainSculpt.endStroke();
			}
			await new Promise((r) => setTimeout(r, 150));
		},
		[uuid, source, spots]
	);

h.run(async () => {
	const net = makeCc0Network();
	const browser = await h.launch(h.GPU_ARGS ? { args: h.GPU_ARGS } : undefined);
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await net.routes(page);
	const { model } = net.ids;

	// ---- C: a CC0 model through 46's auto-optimize -----------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.closeMenu.set(false));
	await page.locator('#open-asset-browser').click();
	await page.waitForSelector('#asset-browser-window', { timeout: 20000 });
	await page.waitForFunction(() => Number(document.querySelector('#asset-browser-grid')?.dataset.count) > 0, null, { timeout: 30000 }).catch(() => {});
	await page.click('#asset-browser-res-1k');
	await page.locator(`.ab-card[data-asset-id="${model}"] [data-act="library"]`).click();
	await page
		.waitForFunction((i) => document.querySelector(`.ab-card[data-asset-id="${i}"]`)?.dataset.held === 'true', model, { timeout: 60000 })
		.catch(() => {});
	const item = (await store(page, 'explorer.explorerItems')).find((i) => i.source?.id === model);
	h.check(!!item && item.source?.license === 'CC0', `C.1 the model is in the Library with its CC0 source (${item?.name})`);
	await page.locator('#asset-browser-close').click().catch(() => {});
	// the per-asset override says Always (46 P2), so placing it runs the optimizer on this small file
	const placedUuid = await page.evaluate(async (id) => {
		const s = window.__tp?.test.v1;
		s.importOptimize.setAssetOverride(id, { mode: 'always' }); // the debug hook (a deployed build has no /src paths)
		let items;
		s.explorer.explorerItems.subscribe((x) => (items = x))();
		return s.cc0.placeItem(items.find((i) => i.id === id));
	}, item?.id);
	h.check(typeof placedUuid === 'string', `C.2 Add to scene placed it (${placedUuid})`);
	await h.eventually(
		() => store(page, 'explorer.explorerItems').then((items) => items.find((i) => i.optimizedFrom === item?.hash) ?? null),
		(twin) => !!twin,
		'C.3 the optimizer kept an optimized copy beside the original',
		30000
	);
	const twin = (await store(page, 'explorer.explorerItems')).find((i) => i.optimizedFrom === item?.hash);
	h.check(twin?.source?.id === model && twin?.source?.license === 'CC0' && twin?.source?.url === item?.source?.url, `C.4 the optimized copy names the same CC0 source (${JSON.stringify(twin?.source ?? null).slice(0, 120)})`);
	const placed = await page.evaluate((u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', u);
		return o ? { optimized: !!o.userData?.optimized, source: o.userData?.source ?? null } : null;
	}, placedUuid);
	h.check(placed?.optimized === true, 'C.5 the placed object IS the optimized one (userData.optimized)');
	h.check(placed?.source?.id === model && placed?.source?.license === 'CC0', `C.6 ...and still carries its CC0 source (${placed?.source?.id})`);
	await page.evaluate((u) => window.__tp.test.v1.commandsHandler.sceneCommand('/delete ' + u), placedUuid).catch(() => {});

	// ---- T1: the budget meter counts the scatter ---------------------------------------------------
	const uuid = await page.evaluate(async () => {
		window.__tp.test.v1.commandsHandler.sceneCommand('/create Terrain 96 48');
		await new Promise((r) => setTimeout(r, 800));
		const group = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		return group.children[group.children.length - 1].uuid;
	});
	const reading = () =>
		page.evaluate((u) => {
			const r = window.__tp.test.v1.budgetMeter.sampleBudget();
			const row = r.rows.find((x) => x.uuid === u);
			return { tris: r.totals.triangles, calls: r.totals.calls, rowTris: row?.triangles ?? null, rowCalls: row?.calls ?? null };
		}, uuid);
	const before = await reading();
	await scatter(page, uuid, { kind: 'primitive', type: 'Cone' }, [
		[-40, -40],
		[40, 40],
		[0, 0]
	]);
	const cones = await page.evaluate(() => window.__tp.test.v1.terrainSurface.terrainSurfaceStats());
	h.check(cones.instances > 10, `T1.1 three strokes scattered cones (${cones.instances})`);
	h.check(cones.instancedMeshes === 1, `T1.2 a light model stays ONE InstancedMesh for the set, across the terrain (${cones.instancedMeshes})`);
	const after = await reading();
	h.check(after.tris - before.tris === cones.tris, `T1.3 the meter's triangles grow by exactly the scatter's (${before.tris} -> ${after.tris}, scatter ${cones.tris})`);
	h.check(after.rowTris - before.rowTris === cones.tris && after.rowCalls === before.rowCalls + 1, `T1.4 ...on the TERRAIN's row, +1 call (${before.rowCalls} -> ${after.rowCalls})`);

	// ---- T2: a dense Library model takes 46's LOD, per cell ---------------------------------------
	const ball = await page.evaluate(async () => {
		const s = window.__tp?.test.v1;
		const THREE = s.THREE;
		const { GLTFExporter } = s.GLTFExporterModule;
		const scene = new THREE.Scene();
		const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.MeshStandardMaterial({ color: 0x55aa55 }));
		mesh.name = 'Shrub';
		scene.add(mesh);
		const buf = await new GLTFExporter().parseAsync(scene, { binary: true });
		const it = await s.explorer.addItemFromBytes(buf, 'Shrub.glb');
		return { hash: it.hash, tris: mesh.geometry.index.count / 3 };
	});
	await scatter(page, uuid, { kind: 'library', hash: ball.hash, name: 'Shrub.glb' }, [
		[-40, -40],
		[40, 40]
	]);
	await h.eventually(
		() => page.evaluate(() => window.__tp.test.v1.terrainSurface.terrainSurfaceStats().instancedMeshes),
		(n) => n >= 3,
		'T2.1 the dense model is laid out (in cells)',
		30000
	);
	const cells = await page.evaluate((hash) => {
		let scene;
		window.__tp.test.v1.globalScene.subscribe((x) => (scene = x))();
		const holder = scene.children.find((c) => c.name === 'terrain-scatter');
		return holder.children.filter((m) => m.geometry.index && m.geometry.index.count / 3 > 1000).map((m) => ({ uuid: m.uuid, count: m.count }));
	}, ball.hash);
	h.check(cells.length === 2, `T2.2 two far-apart strokes = two cells for the dense model (${cells.length}: ${cells.map((c) => c.count)})`);
	const meter = await reading();
	const stats2 = await page.evaluate(() => window.__tp.test.v1.terrainSurface.terrainSurfaceStats());
	h.check(meter.tris - before.tris === stats2.tris, `T2.3 the meter counts every instance of both sets (${meter.tris - before.tris} = ${stats2.tris})`);
	await h.eventually(
		() => page.evaluate((ids) => window.__tp.test.v1.lod.lodStats().meshes.filter((m) => ids.includes(m.uuid) && m.explicit && m.levels?.length).length, cells.map((c) => c.uuid)),
		(n) => n === 2,
		'T2.4 both cells registered with 46 LOD and their levels built',
		30000
	);
	// stand next to the (-40, -40) stroke, looking across the terrain at the far one
	await look(page, [-44, 6, -44], [40, 0, 40]);
	await page.waitForTimeout(800);
	const levels = await page.evaluate((ids) => {
		const st = window.__tp.test.v1.lod.lodStats();
		let scene;
		window.__tp.test.v1.globalScene.subscribe((x) => (scene = x))();
		const holder = scene.children.find((c) => c.name === 'terrain-scatter');
		return ids.map((id) => {
			const m = holder.children.find((c) => c.uuid === id);
			m.geometry.computeBoundingBox();
			const e = st.meshes.find((x) => x.uuid === id);
			const c = m.boundingSphere.center;
			return { near: c.x < 0, current: e?.current ?? null, levels: e?.levels };
		});
	}, cells.map((c) => c.uuid));
	const near = levels.find((l) => l.near);
	const far = levels.find((l) => !l.near);
	h.check(near?.current === 0, `T2.5 the cell beside the camera draws full detail (level ${near?.current})`);
	h.check((far?.current ?? 0) >= 2, `T2.6 the cell across the terrain draws a coarse level (level ${far?.current}, levels ${JSON.stringify(far?.levels)})`);
	// clearing the scatter lets the LOD entries go (no leak through lod.js)
	await page.evaluate((u) => window.__tp.test.v1.terrainSurface.applyTerrainScatter(u, null), uuid);
	const left = await page.evaluate((ids) => window.__tp.test.v1.lod.lodStats().meshes.filter((m) => ids.includes(m.uuid)).length, cells.map((c) => c.uuid));
	h.check(left === 0, `T2.7 removing the scatter releases its LOD entries (${left} left)`);
	await browser.close();
});
