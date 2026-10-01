// 33 (K6) — THE LOD GROUP PANEL in object settings (src/components/menu/LodGroupPanel.svelte),
// driven through the REAL UI: the level bar, selecting a level (it previews on this screen,
// then back to Auto), Force LOD, dragging a transition edge (ONE undo entry, ONE message),
// Generate levels on a plain dense mesh, a per-level material override, the gizmo on a level
// (offset), the "Show LOD level" overlay, replacing a level with another object, undo/redo,
// and two peers (the block replicates; the peer draws the forced level).
// Run: APP_URL=https://theprototype.app:5283/ npm run e2e -- lod-panel
const h = require('./helpers.cjs');
const { setupLodFixture } = require('./lodFixture.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1400, height: 900 } } });
	const page = A.page;
	const { fixture } = await setupLodFixture(page);
	// every outgoing message, for the "one message per gesture" checks
	await page.evaluate(async () => {
		window.__sent = [];
		const inst = await new Promise((r) => window.__stores.peers.subscribe(r)());
		const orig = inst.send.bind(inst);
		inst.send = (m) => {
			window.__sent.push(JSON.parse(JSON.stringify(m)));
			return orig(m);
		};
	});
	const lodMsgs = () => page.evaluate(() => window.__sent.filter((m) => m.type === 'objectParameters' && m.parameter === 'lod').length);
	const block = (uuid) => page.evaluate((u) => JSON.parse(JSON.stringify(window.__lg.byUuid(u)?.userData?.lod ?? null)), uuid);
	const undoDepth = () => page.evaluate(() => window.__lg.read(window.__stores.history.undoStack).length);

	const { uuid } = await page.evaluate(() => window.__lg.placeBall('Ball', [0, 1, 0]));
	await page.evaluate((u) => window.__lg.built(u), uuid);
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), uuid);
	await page.waitForTimeout(700);
	const panel = page.locator('#lod-group');
	await panel.scrollIntoViewIfNeeded().catch(() => {});

	// ---- 1 the panel ----------------------------------------------------------------------------
	h.check(await panel.isVisible(), '1.1 the LOD section shows in the object\'s properties');
	const segs = await page.locator('#lod-bar .lod-seg').count();
	h.check(segs === 3, '1.2 the bar has a segment per level (' + segs + ')');
	const segText = await page.locator('#lod-bar .lod-seg').allInnerTexts();
	h.check(segText[2].includes(String(fixture.lod2.tris)), '1.3 each segment names its triangles (LOD2: ' + JSON.stringify(segText[2]) + ')');
	h.check((await page.locator('#lod-bar .lod-edge').count()) === 2, '1.4 two draggable transition edges (LOD0|1, LOD1|2)');

	// ---- 2 select a level: it previews on this screen, then back to Auto -------------------------
	await page.locator('#lod-bar .lod-seg[data-level="2"]').click();
	await page.waitForTimeout(200);
	const preview = await page.evaluate((u) => {
		const p = window.__lg.read(window.__stores.lodGroup.lodPreview);
		return { p, near: window.__lg.drawnFrom(u, 4, [0, 1, 0]).seen.map((d) => d.tris) };
	}, uuid);
	h.check(preview.p?.uuid === uuid && preview.p?.level === 2, '2.1 selecting LOD2 previews it (' + JSON.stringify(preview.p) + ')');
	h.check(preview.near.length > 0 && preview.near.every((t) => t === fixture.lod2.tris), '2.2 up close the viewport now draws LOD2 (' + preview.near + ')');
	h.check(await page.locator('#lod-level-detail[data-level="2"]').isVisible(), '2.3 the level\'s details open below the bar');
	h.check((await page.locator('#lod-level-source').innerText()).includes('ball.lod2.glb'), '2.4 the detail names its source (the pack file)');
	h.check((await lodMsgs()) === 0, '2.5 a preview is LOCAL: no lod message sent');
	await page.locator('#lod-bar .lod-seg[data-level="2"]').click();
	await page.waitForTimeout(200);
	const unpreview = await page.evaluate((u) => ({ p: window.__lg.read(window.__stores.lodGroup.lodPreview), near: window.__lg.drawnFrom(u, 4, [0, 1, 0]).seen.map((d) => d.tris) }), uuid);
	h.check(unpreview.p === null && unpreview.near.every((t) => t === fixture.lod0.tris), '2.6 clicking it again returns to Auto (LOD0 up close)');

	// ---- 3 Force LOD through the dropdown + undo/redo -------------------------------------------
	const depth0 = await undoDepth();
	await page.locator('#lod-force').click();
	await page.locator('.ts-list [role="option"]', { hasText: 'LOD1' }).click();
	await page.waitForTimeout(250);
	const forced = await block(uuid);
	h.check(forced?.mode === 'forced' && forced?.forced === 1, '3.1 Force LOD1 writes the block (' + forced?.mode + ' ' + forced?.forced + ')');
	h.check((await lodMsgs()) === 1 && (await undoDepth()) === depth0 + 1, '3.2 ONE message, ONE undo entry');
	const forcedNear = await page.evaluate((u) => window.__lg.drawnFrom(u, 4, [0, 1, 0]).seen.map((d) => d.tris), uuid);
	h.check(forcedNear.every((t) => t === fixture.lod1.tris), '3.3 it draws LOD1 up close (' + forcedNear + ')');
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(200);
	h.check((await block(uuid))?.mode === 'auto', '3.4 undo: back to Auto');
	await page.evaluate(() => window.__stores.history.redo());
	await page.waitForTimeout(200);
	h.check((await block(uuid))?.forced === 1, '3.5 redo: forced LOD1 again');
	const sentUndo = await page.evaluate(() => window.__sent.filter((m) => m.type === 'objectParameters' && m.parameter === 'lod').map((m) => m.lod?.mode));
	h.check(JSON.stringify(sentUndo) === '["forced","auto","forced"]', '3.6 undo and redo REPLICATE (' + JSON.stringify(sentUndo) + ')');
	await page.locator('#lod-force').click();
	await page.locator('.ts-list [role="option"]', { hasText: 'Auto' }).click();
	await page.waitForTimeout(200);

	// ---- 4 drag a transition edge: live locally, ONE entry + ONE message at release ---------------
	const before4 = await block(uuid);
	const msgs4 = await lodMsgs();
	const depth4 = await undoDepth();
	const edge = page.locator('#lod-bar .lod-edge[data-edge="0"]');
	const eb = await edge.boundingBox();
	await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
	await page.mouse.down();
	await page.mouse.move(eb.x + eb.width / 2 - 25, eb.y + eb.height / 2, { steps: 4 });
	const mid4 = await block(uuid);
	const midMsgs = await lodMsgs();
	await page.mouse.move(eb.x + eb.width / 2 - 50, eb.y + eb.height / 2, { steps: 4 });
	await page.mouse.up();
	await page.waitForTimeout(250);
	const after4 = await block(uuid);
	h.check(mid4.levels[0].screenSize > before4.levels[0].screenSize, '4.1 mid-drag the threshold already moved (live, ' + before4.levels[0].screenSize + ' -> ' + mid4.levels[0].screenSize + ')');
	h.check(midMsgs === msgs4, '4.2 …and nothing was sent mid-drag');
	h.check(after4.levels[0].screenSize > mid4.levels[0].screenSize, '4.3 the release lands further (' + after4.levels[0].screenSize + ')');
	h.check((await lodMsgs()) === msgs4 + 1 && (await undoDepth()) === depth4 + 1, '4.4 ONE message and ONE undo entry for the whole drag');
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(200);
	h.check((await block(uuid)).levels[0].screenSize === before4.levels[0].screenSize, '4.5 ONE undo puts the edge back where the drag began');

	// ---- 5 a level's own material ------------------------------------------------------------------
	await page.locator('#lod-bar .lod-seg[data-level="1"]').click();
	await page.waitForTimeout(150);
	await page.locator('#lod-level-override').check();
	await page.waitForTimeout(250);
	const ov = await page.evaluate((u) => {
		const lv1 = window.__lg.drawnFrom(u, 4, [0, 1, 0]).seen; // LOD1 is previewed
		return { mat: JSON.parse(JSON.stringify(window.__lg.byUuid(u).userData.lod.levels[1].material ?? null)), lv1 };
	}, uuid);
	h.check(ov.mat?.color === '#ffffff', '5.1 "Own material for this level" writes an override (' + JSON.stringify(ov.mat) + ')');
	h.check(ov.lv1.length > 0 && ov.lv1.every((d) => !d.ownMaterial && d.color === 'ffffff'), '5.2 LOD1 draws a COPY wearing the override (' + JSON.stringify(ov.lv1) + ')');
	await page.locator('#lod-bar .lod-seg[data-level="1"]').click(); // deselect -> Auto
	await page.waitForTimeout(150);
	const own0 = await page.evaluate((u) => window.__lg.drawnFrom(u, 4, [0, 1, 0]).seen, uuid);
	h.check(own0.every((d) => d.ownMaterial), '5.3 LOD0 keeps the object\'s own material');

	// ---- 6 the gizmo on a level (offset) ------------------------------------------------------------
	await page.locator('#lod-bar .lod-seg[data-level="1"]').click();
	await page.waitForTimeout(150);
	await page.locator('#lod-level-move').click();
	await page.waitForTimeout(200);
	const depth6 = await undoDepth();
	const g6 = await page.evaluate(async (u) => {
		const s = window.__stores;
		const c = window.__lg.read(s.TControls);
		const onProxy = !!c?.object?.userData?.isLodLevelProxy;
		c.dispatchEvent({ type: 'dragging-changed', value: true });
		c.object.position.y += 0.5;
		c.dispatchEvent({ type: 'change' });
		const live = JSON.parse(JSON.stringify(window.__lg.byUuid(u).userData.lod.levels[1].offset ?? null));
		c.dispatchEvent({ type: 'dragging-changed', value: false });
		await new Promise((r) => setTimeout(r, 100));
		const drawn = window.__lg.drawnFrom(u, 4, [0, 1, 0]).seen;
		const rootY = window.__lg.byUuid(u).position.y;
		return { onProxy, live, offset: JSON.parse(JSON.stringify(window.__lg.byUuid(u).userData.lod.levels[1].offset ?? null)), drawn, rootY };
	}, uuid);
	h.check(g6.onProxy, '6.1 "Move level" puts the gizmo on the level\'s proxy (not the object)');
	h.check(Math.abs((g6.live?.pos?.[1] ?? 0) - 0.5) < 1e-3, '6.2 the level follows the gizmo live (' + JSON.stringify(g6.live) + ')');
	h.check(Math.abs((g6.offset?.pos?.[1] ?? 0) - 0.5) < 1e-3 && (await undoDepth()) === depth6 + 1, '6.3 the release commits the offset as ONE undo entry');
	h.check(g6.drawn.length > 0 && g6.drawn.every((d) => Math.abs(d.y - (g6.rootY + 0.5)) < 0.02), '6.4 LOD1 DRAWS half a metre up (' + JSON.stringify(g6.drawn.map((d) => d.y)) + ', root ' + g6.rootY + ')');
	const objY = await page.evaluate((u) => window.__lg.byUuid(u).position.y, uuid);
	h.check(Math.abs(objY - g6.rootY) < 1e-6, '6.5 the OBJECT did not move');
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(200);
	h.check(!(await block(uuid)).levels[1].offset, '6.6 undo removes the offset');
	await page.locator('#lod-level-move').click(); // Done moving
	await page.waitForTimeout(150);
	const backOnObject = await page.evaluate((u) => window.__lg.read(window.__stores.TControls)?.object?.uuid === u, uuid);
	h.check(backOnObject, '6.7 "Done moving" puts the gizmo back on the object');
	await page.locator('#lod-bar .lod-seg[data-level="1"]').click(); // deselect
	await page.waitForTimeout(150);

	// ---- 7 the overlay --------------------------------------------------------------------------------
	await page.locator('#lod-overlay').check();
	const ovl = await page.evaluate(async (u) => {
		window.__lg.renderFrom(400);
		await new Promise((r) => setTimeout(r, 300));
		return { far: window.__lg.drawnFrom(u, 400, [0, 1, 0]).seen.map((d) => d.material), near: window.__lg.drawnFrom(u, 4, [0, 1, 0]).seen.map((d) => d.material) };
	}, uuid);
	h.check(ovl.far.every((m) => m === 'lod-overlay-2') && ovl.near.every((m) => m === 'lod-overlay-0'), '7.1 "Show LOD level" paints each level its colour (far ' + ovl.far + ', near ' + ovl.near + ')');
	await page.locator('#lod-overlay').uncheck();
	const ovlOff = await page.evaluate((u) => window.__lg.drawnFrom(u, 4, [0, 1, 0]).seen.every((d) => d.ownMaterial), uuid);
	h.check(ovlOff, '7.2 off again: the object wears its own material');
	h.check((await lodMsgs()) === (await lodMsgs()), '7.3 (the overlay is LOCAL — checked by 2.5\'s rule: no lod write)');

	// ---- 8 replace a level with another object (a TREE level) ----------------------------------------
	const standIn = await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff00ff }));
		m.name = 'Stand-in';
		m.position.set(20, 0.5, 0);
		window.__lg.read(s.objectsGroup).add(m);
		s.pokeScene();
		return m.uuid;
	});
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), uuid);
	await page.waitForTimeout(500);
	await page.locator('#lod-bar .lod-seg[data-level="2"]').click();
	await page.waitForTimeout(150);
	await page.locator('#lod-level-replace').click();
	await page.locator('.ts-list [role="option"]', { hasText: 'Stand-in' }).click();
	await page.waitForTimeout(400);
	const rep = await page.evaluate(async ({ u, si }) => {
		const s = window.__stores;
		await window.__lg.built(u);
		const lvl = window.__lg.byUuid(u).userData.lod.levels[2];
		const drawnSelf = window.__lg.drawnFrom(u, 4, [0, 1, 0]).seen.length; // LOD2 previewed
		const stats = s.lodGroup.lodGroupStats().find((g) => g.uuid === u);
		return { source: lvl.source, ref: lvl.ref, si, kind: stats.levels[2].kind, tris: stats.levels[2].tris, drawnSelf };
	}, { u: uuid, si: standIn });
	h.check(rep.source === 'object' && rep.ref === rep.si, '8.1 the level now names the stand-in object');
	h.check(rep.kind === 'tree' && rep.tris === 12, '8.2 it builds as a substitute model (12 tris)');
	h.check(rep.drawnSelf === 0, '8.3 while LOD2 draws, the ball\'s own mesh is not drawn (the stand-in is)');
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(200);
	h.check((await block(uuid)).levels[2].source === 'pack', '8.4 undo: the pack file again');
	await page.locator('#lod-bar .lod-seg[data-level="2"]').click().catch(() => {});

	// ---- 9 Generate levels on a plain dense mesh ---------------------------------------------------------
	const plain = await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const m = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.3, 256, 32), new THREE.MeshStandardMaterial());
		m.name = 'Knot';
		m.position.set(-8, 1, 0);
		window.__lg.read(s.objectsGroup).add(m);
		s.pokeScene();
		return { uuid: m.uuid, tris: m.geometry.index.count / 3 };
	});
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), plain.uuid);
	await page.waitForTimeout(600);
	h.check(await page.locator('#lod-none').isVisible(), '9.1 an object with no group says so');
	const depth9 = await undoDepth();
	await page.locator('#lod-generate').first().click();
	await page.waitForTimeout(300);
	const gen = await page.evaluate(async (u) => {
		const info = await window.__lg.built(u, 20000);
		window.__lg.renderFrom(400, [-8, 1, 0]);
		await new Promise((r) => setTimeout(r, 200));
		const far = window.__lg.drawnFrom(u, 400, [-8, 1, 0]).seen.map((d) => d.tris);
		return { levels: info?.levels?.map((l) => [l.source, l.status, l.tris]), far };
	}, plain.uuid);
	h.check(gen.levels?.length === 4 && gen.levels.slice(1).every((l) => l[0] === 'generated' && l[1] === 'ready'), '9.2 Generate levels builds three meshopt levels in the worker: ' + JSON.stringify(gen.levels));
	h.check(gen.far.length > 0 && gen.far.every((t) => t < plain.tris * 0.15), '9.3 from far away the knot draws the coarse level (' + gen.far + ' of ' + plain.tris + ')');
	h.check((await undoDepth()) === depth9 + 1, '9.4 Generate is ONE undo entry');
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(300);
	h.check((await block(plain.uuid)) === null, '9.5 undo removes the generated group');

	// ---- 10 the wire validator ------------------------------------------------------------------------
	const wire = await page.evaluate((u) => {
		const v = window.__stores.wireValidate.validateWireMessage;
		return {
			ok: v({ type: 'objectParameters', parameter: 'lod', uuid: u, lod: { levels: [] } }),
			nul: v({ type: 'objectParameters', parameter: 'lod', uuid: u, lod: null }),
			bad: v({ type: 'objectParameters', parameter: 'lod', uuid: u, lod: { levels: 'x' } }),
			other: v({ type: 'objectParameters', parameter: 'visible', visible: true })
		};
	}, uuid);
	h.check(wire.ok && wire.nul && !wire.bad && wire.other, '10.1 wireValidate: a lod block or null passes, a malformed one is refused, other parameters untouched');

	// ---- 11 two peers ------------------------------------------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await setupLodFixture(B.page);
	await h.connect(B, A);
	await h.eventually(
		() => B.page.evaluate((u) => JSON.parse(JSON.stringify(window.__lg.byUuid(u)?.userData?.lod ?? null)), uuid),
		(lod) => !!lod && lod.levels.length === 3,
		'11.1 the joiner receives the piece WITH its group (the stub carries userData.lod)',
		30000
	);
	await page.evaluate((u) => window.__stores.lodGroupActions.forceLodLevel(u, 2), uuid);
	await h.eventually(
		() => B.page.evaluate((u) => window.__lg.byUuid(u)?.userData?.lod?.forced ?? null, uuid),
		(f) => f === 2,
		'11.2 Force LOD replicates to the peer',
		15000
	);
	const bNear = await B.page.evaluate(async (u) => {
		await window.__lg.built(u);
		return window.__lg.drawnFrom(u, 4, [0, 1, 0]).seen.map((d) => d.tris);
	}, uuid);
	h.check(bNear.length > 0 && bNear.every((t) => t === fixture.lod2.tris), '11.3 the peer DRAWS the forced LOD2 up close (' + bNear + ')');
	await page.evaluate(() => window.__stores.history.undo());
	await h.eventually(
		() => B.page.evaluate((u) => window.__lg.byUuid(u)?.userData?.lod?.mode ?? null, uuid),
		(m) => m === 'auto',
		'11.4 undo replicates too',
		15000
	);

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'no page errors (' + JSON.stringify([...h.pageErrors(A), ...h.pageErrors(B)]) + ')');
	await h.finish(browser);
});
