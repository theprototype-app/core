// P-A: physics core rework — flow-animated objects become KINEMATIC bodies (a
// spinning slab flings a resting box), Inspector-only userData.physics makes an
// object dynamic with no flow nodes, hull colliders opt in per object (groups
// fall back to box), a peer's move stream holds a dynamic body kinematically,
// and pause/reset work (reset leaves no undo entry).
const h = require('./helpers.cjs');

const posOf = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', uuid);
					resolve(o ? { x: o.position.x, y: o.position.y, z: o.position.z } : null);
				})();
			}),
		uuid
	);

const undoDepth = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));

h.run(async () => {
	const browser = await h.launch();

	// throwaway page warms the vite dep-optimizer for the lazy rapier import
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}

	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	// collapse the dev-server dual-module-instance split (peerHandler's static
	// physics vs the __stores dynamic one) BEFORE connecting; ids change on reload
	for (const peer of [A, B]) {
		await h.freshReload(peer);
		peer.id = await peer.page.evaluate(
			() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))())
		);
	}
	await h.connect(B, A);

	// --- scene: a wide slab with a SPIN effect + a dynamic box resting on it ----
	const { slabUuid, boxUuid } = await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Box 6 0.4 6'); // slab
		cmd('/create Box 1 1 1'); // rider
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const [slab, box] = group.children.slice(-2);
		slab.position.set(0, 1, 0);
		box.position.set(2, 1.75, 0); // resting on the slab top, 2m off-axis
		// dynamic via Inspector-style userData.physics (NO flow mass node)
		box.userData.physics = { mode: 'dynamic', mass: 1 };
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		peer.send({ type: 'move', uuid: slab.uuid, pos: [0, 1, 0], rot: [0, 0, 0], scale: [1, 1, 1] });
		peer.send({ type: 'move', uuid: box.uuid, pos: [2, 1.75, 0], rot: [0, 0, 0], scale: [1, 1, 1] });
		peer.send({ type: 'objectParameters', parameter: 'physics', uuid: box.uuid, physics: box.userData.physics });
		// spin effect on the slab -> it becomes a KINEMATIC platform mid-sim
		const nodes = [
			{ id: 'sp1', type: 'spin', position: { x: 0, y: 0 }, data: { type: 'spin', axis: 'y', speed: 2 }, class: 'w-[150px]' },
			{ id: 'sel1', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', selected: slab.uuid }, class: 'w-[150px]' }
		];
		const edge = { id: 'e1', source: 'sp1', target: 'sel1' };
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set([edge]);
		nodes.forEach((node) => peer.send({ type: 'nodecreate', node }));
		peer.send({ type: 'edgecreate', edge });
		return { slabUuid: slab.uuid, boxUuid: box.uuid };
	});
	await A.page.waitForTimeout(2000); // let the flow tick adopt the slab (baseState)

	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'simulation started on A'
	);

	// classification: slab = kinematic platform, box = dynamic (Inspector-only)
	const debug = await A.page.evaluate(() => window.__stores.physics.physicsDebug());
	const slabEntry = debug.find((d) => d.uuid === slabUuid);
	const boxEntry = debug.find((d) => d.uuid === boxUuid);
	h.check(slabEntry?.mode === 'kinematic', `spin slab classified kinematic (${slabEntry?.mode})`);
	h.check(boxEntry?.mode === 'dynamic', `userData.physics box classified dynamic with NO flow node (${boxEntry?.mode})`);

	// the spinning platform FLINGS the rider: it leaves its start (x=2,z=0) and
	// ends off the slab; the displacement replicates to B via normal moves
	await h.eventually(
		() => posOf(A.page, boxUuid),
		(p) => p && Math.hypot(p.x - 2, p.z) > 1.5,
		'spinning slab flings the resting box on A',
		15000
	);
	await h.eventually(
		() => posOf(B.page, boxUuid),
		(p) => p && Math.hypot(p.x - 2, p.z) > 1.5,
		'fling replicated to B',
		10000
	);
	// the slab itself keeps its flow pose on B (kinematic = zero physics traffic)
	const bSlab = await posOf(B.page, slabUuid);
	h.check(bSlab && Math.abs(bSlab.x) < 0.01 && Math.abs(bSlab.y - 1) < 0.01, `B slab stays at its flow pose (${JSON.stringify(bSlab)})`);

	// --- external move hold: B drags the dynamic box mid-sim -------------------
	await B.page.evaluate(async (uuid) => {
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		window.__extDrag = setInterval(() => {
			peer.send({ type: 'move', uuid, pos: [0, 5, 3], rot: [0, 0, 0], scale: [1, 1, 1] });
		}, 100);
	}, boxUuid);
	await A.page.waitForTimeout(800);
	// the hold flag flickers between identical-value sends (it only refreshes on
	// a DEVIATION), so sample fast in-page rather than one racy read
	const sawHold = await A.page.evaluate(
		async (uuid) => {
			for (let i = 0; i < 30; i++) {
				const d = window.__stores.physics.physicsDebug().find((e) => e.uuid === uuid);
				if (d?.hold === 'external') return true;
				await new Promise((r) => setTimeout(r, 50));
			}
			return false;
		},
		boxUuid
	);
	h.check(sawHold === true, "B's move stream holds the box kinematically on A");
	const heldPos = await posOf(A.page, boxUuid);
	h.check(heldPos && Math.abs(heldPos.y - 5) < 0.5, `held box follows the peer stream (y=${heldPos?.y.toFixed(2)})`);
	await B.page.evaluate(() => clearInterval(window.__extDrag));
	// after ~250ms of silence it drops back to dynamic and falls
	await h.eventually(
		() => posOf(A.page, boxUuid),
		(p) => p && p.y < 4,
		'released box falls again after the stream stops',
		8000
	);

	// --- pause halts, reset restores exactly with NO undo entry ----------------
	const depthBefore = await undoDepth(A.page);
	await A.page.evaluate(() => window.__stores.physics.pauseSimulation(true));
	await A.page.waitForTimeout(300);
	const p1 = await posOf(A.page, boxUuid);
	await A.page.waitForTimeout(500);
	const p2 = await posOf(A.page, boxUuid);
	h.check(p1 && p2 && p1.y === p2.y, `pause halts the fall (y ${p1?.y.toFixed(2)} == ${p2?.y.toFixed(2)})`);

	await A.page.evaluate(() => window.__stores.physics.resetSimulation());
	await h.eventually(
		() => posOf(A.page, boxUuid),
		(p) => p && Math.abs(p.x - 2) < 0.01 && Math.abs(p.y - 1.75) < 0.01,
		'reset restores the exact start layout on A'
	);
	await h.eventually(
		() => posOf(B.page, boxUuid),
		(p) => p && Math.abs(p.x - 2) < 0.01 && Math.abs(p.y - 1.75) < 0.01,
		'reset replicated to B'
	);
	const depthAfter = await undoDepth(A.page);
	h.check(depthAfter === depthBefore, `reset records no undo entry (${depthBefore} -> ${depthAfter})`);

	// --- hull colliders: opt-in per object, groups fall back -------------------
	const hullInfo = await A.page.evaluate(async () => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Sphere 1');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const sphere = group.children[group.children.length - 1];
		sphere.position.set(-5, 4, 0);
		sphere.userData.physics = { mode: 'dynamic', mass: 1, collider: 'hull' };
		window.__stores.objectActions.selectObject(sphere.uuid);
		await window.__stores.physics.toggleSimulation();
		const debug = window.__stores.physics.physicsDebug();
		return debug.find((d) => d.uuid === sphere.uuid);
	});
	h.check(hullInfo?.hull === true, `sphere uses a convex-hull collider (${JSON.stringify(hullInfo)})`);
	await A.page.evaluate(() => window.__stores.physics.stopSimulation());

	await h.finish(browser);
});
