// 21-B B5 — a peer's release, applied EXACTLY.
//
// Before this, a non-initiator's throw was reconstructed on the stepping peer
// from a ~10 Hz move stream, 250 ms after the moves stopped: late, slow, and in
// the wrong direction. The `throw` message carries the velocity the thrower
// measured, and the initiator applies it verbatim (through the same clampThrow,
// so a hostile payload needs no validation of its own).
//
// The load-bearing check is 2.4: WITHIN ONE FRAME, not after the 250 ms
// external-hold timeout — which is the entire point of the message.

const h = require('./helpers.cjs');

const sp = (page, body) =>
	page.evaluate((b) => new Function('sp', b)(window.__stores.scenePhysics), body);
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

/** place the crate in front of B and wait until the crosshair actually has it.
 * A placement made while the crate is still moving on A is overwritten by the
 * next broadcast move, so this retries rather than assuming. */
async function aimAtCrate(page, uuid, distance) {
	for (let attempt = 0; attempt < 12; attempt++) {
		await placeInFront(page, uuid, distance);
		await page.waitForTimeout(350);
		const state = await page.evaluate(() => {
			let value = null;
			window.__stores.playInteract.playInteractState.subscribe((v) => (value = v))();
			return value;
		});
		if (state?.mode === 'aiming' && state.uuid === uuid) return true;
	}
	return false;
}

const pointer = (page, type) =>
	page.evaluate((type) => {
		window.dispatchEvent(new PointerEvent(type, { button: 0, bubbles: true }));
	}, type);

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');

	const crate = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const box = group.children[group.children.length - 1];
		box.name = 'Crate';
		box.position.set(0, 1, 0);
		box.userData.physics = { mode: 'dynamic', mass: 1 };
		window.__stores.objectsGroup.update((v) => v);
		return box.uuid;
	});
	await h.connect(A, B);
	// deselect AFTER connecting: creating the crate selected it on A, and the
	// handshake pushes that selection to B as a lock. Until A broadcasts the
	// unlock, B correctly refuses to grab a peer-locked object.
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. A hosts the world; B carries ===');

	await h.eventually(
		() => posOf(B.page, crate),
		(v) => !!v,
		'1.1 (premise) B has the crate'
	);
	await sp(A.page, 'sp.setScenePhysics({ ground: { enabled: true, height: 0 }, play: { interaction: "grab" } })');
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => phys(A.page, 'return p.physicsDebug().length'),
		(n) => n > 0,
		'1.2 (premise) A is the simulating peer'
	);
	await h.eventually(
		() => B.page.evaluate(() => new Promise((r) => window.__stores.physics.remoteSimulating.subscribe(r)())),
		(v) => !!v,
		'1.3 (premise) B knows a remote peer is simulating'
	);

	// spy on B's outgoing wire so we can compare what it SENT with what A applied
	await B.page.evaluate(() => {
		window.__sent = [];
		let peer = null;
		window.__stores.peers.subscribe((p) => (peer = p))();
		const original = peer.send.bind(peer);
		peer.send = (message) => {
			window.__sent.push(message);
			return original(message);
		};
	});

	// let the crate SETTLE on A first: while it is still falling, A broadcasts a
	// move every ~100 ms, and those would yank it back out of B's view between
	// the placement and the grab
	await A.page.waitForTimeout(2500);
	await B.page.evaluate(() => window.__stores.isLocked.set(true));
	const aimed = await aimAtCrate(B.page, crate, 3.5);
	await h.eventually(
		() =>
			B.page.evaluate(() => {
				let list = [];
				window.__stores.lockedObjects.subscribe((v) => (list = v))();
				return list.length;
			}),
		(n) => n === 0,
		'1.4 (premise) A released its lock, so the crate is grabbable at all'
	);
	h.check(aimed, '1.5 (premise) B crosshair is on the crate');
	await pointer(B.page, 'pointerdown');
	await B.page.waitForTimeout(400);
	const carried = await B.page.evaluate(() => window.__stores.playInteract.playInteractDebug());
	h.check(carried.carrying === crate, '1.6 B is carrying the crate');
	h.check(carried.held === false, '1.7 ...WITHOUT a local body — B is not the initiator');

	const claimed = await bodyOf(A.page, crate);
	h.check(
		claimed?.hold === 'external',
		'1.8 A turned B\'s move stream into an external hold (' + claimed?.hold + ')'
	);
	h.check(!!claimed?.holdPeer, '1.9 ...claimed by B\'s peer id, so a second stream cannot fight it');

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. the release arrives exactly, and immediately ===');

	// yank the carry point in, so the crate is moving hard at the moment of release
	await B.page.evaluate(() => {
		for (let i = 0; i < 40; i++)
			window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
	});
	await B.page.waitForTimeout(120);
	await pointer(B.page, 'pointerup');

	const sent = await h.eventually(
		() => B.page.evaluate(() => window.__sent.find((m) => m.type === 'throw') ?? null),
		(v) => !!v,
		'2.1 B sent a `throw` message on release'
	);
	const message = await B.page.evaluate(() => window.__sent.find((m) => m.type === 'throw'));
	const sentSpeed = Math.hypot(message.linvel[0], message.linvel[1], message.linvel[2]);
	h.check(sentSpeed > 1, '2.2 (premise) it was a real throw (|v| = ' + sentSpeed.toFixed(2) + ' m/s)');
	void sent;

	// read A within a frame or two — the point of the message is that A does NOT
	// wait 250 ms for the external hold to expire
	await A.page.waitForTimeout(80);
	const applied = await bodyOf(A.page, crate);
	const appliedVec = [applied?.linvel?.x ?? 0, applied?.linvel?.y ?? 0, applied?.linvel?.z ?? 0];
	const appliedSpeed = Math.hypot(...appliedVec);
	h.check(applied?.hold === null, '2.3 A released the hold at once');
	h.check(
		applied?.bodyType === 0,
		'2.4 ...and the body is DYNAMIC within ~one frame, not after the 250 ms timeout (type ' +
			applied?.bodyType +
			')'
	);
	// HORIZONTAL speed and direction: gravity is purely vertical, so XZ is
	// unaffected by however many frames passed before this read. Comparing the
	// full 3D vector would be measuring the read latency, not the throw.
	const sentXZ = Math.hypot(message.linvel[0], message.linvel[2]);
	const appliedXZ = Math.hypot(appliedVec[0], appliedVec[2]);
	h.check(
		Math.abs(appliedXZ - sentXZ) / sentXZ < 0.15,
		'2.5 A applied B\'s speed within 15% (horizontal ' +
			sentXZ.toFixed(2) +
			' -> ' +
			appliedXZ.toFixed(2) +
			' m/s)'
	);
	const dot =
		(message.linvel[0] * appliedVec[0] + message.linvel[2] * appliedVec[2]) / (sentXZ * appliedXZ);
	h.check(dot > 0.99, '2.6 ...in the same DIRECTION (horizontal cos = ' + dot.toFixed(4) + ')');
	void appliedSpeed;
	void sentSpeed;

	// the crate flies the way it was thrown, and both peers agree where it lands
	await A.page.waitForTimeout(2500);
	const restA = await posOf(A.page, crate);
	const restB = await posOf(B.page, crate);
	const travelled = Math.hypot(restA[0] - message.pos[0], restA[2] - message.pos[2]);
	h.check(travelled > 0.5, '2.7 it actually travelled (' + travelled.toFixed(2) + ' m in XZ)');
	h.check(
		Math.hypot(restA[0] - restB[0], restA[1] - restB[1], restA[2] - restB[2]) < 0.6,
		'2.8 A and B agree where it landed, over the ordinary move stream (no new state on the wire)'
	);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. what applyThrow refuses ===');

	const unknown = await phys(
		A.page,
		'return p.applyThrow({ uuid: "not-a-real-uuid", pos: [0,0,0], rot: [0,0,0], linvel: [5,0,0], angvel: [0,0,0] })'
	);
	h.check(unknown === false, '3.1 a throw for an unknown uuid is a no-op');

	const nonInitiator = await phys(
		B.page,
		'return p.applyThrow({ uuid: "' + crate + '", pos: [0,2,0], rot: [0,0,0], linvel: [5,0,0], angvel: [0,0,0] })'
	);
	h.check(
		nonInitiator === false,
		'3.2 a NON-initiator applies nothing — two peers authoring one flight is mixing sync models'
	);

	const hostile = await phys(
		A.page,
		'p.applyThrow({ uuid: "' +
			crate +
			'", pos: [0,3,0], rot: [0,0,0], linvel: [1e6, 1e6, 1e6], angvel: [1e6, 0, 0] });' +
			'const b = p.physicsDebug().find((x) => x.uuid === "' +
			crate +
			'");' +
			'return { lin: Math.hypot(b.linvel.x, b.linvel.y, b.linvel.z), ang: Math.hypot(b.angvel.x, b.angvel.y, b.angvel.z) }'
	);
	h.check(
		hostile.lin <= 20.0001 && hostile.ang <= 20.0001,
		'3.3 a hostile 1e6 payload clamps to 20 through the SAME clampThrow as the local path (' +
			hostile.lin.toFixed(2) +
			' m/s, ' +
			hostile.ang.toFixed(2) +
			' rad/s)'
	);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. a peer that vanishes mid-carry ===');

	// section 3 left the crate flying at the clamped 20 m/s, and a moving crate is
	// broadcast back over B's placement every 100 ms — park it first
	await phys(
		A.page,
		'return p.applyThrow({ uuid: "' + crate + '", pos: [0, 1, 0], rot: [0, 0, 0], linvel: [0, 0, 0], angvel: [0, 0, 0] })'
	);
	await A.page.waitForTimeout(2500);
	const aimedAgain = await aimAtCrate(B.page, crate, 3);
	h.check(aimedAgain, '4.0 (premise) B has the crate in its crosshair again');
	await pointer(B.page, 'pointerdown');
	await B.page.waitForTimeout(500);
	const carriedAgain = await B.page.evaluate(() =>
		window.__stores.playInteract.playInteractDebug()
	);
	h.check(carriedAgain.carrying === crate, '4.1 (premise) B is carrying again');
	const heldOnA = await bodyOf(A.page, crate);
	h.check(heldOnA?.hold === 'external', '4.2 (premise) A holds it for B');

	await B.ctx.close();
	await A.page.waitForTimeout(900);
	const afterDrop = await bodyOf(A.page, crate);
	h.check(
		afterDrop?.hold === null && afterDrop?.bodyType === 0,
		'4.3 B disconnecting mid-carry frees the crate on A within the hold timeout (hold ' +
			afterDrop?.hold +
			', type ' +
			afterDrop?.bodyType +
			')'
	);
	h.check(afterDrop?.holdPeer === null, '4.4 ...and the grab claim is dropped, not left hostage');

	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	await h.finish(browser);
});
