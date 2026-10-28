// 52 (V5) — THE UNIVERSAL WORLD GRAB, on IWER (48 G2: the app's own XR path, a Quest 3 emulated).
// The user (2026-10-21): "I can grab both grips and scale world, but it works only if controllers do not
// point at any object, it might be worth of making it universal, so it works even if I am surrounded by
// objects" — refined the same day: object two-hand scale only after one hand already moves the object;
// big / enclosing / terrain / locked things never by touch. VR editor practice (Open Brush, Gravity
// Sketch, ShapesXR): both grips = the world.
//
//  1 standing INSIDE a hollow box (six 3 m panels, none of them scenery on its own) with both rays on its
//    floor: both grips scale the WORLD; no panel moves, no undo entry, nothing sent, nothing selected
//  2 the same with the second grip LATE (> 250 ms, the first grab unmoved): still the world, the floor
//    back where it was, no undo entry
//  3 one hand MOVES a cube, the other grips (its ray on the floor): the CUBE scales (and turns), the
//    world stays 1:1; one undo entry for the whole hold
//  4 touching a 10 m wall (selected) / a 3 m crate with one grip, the ray at the sky: no grab; the
//    selected wall still moves deliberately (ray on it + grip)
//  5 terrain never moves by grip (ray on a small terrain, selected or not)
//  6 Settings ▸ VR "Both grips scale the world: Only in empty air" = the pre-52 rule (both rays on the
//    floor take the floor)
//  7 the miniature: 1:10 and 1:50 are detents (a tick, the readout between the hands says "1:10"); the
//    radial root offers Back to 1:1 only while the world is off life size; the comfort vignette closes in
//    while the world scales
// Red on the base (origin/feat/51, the 1.43 union): 1, 3, 4, 5 (2 passes there too: a late grip on the
// base takes the floor too and never moves it). Green here.
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const g = (page, fn, arg) => page.evaluate(fn, arg);

const state = (page) =>
	g(page, () => {
		const s = window.__stores;
		const get = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const rig = get(s.worldRig);
		return {
			...s.vrControls.vrGripDebug(),
			rigScale: rig.scale.x,
			rigPos: rig.position.toArray(),
			selected: [...get(s.selectedObjects)],
			undo: get(s.history.undoStack).length,
			sent: window.__sent ? window.__sent.slice() : []
		};
	});
/** every fixture object's LOCAL pose, keyed by uuid */
const poses = (page, ids) =>
	g(page, (ids) => {
		let grp;
		window.__stores.objectsGroup.subscribe((x) => (grp = x))();
		const out = {};
		for (const id of ids) {
			const o = grp.getObjectByProperty('uuid', id);
			out[id] = [...o.position.toArray(), ...o.quaternion.toArray(), ...o.scale.toArray()].map((v) => +v.toFixed(4));
		}
		return out;
	}, ids);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clearSent = (page) => g(page, () => (window.__sent = []));
const grip = (page, hand, down) => iwer.button(page, hand, 'squeeze', down);
const release = async (page) => {
	await grip(page, 'left', false);
	await grip(page, 'right', false);
	await iwer.frames(page, 4);
};
const reset = async (page) => {
	await release(page);
	await g(page, () => {
		window.__stores.vrControls.resetWorldRig();
		window.__stores.objectActions.deselectObject();
	});
	await iwer.frames(page, 3);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	// ---- the fixture -------------------------------------------------------------------------------------
	// a hollow 3 m box around the viewer (floor, ceiling, four walls: each panel is < 4 m and does not contain
	// the head, so no panel is "scenery" by itself), a 30 m ground under it, a cube, a 10 m wall and a 3 m crate
	// out to the right, a 3 m terrain behind
	const ids = await g(page, async () => {
		const s = window.__stores;
		const get = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		const make = async (cmd) => {
			s.commandsHandler.sceneCommand(cmd);
			await new Promise((r) => setTimeout(r, 120));
			return get(s.selectedObject);
		};
		const box = async (name, scale, pos) => {
			const o = await make('/create Box 1 1 1');
			o.name = name;
			o.scale.set(...scale);
			o.position.set(...pos);
			o.updateMatrixWorld(true);
			return o.uuid;
		};
		const out = {
			ground: await box('ground', [30, 0.2, 30], [0, -0.2, 0]),
			floor: await box('floor', [3, 0.04, 3], [0, 0.02, 0]),
			ceiling: await box('ceiling', [3, 0.04, 3], [0, 2.6, 0]),
			north: await box('north', [3, 2.6, 0.1], [0, 1.3, -1.5]),
			south: await box('south', [3, 2.6, 0.1], [0, 1.3, 1.5]),
			east: await box('east', [0.1, 2.6, 3], [1.5, 1.3, 0]),
			westWall: await box('west', [0.1, 2.6, 3], [-1.5, 1.3, 0]),
			cube: await box('cube', [0.3, 0.3, 0.3], [0.35, 1.2, -0.8]),
			bigWall: await box('bigWall', [10, 4, 0.5], [0, 2, -12]),
			crate: await box('crate', [3, 1, 1], [0, 0.5, 12])
		};
		const terrain = await make('/create Terrain 3 8');
		terrain.position.set(6, 0.5, 6);
		terrain.updateMatrixWorld(true);
		out.terrain = terrain.uuid;
		out.terrainIsTerrain = !!terrain.userData?.terrain;
		s.objectActions.deselectObject();
		// the wire, seen from here: every message this peer sends
		const peer = get(s.peers);
		if (peer && !peer.__spy) {
			const send = peer.send.bind(peer);
			peer.send = (m) => {
				(window.__sent ??= []).push(m?.type);
				return send(m);
			};
			peer.__spy = true;
		}
		window.__sent = [];
		return out;
	});
	const { terrainIsTerrain, ...objects } = ids;
	const all = Object.values(objects);
	h.check(terrainIsTerrain, 'premise: /create Terrain made a terrain');

	await iwer.enter(page);
	const s0 = await state(page);
	h.check(Math.abs(s0.rigScale - 1) < 1e-6 && s0.grab === null, 'premise: in the headset, Edit, the world 1:1, nothing held');

	// both hands low, rays pointing steeply down at the hollow box's floor
	const aimFloor = async (spread = 0.25) => {
		await iwer.pose(page, 'left', [-spread, 1.1, -0.3], { pitch: -1.3 });
		await iwer.pose(page, 'right', [spread, 1.1, -0.3], { pitch: -1.3 });
		await iwer.frames(page, 3);
	};

	console.log('\n=== 1. inside a hollow box, both rays on its floor: the WORLD scales, nothing moves ===');
	await aimFloor();
	let before = await poses(page, all);
	let undo0 = (await state(page)).undo;
	await clearSent(page);
	await grip(page, 'left', true);
	await grip(page, 'right', true); // the second grip lands inside the 250 ms window
	await iwer.frames(page, 3);
	let s = await state(page);
	h.check(s.worldGrab && s.grab === null, `1.1 both grips start the world grab (world ${s.worldGrab}, holding ${s.grab})`);
	await aimFloor(0.5); // spread the hands 0.5 m -> 1 m
	await iwer.frames(page, 6);
	s = await state(page);
	h.check(s.rigScale > 1.6, `1.2 spreading the hands scales the world (x${s.rigScale.toFixed(2)})`);
	let after = await poses(page, all);
	h.check(same(before, after), '1.3 no panel, no object moved (local poses identical)');
	h.check(s.undo === undo0, `1.4 no undo entry (${undo0} -> ${s.undo})`);
	h.check(!s.sent.includes('move') && s.selected.length === 0, `1.5 nothing sent, nothing selected (sent: ${s.sent.join(',') || 'none'})`);
	await reset(page);

	console.log('\n=== 2. the second grip LATE, the first grab unmoved: still the world ===');
	await aimFloor();
	before = await poses(page, all);
	undo0 = (await state(page)).undo;
	await grip(page, 'left', true);
	await page.waitForTimeout(450);
	await iwer.frames(page, 3);
	await grip(page, 'right', true);
	await iwer.frames(page, 3);
	s = await state(page);
	h.check(s.worldGrab && s.grab === null, `2.1 a late second grip still grabs the world (world ${s.worldGrab}, holding ${s.grab}, dropped ${s.dropped})`);
	await aimFloor(0.5);
	await iwer.frames(page, 6);
	s = await state(page);
	after = await poses(page, all);
	h.check(s.rigScale > 1.6 && same(before, after), `2.2 the world scaled (x${s.rigScale.toFixed(2)}), the floor back where it was`);
	h.check(s.undo === undo0, `2.3 no undo entry (${undo0} -> ${s.undo})`);
	await reset(page);

	console.log('\n=== 3. one hand MOVES a cube, the other grips: the CUBE scales ===');
	// right hand aims at the cube (0.35, 1.2, -0.8) from 0.6 m behind it, level
	await iwer.pose(page, 'right', [0.35, 1.2, -0.2]);
	await iwer.pose(page, 'left', [-0.25, 1.1, -0.3], { pitch: -1.3 }); // left ray on the floor
	await iwer.frames(page, 3);
	const cube0 = (await poses(page, [objects.cube]))[objects.cube];
	undo0 = (await state(page)).undo;
	await grip(page, 'right', true);
	await iwer.frames(page, 3);
	s = await state(page);
	h.check(s.grab === objects.cube, `3.1 the right grip holds the cube (${s.grab})`);
	await iwer.pose(page, 'right', [0.45, 1.25, -0.2]); // carry it ~11 cm
	await iwer.frames(page, 4);
	s = await state(page);
	h.check((s.moved ?? []).some(Boolean) && s.selected.includes(objects.cube), `3.2 moved past 2 cm: committed (selected ${s.selected.includes(objects.cube)})`);
	await grip(page, 'left', true);
	await iwer.frames(page, 3);
	s = await state(page);
	h.check(s.scaleGrab === objects.cube && !s.worldGrab, `3.3 the second grip scales the cube, not the world (scale ${s.scaleGrab}, world ${s.worldGrab})`);
	// hands 0.73 m apart -> 1.4 m apart, and a turn of the hands' axis
	await iwer.pose(page, 'left', [-0.6, 1.1, -0.6], { pitch: -1.3 });
	await iwer.pose(page, 'right', [0.8, 1.25, -0.2]);
	await iwer.frames(page, 6);
	s = await state(page);
	const cube1 = (await poses(page, [objects.cube]))[objects.cube];
	h.check(cube1[7] > cube0[7] * 1.5, `3.4 the cube grew with the hands (${cube0[7]} -> ${cube1[7]})`);
	h.check(!same(cube0.slice(3, 7), cube1.slice(3, 7)) && s.scaleRotates, '3.5 ...and turned with the hands’ axis');
	h.check(Math.abs(s.rigScale - 1) < 1e-6, `3.6 the world stayed 1:1 (x${s.rigScale})`);
	await release(page);
	s = await state(page);
	h.check(s.undo === undo0 + 1, `3.7 one undo entry for the whole hold (${undo0} -> ${s.undo})`);
	await reset(page);

	console.log('\n=== 4. touching big things never grabs them ===');
	// the right hand INSIDE the 10 m wall (selected with the trigger earlier), its ray up at the sky
	await g(page, (id) => window.__stores.objectActions.selectObject(id), objects.bigWall);
	await iwer.pose(page, 'right', [0, 1.6, -12], { pitch: 1.4 });
	await iwer.frames(page, 3);
	const wall0 = (await poses(page, [objects.bigWall]))[objects.bigWall];
	await grip(page, 'right', true);
	await iwer.frames(page, 3);
	s = await state(page);
	h.check(s.grab === null, `4.1 a hand inside a selected 10 m wall does not take it (holding ${s.grab})`);
	await iwer.pose(page, 'right', [0.6, 1.6, -12], { pitch: 1.4 });
	await iwer.frames(page, 4);
	h.check(same(wall0, (await poses(page, [objects.bigWall]))[objects.bigWall]), '4.2 ...and it did not move');
	await grip(page, 'right', false);
	await iwer.frames(page, 3);
	// a hand inside a 3 m crate (not selected), ray at the sky
	await iwer.pose(page, 'right', [0, 0.5, 12], { pitch: 1.4 });
	await iwer.frames(page, 3);
	await grip(page, 'right', true);
	await iwer.frames(page, 3);
	s = await state(page);
	h.check(s.grab === null, `4.3 a hand inside a 3 m crate does not take it (holding ${s.grab})`);
	await grip(page, 'right', false);
	await iwer.frames(page, 3);
	// deliberately: the selected wall, the RAY on it, then grip — it moves
	await g(page, (id) => window.__stores.objectActions.selectObject(id), objects.bigWall);
	await iwer.pose(page, 'right', [0, 1.6, -9]); // 2.75 m in front of the wall, aiming -Z at it
	await iwer.frames(page, 3);
	await grip(page, 'right', true);
	await iwer.frames(page, 3);
	s = await state(page);
	h.check(s.grab === objects.bigWall, `4.4 select + ray + grip still holds the wall (holding ${s.grab})`);
	await release(page);
	await g(page, ({ id, pose }) => {
		let grp;
		window.__stores.objectsGroup.subscribe((x) => (grp = x))();
		const o = grp.getObjectByProperty('uuid', id);
		o.position.set(pose[0], pose[1], pose[2]);
		o.updateMatrixWorld(true);
	}, { id: objects.bigWall, pose: wall0 });
	await reset(page);

	console.log('\n=== 5. terrain never moves by grip ===');
	// the terrain's centre is (6, 0.5, 6): stand the hand 1.5 m short of it, ray down at it
	await iwer.pose(page, 'right', [5, 1.6, 5], { yaw: -Math.PI * 0.75, pitch: -0.6 });
	await iwer.frames(page, 3);
	const ray = await g(page, () => {
		let r, grp;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		window.__stores.objectsGroup.subscribe((v) => (grp = v))();
		const c = r.xr.getController(r.xr.getController(0).userData.handedness === 'right' ? 0 : 1);
		const T = window.__stores.THREE;
		const o = c.getWorldPosition(new T.Vector3());
		const d = new T.Vector3(0, 0, -1).applyQuaternion(c.getWorldQuaternion(new T.Quaternion()));
		const hit = new T.Raycaster(o, d).intersectObjects(grp.children, true)[0];
		return hit ? window.__stores.objectActions.topLevelObjectOf(hit.object)?.uuid : null;
	});
	h.check(ray === objects.terrain, `premise: the right ray points at the terrain (${ray})`);
	for (const selected of [false, true]) {
		if (selected) await g(page, (id) => window.__stores.objectActions.selectObject(id), objects.terrain);
		await grip(page, 'right', true);
		await iwer.frames(page, 3);
		s = await state(page);
		h.check(s.grab === null, `5.${selected ? 2 : 1} a grip on the terrain${selected ? ' (selected)' : ''} does not take it (holding ${s.grab})`);
		await grip(page, 'right', false);
		await iwer.frames(page, 3);
	}
	await reset(page);

	console.log('\n=== 6. Settings ▸ VR: "Only in empty air" = the pre-52 rule ===');
	const row = await g(page, () => {
		const r = window.__stores.vrSettingsSchema.vrSettingRow('bothGripsWorld');
		return { kind: r.kind, label: r.label, options: r.options.map((o) => o.label), value: r.get() };
	});
	h.check(row.kind === 'choice' && row.label === 'Both grips scale the world' && row.options.join('|') === 'Always|Only in empty air' && row.value === 'always', `6.1 the row: ${row.label}: ${row.options.join(' / ')} (default ${row.value})`);
	await g(page, () => window.__stores.vrSettingsSchema.vrSettingRow('bothGripsWorld').set('emptyAir'));
	await aimFloor();
	await grip(page, 'left', true);
	await iwer.frames(page, 2);
	await grip(page, 'right', true);
	await iwer.frames(page, 3);
	s = await state(page);
	h.check(!s.worldGrab && (s.grab === objects.floor || s.scaleGrab === objects.floor), `6.2 both rays on the floor take the floor again (world ${s.worldGrab}, holding ${s.grab ?? s.scaleGrab})`);
	await release(page);
	await g(page, () => window.__stores.vrSettingsSchema.vrSettingRow('bothGripsWorld').set('always'));

	console.log('\n=== 7. the miniature: detents 1:10 / 1:50, the readout, the vignette, Back to 1:1 ===');
	const snap = () => g(page, () => window.__stores.vrWorldSnap.worldSnapDebug());
	// hands 1 m apart, both grips (on the floor: the universal rule), then together to 10 cm = 1:10
	await aimFloor(0.5);
	await grip(page, 'left', true);
	await grip(page, 'right', true);
	await iwer.frames(page, 3);
	const ticks0 = (await snap()).ticks;
	await aimFloor(0.05);
	await iwer.frames(page, 6);
	let d = await snap();
	s = await state(page);
	h.check(d.detent === 0.1 && Math.abs(s.rigScale - 0.1) < 1e-6, `7.1 1:10 is a detent (scale ${s.rigScale}, detent ${d.detent})`);
	h.check(/^1:10 · /.test(d.readout) && d.readoutVisible, `7.2 the readout between the hands says 1:10 (${d.readout})`);
	h.check(d.ticks > ticks0, `7.3 catching it ticked the hands (${ticks0} -> ${d.ticks})`);
	await aimFloor(0.01); // 2 cm apart = 1:50
	await iwer.frames(page, 6);
	d = await snap();
	s = await state(page);
	h.check(d.detent === 0.02 && Math.abs(s.rigScale - 0.02) < 1e-6 && /^1:50 · /.test(d.readout), `7.4 1:50, the table-top miniature (scale ${s.rigScale}, ${d.readout})`);
	await release(page);
	// Back to 1:1 sits on the ROOT ring only while the world is off life size
	const root = () => g(page, () => window.__stores.vrRadialMenu.ringEntries('root').map((e) => e.id));
	h.check((await root()).includes('world:back'), '7.5 the radial root offers Back to 1:1 while the world is a miniature');
	await g(page, () => window.__stores.vrControls.executeVRMenuAction('world:back'));
	await iwer.frames(page, 3);
	s = await state(page);
	h.check(Math.abs(s.rigScale - 1) < 1e-9 && s.rigPos.every((v) => v === 0) && !(await root()).includes('world:back'), `7.6 Back to 1:1 restores life size and leaves the root ring (x${s.rigScale})`);
	// the comfort vignette (53, High) closes in while the world scales, and opens again when it stops
	await g(page, () => {
		window.__stores.vrPrefs.vrComfortVignette.set('high');
		window.__stores.vrPrefs.vrWorldSnap.set(false); // a steady, unsnapped pull
	});
	await aimFloor(0.5);
	await grip(page, 'left', true);
	await grip(page, 'right', true);
	await iwer.frames(page, 2);
	let peak = 0;
	for (let i = 1; i <= 30; i++) {
		await aimFloor(0.5 - i * 0.014);
		await iwer.frames(page, 1);
		peak = Math.max(peak, (await g(page, () => window.__stores.gameKit.comfortVignette.vignetteDebug())).strength);
	}
	h.check(peak > 0.4, `7.7 the vignette closes in while the world scales (peak ${peak.toFixed(2)})`);
	await iwer.frames(page, 90); // hands still
	const still = await g(page, () => window.__stores.gameKit.comfortVignette.vignetteDebug());
	h.check(still.strength < 0.1, `7.8 hands still: it opens again (${still.strength.toFixed(3)})`);
	await reset(page);
	await g(page, () => {
		window.__stores.vrPrefs.vrComfortVignette.set('off');
		window.__stores.vrPrefs.vrWorldSnap.set(true);
	});

	await iwer.exit(page);
	await h.finish(browser);
});
