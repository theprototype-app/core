// 36-water (U2a): water volumes end to end — Create → Water through the Add-menu action,
// local visuals at the scene root (never in objectsGroup), the per-render invisible swap of
// the source mesh (serializers see the box), the desktop pre-pass vs the Quest tier, the
// underwater fog swap (restored after every render), W2 ripples, bubbles, one undo per
// slider gesture, the VR props rows, api.water, the wire validator, and two peers + a late
// joiner seeing the same water. Visual LOOK is judged on the shots in the lane folder.
const h = require('./helpers.cjs');

const dbg = (page) => page.evaluate(() => window.__stores.waterRuntime.waterDebug());

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const glErrors = [];
	A.page.on('console', (m) => {
		if (/WebGLProgram|THREE\.WebGLShader|shader error/i.test(m.text())) glErrors.push(m.text().slice(0, 300));
	});

	// ---- 1. Create → Water (the Add menu's own action) -------------------------------
	const made = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.environment.setEnvironment('daylight');
		const add = s.addObjects;
		const children = add.buildAddChildren(() => [0, 0.75, 0]);
		const water = children.find((c) => c.label === 'Water');
		const labels = water?.children.map((c) => c.label) ?? [];
		water.children.find((c) => c.label === 'Pool').action();
		await new Promise((r) => setTimeout(r, 400));
		const pool = await new Promise((r) => s.selectedObject.subscribe(r)());
		window.__pool = pool;
		return { labels, uuid: pool.uuid, water: pool.userData.water, physics: pool.userData.physics, name: pool.name };
	});
	h.check(['Water tank', 'Pool', 'Ocean', 'Round pool', 'Bubbles'].every((l) => made.labels.includes(l)), `Add ▸ Water lists tank/pool/ocean/round/bubbles (${made.labels.join(', ')})`);
	h.check(made.water?.version === 1 && made.water.preset === 'pool' && made.water.shape === 'box', 'the pool carries a W1 blob (version 1, preset pool, box)');
	h.check(made.physics?.mode === 'static' && made.physics.sensor === true, 'water is a static SENSOR body (never a solid wall)');
	h.check(made.name === 'Pool', 'named Pool');

	await h.eventually(() => dbg(A.page), (d) => d.volumes === 1 && d.entries[0]?.body && d.entries[0].vertices > 100, 'renderer builds one volume (surface + body)');

	const tree = await A.page.evaluate(() => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		let leaked = 0;
		group.traverse((o) => o.userData?.__waterVisual && leaked++);
		let sc;
		s.globalScene.subscribe((v) => (sc = v))();
		const root = sc?.getObjectByName('water-root');
		return { leaked, rootKids: root?.children.length ?? -1 };
	});
	h.check(tree.leaked === 0 && tree.rootKids >= 3, `water visuals live under water-root (${tree.rootKids}), none in objectsGroup`);

	// the source mesh is swapped only DURING a render: serializers see its own material
	const swap = await A.page.evaluate(() => {
		const p = window.__pool;
		const json = p.toJSON();
		return { visible: p.material.visible !== false, type: p.material.type, json: !!json.materials?.length };
	});
	h.check(swap.visible && swap.type !== 'MeshBasicMaterial' && swap.json, `outside a render the pool keeps its own material (${swap.type})`);

	// ---- 2. pixels + the desktop tier ------------------------------------------------
	await A.page.evaluate(() => {
		window.__stores.selectedObjects.set([]);
		window.__stores.objectActions.flyTo([6, 4, 6], [0, 0.5, 0], 0);
	});
	await A.page.waitForTimeout(1500);
	let d = await dbg(A.page);
	h.check(d.tier === 'high' && d.entries[0].defines.includes('WATER_SS'), `desktop tier: screen-space program (${d.tier})`);
	h.check(d.prepass.frame === d.prepass.ours && !!d.prepass.size, `the pre-pass ran this frame (${JSON.stringify(d.prepass.size)})`);
	const withWater = await h.grabFrame(A);
	await A.page.evaluate(() => {
		delete window.__pool.userData.water;
		window.__stores.pokeScene();
	});
	await A.page.waitForTimeout(1200);
	const without = await h.grabFrame(A);
	const delta = await h.frameDelta(A.page, withWater, without);
	h.check(delta.changed > 20000, `the water draws something (${delta.changed} pixels differ from the plain box)`);
	await A.page.evaluate(() => window.__stores.waterActions.applyWaterPreset(window.__pool.uuid, 'pool'));
	await h.eventually(() => dbg(A.page), (x) => x.volumes === 1, 'water comes back on a preset write');

	// ---- 3. Quest tier ----------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.waterPrefs.waterQuality.set('low'));
	await h.eventually(() => dbg(A.page), (x) => x.tier === 'quest' && !x.entries[0].defines.includes('WATER_SS'), 'Low = Quest tier, no screen-space program');
	const frameQ = (await dbg(A.page)).prepass.frame;
	await A.page.waitForTimeout(500);
	d = await dbg(A.page);
	h.check(d.prepass.frame === frameQ && d.drawCalls <= 3, `Quest tier: no pre-pass runs, ${d.drawCalls} draw calls for one volume`);
	await A.page.evaluate(() => window.__stores.waterPrefs.waterQuality.set('auto'));

	// ---- 4. underwater: fog swapped per render, restored after -----------------------
	await A.page.evaluate(() => window.__stores.objectActions.flyTo([0.5, 0.4, 0.3], [2, 0.4, 1], 0));
	await h.eventually(() => dbg(A.page), (x) => x.underwater === made.uuid, 'camera inside the pool → underwater');
	const fog = await A.page.evaluate(() => {
		let sc;
		window.__stores.globalScene.subscribe((v) => (sc = v))();
		return { fog: sc.fog?.far ?? null, bg: sc.background?.isColor ? sc.background.getHexString() : 'tex' };
	});
	h.check(fog.fog === null || fog.fog > 30, `between renders the scene keeps its own fog (far ${fog.fog})`);
	await A.page.evaluate(() => window.__stores.objectActions.flyTo([6, 4, 6], [0, 0.5, 0], 0));
	await h.eventually(() => dbg(A.page), (x) => x.underwater === null, 'out of the water again');

	// ---- 5. W2 ripples ----------------------------------------------------------------
	const rip = await A.page.evaluate(() => window.__stores.waterVolumes.waterVolumes.disturb(window.__pool.uuid, [0, 1.5, 0], 0.5, 1));
	h.check(rip === true, 'disturb() accepts a ripple on a water object');
	await h.eventually(() => dbg(A.page), (x) => x.entries[0].ripples >= 1, 'the ripple reaches the surface uniforms');
	await A.page.waitForTimeout(3300);
	d = await dbg(A.page);
	h.check(d.entries[0].ripples === 0, 'and expires after its life');

	// ---- 6. bubbles -------------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.waterActions.applyWaterPreset(window.__pool.uuid, 'aquarium'));
	await h.eventually(() => dbg(A.page), (x) => x.entries[0].bubbles === true, 'the aquarium preset turns bubbles on (one instanced draw)');
	const burst = await A.page.evaluate(() => {
		const w = window.__stores.waterActions;
		w.updateObjectWater(window.__pool.uuid, { bubbles: { mode: 'burst' } }, { immediate: true });
		w.burstWaterBubbles(window.__pool.uuid);
		return window.__pool.userData.water.bubbles.burstAt;
	});
	h.check(burst > 0, `a burst stamps the shared-clock moment on the blob (${burst.toFixed?.(1)})`);

	// ---- 7. one undo per slider gesture ------------------------------------------------
	const undo = await A.page.evaluate(async () => {
		const s = window.__stores;
		const w = s.waterActions;
		const u = window.__pool.uuid;
		w.flushWaterEdits();
		const depth0 = s.history?.undoStack ? s.history.undoStack.length : null;
		const before = window.__pool.userData.water.look.clarity;
		for (let i = 1; i <= 12; i++) {
			w.updateObjectWater(u, { look: { clarity: before + i * 0.5 } });
			await new Promise((r) => setTimeout(r, 30));
		}
		await new Promise((r) => setTimeout(r, 700));
		const after = window.__pool.userData.water.look.clarity;
		s.history.undo();
		await new Promise((r) => setTimeout(r, 200));
		return { before, after, undone: window.__pool.userData.water.look.clarity, depth0 };
	});
	h.check(undo.after === undo.before + 6, `a 12-step scrub lands (${undo.before} → ${undo.after})`);
	h.check(undo.undone === undo.before, `ONE undo reverts the whole scrub (${undo.undone})`);

	// ---- 8. Inspector section ---------------------------------------------------------
	await A.page.evaluate(() => {
		window.__stores.objectActions.selectObject(window.__pool.uuid);
		window.__stores.showSidebar?.('properties');
	});
	await h.eventually(() => A.page.evaluate(() => !!document.querySelector('#water-preset') && !!document.querySelector('#water-level')), (x) => x, 'the Inspector shows the Water section (preset + level)');

	// ---- 9. VR props rows ---------------------------------------------------------------
	const vr = await A.page.evaluate(async () => {
		const s = window.__stores;
		const panels = s.waterVrPanels;
		s.vrPropsPanelOpen.set(true);
		await new Promise((r) => setTimeout(r, 600));
		let rows;
		panels.vrPropsRows.subscribe((v) => (rows = v))();
		const before = window.__pool.userData.water.preset;
		s.vrControls.executeVRMenuAction('props:water:preset:1');
		await new Promise((r) => setTimeout(r, 100));
		const after = window.__pool.userData.water.preset;
		s.vrPropsPanelOpen.set(false);
		return { rows, before, after };
	});
	h.check(vr.rows.includes('water:preset') && vr.rows.includes('water:remove'), `VR props panel grows the Water rows for a water object (${vr.rows.filter((r) => r.startsWith('water')).length})`);
	h.check(vr.before !== vr.after, `the VR preset row cycles the preset (${vr.before} → ${vr.after})`);

	// ---- 10. api.water + the wire validator ---------------------------------------------
	const api = await A.page.evaluate(async () => {
		const { makeApi } = window.__stores.waterSdk;
		const a = makeApi('water-e2e');
		const q = a.water.query([0, 0.2, 0]);
		const tank = await a.water.create({ kind: 'tank', size: [2, 1, 1], at: [6, 0.5, 0] });
		a.water.configure(tank, { look: { deepColor: '#ff0000' } });
		let o;
		window.__stores.objectsGroup.subscribe((g) => (o = g.getObjectByProperty('uuid', tank)))();
		const wv = window.__stores.wireValidate;
		return {
			q: q && q.uuid === window.__pool.uuid && q.depth > 0,
			tank: !!o?.userData.water,
			deep: o?.userData.water.look.deepColor,
			list: a.water.list().length,
			okNull: wv.validateWireMessage({ type: 'objectParameters', parameter: 'water', uuid: 'x', water: null }),
			badArray: wv.validateWireMessage({ type: 'objectParameters', parameter: 'water', uuid: 'x', water: [1, 2] }),
			badStr: wv.validateWireMessage({ type: 'objectParameters', parameter: 'bubbles', uuid: 'x', bubbles: 'no' })
		};
	});
	h.check(api.q, 'api.water.query finds the pool with a depth');
	h.check(api.tank && api.deep === '#ff0000' && api.list === 2, `api.water.create + configure make a second volume (${api.list})`);
	h.check(api.okNull && !api.badArray && !api.badStr, 'the wire refuses a water/bubbles payload that is not an object or null');

	// ---- 11. two peers + a late joiner ----------------------------------------------------
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 900, height: 600 } } });
	await h.connect(B, A);
	const sameOn = (peer, label) =>
		h.eventually(
			() => peer.page.evaluate((u) => {
				let o;
				window.__stores.objectsGroup.subscribe((g) => (o = g?.getObjectByProperty('uuid', u)))();
				return { preset: o?.userData?.water?.preset ?? null, vols: window.__stores.waterRuntime.waterDebug().volumes };
			}, made.uuid),
			(x) => x.preset !== null && x.vols >= 2,
			label,
			30000
		);
	await sameOn(B, 'B (joined after the water existed) holds the pool blob and renders both volumes');
	await A.page.evaluate(() => window.__stores.waterActions.applyWaterPreset(window.__pool.uuid, 'lava'));
	await h.eventually(
		() => B.page.evaluate((u) => { let o; window.__stores.objectsGroup.subscribe((g) => (o = g.getObjectByProperty('uuid', u)))(); return o?.userData?.water?.preset; }, made.uuid),
		(p) => p === 'lava',
		'a preset change replicates (lava on B)',
		15000
	);
	await A.page.evaluate(() => window.__stores.waterActions.removeObjectWater(window.__pool.uuid));
	await h.eventually(
		() => B.page.evaluate((u) => { let o; window.__stores.objectsGroup.subscribe((g) => (o = g.getObjectByProperty('uuid', u)))(); return !!o?.userData?.water; }, made.uuid),
		(has) => has === false,
		'removing the water replicates',
		15000
	);

	h.check(glErrors.length === 0, `no shader errors (${glErrors[0] ?? ''})`);
	await h.finish(browser);
});
