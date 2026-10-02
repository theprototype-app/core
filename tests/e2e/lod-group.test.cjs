// 33 (K2/K6) — LOD GROUPS (src/lib/lodGroup.js + lodGroupActions.js; the rule is
// lodGroupCore.js, unit-tested in tests/unit/lodGroupCore.test.js). A FIXTURE PACK is served
// through page.route (a dense ball + two offline LOD files, made in-page with the app's own
// GLTFExporter), so nothing here depends on the CDN carrying lods yet.
//   1 contract P1: a pack item's `lods` place as the object's group; the LOD files are NOT
//     fetched until a level is needed; far away the frame draws LOD2's triangles, the mesh
//     keeps ITS OWN material during the draw (shared), the tree/stub never see a level
//   2 the implicit group: a pack piece placed before its pack had lods picks them up
//   3 hysteresis on a camera path: walking back and forth over an edge switches once
//   4 forced + the opt-out
// Run: APP_URL=https://theprototype.app:5283/ npm run e2e -- lod-group
const h = require('./helpers.cjs');
const { setupLodFixture } = require('./lodFixture.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	const { fixture, hits, base } = await setupLodFixture(page);
	h.check(fixture.lod0.tris > 8000 && fixture.lod2.tris < 150, '0.1 (premise) the fixture: LOD0 ' + fixture.lod0.tris + ' tris, LOD1 ' + fixture.lod1.tris + ', LOD2 ' + fixture.lod2.tris);

	// ---- 1 contract P1 ---------------------------------------------------------------------------
	const placed = await page.evaluate(async () => {
		const r = await window.__lg.placeBall('Ball', [0, 1, 0]);
		const root = window.__lg.byUuid(r.uuid);
		return { ...r, lod: JSON.parse(JSON.stringify(root?.userData?.lod ?? null)) };
	});
	h.check(Array.isArray(placed.itemLods) && placed.itemLods.length === 2, '1.1 loadPackItems carries the row\'s lods: ' + JSON.stringify(placed.itemLods));
	h.check(
		!!placed.lod && placed.lod.levels.length === 3 && placed.lod.levels[0].source === 'self' && placed.lod.levels[1].ref === 'lodtest/Ball/glTF-Binary/ball.lod1.glb' && placed.lod.levels[2].ref === 'lodtest/Ball/glTF-Binary/ball.lod2.glb',
		'1.2 the placed object carries its LOD GROUP (finest first, refs beside its file): ' + JSON.stringify(placed.lod)
	);
	await page.evaluate(() => window.__stores.lodGroup.scanLodGroups());
	const near = await page.evaluate(() => window.__lg.drawnFrom('Ball', 4, [0, 1, 0]));
	// the editor's own view may already have needed LOD1 (its camera sits ~10 m away); nothing
	// has needed LOD2 yet, so it must not have been fetched
	h.check(hits.lod2 === 0, '1.3 LAZY: no view needed LOD2 yet, so its file was NOT fetched (lod2 ' + hits.lod2 + ', lod1 ' + hits.lod1 + ' for the editor view)');
	h.check(near.seen.length >= 1 && near.seen.every((d) => d.tris === fixture.lod0.tris), '1.4 up close it draws LOD0 (' + JSON.stringify(near.seen) + ')');
	// far: the first far render ASKS for the level; it draws LOD0 until the level has landed
	await page.evaluate(() => window.__lg.renderFrom(400));
	await h.eventually(
		() => page.evaluate(() => window.__stores.lodGroup.lodGroupStats().find((g) => g.name === 'Ball')),
		(g) => !!g && g.levels[2].status === 'ready',
		'1.5 the far render asked for LOD2 and it was built from the pack file',
		15000
	);
	h.check(hits.lod2 === 1, '1.6 LOD2 was fetched ONCE (' + hits.lod2 + ')');
	const far = await page.evaluate(() => window.__lg.drawnFrom('Ball', 400, [0, 1, 0]));
	h.check(far.seen.length >= 1 && far.seen.every((d) => d.tris === fixture.lod2.tris), '1.7 THE PROPERTY: from 400 m the mesh DRAWS LOD2\'s triangles (' + JSON.stringify(far.seen) + ', file ' + fixture.lod2.tris + ')');
	h.check(far.seen.every((d) => d.ownMaterial), '1.8 shared materials: during the draw the mesh wears ITS OWN material (no copy)');
	h.check(far.afterTris === fixture.lod0.tris && far.afterOwn, '1.9 after the render the mesh holds LOD0 again — the tree never sees a level');
	const mid = await page.evaluate(async () => {
		window.__lg.renderFrom(14);
		await new Promise((r) => setTimeout(r, 800));
		return window.__lg.drawnFrom('Ball', 14, [0, 1, 0]);
	});
	h.check(mid.seen.every((d) => d.tris === fixture.lod1.tris), '1.10 a middle distance draws LOD1 (' + JSON.stringify(mid.seen) + ')');
	const stub = await page.evaluate((uuid) => {
		const s = window.__stores;
		const root = window.__lg.read(s.objectsGroup).getObjectByProperty('uuid', uuid);
		window.__lg.renderFrom(400);
		const el = s.packRefs.isPristinePackRef(root) ? s.packRefs.stubElementOf(root) : null;
		return { pristine: !!el, lod: el?.object?.userData?.lod ?? null, levelsInTree: (() => {
			let n = 0;
			root.traverse((o) => o.isMesh && n++);
			return n;
		})() };
	}, placed.uuid);
	h.check(stub.pristine && stub.lod?.levels?.length === 3, '1.11 the piece still saves as a pack STUB, and the stub carries its group');
	h.check(stub.levelsInTree === 1, '1.12 no level ever entered the tree (meshes under the root: ' + stub.levelsInTree + ')');
	const autoLod = await page.evaluate(() => window.__stores.lod.lodStats().meshes.filter((m) => m.name === 'Body').length);
	h.check(autoLod === 0, '1.13 the group\'s mesh left 31-perf\'s auto LOD (one system draws it, not two)');

	// ---- 2 the implicit group (a piece placed before its pack had lods) -----------------------------
	const implicit = await page.evaluate(async () => {
		const s = window.__stores;
		const { uuid } = await window.__lg.placeBall('Old ball', [6, 1, 0], false);
		await new Promise((r) => setTimeout(r, 1500));
		s.lodGroup.scanLodGroups();
		const root = window.__lg.byUuid(uuid);
		return { uuid, stored: root.userData.lod ?? null, info: s.lodGroup.lodGroupInfo(uuid) };
	});
	h.check(implicit.stored === null, '2.1 (premise) the old piece carries no block');
	h.check(!!implicit.info && implicit.info.implicit && implicit.info.levels.length === 3, '2.2 it runs on an IMPLICIT group from its pack row: ' + JSON.stringify(implicit.info?.levels?.map((l) => l.source)));
	const impFar = await page.evaluate(async () => {
		window.__lg.renderFrom(400, [6, 1, 0]);
		await new Promise((r) => setTimeout(r, 1500));
		return window.__lg.drawnFrom('Old ball', 400, [6, 1, 0]);
	});
	h.check(impFar.seen.every((d) => d.tris === fixture.lod2.tris), '2.3 and from far away it draws LOD2 too (' + JSON.stringify(impFar.seen) + ')');
	h.check(hits.lod2 === 1, '2.4 its LOD2 came from the SAME parsed file (fetched once for both pieces: ' + hits.lod2 + ')');

	// ---- 3 hysteresis on a camera path --------------------------------------------------------------
	const path = await page.evaluate(() => {
		const s = window.__stores;
		const info = s.lodGroup.lodGroupInfo(window.__lg.byName('Ball').uuid);
		// the distance where LOD0 meets LOD1 at fov 50 for this radius
		const g = s.lodGroup.lodGroupStats().find((x) => x.name === 'Ball');
		const r = g.radius; // the runtime's own bounding radius (1 for the fixture ball)
		const t0 = info.block.levels[0].screenSize;
		// the quality governor's bias pulls every threshold in (a busy headless box steps it down)
		const q = s.lod.lodStats().bias || 1;
		const dEdge = r / ((t0 / q) * Math.tan((50 * Math.PI) / 360));
		window.__lg.renderFrom(2); // start the walk from LOD0 (one camera's history, not the editor's)
		const seq = [];
		// a walk that wobbles +-2% around the edge for 60 frames (a head bob on the line)
		for (let i = 0; i < 60; i++) {
			window.__lg.renderFrom(dEdge * (1 + (i % 2 ? 0.02 : -0.02)));
			seq.push(s.lodGroup.lodGroupStats().find((x) => x.name === 'Ball').current);
		}
		let switches = 0;
		for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) switches++;
		return { dEdge, switches, first: seq[0], last: seq[seq.length - 1], g: !!g };
	});
	h.check(path.first === 0, '3.0 (premise) the walk starts on LOD0 (' + path.first + ')');
	h.check(path.switches === 1 && path.last === 1, '3.1 HYSTERESIS: a camera bobbing on the LOD0/LOD1 edge (' + path.dEdge.toFixed(1) + ' m) switches exactly once in 60 frames, then holds LOD1 (' + path.switches + ', last ' + path.last + ')');

	// ---- 4 forced + the opt-out ---------------------------------------------------------------------
	const forced = await page.evaluate(async (uuid) => {
		const s = window.__stores;
		s.lodGroupActions.forceLodLevel(uuid, 2);
		const near = window.__lg.drawnFrom('Ball', 4, [0, 1, 0]);
		s.lodGroupActions.forceLodLevel(uuid, 'auto');
		const back = window.__lg.drawnFrom('Ball', 4, [0, 1, 0]);
		s.lod.lodEnabled.set(false);
		const off = window.__lg.drawnFrom('Ball', 400, [0, 1, 0]);
		s.lod.lodEnabled.set(true);
		return { near: near.seen.map((d) => d.tris), back: back.seen.map((d) => d.tris), off: off.seen.map((d) => d.tris) };
	}, placed.uuid);
	h.check(forced.near.every((t) => t === fixture.lod2.tris), '4.1 Force LOD2: up close it draws LOD2 (' + forced.near + ')');
	h.check(forced.back.every((t) => t === fixture.lod0.tris), '4.2 back to Auto: up close it draws LOD0 again (' + forced.back + ')');
	h.check(forced.off.every((t) => t === fixture.lod0.tris), '4.3 COUNTERFACTUAL: with LOD switched off the far render draws LOD0 (' + forced.off + ')');

	h.check(h.pageErrors(A).length === 0, 'no page errors (' + JSON.stringify(h.pageErrors(A)) + ')');
	await h.finish(browser);
});
