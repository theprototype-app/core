// Roadmap 71 TR6 — THE VISITOR GRAB DEFAULT, on a real cloud plugin: host A, viewer B.
//   1  default: B's crosshair does not offer the crate, a press carries nothing, a raw `move` and `hit` reach nobody
//   2  N6 folded + unfolded: the switch in the Play section; the host turns it on and it reaches B
//   3  on: B carries the crate and A sees it. A static object, a resize and a locked crate stay refused
//   4  COUNTERFACTUAL: an editor needs no switch
//   5  VR (IWER): the same real squeeze is refused with the switch off and takes the crate with it on
// Run: E2E_CLOUD_PLUGIN=/cloud-plugin.js APP_URL=https://theprototype.app:5601/ npm run e2e -- roles-visitor-grab
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');

const SHOTS = process.env.E2E_SHOT_DIR || '';
const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'get', 'arg', src)(window.__stores, pc, get, a);
		},
		[body, arg ?? null]
	);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RI = 'const r = get(s.cloudHooks.rolesInfo);';
const myRole = (p) => inPage(p, RI + 'return r?.myRole ?? null;');
const poseOf = (p, uuid) =>
	inPage(p, 'const o = get(s.objectsGroup).getObjectByProperty("uuid", arg); return o ? { pos: o.position.toArray(), scale: o.scale.toArray() } : null;', uuid);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const setSwitch = (p, on) => inPage(p, 's.scenePhysics.setScenePhysics({ play: { visitorsGrab: arg } });', on);
const seesSwitch = (p) => inPage(p, 'return get(s.scenePhysics.scenePlay).visitorsGrab === true;');
const raw = (p, msg) => inPage(p, 'pc.send(arg);', msg);
const interact = (p) => inPage(p, 'return { ...s.playInteract.playInteractDebug(), ...get(s.playInteract.playInteractState) };');
const aim = (p, eye, at) =>
	inPage(
		p,
		`const THREE = s.THREE; const cam = get(s.playerCam); const v = new THREE.Vector3(...arg.eye);
		if (cam.parent) cam.parent.worldToLocal(v);
		cam.position.copy(v); cam.updateMatrixWorld(true); cam.lookAt(new THREE.Vector3(...arg.at)); cam.updateMatrixWorld(true);`,
		{ eye, at }
	);
const press = (p) => p.page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })));
const lift = (p) => p.page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true })));
const EYE = [0, 1.7, 0];
const CRATE = [0, 0.4, -1.6];

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B', { init: iwer.initScript() });
	if (!(await inPage(A, RI + 'return !!r;'))) {
		console.log('no roles plugin in this build: set E2E_CLOUD_PLUGIN to prove this');
		await h.finish(browser, [A, B]);
		return;
	}
	await h.connect(B, A);
	await inPage(A, RI + 'r.setRole(arg, "viewer");', B.id);
	await h.eventually(() => myRole(B), (v) => v === 'viewer', 'B is a viewer', 20000);

	const ids = await inPage(
		A,
		`for (let i = 0; i < 3; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 900));
		const [floor, crate, statue] = get(s.objectsGroup).children.filter((c) => c.name === 'Box');
		const place = (o, pos, scale) => { o.position.set(...pos); o.rotation.set(0, 0, 0); o.scale.set(...scale); o.updateMatrixWorld(true);
			pc.send({ type: 'move', uuid: o.uuid, pos, rot: [0, 0, 0], scale }); };
		place(floor, [0, -0.25, 0], [30, 0.5, 30]);
		place(crate, arg, [0.8, 0.8, 0.8]);
		place(statue, [2, 0.4, -1.6], [0.8, 0.8, 0.8]);
		s.physics.setPhysicsFor(floor.uuid, { mode: 'static' });
		s.physics.setPhysicsFor(statue.uuid, { mode: 'static' });
		s.physics.setPhysicsFor(crate.uuid, { mode: 'dynamic', mass: 1 });
		s.objectActions.deselectObject();
		return { floor: floor.uuid, crate: crate.uuid, statue: statue.uuid };`,
		CRATE
	);
	const mode = (uuid) => inPage(B, 'return get(s.objectsGroup).getObjectByProperty("uuid", arg)?.userData?.physics?.mode ?? null;', uuid);
	await h.eventually(() => mode(ids.crate), (m) => m === 'dynamic', 'premise: B knows the crate is dynamic', 20000);
	await h.eventually(() => mode(ids.statue), (m) => m === 'static', 'premise: B knows the statue is static', 20000);

	await inPage(A, 's.physics.toggleSimulation();');
	await h.eventually(() => inPage(A, 'return s.physics.physicsWorldDebug().running;'), (ok) => ok, 'premise: the simulation runs on the host', 30000);
	await wait(1500);

	console.log('\n=== 1. the default: no grab ===');
	h.check((await seesSwitch(A)) === false, 'the switch starts off');
	await inPage(B, 's.isLocked.set(true);');
	await wait(600);
	await aim(B, EYE, CRATE);
	await wait(800);
	const off = await interact(B);
	h.check(off.mode === 'idle', `the crosshair offers nothing (${off.mode})`);
	await press(B);
	await wait(300);
	const offPress = await interact(B);
	await lift(B);
	h.check(offPress.carrying == null, `a press carries nothing (${offPress.carrying})`);
	await B.page.locator('text=View-only').first().waitFor({ state: 'attached', timeout: 8000 }).then(() => h.check(true, 'and B is told why'), () => h.check(false, 'and B is told why'));
	const restA = await poseOf(A, ids.crate);
	await raw(B, { type: 'move', uuid: ids.crate, pos: [9, 4, 9], rot: [0, 0, 0], scale: [0.8, 0.8, 0.8] });
	await raw(B, { type: 'hit', uuid: ids.crate, linvel: [0, 9, 0], angvel: [0, 0, 0], point: CRATE, speed: 9, at: Date.now(), by: B.id, probe: 'e2e' });
	await wait(1800);
	h.check(dist((await poseOf(A, ids.crate)).pos, restA.pos) < 0.2, 'a raw move and a raw hit reach nobody');

	console.log('\n=== 2. the switch ===');
	await inPage(A, 's.openSceneSection("Play");');
	const toggle = A.page.locator('#physics-play-visitors-grab');
	await toggle.waitFor({ state: 'attached', timeout: 15000 });
	for (const [label, width, height] of [['folded', 360, 800], ['unfolded', 720, 800]]) {
		await A.page.setViewportSize({ width, height });
		await inPage(A, 's.openSceneSection("Play");');
		await wait(500);
		await toggle.scrollIntoViewIfNeeded();
		const box = await toggle.boundingBox();
		h.check(!!box && box.x >= 0 && box.x + box.width <= width, label + ': the switch is on screen (' + JSON.stringify(box) + ')');
		if (SHOTS) await A.page.screenshot({ path: `${SHOTS}/switch-${label}.png` });
	}
	await toggle.click({ force: true });
	await A.page.setViewportSize({ width: 1280, height: 800 });
	await h.eventually(() => seesSwitch(A), (v) => v, 'a tap turns it on for the host', 8000);
	await h.eventually(() => seesSwitch(B), (v) => v, 'and it reaches the visitor', 15000);

	console.log('\n=== 3. allowed: dynamic bodies only ===');
	await aim(B, EYE, (await poseOf(B, ids.crate)).pos);
	await h.eventually(() => interact(B), (s) => s.mode === 'aiming' && s.uuid === ids.crate, 'the crosshair now offers the crate', 8000);
	const fromA = (await poseOf(A, ids.crate)).pos;
	await press(B);
	await h.eventually(() => interact(B), (s) => s.carrying === ids.crate, 'a press takes it', 5000);
	await aim(B, EYE, [2.2, 1.6, -1.6]);
	await h.eventually(async () => dist((await poseOf(A, ids.crate)).pos, fromA), (d) => d > 0.3, 'A sees the carry', 15000);
	if (SHOTS) await A.page.screenshot({ path: `${SHOTS}/carried-seen-by-host.png` });
	await lift(B);
	await h.eventually(() => interact(B), (s) => s.carrying == null, 'B lets go', 5000);

	await aim(B, EYE, [2, 0.4, -1.6]);
	await wait(800);
	const statueAim = await interact(B);
	h.check(statueAim.mode === 'idle', `the crosshair does not offer the static statue (${statueAim.mode})`);
	const statueAt = await poseOf(A, ids.statue);
	await raw(B, { type: 'move', uuid: ids.statue, pos: [9, 4, 9], rot: [0, 0, 0], scale: [0.8, 0.8, 0.8] });
	await wait(1200);
	h.check(dist((await poseOf(A, ids.statue)).pos, statueAt.pos) < 0.01, 'COUNTERFACTUAL: a raw move of the static statue is dropped with the switch on');
	const now = await poseOf(A, ids.crate);
	await raw(B, { type: 'move', uuid: ids.crate, pos: now.pos, rot: [0, 0, 0], scale: [5, 5, 5] });
	await wait(1200);
	h.check(Math.abs((await poseOf(A, ids.crate)).scale[0] - 0.8) < 0.01, 'a move that resizes the crate is dropped');
	// a raw hit the switch now lets through: the same message section 1 dropped
	await h.eventually(async () => {
		await wait(800);
		const y0 = (await poseOf(A, ids.crate)).pos[1];
		await raw(B, { type: 'hit', uuid: ids.crate, linvel: [0, 9, 0], angvel: [0, 0, 0], point: CRATE, speed: 9, at: Date.now(), by: B.id, probe: 'e2e' });
		await wait(500);
		return (await poseOf(A, ids.crate)).pos[1] - y0;
	}, (dy) => dy > 0.2, 'the raw hit dropped in section 1 now lands on A', 25000);
	// a lock (someone working on it) takes it out of reach again
	await inPage(A, 'get(s.lockedObjects); s.lockedObjects.update((l) => [...l, ["someone", arg]]);', ids.crate);
	await inPage(B, 's.lockedObjects.update((l) => [...l, ["someone", arg]]);', ids.crate);
	const lockedAt = await poseOf(A, ids.crate);
	await raw(B, { type: 'move', uuid: ids.crate, pos: [9, 4, 9], rot: [0, 0, 0], scale: [0.8, 0.8, 0.8] });
	await wait(1200);
	h.check(dist((await poseOf(A, ids.crate)).pos, [9, 4, 9]) > 2, 'a locked crate is refused (' + lockedAt.pos.map((v) => v.toFixed(1)) + ')');
	await inPage(A, 's.lockedObjects.update((l) => l.filter((e) => e[1] !== arg));', ids.crate);
	await inPage(B, 's.lockedObjects.update((l) => l.filter((e) => e[1] !== arg));', ids.crate);

	console.log('\n=== 4. an editor needs no switch ===');
	await setSwitch(A, false);
	await h.eventually(() => seesSwitch(B), (v) => !v, 'the switch is off on B again', 15000);
	await wait(1500);
	await aim(B, EYE, (await poseOf(B, ids.crate)).pos);
	await h.eventually(() => interact(B), (s) => s.mode === 'idle', 'off again: the crosshair offers nothing', 8000);
	await inPage(A, RI + 'r.setRole(arg, "editor");', B.id);
	await h.eventually(() => myRole(B), (v) => v === 'editor', 'B is an editor', 15000);
	await h.eventually(() => interact(B), (s) => s.mode === 'aiming' && s.uuid === ids.crate, 'COUNTERFACTUAL: with the switch off an editor is offered the crate', 8000);
	await inPage(A, RI + 'r.setRole(arg, "viewer");', B.id);
	await h.eventually(() => myRole(B), (v) => v === 'viewer', 'B is a viewer again', 15000);
	await inPage(B, 's.isLocked.set(false);');

	console.log('\n=== 5. VR: a real squeeze (IWER) ===');
	await iwer.enter(B.page);
	await iwer.frames(B.page, 6);
	await inPage(B, 's.objectActions.setEditorMode("interact");');
	await iwer.pose(B.page, 'head', [0, 1.6, 0]);
	const crateNow = (await poseOf(B, ids.crate)).pos;
	await iwer.frames(B.page, 4);
	// a hand beside the crate, aimed at it
	const hand = [crateNow[0] + 0.1, crateNow[1] + 0.5, crateNow[2] + 0.7];
	const dx = crateNow[0] - hand[0], dy = crateNow[1] - hand[1], dz = crateNow[2] - hand[2];
	await iwer.pose(B.page, 'right', hand, { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) });
	await iwer.frames(B.page, 4);
	const grip = () => inPage(B, 'return { ...s.vrControls.vrGripDebug(), refused: s.vrControls.refusedGripsDebug() };');
	const before = await grip();
	await iwer.button(B.page, 'right', 'squeeze', 1);
	await iwer.frames(B.page, 6);
	const refused = await grip();
	await iwer.button(B.page, 'right', 'squeeze', 0);
	await iwer.frames(B.page, 4);
	h.check(refused.grab === null, `switch off: the squeeze holds nothing (${refused.grab})`);
	h.check(refused.refused === before.refused + 1, `and it is a refusal by role, not a miss (${before.refused} -> ${refused.refused})`);
	h.check(!refused.worldGrab && !refused.worldPan, 'and it does not grab the world');
	await setSwitch(A, true);
	await h.eventually(() => seesSwitch(B), (v) => v, 'the switch reaches the headset', 15000);
	await iwer.button(B.page, 'right', 'squeeze', 1);
	await iwer.frames(B.page, 6);
	const taken = await grip();
	h.check(taken.grab === ids.crate && taken.grabInteract, `switch on: the SAME squeeze takes the crate (${taken.grab === ids.crate})`);
	const heldFrom = (await poseOf(A, ids.crate)).pos;
	await iwer.pose(B.page, 'right', [hand[0] + 1, hand[1] + 0.4, hand[2]], { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) });
	await iwer.frames(B.page, 10);
	await h.eventually(async () => {
		await iwer.frames(B.page, 2);
		return dist((await poseOf(A, ids.crate)).pos, heldFrom);
	}, (d) => d > 0.3, 'A sees the hand carry it', 15000);
	await iwer.button(B.page, 'right', 'squeeze', 0);
	await iwer.frames(B.page, 4);
	h.check((await grip()).grab === null, 'the hand lets go');

	await h.finish(browser, [A, B]);
});
