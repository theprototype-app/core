// 31-towers P1 — GRAB REACH and JUMP, the two rules that make a stacking game a puzzle (the
// user's Quest note: "you can't take object from specific distance and need to jump on other
// objects"). Both are CORE and opt-in, so any game can use them:
//   · `play.reach` (metres): Interact/Play grabs only what lies within that distance of the
//     player's BODY (the segment feet..eye — playReach.js). Desktop Play's crosshair says
//     "Too far" and a press does nothing; a carry is held inside the reach. A VR grip on a
//     piece out of reach does nothing but a `fail` buzz. Absent = no limit (every older scene).
//   · the Character Controller node's `jumpHeight` now jumps in VR as well (right A, Interact
//     walking); desktop walk mode already jumped on Space. The capsule stands on a piece.
// Every guard here has its counterfactual measured in the same run (reach removed → the far
// crate is grabbable; jumpHeight 0 → the crate stays a wall).
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

const REACH = 1.3;

const camWorld = (page) =>
	page.evaluate(() => {
		let cam;
		window.__stores.playerCam.subscribe((c) => (cam = c))();
		const w = cam.getWorldPosition(new window.__stores.THREE.Vector3());
		return { x: w.x, y: w.y, z: w.z };
	});
/** put the play eye at a world point, looking at another */
const aimRig = (page, eye, at) =>
	page.evaluate(
		({ eye, at }) => {
			const THREE = window.__stores.THREE;
			let cam;
			window.__stores.playerCam.subscribe((c) => (cam = c))();
			const v = new THREE.Vector3(...eye);
			if (cam.parent) cam.parent.worldToLocal(v);
			cam.position.copy(v);
			cam.updateMatrixWorld(true);
			if (at) cam.lookAt(new THREE.Vector3(...at));
			else cam.rotation.set(0, 0, 0);
			cam.updateMatrixWorld(true);
		},
		{ eye, at }
	);
const interact = (page) =>
	page.evaluate(() => {
		let s;
		window.__stores.playInteract.playInteractState.subscribe((v) => (s = v))();
		return { ...window.__stores.playInteract.playInteractDebug(), ...s };
	});
const setReach = (page, reach) =>
	page.evaluate((reach) => window.__stores.scenePhysics.setScenePhysics({ play: { reach } }), reach);
const setGraph = (page, nodes) =>
	page.evaluate((nodes) => {
		window.__stores.setActiveGraph(window.__stores.SCENE_GRAPH);
		window.__stores.flowNodes.set(
			nodes.map((n) => ({ id: n.id, type: n.type, position: { x: 0, y: 0 }, data: { type: n.type, ...n.data }, class: 'w-[150px]' }))
		);
		window.__stores.flowEdges.set([]);
	}, nodes);
const CONTROLLER = (jumpHeight) => ({
	id: 'cc',
	type: 'charcontroller',
	data: { mode: 'walk', speed: 0.05, jumpHeight, eyeHeight: 1.7, gravity: true }
});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---- the fixture: a floor (top 0), a NEAR crate, a FAR crate, a crate to jump on --------
	const ids = await page.evaluate(async () => {
		const s = window.__stores;
		const get = (store) => { let v; store.subscribe((x) => (v = x))(); return v; };
		for (let i = 0; i < 4; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 700));
		const [floor, near, far, step] = get(s.objectsGroup).children.filter((c) => c.name === 'Box');
		const place = (o, pos, scale) => { o.position.set(...pos); o.rotation.set(0, 0, 0); o.scale.set(...scale); o.updateMatrixWorld(true); };
		place(floor, [0, -0.25, 0], [30, 0.5, 30]);
		place(near, [0, 0.3, -0.9], [0.6, 0.6, 0.6]);
		place(far, [0, 0.3, -2.8], [0.6, 0.6, 0.6]);
		place(step, [5, 0.3, 0], [0.8, 0.6, 0.8]);
		s.physics.setPhysicsFor(floor.uuid, { mode: 'static' });
		for (const o of [near, far]) s.physics.setPhysicsFor(o.uuid, { mode: 'dynamic', mass: 1 });
		s.physics.setPhysicsFor(step.uuid, { mode: 'dynamic', mass: 8, friction: 1 });
		s.objectActions.deselectObject();
		s.scenePhysics.setScenePhysics({ play: { interaction: 'grab', reach: 1.3 } });
		return { floor: floor.uuid, near: near.uuid, far: far.uuid, step: step.uuid };
	});
	const play = await page.evaluate(() => {
		let v;
		window.__stores.scenePhysics.scenePlay.subscribe((x) => (v = x))();
		return v;
	});
	h.check(play.reach === REACH, `the play block stores the reach (${play.reach})`);
	await setReach(page, 999);
	const clamped = await page.evaluate(() => { let v; window.__stores.scenePhysics.scenePlay.subscribe((x) => (v = x))(); return v.reach; });
	h.check(clamped === 20, `an absurd reach clamps at the boundary (${clamped})`);
	await setReach(page, REACH);

	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => page.evaluate(() => window.__stores.physics.physicsWorldDebug().running),
		(ok) => ok,
		'premise: a simulation is running (only dynamic bodies of a running sim are grabbable)',
		15000
	);
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(800);

	// ---- 1. desktop Play: the crosshair knows what is within reach of your BODY ------------------
	await aimRig(page, [0, 1.7, 0], [0, 0.35, -0.9]);
	await h.eventually(() => interact(page), (s) => s.mode === 'aiming' && s.uuid === ids.near, 'a crate at your feet (0.9 m away, 1.7 m below the eye) is IN reach — it is measured from the body, not the eye', 4000);
	await aimRig(page, [0, 1.7, 0], [0, 0.35, -2.8]);
	await h.eventually(() => interact(page), (s) => s.mode === 'toofar' && s.uuid === ids.far, 'a crate 2.8 m away reads TOO FAR', 4000);
	h.check(/Too far/.test((await page.locator('#play-reticle-toofar').textContent().catch(() => '')) ?? ''), 'the crosshair says "Too far — get closer"');
	await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })));
	await page.waitForTimeout(250);
	let d = await interact(page);
	h.check(d.carrying === null && d.lastUp === 'too-far' && d.reachRefusals >= 1, `a press on it carries nothing (carrying ${d.carrying}, ${d.lastUp}, refusals ${d.reachRefusals})`);
	await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true })));
	// counterfactual: the SAME aim with the reach removed is an ordinary grab
	await setReach(page, null);
	await h.eventually(() => interact(page), (s) => s.mode === 'aiming' && s.uuid === ids.far, 'COUNTERFACTUAL: with no reach the far crate is grabbable (the refusal is the reach, nothing else)', 4000);
	await setReach(page, REACH);
	await h.eventually(() => interact(page), (s) => s.mode === 'toofar', 'the reach restored, it is too far again', 4000);

	// a carry is held INSIDE the reach, however far the wheel pushes it
	await aimRig(page, [0, 1.7, 0], [0, 0.35, -0.9]);
	await h.eventually(() => interact(page), (s) => s.mode === 'aiming' && s.uuid === ids.near, 'premise: aiming at the near crate again', 4000);
	await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })));
	await page.waitForTimeout(200);
	d = await interact(page);
	h.check(d.carrying === ids.near, `a press on the near crate carries it (${d.carrying === ids.near})`);
	await aimRig(page, [0, 1.7, 0], null); // look level ahead
	for (let i = 0; i < 24; i++) await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })));
	await page.waitForTimeout(1500);
	const held = await page.evaluate((uuid) => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', uuid);
		return { x: o.position.x, y: o.position.y, z: o.position.z };
	}, ids.near);
	d = await interact(page);
	const heldDist = Math.hypot(held.x, held.z);
	h.check(d.distance > 4, `premise: the wheel asked for a long carry (${d.distance.toFixed(2)} m)`);
	h.check(heldDist < REACH + 0.2, `the carried crate stays within reach (${heldDist.toFixed(2)} m from the body, reach ${REACH})`);
	await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true })));
	await page.waitForTimeout(300);

	// ---- 2. desktop jump: a Character Controller in walk mode stands ON a piece ---------------
	await setGraph(page, [CONTROLLER(1.0)]);
	await h.eventually(() => page.evaluate(() => window.__stores.charController.charControllerDebug().control?.mode), (m) => m === 'walk', 'premise: the walk controller is declared', 5000);
	await aimRig(page, [5, 1.7, 1.5], null); // 1.5 m south of the step crate, looking -Z at it
	await h.eventually(() => page.evaluate(() => window.__stores.charController.charControllerDebug().walker), (w) => w.source === 'rapier' && w.grounded, 'premise: the walker stands on the floor through the rapier capsule', 8000);
	await page.keyboard.down('KeyW');
	await page.waitForTimeout(1200);
	await page.keyboard.up('KeyW');
	await page.waitForTimeout(300);
	let eye = await camWorld(page);
	h.check(Math.abs(eye.y - 1.7) < 0.08 && eye.z > 0.2, `walking into the 0.6 m crate stops at it — too tall to step up (eye ${eye.y.toFixed(2)}, z ${eye.z.toFixed(2)})`);
	// W + Space, and let go of W once over the crate (walking has no momentum: a held W
	// carries you clean over a 0.8 m crate at 3 m/s — measured, the arc landed at z -1.8)
	await page.keyboard.down('KeyW');
	await page.keyboard.down('Space');
	await page.waitForTimeout(320);
	await page.keyboard.up('KeyW');
	await page.keyboard.up('Space');
	await page.waitForTimeout(1200);
	eye = await camWorld(page);
	const walker = (await page.evaluate(() => window.__stores.charController.charControllerDebug())).walker;
	h.check(Math.abs(eye.y - 2.3) < 0.12 && walker.grounded, `JUMP: Space + W lands you ON the crate (eye ${eye.y.toFixed(2)} = 0.6 + 1.7, grounded ${walker.grounded})`);
	const stepNow = await page.evaluate((uuid) => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', uuid);
		return [o.position.x, o.position.z];
	}, ids.step);
	h.check(Math.hypot(stepNow[0] - 5, stepNow[1]) < 0.15, `the crate you stand on was not shoved (${stepNow.map((n) => n.toFixed(2))})`);
	// counterfactual: no jump height, and the crate is a wall again
	await setGraph(page, [CONTROLLER(0)]);
	await page.waitForTimeout(300);
	await aimRig(page, [5, 1.7, 1.5], null);
	await page.waitForTimeout(800);
	await page.keyboard.down('KeyW');
	await page.keyboard.down('Space');
	await page.waitForTimeout(150);
	await page.keyboard.up('Space');
	await page.waitForTimeout(1200);
	await page.keyboard.up('KeyW');
	await page.waitForTimeout(600);
	eye = await camWorld(page);
	h.check(Math.abs(eye.y - 1.7) < 0.08, `COUNTERFACTUAL: with jumpHeight 0 the same keys leave you on the floor (eye ${eye.y.toFixed(2)})`);
	await page.evaluate(() => window.__stores.isLocked.set(null));
	await page.waitForTimeout(500);

	// ---- 3. VR Interact: a grip takes only what is within reach of the body ---------------------
	await setGraph(page, [CONTROLLER(1.0)]);
	await page.evaluate(() => window.__stores.isVRMode.set(true));
	await xr.install(page);
	await xr.installSpace(page, { head: [0, 1.6, 0], yaw: 0 });
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await page.waitForTimeout(400);
	const gripAt = (target) =>
		page.evaluate(
			({ target }) => {
				const s = window.__stores;
				const THREE = s.THREE;
				let cam; s.globalCamera.subscribe((c) => (cam = c))();
				cam.position.set(0, 1.6, 0);
				cam.updateMatrixWorld(true);
				const hand = new THREE.Vector3(0.2, 1.2, -0.25);
				const ray = new THREE.Raycaster(hand, new THREE.Vector3(...target).sub(hand).normalize());
				const got = s.vrControls.gripTargetOf(ray, hand, 'interact');
				return { got: got?.uuid ?? null, refusal: s.vrControls.lastGripRefusalDebug() };
			},
			{ target }
		);
	let g = await gripAt([0, 0.3, -0.9]);
	h.check(g.got === ids.near && g.refusal === null, `VR: a grip on the near crate takes it (${g.got === ids.near})`);
	g = await gripAt([0, 0.3, -2.8]);
	h.check(g.got === null && g.refusal?.uuid === ids.far, `VR: a grip on the far crate takes nothing, and says why (${JSON.stringify(g.refusal)})`);
	await setReach(page, null);
	g = await gripAt([0, 0.3, -2.8]);
	h.check(g.got === ids.far, 'COUNTERFACTUAL: with no reach the same grip takes the far crate');
	await setReach(page, REACH);
	// the real per-frame path: squeezing at the far crate buzzes `fail` and holds nothing
	await xr.pose(page, 'right', [0.2, 1.2, -0.25], { pitch: -Math.atan2(0.9, 2.55), yaw: 0 });
	const before = await xr.pulses(page);
	await xr.button(page, 'right', 1, true);
	await page.waitForTimeout(400);
	const grip = await page.evaluate(() => window.__stores.vrControls.vrGripDebug());
	const after = await xr.pulses(page);
	await xr.button(page, 'right', 1, false);
	await page.waitForTimeout(200);
	h.check(grip.grab === null && !grip.worldGrab, `VR: the squeeze holds nothing and never grabs the world (${JSON.stringify(grip)})`);
	h.check(after.right > before.right, `VR: ...and buzzes the hand (pulses ${before.right} -> ${after.right})`);

	// ---- 4. VR jump: right A leaves the ground while the controller can jump ---------------------
	await xr.installSpace(page, { head: [-6, 1.6, 6], yaw: 0 });
	await page.waitForTimeout(600);
	h.check((await page.evaluate(() => window.__stores.vrControls.vrJumpHeight())) === 1, 'VR: Interact + a walk controller with jumpHeight 1 can jump');
	const sampleHead = async (ms) => {
		let max = -Infinity;
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			const hd = await xr.head(page);
			if (hd.y > max) max = hd.y;
			await page.waitForTimeout(40);
		}
		return max;
	};
	await xr.button(page, 'right', 4, true);
	const peak = await sampleHead(700);
	await xr.button(page, 'right', 4, false);
	await page.waitForTimeout(1200);
	let hd = await xr.head(page);
	h.check(peak > 2.2, `VR: pressing A lifts the head well off the ground (peak ${peak.toFixed(2)}, standing 1.60)`);
	h.check(Math.abs(hd.y - 1.6) < 0.1, `VR: ...and it lands again (${hd.y.toFixed(2)})`);
	const ptt = await page.evaluate(() => { let v; window.__stores.voiceChat.pttActive.subscribe((x) => (v = x))(); return v; });
	h.check(!ptt, `VR: while A jumps it is not push-to-talk (${ptt})`);
	// counterfactual: no controller node, no jump
	await setGraph(page, []);
	await h.eventually(() => page.evaluate(() => window.__stores.vrControls.vrJumpHeight()), (v) => v === 0, 'with no controller node the VR jump is off', 4000);
	await xr.button(page, 'right', 4, true);
	const flat = await sampleHead(600);
	await xr.button(page, 'right', 4, false);
	h.check(flat < 1.7, `COUNTERFACTUAL: A no longer jumps (peak ${flat.toFixed(2)})`);
	await xr.uninstall(page);
	await page.evaluate(() => window.__stores.isVRMode.set(false));
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));

	// ---- 5. Configure Scene ▸ Physics ▸ Play mode: the Limit grab reach row ----------------------
	await page.evaluate(() => window.__stores.openSceneSection('Physics'));
	await page.waitForTimeout(1200);
	const row = await page.evaluate(() => ({
		on: document.querySelector('#physics-play-reach-on')?.checked ?? null,
		slider: !!document.querySelector('#physics-play-reach')
	}));
	h.check(row.on === true && row.slider, `the Inspector row reads the scene's reach (${JSON.stringify(row)})`);
	await page.click('#physics-play-reach-on');
	await page.waitForTimeout(400);
	const off = await page.evaluate(() => { let v; window.__stores.scenePhysics.scenePlay.subscribe((x) => (v = x))(); return { has: 'reach' in v, slider: !!document.querySelector('#physics-play-reach') }; });
	h.check(!off.has && !off.slider, `unticking removes the key (a scene without a reach saves as before) and folds the slider (${JSON.stringify(off)})`);
	await page.click('#physics-play-reach-on');
	await page.waitForTimeout(400);
	const on = await page.evaluate(() => { let v; window.__stores.scenePhysics.scenePlay.subscribe((x) => (v = x))(); return v.reach; });
	h.check(on === 1.3, `ticking it sets a 1.3 m reach (${on})`);

	await h.finish(browser);
});
