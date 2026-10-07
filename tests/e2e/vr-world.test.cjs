// 37-vr-world (R9 R10) — driven through the REAL per-frame VR path (fakeXR):
//   1. world-grab snapping: two grips in empty air, hands spread 2.1x -> the world sits at exactly 2x, a 40 deg
//      twist -> 45 deg, ticks + the readout, release hides it; snapping OFF = the same gesture is free
//   2. the dollhouse: Scene > Dollhouse shrinks the rig onto a table, the pin marks the feet, the pointer hand
//      lands a disc on a box in the model, the trigger stands you ON it at full size (rig back to 1:1); a
//      trigger at the sky leaves without moving; World 1:1 and an Interact switch close it
//   3. VR sculpt: Add > Terrain lands a terrain ahead and starts a session; the menu opens on the Sculpt ring;
//      the pointer ray puts the brush ring on it; a trigger stroke raises it as ONE undo entry; the pointer
//      stick sizes the brush and does NOT walk you (the other stick does); Done ends it; a terrain selection's
//      Selected ring offers Sculpt terrain instead of Edit mesh
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const wait = (ms = 250) => page.waitForTimeout(ms);
	const g = (fn, arg) => page.evaluate(fn, arg);

	await g(() => window.__stores.isVRMode.set(true));
	await xr.install(page);
	await xr.installSpace(page, { head: [0, 1.6, 0], yaw: 0 });
	const rig = () =>
		g(() => {
			let r;
			window.__stores.worldRig.subscribe((v) => (r = v))();
			const THREE = window.__stores.THREE;
			const yaw = new THREE.Euler().setFromQuaternion(r.quaternion, 'YXZ').y;
			return { scale: r.scale.x, pos: r.position.toArray(), yaw: (yaw * 180) / Math.PI };
		});
	const menuHand = await g(() => {
		let v;
		window.__stores.vrMenuHand.subscribe((x) => (v = x))();
		return v;
	});
	const pointer = menuHand === 'right' ? 'left' : 'right';
	const pointerSlot = pointer === 'left' ? 0 : 1;
	console.log(`menu hand ${menuHand}, pointer ${pointer}`);

	// ---- 1. world-grab snapping -------------------------------------------------------------
	console.log('\n=== 1. world-grab snapping ===');
	const snapDbg = () => g(() => window.__stores.vrWorldSnap.worldSnapDebug());
	await xr.pose(page, 'left', [-0.5, 1.2, -0.3]);
	await xr.pose(page, 'right', [0.5, 1.2, -0.3]);
	await wait();
	await xr.button(page, 'left', 1, true);
	await xr.button(page, 'right', 1, true);
	await wait();
	h.check((await g(() => window.__stores.vrControls.vrGripDebug())).worldGrab, 'premise: two grips in empty air start the world grab');
	const ticks0 = (await snapDbg()).ticks;
	await xr.pose(page, 'left', [-1.05, 1.2, -0.3]);
	await xr.pose(page, 'right', [1.05, 1.2, -0.3]);
	await wait(400);
	let r = await rig();
	let d = await snapDbg();
	h.check(r.scale === 2, `hands spread 2.1x -> the world sits at exactly 2x (${r.scale})`);
	h.check(d.detent === 2 && d.readoutVisible && /^2× · 0°/.test(d.readout), `the readout says 2x . 0 deg and a detent caught (${d.readout}, detent ${d.detent})`);
	h.check(d.ticks > ticks0, `catching the detent ticked (${ticks0} -> ${d.ticks})`);
	// the world point between the hands stays glued: pos = mid - 2*mid  => y = 1.2 - 2.4
	h.check(Math.abs(r.pos[1] - (1.2 - 2 * 1.2)) < 1e-6, `the hands' midpoint stays the pivot (rig y ${r.pos[1].toFixed(4)})`);
	// twist 40 deg about the midpoint (keeping the 2.1 m span): a step of 45
	const a = (40 * Math.PI) / 180;
	await xr.pose(page, 'left', [-1.05 * Math.cos(a), 1.2, -0.3 + 1.05 * Math.sin(a)]);
	await xr.pose(page, 'right', [1.05 * Math.cos(a), 1.2, -0.3 - 1.05 * Math.sin(a)]);
	await wait(400);
	r = await rig();
	h.check(Math.abs(Math.abs(r.yaw) - 45) < 1e-6, `a 40 deg twist lands on 45 deg (${r.yaw.toFixed(3)})`);
	h.check(r.scale === 2, `the scale detent holds through the twist (${r.scale})`);
	await xr.button(page, 'left', 1, false);
	await xr.button(page, 'right', 1, false);
	await wait();
	d = await snapDbg();
	h.check(!d.readoutVisible && !d.active, `releasing a grip hides the readout (visible ${d.readoutVisible})`);
	// counterfactual: snapping off, the same spread is free
	await g(() => {
		window.__stores.vrControls.resetWorldRig();
		window.__stores.vrPrefs.vrWorldSnap.set(false);
	});
	await xr.pose(page, 'left', [-0.5, 1.2, -0.3]);
	await xr.pose(page, 'right', [0.5, 1.2, -0.3]);
	await wait();
	await xr.button(page, 'left', 1, true);
	await xr.button(page, 'right', 1, true);
	await wait();
	await xr.pose(page, 'left', [-1.05, 1.2, -0.3]);
	await xr.pose(page, 'right', [1.05, 1.2, -0.3]);
	await wait(400);
	r = await rig();
	h.check(Math.abs(r.scale - 2.1) < 1e-6 && !(await snapDbg()).readoutVisible, `snapping OFF: the same spread is free, no readout (${r.scale})`);
	await xr.button(page, 'left', 1, false);
	await xr.button(page, 'right', 1, false);
	await wait();
	await g(() => {
		window.__stores.vrControls.resetWorldRig();
		window.__stores.vrPrefs.vrWorldSnap.set(true);
	});
	const row = await g(() => window.__stores.vrSettingsSchema.VR_SETTINGS.find((x) => x.id === 'worldSnap'));
	h.check(row?.page === 'controls' && row?.keywords?.includes('world grab'), 'Settings > VR > Controls lists "World grab snapping" with search keywords');

	// ---- 2. the dollhouse -------------------------------------------------------------------
	console.log('\n=== 2. the dollhouse ===');
	const box = await g(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((res) => setTimeout(res, 500));
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const b = grp.children.find((c) => c.name === 'Box');
		b.userData.physics = { mode: 'static' };
		b.scale.set(2, 1, 2);
		b.position.set(5, 0.5, -6); // top at y 1
		b.updateMatrixWorld(true);
		s.objectActions.deselectObject();
		return b.uuid;
	});
	await wait(400);
	const dh = () => g(() => window.__stores.vrDollhouse.dollhouseDebug());
	await g(() => {
		const s = window.__stores;
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('nav:scene');
		s.vrControls.executeVRMenuAction('dollhouse');
	});
	await h.eventually(dh, (x) => x.open, 'Scene > Dollhouse opens it');
	let st = await dh();
	r = await rig();
	const menuOpen = await g(() => {
		let v;
		window.__stores.vrMenuOpen.subscribe((x) => (v = x))();
		return v;
	});
	// one 2 m box: the 4 m minimum frame applies (a lone cube still reads as a room), so 0.9 / 4
	const extent = Math.max(st.box.max[0] - st.box.min[0], st.box.max[2] - st.box.min[2]);
	const framed = Math.max(extent, 4);
	h.check(r.scale <= 0.25 && r.scale === st.scale && Math.abs(r.scale - 0.9 / framed) < 1e-9, `the world rig is the model: scale ${r.scale.toFixed(4)} (0.9 / ${framed.toFixed(2)})`);
	h.check(!menuOpen, 'the radial closed as the dollhouse opened');
	h.check(Math.abs(framed * r.scale - 0.9) < 0.01 && extent * r.scale <= 0.9 + 1e-6, `the framed area is 0.9 m across, the box inside it (${(framed * r.scale).toFixed(3)} m, box ${(extent * r.scale).toFixed(3)} m)`);
	h.check(st.marker && Math.abs(st.marker[0]) < 1e-6 && Math.abs(st.marker[2]) < 1e-6 && Math.abs(st.marker[1]) < 1e-6, `the pin sits at your feet in the model (${JSON.stringify(st.marker)})`);
	// aim the pointer hand straight down onto the box top in the model
	const boxTopW = await g((uuid) => {
		let grp;
		window.__stores.objectsGroup.subscribe((v) => (grp = v))();
		const b = grp.getObjectByProperty('uuid', uuid);
		return b.localToWorld(new window.__stores.THREE.Vector3(0, 0.5, 0)).toArray();
	}, box);
	await xr.pose(page, pointer, [boxTopW[0], boxTopW[1] + 0.15, boxTopW[2]], { pitch: -Math.PI / 2 });
	await wait(400);
	st = await dh();
	h.check(st.discVisible && st.valid, `the pointer lands the disc on the box (visible ${st.discVisible}, valid ${st.valid})`);
	h.check(st.target && Math.abs(st.target[0] - 5) < 0.05 && Math.abs(st.target[1] - 1) < 0.05 && Math.abs(st.target[2] + 6) < 0.05, `the disc is on the box top in content metres (${JSON.stringify(st.target?.map((v) => +v.toFixed(2)))})`);
	const headBefore = await xr.head(page);
	const took = await g((slot) => window.__stores.vrControls.vrModuleTriggerStart(slot), pointerSlot);
	const swallowed = await g(() => window.__stores.vrControls.vrModuleSelectSwallowed());
	await wait(300);
	st = await dh();
	r = await rig();
	const headAfter = await xr.head(page);
	h.check(took && swallowed, `the trigger is the dollhouse's, and its select click never falls through to a pick (took ${took}, swallowed ${swallowed})`);
	h.check(!st.open && r.scale === 1 && r.pos.every((v) => v === 0), `landing closes it and puts the rig back at 1:1 (scale ${r.scale})`);
	h.check(Math.abs(headAfter.x - 5) < 0.02 && Math.abs(headAfter.z + 6) < 0.02, `you stand over the box (head ${headAfter.x.toFixed(2)}, ${headAfter.z.toFixed(2)}; was ${headBefore.x.toFixed(2)}, ${headBefore.z.toFixed(2)})`);
	h.check(Math.abs(headAfter.y - (1 + 1.6)) < 0.05, `feet on the box top: head at ${headAfter.y.toFixed(2)} (top 1 + 1.6)`);
	h.check(!(await g(() => window.__stores.vrControls.vrModuleSelectSwallowed())), 'the swallow is spent after one click (the next press picks normally)');
	// a trigger at the sky leaves without moving
	await g(() => window.__stores.vrDollhouse.openDollhouse());
	await wait(200);
	await xr.pose(page, pointer, [0.3, 1.2, -0.4], { pitch: 1.2 });
	await wait(300);
	const head2 = await xr.head(page);
	const cancels0 = (await dh()).cancels;
	await g((slot) => window.__stores.vrControls.vrModuleTriggerStart(slot), pointerSlot);
	await g(() => window.__stores.vrControls.vrModuleSelectSwallowed());
	await wait(200);
	st = await dh();
	r = await rig();
	const head3 = await xr.head(page);
	h.check(!st.open && st.cancels === cancels0 + 1 && r.scale === 1, `a trigger at the sky closes it, rig back (cancels ${st.cancels})`);
	h.check(Math.abs(head3.x - head2.x) < 1e-6 && Math.abs(head3.z - head2.z) < 1e-6, 'and does not move you');
	// World 1:1 closes it; so does switching to Interact
	await g(() => window.__stores.vrDollhouse.openDollhouse());
	await wait(150);
	await g(() => window.__stores.vrControls.executeVRMenuAction('world'));
	await wait(150);
	h.check(!(await dh()).open && (await rig()).scale === 1, 'World 1:1 closes the dollhouse at 1:1');
	await g(() => window.__stores.vrDollhouse.openDollhouse());
	await wait(150);
	await g(() => window.__stores.objectActions.setEditorMode('interact'));
	await wait(400);
	h.check(!(await dh()).open, 'switching to Interact drops the dollhouse');
	await g(() => window.__stores.objectActions.setEditorMode('edit'));
	await wait(400);
	// navigation stands down while it is up (the arc would aim into the model)
	await g(() => window.__stores.vrDollhouse.openDollhouse());
	await wait(150);
	h.check(await g(() => window.__stores.vrControls.vrNavigationSuppressed()), 'stick navigation stands down while the dollhouse is up');
	await g(() => window.__stores.vrDollhouse.closeDollhouse());
	await wait(150);
	h.check(!(await g(() => window.__stores.vrControls.vrNavigationSuppressed())), '...and comes back when it closes');

	// ---- 3. VR sculpt -----------------------------------------------------------------------
	console.log('\n=== 3. VR sculpt ===');
	await xr.installSpace(page, { head: [0, 1.6, 0], yaw: 0 }); // stand at the origin again
	const sc = () => g(() => window.__stores.vrSculpt.vrSculptDebug());
	const terrainState = () =>
		g(() => {
			const s = window.__stores;
			let grp;
			s.objectsGroup.subscribe((v) => (grp = v))();
			const t = grp.children.find((c) => c.userData?.terrain);
			if (!t) return null;
			const p = t.geometry.attributes.position;
			let maxY = -Infinity;
			for (let i = 0; i < p.count; i++) maxY = Math.max(maxY, p.getY(i));
			let undo = null;
			s.history.undoStack?.subscribe?.((v) => (undo = v.length))();
			return { uuid: t.uuid, pos: t.position.toArray(), maxY, undo };
		});
	const ring = await g(() => window.__stores.vrRadialMenu.ringEntries('add').map((e) => e.id));
	h.check(ring.includes('terrain') && ring.indexOf('terrain') < ring.indexOf('prefabs'), `the Add ring has Terrain (before Prefabs): ${ring.join(' ')}`);
	// fakeXR's frame carries no views, so three never drives the camera from the fake head: "ahead" is measured
	// from the camera the app placed it from (on a headset that camera IS the head)
	const ahead = await g(() => {
		const s = window.__stores;
		let cam;
		s.globalCamera.subscribe((v) => (cam = v))();
		const THREE = s.THREE;
		const d = cam.getWorldDirection(new THREE.Vector3());
		d.y = 0;
		d.normalize().multiplyScalar(6);
		const p = cam.getWorldPosition(new THREE.Vector3());
		s.vrMenuOpen.set(true);
		s.vrControls.executeVRMenuAction('nav:add');
		s.vrControls.executeVRMenuAction('terrain');
		return [p.x + d.x, p.z + d.z];
	});
	await h.eventually(sc, (x) => x.active && !!x.uuid, 'Add > Terrain starts a VR sculpt session');
	let t = await terrainState();
	let s3 = await sc();
	h.check(t && s3.uuid === t.uuid, 'on the new terrain');
	h.check(t && Math.abs(t.pos[0] - ahead[0]) < 0.05 && Math.abs(t.pos[2] - ahead[1]) < 0.05, `the terrain's centre lands 6 m ahead of the view, level (${t?.pos.map((v) => v.toFixed(2))} vs ${ahead.map((v) => v.toFixed(2))})`);
	await g(() => window.__stores.vrMenuOpen.set(true));
	await wait(100);
	const activeRing = await g(() => {
		let v;
		window.__stores.vrRadialMenu.activeRing.subscribe((x) => (v = x))();
		return v;
	});
	const sculptRing = await g(() => window.__stores.vrRadialMenu.ringEntries('sculpt').map((e) => e.id));
	h.check(activeRing === 'sculpt', `while sculpting the menu opens on the Sculpt ring (${activeRing})`);
	h.check(sculptRing.join() === 'sculpt:raise,sculpt:lower,sculpt:smooth,sculpt:flatten,sculpt:done', `Raise / Lower / Smooth / Flatten / Done (${sculptRing.join(' ')})`);
	await g(() => window.__stores.vrControls.executeVRMenuAction('sculpt:raise'));
	await wait(300);
	h.check(!(await g(() => { let v; window.__stores.vrMenuOpen.subscribe((x) => (v = x))(); return v; })) && (await sc()).op === 'raise', 'Raise picks the brush and closes the ring');
	// aim the pointer down at the terrain, 2 m ahead
	await xr.pose(page, pointer, [0, 1.2, -2], { pitch: -Math.PI / 2 });
	await wait(400);
	const cursor = await g(() => {
		let sc;
		window.__stores.globalScene.subscribe((v) => (sc = v))();
		const c = sc.getObjectByName('sculpt-cursor');
		return c ? { visible: c.visible, pos: c.position.toArray() } : null;
	});
	h.check(cursor?.visible && Math.abs(cursor.pos[2] + 2) < 0.1, `the brush ring follows the pointer onto the terrain (${JSON.stringify(cursor?.pos?.map((v) => +v.toFixed(2)))})`);
	s3 = await sc();
	h.check(s3.label.startsWith('Raise · ') && s3.labelHand === pointer, `the label on the ${pointer} hand reads "${s3.label}"`);
	t = await terrainState();
	const before = t;
	const tookS = await g((slot) => window.__stores.vrControls.vrModuleTriggerStart(slot), pointerSlot);
	await wait(700);
	h.check(tookS && (await sc()).stroking, 'a trigger on the terrain starts a stroke');
	await g((slot) => window.__stores.vrControls.vrModuleTriggerEnd(slot), pointerSlot);
	await g(() => window.__stores.vrControls.vrModuleSelectSwallowed());
	await wait(400);
	t = await terrainState();
	h.check(t.maxY > before.maxY + 0.05, `the stroke raised the terrain (max y ${before.maxY.toFixed(3)} -> ${t.maxY.toFixed(3)})`);
	h.check(t.undo === before.undo + 1, `ONE undo entry for the stroke (${before.undo} -> ${t.undo})`);
	await g(() => window.__stores.history.undo());
	await wait(300);
	const undone = await terrainState();
	h.check(Math.abs(undone.maxY - before.maxY) < 1e-6, `Ctrl+Z puts it back (max y ${undone.maxY.toFixed(3)})`);
	await g(() => window.__stores.history.redo());
	await wait(200);
	// the pointer stick sizes the brush, and does not walk you
	const r0 = (await sc()).radius;
	const s0 = (await sc()).strength;
	const head4 = await xr.head(page);
	await xr.stick(page, pointer, 1, 0);
	await wait(700);
	await xr.stick(page, pointer, 0, -1);
	await wait(700);
	await xr.stick(page, pointer, 0, 0);
	await wait(150);
	s3 = await sc();
	const head5 = await xr.head(page);
	h.check(s3.radius > r0 + 0.3, `stick right grows the brush (${r0} -> ${s3.radius})`);
	h.check(s3.strength > s0 + 0.1, `stick up raises the strength (${s0} -> ${s3.strength})`);
	h.check(s3.ticks > 0, `size/strength steps tick (${s3.ticks})`);
	h.check(Math.hypot(head5.x - head4.x, head5.z - head4.z) < 1e-6, `that stick does not move or turn you while sculpting (moved ${Math.hypot(head5.x - head4.x, head5.z - head4.z).toFixed(3)} m)`);
	await g(() => window.__stores.vrControls.executeVRMenuAction('sculpt:smooth'));
	await wait(200);
	h.check((await sc()).op === 'smooth', 'Smooth picks the smooth brush (the desktop toolbar store)');
	await g(() => window.__stores.vrControls.executeVRMenuAction('sculpt:done'));
	await wait(300);
	s3 = await sc();
	h.check(!s3.active && !s3.uuid, 'Done ends the session (sculpt mode off, the terrain released)');
	h.check(!(await g(() => window.__stores.vrControls.stickOwned('left') || window.__stores.vrControls.stickOwned('right'))), 'no stick is owned after Done');
	// a terrain selection's Selected ring: Sculpt terrain instead of Edit mesh
	await g((uuid) => window.__stores.objectActions.selectObject(uuid), t.uuid);
	await wait(200);
	const obj = await g(() => window.__stores.vrRadialMenu.ringEntries('object').map((e) => e.id));
	h.check(obj.includes('obj:sculpt') && !obj.includes('obj:editmesh'), `a terrain's Selected ring offers Sculpt terrain, not Edit mesh (${obj.join(' ')})`);
	await g(() => window.__stores.vrControls.executeVRMenuAction('obj:sculpt'));
	await h.eventually(sc, (x) => x.active && x.uuid === t.uuid, 'Selected > Sculpt terrain starts a session on it');
	await g(() => window.__stores.objectActions.setEditorMode('interact'));
	await wait(400);
	h.check(!(await sc()).active, 'switching to Interact ends the sculpt session');
	await g(() => window.__stores.objectActions.setEditorMode('edit'));
	await g((uuid) => window.__stores.objectActions.selectObject(uuid), box);
	await wait(200);
	const objBox = await g(() => window.__stores.vrRadialMenu.ringEntries('object').map((e) => e.id));
	h.check(objBox.includes('obj:editmesh') && !objBox.includes('obj:sculpt'), 'a box keeps Edit mesh and gets no Sculpt');

	await h.finish(browser);
});
