// 21-E6 — the character controller as nodes: charcontroller / moveinput / possessnode /
// camerafollow / movespeed.
//
// THE POINT OF THIS SUITE IS THE PARITY A/B. Play mode shipped one hardcoded movement
// model, and the merge gate is that declaring it as a node changes nothing: a
// Character Controller on `fly` at speed 0.1 must move you exactly as far as no node at
// all. A git-level A/B is impossible from inside the page, so the suite measures the
// SAME page twice — once with `charControl` null (the built-in path) and once with the
// node present — and demands the two displacements match. That is the stronger reading
// anyway: it proves the node reproduces the default on the build that has both.
//
// Timing matters in every section (gravity, a jump arc, a displacement over a fixed
// window), so this runs with h.GPU_ARGS. A SwiftShader page ticks at ~4.5fps, where a
// 1.2s window is nine frames and a 5% tolerance is meaningless.
//
// Run: $env:APP_URL='https://localhost:5200/'; npm run e2e -- char-controller
//   two-peer section needs PEER_CONFIG (see helpers.cjs)
const h = require('./helpers.cjs');

// ---- reading the rig --------------------------------------------------------
// The camera lives in a group at y = 0.9, so LOCAL y is not eye height. Everything
// here is WORLD space, which is also the space `eyeHeight` is expressed in.
const camWorld = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.playerCam.subscribe((cam) => {
					if (!cam) return resolve(null);
					const w = cam.getWorldPosition(new window.__stores.THREE.Vector3());
					resolve({ x: w.x, y: w.y, z: w.z });
				})();
			})
	);

const setRigWorld = (page, x, y, z) =>
	page.evaluate(
		({ x, y, z }) =>
			new Promise((resolve) => {
				window.__stores.playerCam.subscribe((cam) => {
					if (!cam) return resolve(false);
					const v = new window.__stores.THREE.Vector3(x, y, z);
					if (cam.parent) cam.parent.worldToLocal(v);
					cam.position.copy(v);
					cam.updateMatrixWorld(true);
					resolve(true);
				})();
			}),
		{ x, y, z }
	);

/**
 * Point the rig HORIZONTALLY, once, and never touch it again.
 *
 * Two reasons, both load-bearing. Player.svelte aims the camera with
 * `lookAt(0, 2, 0)` from a rig at world y = 0.9, i.e. steeply upward — and (a) fly
 * `translateZ` follows the full quaternion, so "forward" would be mostly VERTICAL,
 * which makes the XZ-only walk assertion meaningless, and (b) yaw extraction is
 * DEGENERATE at straight up (gimbal lock), so `walkStep` would read an arbitrary
 * heading. Both A/B runs share this one orientation because nothing here moves the
 * mouse.
 */
const levelCamera = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.playerCam.subscribe((cam) => {
					if (!cam) return resolve(false);
					cam.rotation.set(0, 0, 0); // looking down -Z, level
					cam.updateMatrixWorld(true);
					resolve(true);
				})();
			})
	);

/** min / max / final world y across a real rAF window — a jump arc is a shape, not a
 * pair of endpoints, and a settled read would miss it entirely. */
const sampleY = (page, ms) =>
	page.evaluate(
		(ms) =>
			new Promise((resolve) => {
				let cam = null;
				window.__stores.playerCam.subscribe((c) => (cam = c))();
				const V = window.__stores.THREE.Vector3;
				let max = -Infinity;
				let min = Infinity;
				const t0 = performance.now();
				const step = () => {
					const w = cam ? cam.getWorldPosition(new V()) : null;
					if (w) {
						if (w.y > max) max = w.y;
						if (w.y < min) min = w.y;
					}
					if (performance.now() - t0 < ms) requestAnimationFrame(step);
					else resolve({ max, min, end: w ? w.y : null });
				};
				requestAnimationFrame(step);
			}),
		ms
	);

const charDebug = (page) => page.evaluate(() => window.__stores.charController.charControllerDebug());

const values = (page) =>
	page.evaluate(() => {
		let v;
		window.__stores.flowValues.subscribe((x) => (v = x))();
		return v;
	});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Hold a key for `ms` and report how far the rig travelled. */
async function travel(page, code, ms) {
	const before = await camWorld(page);
	await page.keyboard.down(code);
	await page.waitForTimeout(ms);
	await page.keyboard.up(code);
	await page.waitForTimeout(150);
	const after = await camWorld(page);
	return { before, after, moved: dist(before, after), movedXZ: distXZ(before, after) };
}

// ---- driving the graph ------------------------------------------------------
// THE SCOPE RESET IS LOAD-BEARING (logic-nodes documents the cost): the editor's scope
// FOLLOWS THE SELECTION, creating an object SELECTS it, and the mirror refuses to write
// the view into an object with no flow document — so one `/create box` turns every later
// flowNodes.set into a silent no-op.
const setGraph = (page, nodes, edges) =>
	page.evaluate(
		({ nodes, edges }) => {
			window.__stores.setActiveGraph(window.__stores.SCENE_GRAPH);
			window.__stores.flowNodes.set(
				nodes.map((n) => ({
					id: n.id,
					type: n.type,
					position: n.position ?? { x: 0, y: 0 },
					data: { type: n.type, ...(n.data ?? {}) },
					class: 'w-[150px]'
				}))
			);
			window.__stores.flowEdges.set(edges ?? []);
		},
		{ nodes, edges }
	);

/** An edge id in the editor's format — handles included, which peer dedupe depends on. */
const wire = (source, target, targetHandle) => ({
	id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''),
	source,
	target,
	...(targetHandle ? { targetHandle } : {})
});

/** Fire an event node the way the app does — a shared synced stamp. */
const pulse = (page, id, replicate = true) =>
	page.evaluate(
		({ id, replicate }) =>
			window.__stores.flowRuntime.applyNodeTrigger(id, (Date.now() % 86400000) / 1000, replicate),
		{ id, replicate }
	);

const CONTROLLER = (over = {}) => ({
	id: 'cc',
	type: 'charcontroller',
	data: { mode: 'fly', speed: 0.1, jumpHeight: 1.2, eyeHeight: 1.7, gravity: true, ...over }
});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	// throwaway page warms the vite dep-optimizer for the lazy rapier import (the
	// physics-suite ritual) — section 3 needs a world on its first try
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}

	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(600);
	h.check(await levelCamera(A.page), 'the rig starts level, so forward is horizontal in both modes');
	await setRigWorld(A.page, 0, 1.7, 0);

	// =========================================================================
	// 1. THE PARITY A/B — the node at its defaults IS the default
	// =========================================================================
	const pristine = await charDebug(A.page);
	h.check(
		pristine.control === null,
		`no controller node -> charControl is null (${JSON.stringify(pristine.control)})`
	);
	h.check(pristine.moveSpeed === null, 'and no speed override, so PLC keeps its own moveSpeed');

	const WINDOW = 1200;
	const builtin = await travel(A.page, 'KeyW', WINDOW);
	h.check(builtin.moved > 0.5, `built-in fly moves the rig (${builtin.moved.toFixed(3)} units)`);
	// a 1.2s window at 60fps is ~72 frames x 0.1 = ~7.2 units; a wide band, because the
	// point here is only that the number is the RIGHT ORDER (a stuck or doubled speed
	// would fall outside it) and the tight comparison is the A/B below
	h.check(
		builtin.moved > 2 && builtin.moved < 12,
		`and by about speed x frames (${builtin.moved.toFixed(2)} units in ${WINDOW}ms)`
	);
	const stillNull = await charDebug(A.page);
	h.check(stillNull.control === null, 'flying with no controller node declares nothing');

	// now the SAME movement with the node present
	await setGraph(A.page, [CONTROLLER()], []);
	await h.eventually(
		() => charDebug(A.page),
		(d) => d.control?.mode === 'fly',
		'the Character Controller node declares itself'
	);
	const declared = await charDebug(A.page);
	h.check(declared.control.speed === 0.1, `and carries its authored speed (${declared.control.speed})`);
	h.check(
		declared.control.sourceNodeId === 'cc',
		`naming the node it came from (${declared.control.sourceNodeId})`
	);
	h.check(declared.moveSpeed === null, 'with no override yet, so the param is what moves you');

	const noded = await travel(A.page, 'KeyW', WINDOW);
	const gap = Math.abs(noded.moved - builtin.moved) / builtin.moved;
	h.check(
		gap < 0.05,
		`PARITY: fly@0.1 as a node matches the built-in within 5% ` +
			`(${builtin.moved.toFixed(3)} vs ${noded.moved.toFixed(3)}, ${(gap * 100).toFixed(1)}% apart)`
	);

	// the guard has to be able to FAIL: a different authored speed must move you a
	// different distance, or the check above would pass with the param ignored
	await setGraph(A.page, [CONTROLLER({ speed: 0.3 })], []);
	await h.eventually(
		() => charDebug(A.page),
		(d) => d.control?.speed === 0.3,
		'the speed param reaches the store'
	);
	const faster = await travel(A.page, 'KeyW', WINDOW);
	const ratio = faster.moved / noded.moved;
	h.check(
		ratio > 2.4 && ratio < 3.6,
		`3x the speed is ~3x the distance (${noded.moved.toFixed(2)} -> ${faster.moved.toFixed(2)}, x${ratio.toFixed(2)})`
	);

	// =========================================================================
	// 2. WALK: XZ only, gravity, and one jump per press
	// =========================================================================
	await setGraph(A.page, [CONTROLLER({ mode: 'walk', speed: 0.1, jumpHeight: 1.2, eyeHeight: 1.7 })], []);
	await h.eventually(
		() => charDebug(A.page),
		(d) => d.control?.mode === 'walk',
		'switching the node to walk switches the model'
	);

	// dropped from above, the walker LANDS at eye height on the scene's ground plane
	await setRigWorld(A.page, 0, 5, 0);
	await h.eventually(
		() => camWorld(A.page),
		(w) => w && Math.abs(w.y - 1.7) < 0.06,
		'gravity: dropped from y=5 it lands at eye height'
	);
	const landed = await charDebug(A.page);
	h.check(landed.walker.grounded === true, 'and reports itself grounded');
	h.check(
		landed.walker.source === 'plane',
		`resolved by the ground-plane tier with no sim running (source ${landed.walker.source})`
	);
	h.check(
		Math.abs(landed.walker.vy) < 0.2,
		`with the fall absorbed rather than accumulating (vy ${landed.walker.vy.toFixed(3)})`
	);

	// W walks on the XZ plane and does NOT climb
	const walked = await travel(A.page, 'KeyW', 800);
	h.check(walked.movedXZ > 0.3, `walking moves on XZ (${walked.movedXZ.toFixed(2)} units)`);
	h.check(
		Math.abs(walked.after.y - walked.before.y) < 0.03,
		`and not in Y (${walked.before.y.toFixed(3)} -> ${walked.after.y.toFixed(3)})`
	);

	// JUMP: y rises then returns. sqrt(2*g*h) with h=1.2 gives a ~1s arc.
	await A.page.keyboard.down('Space');
	const arc = await sampleY(A.page, 1400);
	await A.page.keyboard.up('Space');
	await A.page.waitForTimeout(200);
	h.check(
		arc.max > 1.7 + 0.6,
		`jump: the eye rises well above standing height (peak ${arc.max.toFixed(2)}, eye 1.70)`
	);
	h.check(
		Math.abs(arc.end - 1.7) < 0.08,
		`and comes back down to it (${arc.end.toFixed(3)})`
	);

	// A HELD key is ONE jump. Playwright's keyboard.down does not auto-repeat, so the
	// repeats a real held key produces are dispatched explicitly — that is the path the
	// edge guard exists for, and without it this section would pass vacuously.
	await A.page.keyboard.down('Space');
	await A.page.evaluate(() => {
		// the browser's own repeat stream, at roughly the rate a keyboard produces
		window.__charRepeat = setInterval(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { code: 'Space', key: ' ', repeat: true, bubbles: true })
			);
		}, 30);
	});
	const firstArc = await sampleY(A.page, 1500); // the one jump we asked for
	const secondArc = await sampleY(A.page, 1500); // still held: nothing should happen
	await A.page.evaluate(() => clearInterval(window.__charRepeat));
	await A.page.keyboard.up('Space');
	await A.page.waitForTimeout(200);
	h.check(firstArc.max > 1.7 + 0.6, `a held Space jumps once (peak ${firstArc.max.toFixed(2)})`);
	h.check(
		secondArc.max < 1.7 + 0.15,
		`and does NOT bunny-hop while it stays down (peak ${secondArc.max.toFixed(2)} over the next 1.5s)`
	);

	// releasing and pressing again RE-ARMS — the other half of the same rule
	await A.page.keyboard.down('Space');
	const rearmed = await sampleY(A.page, 1400);
	await A.page.keyboard.up('Space');
	await A.page.waitForTimeout(200);
	h.check(rearmed.max > 1.7 + 0.6, `a fresh press jumps again (peak ${rearmed.max.toFixed(2)})`);

	// gravity OFF pins the eye to the floor rather than integrating a fall
	await setGraph(A.page, [CONTROLLER({ mode: 'walk', eyeHeight: 1.2, gravity: false })], []);
	await h.eventually(
		() => charDebug(A.page),
		(d) => d.control?.gravity === false,
		'gravity can be switched off'
	);
	await setRigWorld(A.page, 0, 6, 0);
	await h.eventually(
		() => camWorld(A.page),
		(w) => w && Math.abs(w.y - 1.2) < 0.05,
		'and the eye pins to the floor at the authored eye height (1.2)'
	);

	// =========================================================================
	// 3. THE RAPIER TIER — a capsule that stands ON things
	// =========================================================================
	// TWO SETTLES, and the first one is not padding: part of `/create box` runs after the
	// call returns and RE-SEATS the object on the ground for its scale, so writing the
	// transform in the same tick is silently undone. Measured the hard way — the slab's
	// collider came out at y=0.249 (top 0.499) instead of 1.0, the walker correctly stood
	// on it at 0.519, and it read as a broken feature rather than a broken fixture.
	await A.page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create box');
		cmd('/create box');
	});
	await A.page.waitForTimeout(1200);
	const built = await A.page.evaluate(async () => {
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const [floor, faller] = group.children;
		floor.scale.set(4, 0.5, 4);
		floor.position.set(0, 1, 0);
		floor.updateMatrixWorld(true);
		faller.position.set(9, 3, 0);
		faller.updateMatrixWorld(true);
		// A NEW PRIMITIVE IS BORN DYNAMIC — `/create box` stamps
		// `userData.physics = {mode:'dynamic', mass:1}` — so an un-marked "floor" FALLS,
		// and the walker then correctly stands on it wherever it came to rest. That cost
		// two probe runs: the slab's collider read y=0.249 with the object at y=1, which
		// looks exactly like a broken capsule. Say STATIC out loud.
		window.__stores.physics.setPhysicsFor(floor.uuid, { mode: 'static' });
		// and startSimulation refuses a world with no dynamic body at all, so keep one
		window.__stores.physics.setPhysicsFor(faller.uuid, { mode: 'dynamic', mass: 1 });
		return { floor: floor.uuid, faller: faller.uuid };
	});
	await A.page.waitForTimeout(800);
	const slab = await A.page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					resolve(o ? { y: o.position.y, sy: o.scale.y } : null);
				})();
			}),
		built.floor
	);
	const slabTop = slab ? slab.y + slab.sy / 2 : 0;
	h.check(
		Math.abs(slabTop - 1.25) < 1e-6,
		`PREMISE: the 4x0.5x4 slab really is at y=1, so its top is ${slabTop.toFixed(3)} (want 1.250)`
	);

	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await A.page.waitForTimeout(2500);
	const world = await A.page.evaluate(() => window.__stores.physics.physicsWorldDebug());
	if (!world.running) {
		h.check(true, 'SKIPPED the rapier tier: the wasm world did not start in this browser');
	} else {
		h.check(world.bodies >= 1, `a simulation is running (${world.bodies} bodies)`);
		// the BASELINE for the "not a scene collider" claim, taken before the walker has
		// ever built a capsule in this world
		const ownedBefore = world.ownerHandles.length;
		// AND the premise the standing-height number rests on: read the slab's top out of
		// RAPIER, not out of THREE. The suite is asserting a contact height, so the thing
		// that must be right is the collider the contact happens against.
		const colliderTop = await A.page.evaluate(() => {
			const rt = window.__stores.physics.physicsRuntime();
			if (!rt) return null;
			let best = -Infinity;
			rt.world.forEachCollider((/** @type {any} */ c) => {
				const t = c.translation();
				const he = c.halfExtents ? c.halfExtents() : null;
				// the slab is the wide one that is not the 500-unit ground plane
				if (he && he.x > 1 && he.x < 100 && Math.abs(t.x) < 0.01) best = Math.max(best, t.y + he.y);
			});
			return Number.isFinite(best) ? best : null;
		});
		h.check(
			colliderTop !== null && Math.abs(colliderTop - 1.25) < 0.02,
			`PREMISE: rapier's own slab collider tops out at ${colliderTop?.toFixed(3)} (want 1.250)`
		);
		await setGraph(A.page, [CONTROLLER({ mode: 'walk', speed: 0.1, eyeHeight: 1.7 })], []);
		await h.eventually(
			() => charDebug(A.page),
			(d) => d.control?.mode === 'walk' && d.control?.gravity === true,
			'walking again, this time with a world'
		);
		await setRigWorld(A.page, 0, 5, 0);
		await h.eventually(
			() => charDebug(A.page),
			(d) => d.walker.source === 'rapier' && d.capsule === true,
			'the walker resolves through the rapier capsule while a sim runs'
		);
		await h.eventually(
			() => camWorld(A.page),
			(w) => w && Math.abs(w.y - (slabTop + 1.7)) < 0.3,
			`and STANDS ON THE SLAB (eye at ~${(slabTop + 1.7).toFixed(2)}, not the plane's 1.70)`
		);
		const finalY = (await camWorld(A.page)).y;
		h.check(
			finalY > 1.7 + 0.5,
			`which is measurably above the ground-plane answer (${finalY.toFixed(3)} vs 1.70)`
		);
		// the capsule is OURS: created straight onto the world, so it must add NOTHING to
		// physics.js's own bookkeeping — no colliderOwner entry and no rigid body
		const after = await A.page.evaluate(() => ({
			owned: window.__stores.physics.physicsWorldDebug().ownerHandles.length,
			bodies: window.__stores.physics.physicsDebug().length
		}));
		h.check(
			after.owned === ownedBefore,
			`and takes no colliderOwner entry (${ownedBefore} -> ${after.owned} owned handles)`
		);
		h.check(
			after.bodies === world.bodies,
			`nor a rigid body physics.js would write back to (${world.bodies} -> ${after.bodies})`
		);
	}
	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await A.page.waitForTimeout(600);
	const afterStop = await charDebug(A.page);
	h.check(
		afterStop.control !== null,
		'stopping the sim leaves the controller declared (the walker just drops a tier)'
	);

	// =========================================================================
	// 4. MOVE SPEED — readable, writable, and still on the scroll wheel
	// =========================================================================
	await setGraph(
		A.page,
		[
			CONTROLLER({ speed: 0.1 }),
			{ id: 'trig', type: 'onclick', data: { pulse: 0.3 } },
			{ id: 'boost', type: 'movespeed', data: { value: 0.35 } },
			{ id: 'readout', type: 'movespeed', data: { value: 0.1 } }
		],
		[wire('trig', 'boost', 'set')]
	);
	await h.eventually(
		() => charDebug(A.page),
		(d) => d.control?.mode === 'fly' && d.control?.speed === 0.1,
		'back to fly at 0.1 with a Move Speed pair wired up'
	);
	const readBefore = await values(A.page);
	h.check(
		Math.abs((readBefore.readout ?? -1) - 0.1) < 1e-6,
		`Move Speed READS the speed in force (${readBefore.readout})`
	);

	const slow = await travel(A.page, 'KeyW', WINDOW);
	await pulse(A.page, 'trig');
	await h.eventually(
		() => charDebug(A.page),
		(d) => d.moveSpeed === 0.35,
		'the `set` input WRITES it on the trigger stamp edge'
	);
	const readAfter = await values(A.page);
	h.check(
		Math.abs((readAfter.readout ?? -1) - 0.35) < 1e-6,
		`and the other Move Speed node reads the new value, not its own param (${readAfter.readout})`
	);
	const fast = await travel(A.page, 'KeyW', WINDOW);
	const speedRatio = fast.moved / slow.moved;
	h.check(
		speedRatio > 2.6 && speedRatio < 4.4,
		`which actually MOVES you faster (${slow.moved.toFixed(2)} -> ${fast.moved.toFixed(2)}, x${speedRatio.toFixed(2)})`
	);

	// the scroll wheel writes through the same store while a controller is declared
	const beforeWheel = (await charDebug(A.page)).moveSpeed;
	await A.page.evaluate(() =>
		window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
	);
	await A.page.waitForTimeout(250);
	const afterWheel = (await charDebug(A.page)).moveSpeed;
	h.check(
		afterWheel !== null && afterWheel > beforeWheel,
		`the scroll wheel writes THROUGH the store, so scroll still works and the graph can see it (${beforeWheel} -> ${afterWheel})`
	);

	// editing the node's own speed CLEARS the override, or one scroll would pin it
	await setGraph(A.page, [CONTROLLER({ speed: 0.22 })], []);
	await h.eventually(
		() => charDebug(A.page),
		(d) => d.control?.speed === 0.22 && d.moveSpeed === null,
		'editing the authored speed clears the live override'
	);

	// =========================================================================
	// 5. POSSESS + CAMERA FOLLOW — possess.js as trigger-edge nodes
	// =========================================================================
	const ride = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const object = group.children[group.children.length - 1];
		object.position.set(-6, 0.5, 0);
		object.updateMatrixWorld(true);
		return object.uuid;
	});
	await setGraph(
		A.page,
		[
			{ id: 'go', type: 'onclick', data: { pulse: 0.3 } },
			{ id: 'stop', type: 'onclick', data: { pulse: 0.3 } },
			{ id: 'p', type: 'possessnode', data: { target: ride, camera: 'chase', speed: 4 } }
		],
		[wire('go', 'p', 'trigger'), wire('stop', 'p', 'release')]
	);
	await A.page.waitForTimeout(400);
	await pulse(A.page, 'go');
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.possess.possessed.subscribe(r)())),
		(v) => v === ride,
		'Possess Object takes control on its trigger stamp'
	);
	await pulse(A.page, 'stop');
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.possess.possessed.subscribe(r)())),
		(v) => v === null,
		'and the `release` input hands it back'
	);

	await setGraph(
		A.page,
		[
			{ id: 'go', type: 'onclick', data: { pulse: 0.3 } },
			{ id: 'stop', type: 'onclick', data: { pulse: 0.3 } },
			{ id: 'f', type: 'camerafollow', data: { target: ride } }
		],
		[wire('go', 'f', 'trigger'), wire('stop', 'f', 'stop')]
	);
	await A.page.waitForTimeout(400);
	await pulse(A.page, 'go');
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.possess.followingCam.subscribe(r)())),
		(v) => v === ride,
		'Camera Follow starts the chase cam (LOCAL, per the setcamera rule)'
	);
	await pulse(A.page, 'stop');
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.possess.followingCam.subscribe(r)())),
		(v) => v === null,
		'and `stop` lets go'
	);

	// =========================================================================
	// 6. MOVE INPUT is LOCAL — a peer reads its OWN keys, and nothing else's
	// =========================================================================
	// LEAVE PLAY MODE FIRST: the connection-request toast is chrome, and A has been in
	// play mode since section 1 — the Approve button renders but nothing can click it
	// (measured: the button is in the DOM and `locator.click` times out). Move Input
	// reads inputRuntime, whose key listeners are live in the editor too, so this
	// section does not need play mode at all.
	await A.page.evaluate(() => window.__stores.isLocked.set(false));
	await A.page.waitForTimeout(600);
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await setGraph(A.page, [CONTROLLER(), { id: 'mv', type: 'moveinput', data: {} }], []);
	// flowNodes.set does NOT broadcast — push explicitly (the hud-nodes pattern)
	await A.page.evaluate((peerId) => window.__stores.nodesHandler.sendNodes(peerId), B.id);
	const peerTypes = () =>
		B.page.evaluate(() => {
			let g;
			window.__stores.flowGraphs.subscribe((x) => (g = x))();
			return (g?.scene?.nodes ?? []).map((n) => n.type);
		});
	await h.eventually(
		peerTypes,
		(types) => types.includes('moveinput'),
		'the graph carrying Move Input reaches the peer'
	);
	// the PREMISE the locality claim rests on: B must really be holding the node, or
	// "the peer reads 0" is only "the peer has no node" and proves nothing
	const landedOnB = (await peerTypes()).includes('moveinput');

	await A.page.keyboard.down('KeyW');
	await A.page.keyboard.down('KeyD');
	await A.page.waitForTimeout(500);
	const mine = (await values(A.page)).mv?.__handles ?? null;
	const theirs = landedOnB ? ((await values(B.page)).mv?.__handles ?? null) : null;
	await A.page.keyboard.up('KeyW');
	await A.page.keyboard.up('KeyD');
	h.check(
		mine && mine.y === 1 && mine.x === 1,
		`Move Input reads MY keys as +-1 on two handles (${JSON.stringify(mine)})`
	);
	h.check(
		landedOnB && theirs && theirs.x === 0 && theirs.y === 0,
		`and the PEER holding the same graph reads 0 — local by design, never streamed (${JSON.stringify(theirs)})`
	);
	await A.page.waitForTimeout(300);
	const released = (await values(A.page)).mv?.__handles ?? null;
	h.check(
		released && released.x === 0 && released.y === 0,
		`releasing the keys returns it to zero (${JSON.stringify(released)})`
	);

	// =========================================================================
	// 7. PARITY AGAIN — removing the nodes restores the built-in exactly
	// =========================================================================
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(600);
	await setGraph(A.page, [], []);
	await h.eventually(
		() => charDebug(A.page),
		(d) => d.control === null && d.moveSpeed === null,
		'deleting the node clears charControl AND the speed override'
	);
	const restored = await travel(A.page, 'KeyW', WINDOW);
	const backGap = Math.abs(restored.moved - builtin.moved) / builtin.moved;
	h.check(
		backGap < 0.08,
		`PARITY RESTORED: movement matches the very first measurement ` +
			`(${builtin.moved.toFixed(3)} vs ${restored.moved.toFixed(3)}, ${(backGap * 100).toFixed(1)}% apart)`
	);
	const noWalker = await charDebug(A.page);
	h.check(
		noWalker.capsule === false,
		'and the walker capsule is gone with it (nothing left in any physics world)'
	);

	await A.page.evaluate(() => window.__stores.isLocked.set(false));
	await h.finish(browser);
});
