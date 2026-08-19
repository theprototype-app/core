// 21-B B3 — play mode becomes interact mode.
//
// isLocked is set through window.__stores (the dungeon-play pattern): real
// pointer lock is unavailable headless AND unnecessary here, because the ray is
// NDC (0,0) every frame and every listener is on `window`.
//
// The check that would have been easiest to fake is the stuck-kinematic guard
// (4.x): a cancel must leave the body DYNAMIC, because a body left kinematic
// forever is the failure mode. It is asserted on the rapier body type, not on
// our own bookkeeping.

const h = require('./helpers.cjs');

const sp = (page, body) =>
	page.evaluate((b) => new Function('sp', b)(window.__stores.scenePhysics), body);
const play = (page, body) =>
	page.evaluate((b) => new Function('pi', b)(window.__stores.playInteract), body);
const phys = (page, body) =>
	page.evaluate((b) => new Function('p', b)(window.__stores.physics), body);

const bodyOf = (page, uuid) =>
	page.evaluate((uuid) => window.__stores.physics.physicsDebug().find((b) => b.uuid === uuid), uuid);

const posOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const o = group.getObjectByProperty('uuid', uuid);
		return o ? o.position.toArray() : null;
	}, uuid);

// Two things about this environment shape every fixture below.
//
// (1) Headless has no real pointer lock, so PointerLockControls' own
//     pointerlockchange handler never runs and never swaps threlte's camera:
//     playInteract is handed the EDITOR camera, exactly as it would be handed
//     the player camera in a real session. Its logic does not care which.
// (2) OrbitControls re-derives the editor camera's position from its own
//     spherical state every frame, so writing camera.position is reverted on the
//     next frame (the documented trap). So we move the TARGET, never the camera.
async function placeInFront(page, uuid, distance) {
	return page.evaluate(
		([uuid, distance]) => {
			const THREE = window.__stores.THREE;
			let camera = null;
			let group = null;
			window.__stores.globalCamera.subscribe((v) => (camera = v))();
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			const at = camera
				.getWorldPosition(new THREE.Vector3())
				.addScaledVector(camera.getWorldDirection(new THREE.Vector3()), distance);
			const object = group.getObjectByProperty('uuid', uuid);
			object.position.copy(at);
			object.updateMatrixWorld();
			window.__stores.objectsGroup.update((v) => v);
			return at.toArray();
		},
		[uuid, distance]
	);
}

/** how far is the object from the camera doing the aiming? */
const rangeOf = (page, uuid) =>
	page.evaluate((uuid) => {
		const THREE = window.__stores.THREE;
		let camera = null;
		let group = null;
		window.__stores.globalCamera.subscribe((v) => (camera = v))();
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const object = group.getObjectByProperty('uuid', uuid);
		if (!object) return null;
		return camera
			.getWorldPosition(new THREE.Vector3())
			.distanceTo(object.getWorldPosition(new THREE.Vector3()));
	}, uuid);

/** the PLAY rig — the player camera's parent, not the editor dolly */
const rigY = (page) =>
	page.evaluate(() => {
		let cam = null;
		window.__stores.playerCam.subscribe((v) => (cam = v))();
		return cam?.parent ? cam.parent.position.y : null;
	});

/** dispatch a wheel the way the browser does: on the CANVAS, bubbling to
  * window. Dispatching ON window collapses the capture and bubble phases into
  * registration order, so the capture-phase claim cannot win — an artefact of
  * the test, not of the app. */
const wheel = (page, deltaY, times = 1) =>
	page.evaluate(
		([deltaY, times]) => {
			let renderer = null;
			window.__stores.globalRenderer.subscribe((v) => (renderer = v))();
			const target = renderer?.domElement ?? document.body;
			let prevented = false;
			for (let i = 0; i < times; i++) {
				const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
				target.dispatchEvent(event);
				prevented = event.defaultPrevented;
			}
			return prevented;
		},
		[deltaY, times]
	);
const pointer = (page, type, button = 0) =>
	page.evaluate(
		([type, button]) => {
			window.dispatchEvent(new PointerEvent(type, { button, bubbles: true }));
		},
		[type, button]
	);

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// a dynamic crate and a STATIC plinth, four metres in front of the camera
	const ids = await page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		let group = null;
		cmd('/create box');
		cmd('/create box');
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const [crate, plinth] = group.children.slice(-2);
		crate.name = 'Crate';
		crate.position.set(0, 1, 0);
		crate.userData.physics = { mode: 'dynamic', mass: 1 };
		plinth.name = 'Plinth';
		plinth.position.set(3, 1, 0);
		plinth.userData.physics = { mode: 'static' };
		window.__stores.objectsGroup.update((v) => v);
		return { crate: crate.uuid, plinth: plinth.uuid };
	});
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await sp(page, 'sp.setScenePhysics({ play: { interaction: "grab" }, ground: { enabled: true, height: 0 } })');

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the listeners are live only in play mode ===');

	const offMode = await play(page, 'return pi.playInteractDebug()');
	h.check(offMode.started === true, '1.1 startPlayInteract ran from Scene onMount');
	h.check(offMode.mode === 'off', '1.2 ...and the interact mode is off outside play mode');

	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(400);
	const onMode = await play(page, 'return pi.playInteractDebug()');
	h.check(onMode.mode === 'grab', '1.3 entering play mode arms the grab (got ' + onMode.mode + ')');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. grab, carry, and the crosshair ===');

	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => phys(page, 'return p.physicsDebug().length'),
		(n) => n > 0,
		'2.1 (premise) the simulation is running with a dynamic crate'
	);
	await placeInFront(page, ids.crate, 4);
	await page.waitForTimeout(400);

	const aiming = await page.evaluate(() => {
		let s = null;
		window.__stores.playInteract.playInteractState.subscribe((v) => (s = v))();
		return s;
	});
	h.check(aiming.mode === 'aiming', '2.2 the crosshair reports a grabbable target (' + aiming.mode + ')');

	await pointer(page, 'pointerdown');
	await page.waitForTimeout(300);
	const held = await bodyOf(page, ids.crate);
	const carrying = await play(page, 'return pi.playInteractDebug()');
	h.check(carrying.carrying === ids.crate, '2.3 pointerdown grabs the crate');
	h.check(held?.hold === 'user', '2.4 ...as a user hold (physicsDebug: ' + held?.hold + ')');
	h.check(held?.bodyType === 2, '2.5 ...and the rapier body is kinematic (type ' + held?.bodyType + ')');

	// the spring pulls the crate to the CARRY POINT — camera + forward * distance
	// — from wherever it was grabbed, which is what "it follows the camera" means
	// with the camera held still
	const grabbedAt = await rangeOf(page, ids.crate);
	await page.waitForTimeout(1200);
	const settledAt = await rangeOf(page, ids.crate);
	h.check(grabbedAt > 3.5, '2.6 (premise) it was grabbed at arm\'s length (' + grabbedAt.toFixed(2) + ' m)');
	// the pickup does not YANK: it carries at the range you grabbed at, and the
	// wheel is what changes that (section 3)
	h.check(
		Math.abs(settledAt - grabbedAt) < 0.35,
		'2.7 the spring holds it at its grab range instead of yanking (' +
			grabbedAt.toFixed(2) +
			' -> ' +
			settledAt.toFixed(2) +
			' m)'
	);
	// ...and it is really held against gravity, which a dynamic body is not
	h.check(
		(await posOf(page, ids.crate))[1] > 1,
		'2.8 ...and it does not fall while carried'
	);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. the wheel changes carry distance and NOT moveSpeed ===');

	const walk = async () =>
		page.evaluate(async () => {
			// the rig PointerLockControls drives is the play CAMERA itself — its
			// cameraParent is useParent(), and it throws unless that is a Camera
			let rig = null;
			window.__stores.playerCam.subscribe((v) => (rig = v))();
			if (!rig) return null;
			const from = rig.position.clone();
			document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
			await new Promise((r) => setTimeout(r, 500));
			document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
			return from.distanceTo(rig.position);
		});
	const walkBefore = await walk();
	const distBefore = (await play(page, 'return pi.playInteractDebug()')).distance;
	const prevented = await wheel(page, -100);
	await page.waitForTimeout(200);
	const distAfter = (await play(page, 'return pi.playInteractDebug()')).distance;
	h.check(distAfter > distBefore, '3.1 the wheel pushes the crate further away (' + distBefore + ' -> ' + distAfter + ')');
	h.check(
		prevented,
		'3.2 ...and the event is marked handled, which is how PointerLockControls knows to stand down'
	);
	// and the clamp
	await wheel(page, -100, 40);
	await page.waitForTimeout(200);
	const clamped = (await play(page, 'return pi.playInteractDebug()')).distance;
	// moveSpeed is a component local, so measure what it DOES rather than reading
	// it. Measured AFTER the 41-event burst, and against a threshold the real
	// failure mode would blow through: PointerLockControls moves moveSpeed by 0.01
	// per wheel event from a base of 0.1, so a leaked burst is a TENFOLD walk —
	// while a 500 ms sample of the same speed varies ~40% on frame timing alone.
	const walkAfter = await walk();
	h.check(
		walkBefore > 0 && walkAfter < walkBefore * 2,
		'3.3 a carry wheel does not leak into walking speed — 41 events would be 10x (' +
			(walkBefore ?? 0).toFixed(2) +
			' m -> ' +
			(walkAfter ?? 0).toFixed(2) +
			' m per 0.5 s)'
	);
	h.check(clamped <= 6.0001, '3.4 carry distance clamps at 6 m (got ' + clamped + ')');
	await page.waitForTimeout(900);
	const pushedTo = await rangeOf(page, ids.crate);
	h.check(
		Math.abs(pushedTo - clamped) < 0.4,
		'3.5 the crate really travels to the new carry distance (' + pushedTo.toFixed(2) + ' m vs ' + clamped + ')'
	);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. release throws; every cancel path does NOT ===');

	// the flick: yank the carry point from 6 m back to 0.8 m, so the crate is
	// travelling hard toward the camera at the moment of release
	await wheel(page, 100, 40);
	await page.waitForTimeout(120);
	await pointer(page, 'pointerup');
	await page.waitForTimeout(150);
	const thrown = await bodyOf(page, ids.crate);
	const speed = Math.hypot(thrown?.linvel?.x ?? 0, thrown?.linvel?.y ?? 0, thrown?.linvel?.z ?? 0);
	h.check(thrown?.hold === null, '4.1 release returns the body to dynamic');
	h.check(thrown?.bodyType === 0, '4.2 ...as a rapier DYNAMIC body (type ' + thrown?.bodyType + ')');
	h.check(speed > 1, '4.3 the flick became a throw (|v| = ' + speed.toFixed(2) + ' m/s)');

	// cancel: leaving play mode mid-carry
	await placeInFront(page, ids.crate, 3);
	await page.waitForTimeout(400);
	await pointer(page, 'pointerdown');
	await page.waitForTimeout(300);
	h.check(
		(await play(page, 'return pi.playInteractDebug()')).carrying === ids.crate,
		'4.4 (premise) carrying again'
	);
	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(400);
	const cancelled = await bodyOf(page, ids.crate);
	// HORIZONTAL speed: the body is read a few frames after the cancel and has
	// already started falling, so total speed would measure gravity. A cancelled
	// carry drops straight down; a throw does not.
	const cancelSpeed = Math.hypot(cancelled?.linvel?.x ?? 0, cancelled?.linvel?.z ?? 0);
	h.check(cancelled?.hold === null, '4.5 leaving play mode releases the hold');
	h.check(
		cancelled?.bodyType === 0,
		'4.6 ...leaving the body DYNAMIC, never stuck kinematic (type ' + cancelled?.bodyType + ')'
	);
	h.check(cancelSpeed < 0.6, '4.7 ...and a cancel is not a throw (horizontal |v| = ' + cancelSpeed.toFixed(2) + ' m/s)');

	// cancel: the simulation stopping under a live carry
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await placeInFront(page, ids.crate, 3);
	await page.waitForTimeout(500);
	await pointer(page, 'pointerdown');
	await page.waitForTimeout(300);
	const grabbedAgain = (await play(page, 'return pi.playInteractDebug()')).carrying;
	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await page.waitForTimeout(400);
	const afterStop = await play(page, 'return pi.playInteractDebug()');
	h.check(grabbedAgain === ids.crate, '4.8 (premise) carrying when the sim stops');
	h.check(afterStop.carrying === null, '4.9 stopping the simulation cancels the carry');

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. what may NOT be grabbed ===');

	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await page.waitForTimeout(600);
	await placeInFront(page, ids.plinth, 3); // the STATIC plinth
	await placeInFront(page, ids.crate, 30); // and the crate far out of reach
	await page.waitForTimeout(400);
	await pointer(page, 'pointerdown');
	await page.waitForTimeout(300);
	h.check(
		(await play(page, 'return pi.playInteractDebug()')).carrying === null,
		'5.1 a STATIC object refuses the grab — scenery can never be dragged'
	);
	await pointer(page, 'pointerup');

	// a peer-locked object
	await page.evaluate(
		(uuid) => window.__stores.lockedObjects.set([['peer-x', uuid]]),
		ids.crate
	);
	await placeInFront(page, ids.plinth, 30);
	await placeInFront(page, ids.crate, 3);
	await page.waitForTimeout(400);
	await pointer(page, 'pointerdown');
	await page.waitForTimeout(300);
	h.check(
		(await play(page, 'return pi.playInteractDebug()')).carrying === null,
		'5.2 a peer-LOCKED object refuses the grab'
	);
	await pointer(page, 'pointerup');
	await page.evaluate(() => window.__stores.lockedObjects.set([]));

	// with NO simulation there is no body to hold, so a grab is inert — which is
	// what bounds the blast radius of shipping 'grab' as the default: in an
	// ordinary shared scene nobody is simulating until someone presses P
	await sp(page, 'sp.setScenePhysics({ play: { interaction: "grab" } })');
	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await placeInFront(page, ids.crate, 3);
	await page.waitForTimeout(500);
	const aimNoSim = await page.evaluate(() => {
		let value = null;
		window.__stores.playInteract.playInteractState.subscribe((v) => (value = v))();
		return value;
	});
	await pointer(page, 'pointerdown');
	await page.waitForTimeout(300);
	h.check(
		(await play(page, 'return pi.playInteractDebug()')).carrying === null,
		'5.4 with no simulation running the grab is INERT (nothing to hold)'
	);
	h.check(
		aimNoSim.mode !== 'aiming',
		'5.5 ...and the crosshair does not even offer it (' + aimNoSim.mode + ')'
	);
	await pointer(page, 'pointerup');
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await page.waitForTimeout(600);

	// interaction: 'off'
	await sp(page, 'sp.setScenePhysics({ play: { interaction: "off" } })');
	await page.waitForTimeout(300);
	await pointer(page, 'pointerdown');
	await page.waitForTimeout(300);
	h.check(
		(await play(page, 'return pi.playInteractDebug()')).carrying === null,
		'5.6 interaction "off" disables the grab entirely'
	);
	await pointer(page, 'pointerup');

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. a TAP fires On Click, which play mode never had ===');

	await sp(page, 'sp.setScenePhysics({ play: { interaction: "click" } })');
	await page.evaluate((uuid) => {
		// write BOTH halves: flowGraphs is what the RUNTIME reads, flowNodes is the
		// editor VIEW, and the mirror runs both ways — writing one leaves the other
		// stale (this check flaked exactly that way, then failed 3/3)
		const nodes = [
			{ id: 'clk1', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 }, class: 'w-[150px]' },
			{ id: 'selC', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', selected: uuid }, class: 'w-[150px]' },
			{ id: 'cnt1', type: 'counter', position: { x: 0, y: 200 }, data: { type: 'counter', op: 'up', step: 1 }, class: 'w-[150px]' }
		];
		const edges = [
			{ id: 'e-clk1-selC', source: 'clk1', target: 'selC' },
			{ id: 'e-clk1-cnt1', source: 'clk1', target: 'cnt1' }
		];
		window.__stores.flowGraphs.update((graphs) => ({ ...graphs, scene: { nodes, edges } }));
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set(edges);
	}, ids.crate);
	await placeInFront(page, ids.crate, 3);
	await page.waitForTimeout(500);
	const countBefore = await page.evaluate(() => {
		let map = {};
		window.__stores.flowTriggers.subscribe((v) => (map = v))();
		return map.cnt1?.count ?? 0;
	});
	// ONE in-page gesture: a tap is defined by the gap between down and up (180
	// ms), and two CDP round-trips can exceed that under load — the check flaked
	// exactly that way
	await page.evaluate(
		() =>
			new Promise((resolve) => {
				window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
				setTimeout(() => {
					window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
					resolve(true);
				}, 120);
			})
	);
	await page.waitForTimeout(400);
	const countAfter = await page.evaluate(() => {
		let map = {};
		window.__stores.flowTriggers.subscribe((v) => (map = v))();
		return map.cnt1?.count ?? 0;
	});
	h.check(
		countAfter > countBefore,
		'6.1 a short tap pulses the On Click node (' + countBefore + ' -> ' + countAfter + ')'
	);
	h.check(
		(await play(page, 'return pi.playInteractDebug()')).carrying === null,
		'6.2 ...and in "click" mode nothing is picked up'
	);

	// a long press is NOT a tap
	const beforeLong = await page.evaluate(() => {
		let map = {};
		window.__stores.flowTriggers.subscribe((v) => (map = v))();
		return map.cnt1?.count ?? 0;
	});
	await pointer(page, 'pointerdown');
	await page.waitForTimeout(500);
	await pointer(page, 'pointerup');
	await page.waitForTimeout(400);
	const afterLong = await page.evaluate(() => {
		let map = {};
		window.__stores.flowTriggers.subscribe((v) => (map = v))();
		return map.cnt1?.count ?? 0;
	});
	h.check(afterLong === beforeLong, '6.3 a long press is not a tap (' + beforeLong + ' -> ' + afterLong + ')');

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. playSettings: the shared block, module overrides, grounded ===');

	const resolved = await page.evaluate(() => {
		let scene = null;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		return window.__stores.playSettings.resolvePlaySettings(scene);
	});
	h.check(resolved.interaction === 'click', '7.1 the scene block drives the resolved interaction');
	h.check(resolved.eyeHeight === 0.8, '7.2 eye height defaults to the value the spawn always used');

	// two publishers, added in OPPOSITE order on two "peers": the resolution must
	// not depend on scene.children order, which is per-peer
	const sorted = await page.evaluate(() => {
		let scene = null;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const THREE = window.__stores.THREE;
		const make = (name, play) => {
			const group = new THREE.Group();
			group.name = name;
			group.userData.play = play;
			return group;
		};
		const alpha = make('alpha-module', { interaction: 'grab' });
		const zulu = make('zulu-module', { interaction: 'off', grounded: true });
		scene.add(alpha, zulu);
		const forwards = window.__stores.playSettings.resolvePlaySettings(scene);
		// now reverse the ADD order, which is what differs between peers
		scene.remove(alpha, zulu);
		scene.add(zulu, alpha);
		const backwards = window.__stores.playSettings.resolvePlaySettings(scene);
		scene.remove(alpha, zulu);
		return { forwards, backwards };
	});
	h.check(
		sorted.forwards.interaction === sorted.backwards.interaction &&
			sorted.forwards.grounded === sorted.backwards.grounded,
		'7.3 two publishers resolve IDENTICALLY whatever order they were added in (' +
			JSON.stringify(sorted.forwards) +
			')'
	);
	h.check(
		sorted.forwards.interaction === 'off' && sorted.forwards.grounded === true,
		'7.4 ...and the sort puts the later name last, so its declaration wins'
	);

	// grounded: Q/E stop flying
	await sp(page, 'sp.setScenePhysics({ play: { grounded: true } })');
	await page.waitForTimeout(300);
	const flyBlocked = await page.evaluate(async () => {
		let rig = null;
		window.__stores.playerCam.subscribe((v) => (rig = v))();
		if (!rig) return null;
		rig.position.y = 3;
		const before = rig.position.y;
		document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }));
		await new Promise((r) => setTimeout(r, 700));
		document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ', bubbles: true }));
		return { before, after: rig.position.y };
	});
	h.check(
		flyBlocked && Math.abs(flyBlocked.after - 0.8) < 0.001,
		'7.5 grounded pins the rig to eye height and Q cannot fly (' + JSON.stringify(flyBlocked) + ')'
	);

	// the counterfactual: with grounded OFF, Q flies again — otherwise 7.5 would
	// pass just as well against a Q key that never worked in this environment
	await sp(page, 'sp.setScenePhysics({ play: { grounded: false } })');
	await page.waitForTimeout(300);
	const flies = await page.evaluate(async () => {
		let rig = null;
		window.__stores.playerCam.subscribe((v) => (rig = v))();
		if (!rig) return null;
		rig.position.y = 3;
		const before = rig.position.y;
		document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }));
		await new Promise((r) => setTimeout(r, 700));
		document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ', bubbles: true }));
		return { before, after: rig.position.y };
	});
	h.check(
		flies && flies.after < flies.before - 0.05,
		'7.6 (counterfactual) with grounded OFF the same Q press DOES fly (' +
			JSON.stringify(flies) +
			')'
	);
	void rigY;

	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.evaluate(() => window.__stores.physics.stopSimulation());

	await h.finish(browser);
});
