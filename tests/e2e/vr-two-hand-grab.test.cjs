// 33 G4: TWO HANDS, TWO THINGS. The Quest report (Towers): "when I grab another box for some
// reason the other one stuck in space until I take it again (only then physics applied to
// it)". vrControls kept ONE grab slot: the second hand's grab overwrote the first, the first
// piece stayed in its kinematic physics hold, nothing ever updated or released it, and it hung
// in mid-air until a hand took it again. Grabs are per HAND now.
//
// Driven through the REAL per-frame path (Scene's useTask -> updateVRControls) with a fake XR
// session (fakeXR.cjs) and a running rapier simulation: two emulated controllers each hold a
// different dynamic crate, carry both, and release them one at a time.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

const grips = (page) => page.evaluate(() => window.__stores.vrControls.vrGripDebug());
const posOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		return g.getObjectByProperty('uuid', uuid).position.toArray();
	}, uuid);
const bodyOf = (page, uuid) =>
	page.evaluate((uuid) => {
		const b = window.__stores.physics.physicsDebug().find((e) => e.uuid === uuid);
		return b ? { hold: b.hold, bodyType: b.bodyType } : null;
	}, uuid);
const grip = async (page, hand, down) => {
	await xr.button(page, hand, 1, down);
	await page.waitForTimeout(250);
};

h.run(async () => {
	// GPU: software GL runs a few fps and the fixed-step accumulator then lags real time
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
	await A.page.waitForTimeout(2000);

	// ---- the fixture: a floor and two dynamic crates side by side ---------------------------
	const ids = await A.page.evaluate(async () => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		for (let i = 0; i < 3; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		const [floor, a, b] = get(s.objectsGroup).children.filter((c) => c.name === 'Box');
		floor.scale.set(20, 0.5, 20);
		floor.position.set(0, -0.25, 0);
		floor.userData.physics = { mode: 'static' };
		for (const [box, x] of [[a, 0.7], [b, -0.7]]) {
			box.scale.setScalar(0.4);
			box.position.set(x, 0.2, -1.5);
			box.rotation.set(0, 0, 0);
			box.userData.physics = { mode: 'dynamic', mass: 1 };
		}
		for (const o of [floor, a, b]) o.updateMatrixWorld(true);
		s.objectActions.deselectObject();
		s.isVRMode.set(true);
		return { floor: floor.uuid, a: a.uuid, b: b.uuid };
	});
	await A.page.waitForTimeout(600);
	await xr.install(A.page);
	// park both hands high and aimed at nothing (straight up)
	const park = async () => {
		await xr.pose(A.page, 'left', [-0.3, 1.6, 0], { pitch: Math.PI / 2 });
		await xr.pose(A.page, 'right', [0.3, 1.6, 0], { pitch: Math.PI / 2 });
	};
	await park();

	// ================================================================ 1. EDIT, no simulation
	console.log('\n=== 1. Edit: each hand holds its own crate ===');
	{
		const a0 = await posOf(A.page, ids.a);
		const b0 = await posOf(A.page, ids.b);
		await xr.pose(A.page, 'right', [a0[0], a0[1], 0]); // aims -Z through crate A
		await grip(A.page, 'right', true);
		await xr.pose(A.page, 'left', [b0[0], b0[1], 0]); // aims -Z through crate B
		await grip(A.page, 'left', true);
		const g = await grips(A.page);
		h.check(g.grabs[1] === ids.a && g.grabs[0] === ids.b, `1.1 the right hand holds A, the left holds B (${JSON.stringify(g.grabs)})`);
		// lift both hands half a metre: BOTH crates follow their own hand
		await xr.pose(A.page, 'right', [a0[0] + 0.3, a0[1] + 0.5, 0]);
		await xr.pose(A.page, 'left', [b0[0] - 0.3, b0[1] + 0.5, 0]);
		await A.page.waitForTimeout(300);
		const a1 = await posOf(A.page, ids.a);
		const b1 = await posOf(A.page, ids.b);
		h.check(Math.abs(a1[1] - (a0[1] + 0.5)) < 0.05 && Math.abs(a1[0] - (a0[0] + 0.3)) < 0.05, `1.2 crate A follows the right hand (y ${a0[1].toFixed(2)} -> ${a1[1].toFixed(2)})`);
		h.check(Math.abs(b1[1] - (b0[1] + 0.5)) < 0.05 && Math.abs(b1[0] - (b0[0] - 0.3)) < 0.05, `1.3 crate B follows the left hand (y ${b0[1].toFixed(2)} -> ${b1[1].toFixed(2)})`);
		await grip(A.page, 'right', false);
		await grip(A.page, 'left', false);
		const g2 = await grips(A.page);
		h.check(g2.grabs.every((u) => u === null), `1.4 both releases end both grabs (${JSON.stringify(g2.grabs)})`);
		// the editor's two-hand SCALE still happens when both hands take the SAME object
		const a2 = await posOf(A.page, ids.a);
		await xr.pose(A.page, 'right', [a2[0], a2[1], 0]);
		await grip(A.page, 'right', true);
		await xr.pose(A.page, 'left', [a2[0] - 0.05, a2[1], 0]);
		await grip(A.page, 'left', true);
		const g3 = await grips(A.page);
		h.check(g3.scaleGrab === ids.a && g3.grabs.every((u) => u === null), `1.5 two hands on ONE object still scale it in Edit (${g3.scaleGrab === ids.a})`);
		await grip(A.page, 'left', false);
		await grip(A.page, 'right', false);
		// put the crates back on the floor for the simulation
		await A.page.evaluate((ids) => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			for (const [u, x] of [[ids.a, 0.7], [ids.b, -0.7]]) {
				const o = g.getObjectByProperty('uuid', u);
				o.position.set(x, 0.2, -1.5);
				o.rotation.set(0, 0, 0);
				o.scale.setScalar(0.4);
				o.updateMatrixWorld(true);
			}
			window.__stores.objectActions.deselectObject();
		}, ids);
		await park();
	}

	// ================================================================ 2. INTERACT + physics
	console.log('\n=== 2. Interact + a running simulation: two crates, two hands ===');
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await A.page.waitForTimeout(1500);
	const running = await A.page.evaluate(() => window.__stores.physics.physicsDebug().length);
	h.check(running >= 2, `2.0 (premise) the simulation is running (${running} dynamic bodies)`);
	const a0 = await posOf(A.page, ids.a);
	const b0 = await posOf(A.page, ids.b);
	h.check(a0[1] < 0.4 && b0[1] < 0.4, `2.0b (premise) both crates rest on the floor (y ${a0[1].toFixed(2)}, ${b0[1].toFixed(2)})`);

	await xr.pose(A.page, 'right', [a0[0], a0[1], 0]);
	await grip(A.page, 'right', true);
	let ba = await bodyOf(A.page, ids.a);
	h.check(ba?.hold === 'user', `2.1 the right hand holds crate A (hold ${ba?.hold})`);
	await xr.pose(A.page, 'left', [b0[0], b0[1], 0]);
	await grip(A.page, 'left', true);
	let g = await grips(A.page);
	h.check(g.grabs[1] === ids.a && g.grabs[0] === ids.b, `2.2 the second hand takes B and the first keeps A (${JSON.stringify(g.grabs)})`);

	// carry both up to 1.3 m: each crate rides ITS hand (the bug: A hung where B's grab began)
	await xr.pose(A.page, 'right', [a0[0], 1.3, 0]);
	await xr.pose(A.page, 'left', [b0[0], 1.3, 0]);
	await A.page.waitForTimeout(400);
	const a1 = await posOf(A.page, ids.a);
	const b1 = await posOf(A.page, ids.b);
	h.check(Math.abs(a1[1] - 1.3) < 0.08, `2.3 crate A rises with the right hand while the left holds B (y ${a1[1].toFixed(2)})`);
	h.check(Math.abs(b1[1] - 1.3) < 0.08, `2.4 crate B rises with the left hand (y ${b1[1].toFixed(2)})`);

	// release A only: it is a dynamic body AT ONCE and falls; B stays in the left hand
	await xr.button(A.page, 'right', 1, false);
	await A.page.waitForTimeout(120);
	ba = await bodyOf(A.page, ids.a);
	let bb = await bodyOf(A.page, ids.b);
	h.check(ba?.hold === null && ba?.bodyType === 0, `2.5 released crate A gets physics immediately (hold ${ba?.hold}, bodyType ${ba?.bodyType})`);
	h.check(bb?.hold === 'user', `2.6 crate B is still held by the left hand (hold ${bb?.hold})`);
	await A.page.waitForTimeout(900);
	const a2 = await posOf(A.page, ids.a);
	const b2 = await posOf(A.page, ids.b);
	h.check(a2[1] < 0.6, `2.7 crate A fell (y ${a1[1].toFixed(2)} -> ${a2[1].toFixed(2)})`);
	h.check(Math.abs(b2[1] - 1.3) < 0.08, `2.8 crate B did not fall while held (y ${b2[1].toFixed(2)})`);
	// the left hand still carries B
	await xr.pose(A.page, 'left', [b0[0] - 0.4, 1.3, 0]);
	await A.page.waitForTimeout(300);
	const b3 = await posOf(A.page, ids.b);
	h.check(Math.abs(b3[0] - (b0[0] - 0.4)) < 0.08, `2.9 crate B still follows the left hand (x ${b3[0].toFixed(2)})`);

	// release B: it falls too
	await xr.button(A.page, 'left', 1, false);
	await A.page.waitForTimeout(1000);
	bb = await bodyOf(A.page, ids.b);
	const b4 = await posOf(A.page, ids.b);
	h.check(bb?.hold === null && b4[1] < 0.6, `2.10 released crate B falls (hold ${bb?.hold}, y ${b4[1].toFixed(2)})`);
	g = await grips(A.page);
	h.check(g.grabs.every((u) => u === null), `2.11 no hand holds anything (${JSON.stringify(g.grabs)})`);

	// a re-grab in the SAME hand of another crate releases the first (a hand holds one thing)
	const a5 = await posOf(A.page, ids.a);
	const b5 = await posOf(A.page, ids.b);
	await xr.pose(A.page, 'right', [a5[0], a5[1], 0]);
	await grip(A.page, 'right', true);
	await xr.pose(A.page, 'right', [a5[0], 1.2, 0]);
	await A.page.waitForTimeout(300);
	// the knock probe skips EVERYTHING the hands hold (both of them)
	await xr.pose(A.page, 'left', [b5[0], b5[1], 0]);
	await grip(A.page, 'left', true);
	const held = await A.page.evaluate(() => window.__stores.vrControls.vrGrabbedUuids());
	h.check(held.includes(ids.a) && held.includes(ids.b), `2.12 vrGrabbedUuids names both held crates (${held.length})`);
	await grip(A.page, 'left', false);
	await grip(A.page, 'right', false);

	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await xr.uninstall(A.page);
	await A.page.evaluate(() => window.__stores.isVRMode.set(false));
	await h.finish(browser);
});
