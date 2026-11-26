// 107-look-fixes (owner's connector report 27 Nov) — through a real connector tab, against the fake relay:
//   1. per-slot tiling: set_look material faces makes a slot that copies the slot those faces wore (look + tiling) and
//      says so; set_look uv tiles ONE slot and answers every slot's tiling; the Inspector's tiling on one slot leaves a
//      slot made from it alone. 1b. a scene SAVED the 1.84 way (two slots sharing one texture) opens and looks the same,
//      and tiling one of its slots leaves the other.
//   2. control_simulation start: the selection fallback (mass 1) and a Spin that physics overrides are said in the answer.
//   3. edit_shape mesh: extrude -> inset -> extrude continues on the previous op's selection; a failed op takes the WHOLE
//      call back (the mesh as it was, no undo step).
//   4. set_look shader: dangling nodes + an unwired output are warnings, an invalid GLSL expression is an error naming its
//      node, a node label, and the worked edit_shader example from the description compiles.
//   5. hud create: every screen says where it shows; an open HUD Editor turns to the new screen; closed = a note.
// Run: APP_URL='https://localhost:7250/' npm run e2e -- connector-look-107
const h = require('./helpers.cjs');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

/** every slot's texture as the page holds it @returns {Promise<any[]>} */
const slotsOf = (A, id) =>
	A.page.evaluate((id) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', id);
		const ms = Array.isArray(o.material) ? o.material : [o.material];
		return ms.map((m, i) => ({ i, color: m.color?.getHexString?.(), tex: m.map ? m.map.uuid : null, rep: m.map ? [m.map.repeat.x, m.map.repeat.y] : null, shared: !!m.map && ms.some((n, j) => j !== i && n.map === m.map) }));
	}, id);
const triCount = (A, id) =>
	A.page.evaluate((id) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const geo = g?.getObjectByProperty('uuid', id)?.geometry;
		return geo ? (geo.index ? geo.index.count : geo.attributes.position.count) / 3 : -1;
	}, id);
const undoDepth = (A) => A.page.evaluate(() => { let n = 0; window.__tp.test.v1.history.undoStack.subscribe((s) => (n = s.length))(); return n; });

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__tp.test.v1.aiAssistantHidden.set(''));
	const relay = await fakeRelay(A.page);
	await installProvider(A.page);
	await A.page.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 15000);
	let seq = 0;
	const call = async (tool, args = {}, scope = 'edit', timeout = 60000) => {
		const id = 'c' + ++seq;
		relay.call(id, tool, args, scope);
		const a = await relay.answer(id, timeout);
		return a?.type === 'result' ? a.result : { error: a?.error?.message ?? JSON.stringify(a) };
	};
	const short = (x) => JSON.stringify(x).slice(0, 600);
	const mk = async (name, position) => (await call('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name, position }] }))?.created?.[0]?.uuid;

	// ---- 1: per-slot tiling ------------------------------------------------------------------------------------
	console.log('\n=== 1. per-slot tiling ===');
	const img = await call('add_image', { name: 'tile107', canvas: { width: 32, height: 32, background: '#884422', ops: [{ op: 'checker', cols: 4, rows: 4, colors: ['#ffffff', '#000000'] }] } });
	h.check(!!img?.hash, 'an image to tile: ' + short(img));
	const box = await mk('Tiled', [0, 1, 0]);
	await call('set_material', { objects: [box], maps: { albedo: img.hash } });
	const t3 = await call('set_uv', { objects: [box], tiling: 3 });
	h.check(JSON.stringify(t3.updated?.[0]?.slots?.map((s) => s.tiling)) === '[[3,3]]', '1. set_uv answers every slot\'s tiling: ' + short(t3));
	const top = await call('set_material', { objects: [box], faces: { normal: 'up' }, color: '#00ff00' });
	const made = top.updated?.[0]?.newSlot;
	h.check(made?.slot === 1 && made.from === 0 && JSON.stringify(made.tiling) === '[3,3]', '1. faces makes slot 1, a copy of slot 0 with its tiling 3 x 3: ' + short(top));
	h.check(/copy of slot 0/.test(top.updated?.[0]?.note ?? '') && /3 x 3/.test(top.updated?.[0]?.note ?? ''), '1. and says so: ' + top.updated?.[0]?.note);
	let slots = await slotsOf(A, box);
	h.check(slots.length === 2 && slots[1].rep?.[0] === 3 && !slots[1].shared, '1. the new slot has its OWN texture, tiled 3 (not one shared object): ' + short(slots));
	const t5 = await call('set_uv', { objects: [box], slot: 1, tiling: 5 });
	h.check(JSON.stringify(t5.updated?.[0]?.slots?.map((s) => s.tiling)) === '[[3,3],[5,5]]', '1. set_uv slot 1 tiles slot 1 only, and the answer shows both: ' + short(t5?.updated?.[0]?.slots));
	// the Inspector's tiling (materialMaps.setTexTransform) on slot 0: slot 1 stays
	await A.page.evaluate((id) => window.__tp.test.v1.materialMaps.setTexTransform(id, { repeat: [9, 9], offset: [0, 0], rotation: 0 }, 0), box);
	slots = await slotsOf(A, box);
	h.check(slots[0].rep?.[0] === 9 && slots[1].rep?.[0] === 5, '1. the Inspector tiling slot 0 leaves slot 1 at 5: ' + short(slots));
	// a second faces call takes ITS faces' slot (0, tiling 9), not the last slot in the list (1, tiling 5)
	const bottom = await call('set_material', { objects: [box], faces: { normal: 'down' }, roughness: 0.2 });
	const made2 = bottom.updated?.[0]?.newSlot;
	h.check(made2?.slot === 2 && made2.from === 0 && JSON.stringify(made2.tiling) === '[9,9]', '1. faces down copies slot 0 (the slot they wore), not the last slot: ' + short(made2));
	await A.page.evaluate((id) => window.__tp.test.v1.materialMaps.setTexTransform(id, { repeat: [2, 2], offset: [0, 0], rotation: 0 }, 2), box);
	slots = await slotsOf(A, box);
	h.check(slots[0].rep?.[0] === 9 && slots[1].rep?.[0] === 5 && slots[2].rep?.[0] === 2, '1. Inspector tiling slot 2 moves only slot 2: ' + short(slots));

	// set_uv takes a slot by name, and turns about the corner in the Inspector's terms
	const byName = await call('set_uv', { objects: [box], slot: 'slot1', rotation: Math.PI / 2 });
	const r1 = byName.updated?.[0]?.slots?.[1];
	h.check(byName.updated?.[0]?.slot === 1 && r1?.rotationDegrees === 90 && r1.rotationAbout === 'the corner', '1. set_uv slot by name, rotation said in degrees about the corner (as the Inspector row): ' + short(byName.updated?.[0]?.slots));
	const inspectorRot = await A.page.evaluate((id) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const m = g.getObjectByProperty('uuid', id).material[1];
		return [window.__tp.test.v1.materialMapTextures.texTransformOf(m).rotation, m.map.center.x, m.map.center.y];
	}, box);
	h.check(Math.abs(inspectorRot[0] - Math.PI / 2) < 1e-6 && inspectorRot[1] === 0 && inspectorRot[2] === 0, '1. the Inspector reads the same rotation, about the same corner: ' + short(inspectorRot));

	// ---- 1b: a scene saved the 1.84 way -------------------------------------------------------------------------
	console.log('\n=== 1b. a 1.84-saved scene with a shared map ===');
	const old = await mk('Saved184', [3, 1, 0]);
	await call('set_material', { objects: [old], maps: { albedo: img.hash } });
	await call('set_uv', { objects: [old], tiling: 4 });
	// 1.84's addMaterialSlot: Material.clone() of the last slot, which SHARES the texture object; one covering group on slot 0, then the top on slot 1
	const shaped = await A.page.evaluate(async (id) => {
		const v1 = window.__tp.test.v1;
		let g;
		v1.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', id);
		const count = o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
		v1.materialsHandler.commitMaterialList(id, (ms) => {
			const fresh = ms[0].clone();
			fresh.name = 'slot1';
			fresh.color.set('#3366ff');
			return { materials: [ms[0], fresh], groups: [{ start: 0, count: count - 6, materialIndex: 0 }, { start: count - 6, count: 6, materialIndex: 1 }] };
		});
		const payload = v1.sessions.buildSessionPayload('look107');
		const text = JSON.stringify(payload);
		return { payload, sharesOne: (text.match(/"map":"([0-9a-f-]{36})"/g) ?? []).length };
	}, old);
	const before = await slotsOf(A, old);
	h.check(before.length === 2 && before[0].shared && before[1].shared && before[1].rep?.[0] === 4, '1b. the 1.84 shape: two slots on one texture object, tiled 4: ' + short(before));
	await A.page.evaluate(async (payload) => {
		const s = window.__tp.test.v1.sessions;
		await s.applySession(payload, { backup: false, quiet: true });
	}, shaped.payload);
	await h.eventually(() => slotsOf(A, old).catch(() => null), (x) => Array.isArray(x) && x.length === 2 && !!x[0].tex, '1b. the saved scene opens with both slots textured', 20000);
	const after = await slotsOf(A, old);
	h.check(JSON.stringify(after.map((x) => [x.color, x.rep])) === JSON.stringify(before.map((x) => [x.color, x.rep])), '1b. and looks the same (colours + tiling per slot): ' + short(after));
	const ou = await call('set_uv', { objects: [old], slot: 0, tiling: 7 });
	h.check(JSON.stringify(ou.updated?.[0]?.slots?.map((s) => s.tiling)) === '[[7,7],[4,4]]', '1b. set_uv slot 0 of the opened scene leaves slot 1 at 4: ' + short(ou?.updated?.[0]?.slots));
	await A.page.evaluate((id) => window.__tp.test.v1.materialMaps.setTexTransform(id, { repeat: [6, 6], offset: [0, 0], rotation: 0 }, 1), old);
	const after2 = await slotsOf(A, old);
	h.check(after2[0].rep?.[0] === 7 && after2[1].rep?.[0] === 6, '1b. the Inspector tiling slot 1 leaves slot 0 at 7: ' + short(after2));
	// the save my build writes for a new slot: an own texture per slot, ONE image (additive: an older reader reads it as before)
	const saved = await A.page.evaluate(() => {
		const p = window.__tp.test.v1.sessions.buildSessionPayload('look107b');
		return JSON.stringify(p).length;
	});
	h.check(saved > 0, '1b. the scene saves again (' + saved + ' chars)');

	// ---- 2: control_simulation says what start did ---------------------------------------------------------------
	console.log('\n=== 2. control_simulation start warnings ===');
	await call('clear_scene', { confirm: true });
	const spinner = await mk('Spinner', [0, 2, 0]);
	await call('create_flow_nodes', { graph: spinner, nodes: [{ type: 'spin', data: { axis: 'y', speed: 40 } }] });
	await A.page.evaluate((id) => window.__tp.test.v1.objectActions.selectObject(id, false), spinner);
	const st = await call('control_simulation', { action: 'start' });
	console.log('   start: ' + short(st));
	if (st.simulating) {
		h.check(/selected object "Spinner"/.test(st.warning ?? '') && /mass 1/.test(st.warning ?? '') && st.physicsBodies?.selected?.uuid === spinner, '2. the selection fallback is said: ' + short(st));
		h.check(/flow motion/.test(st.warning ?? ''), '2. and that its Spin stops while it runs');
		await call('control_simulation', { action: 'stop' });
	} else h.check(false, '2. the simulation started on the selection: ' + short(st));
	// a spinning object with dynamic physics, nothing selected
	const wheel = await mk('Wheel', [3, 2, 0]);
	await call('create_flow_nodes', { graph: wheel, nodes: [{ type: 'spin', data: { axis: 'y', speed: 40 } }] });
	await call('set_physics', { updates: [{ uuid: wheel, mode: 'dynamic', mass: 2 }] });
	await A.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
	const st2 = await call('control_simulation', { action: 'start' });
	h.check(/"Wheel" has flow motion/.test(st2.warning ?? '') && st2.physicsBodies?.overridesFlowMotion?.includes(wheel) && !st2.physicsBodies?.selected, '2. a Spin physics overrides is named: ' + short(st2));
	await call('control_simulation', { action: 'stop' });

	// ---- 3: edit_shape mesh chaining + rollback --------------------------------------------------------------
	console.log('\n=== 3. edit_mesh chaining and rollback ===');
	const block = await mk('Block', [-3, 1, 0]);
	const tris0 = await triCount(A, block);
	const chain = await call('edit_mesh', { object: block, ops: [{ op: 'extrude', select: { normal: 'up' }, distance: 0.5 }, { op: 'inset', amount: 0.3 }, { op: 'extrude', distance: 0.4 }] });
	const ops = chain.updated?.[0]?.ops ?? [];
	h.check(chain.updated?.[0]?.ok === true && ops.length === 3 && ops[1].on === 'previous' && ops[2].on === 'previous', '3. extrude -> inset -> extrude continues on the previous selection: ' + short(chain));
	const tris1 = await triCount(A, block);
	h.check(tris1 > tris0, '3. the mesh grew (' + tris0 + ' -> ' + tris1 + ' triangles)');
	const depth = await undoDepth(A);
	const bad = await call('edit_mesh', { object: block, ops: [{ op: 'extrude', select: { normal: 'up' }, distance: 0.5 }, { op: 'inset', amount: 0.2 }, { op: 'move', select: { indices: [99999] }, distance: 1 }] });
	h.check(/ops\[2\]/.test(bad.error ?? '') && /taken back \(extrude, inset\)/.test(bad.error ?? '') && !bad.updated, '3. a failed op answers an error saying the ops before it were taken back: ' + short(bad));
	h.check((await triCount(A, block)) === tris1, '3. and the mesh is exactly as it was (' + (await triCount(A, block)) + ' triangles)');
	h.check((await undoDepth(A)) === depth, '3. and no undo step was left behind');
	const typo = await call('edit_mesh', { object: block, ops: [{ op: 'extrude', select: { normal: 'up' }, distance: 0.5 }, { op: 'weld', select: { mode: 'faces', all: true } }] });
	h.check(/not a faces op/.test(typo.error ?? '') && (await triCount(A, block)) === tris1, '3. a bad op is refused before anything runs: ' + short(typo));

	// ---- 4: shader diagnostics --------------------------------------------------------------------------------
	console.log('\n=== 4. shader diagnostics ===');
	const sign = await mk('Sign', [0, 1, 4]);
	const dang = await call('create_shader', { objects: [sign], text: 'c = color {value: "#ff8800"}\nloose = float {value: 2}\nout = surface\nc -> out.emissive' });
	h.check(dang.created?.[0]?.ok === true && dang.created[0].dangling?.some((d) => d.node === 'loose') && /not wired/.test((dang.created[0].warnings ?? []).join(' ')), '4. a node not wired to the surface is a warning, by id: ' + short(dang));
	const badExpr = await call('edit_shader', { shader: sign, add: 'g = glsl {expression: "a +* b"}\ng -> out.roughness' });
	h.check(/node "g"/.test(badExpr.error ?? '') && /operators/.test(badExpr.error ?? ''), '4. an invalid expression is an error naming its node: ' + short(badExpr));
	const unwired = await call('create_shader', { objects: [await mk('Plain', [2, 1, 4])], text: 'c = color {value: "#ff8800"}\nout = surface' });
	h.check(/nothing is wired into the surface|not created — ./.test(JSON.stringify(unwired)), '4. an unwired surface says why (the reason now reaches the connector): ' + short(unwired));
	const example = await call('edit_shader', { shader: sign, removeNodes: ['loose', 'c'], add: 't = time\ns = sin\ng = color {value: "#33ccff"}\nm = multiply\nt -> s.a\ng -> m.a\ns -> m.b\nm -> out.emissive', params: [{ node: 'g', param: 'label', value: 'Glow colour' }] });
	h.check(example.updated?.[0]?.ok === true && !example.updated[0].dangling, '4. the worked example from the description compiles, nothing dangling: ' + short(example));
	const labelled = await A.page.evaluate((id) => window.__tp.test.v1.shaderGraph.shaderGraphOf(id)?.nodes?.find((n) => n.id === 'g')?.data?.label ?? null, sign);
	h.check(labelled === 'Glow colour', '4. the node label is on the graph for the Shader Editor: ' + labelled);
	const desc = await A.page.evaluate(() => window.__tp.test.v1.aiTools.getAiTools().find((t) => (t.function || t).name === 'edit_shader')?.function?.description ?? '');
	h.check(desc.includes('t = time\\ns = sin'), '4. the example IS the one the description carries');

	// ---- 5: hud create says where a screen shows -------------------------------------------------------------
	console.log('\n=== 5. hud create ===');
	const hud1 = await call('create_hud', { screens: [{ name: 'Race', showWhile: 'playing', elements: [{ kind: 'timer' }] }] });
	const s1 = hud1.screens?.[0];
	h.check(/while a round is playing/.test(s1?.shows?.play ?? '') && /not over the editor view/.test(s1?.shows?.editor ?? ''), '5. a playing-only screen says so: ' + short(s1));
	h.check(/closed/.test(hud1.hudEditor ?? ''), '5. a closed HUD Editor is a note: ' + hud1.hudEditor);
	await A.page.evaluate(() => window.__tp.test.v1.hudDocs.openHudEditor());
	await A.page.locator('.hud-screen-row').first().waitFor({ timeout: 20000 });
	const hud2 = await call('create_hud', { screens: [{ name: 'Pause card', active: false, elements: [{ kind: 'text', text: 'Paused' }] }] });
	const s2 = hud2.screens?.[0];
	h.check(/NOT on its own/.test(s2?.shows?.play ?? '') && /hudscreen/.test(s2?.shows?.play ?? ''), '5. a screen that is not active says how it would show: ' + short(s2));
	h.check(/selected "Pause card"/.test(hud2.hudEditor ?? ''), '5. the answer says the open HUD Editor selected it: ' + hud2.hudEditor);
	await h.eventually(() => A.page.locator('.hud-screen-row.hud-screen-on').first().innerText().catch(() => ''), (t) => /Pause card/.test(t), '5. the HUD Editor shows the new screen selected', 15000);

	await browser.close();
});
