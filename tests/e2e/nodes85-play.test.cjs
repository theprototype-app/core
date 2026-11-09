// 85 N3 / I1 — AN ANIMAL THAT WANDERS AND RESTS, AND THINGS YOU PICK UP THAT STAY OR GO BACK,
// ON TWO PEERS. The animal's place is a pure function of the shared clock (its rests are a time
// warp of it), so both peers are asked for its pose at the SAME shared moment. The grabbables
// need no simulation: play mode carries them kinematically over the ordinary `move` stream, and on
// release one stays where it was put while the other glides home — B must see both.
const h = require('./helpers.cjs');

const GRAPH = {
	nodes: [
		{ id: 'cat', type: 'ambientanimal', data: { speed: 0.6, rx: 3, ry: 0.3, rz: 3, rest: 0.5, restTime: 2, lookRadius: 0, fleeRadius: 0, clips: false, seed: 7 } },
		{ id: 'selCat', type: 'objectselector', obj: 'cat' },
		{ id: 'gStay', type: 'grabbable', data: { release: 'stay' } },
		{ id: 'selStay', type: 'objectselector', obj: 'mug' },
		{ id: 'gBack', type: 'grabbable', data: { release: 'return', returnAfter: 0.5, returnTime: 0.5 } },
		{ id: 'selBack', type: 'objectselector', obj: 'tool' },
		{ id: 'sit', type: 'sitspot', data: { facing: '+z', eyeHeight: 0.7 } },
		{ id: 'selChair', type: 'objectselector', obj: 'chair' }
	],
	edges: [
		['cat', 'selCat', null],
		['gStay', 'selStay', null],
		['gBack', 'selBack', null],
		['sit', 'selChair', null]
	]
};

const pointer = (page, type) => page.evaluate((t) => window.dispatchEvent(new PointerEvent(t, { button: 0, bubbles: true })), type);
const wheel = (page, deltaY, times) =>
	page.evaluate(
		([d, n]) => {
			let r;
			window.__stores.globalRenderer.subscribe((v) => (r = v))();
			for (let i = 0; i < n; i++) (r?.domElement ?? document.body).dispatchEvent(new WheelEvent('wheel', { deltaY: d, bubbles: true, cancelable: true }));
		},
		[deltaY, times]
	);
/** put an object `distance` m in front of the (editor) camera — OrbitControls owns the camera, so we move the object */
const placeInFront = (page, uuid, distance) =>
	page.evaluate(
		([u, d]) => {
			const THREE = window.__stores.THREE;
			let cam;
			let g;
			window.__stores.globalCamera.subscribe((v) => (cam = v))();
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const at = cam.getWorldPosition(new THREE.Vector3()).addScaledVector(cam.getWorldDirection(new THREE.Vector3()), d);
			const o = g.getObjectByProperty('uuid', u);
			o.position.copy(at);
			o.updateMatrixWorld();
			return at.toArray();
		},
		[uuid, distance]
	);
const posOf = (p, uuid) =>
	p.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		return g.getObjectByProperty('uuid', u)?.position.toArray() ?? null;
	}, uuid);
const near = (a, b, eps) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < eps);
const piDebug = (page) => page.evaluate(() => window.__stores.playInteract.playInteractDebug());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const ids = await A.page.evaluate(() => {
		const S = window.__stores;
		const made = {};
		for (const name of ['cat', 'mug', 'tool', 'chair']) {
			S.commandsHandler.sceneCommand('/create box');
			let g;
			S.objectsGroup.subscribe((x) => (g = x))();
			const o = g.children[g.children.length - 1];
			o.name = name;
			made[name] = o.uuid;
		}
		S.objectActions.deselectObject();
		return made;
	});
	await A.page.waitForTimeout(1500); // '/create box' re-seats after the call
	await A.page.evaluate(() => window.__stores.lockedObjects.set([]));
	// the mug and the tool start in front of the camera (before B joins, so B's first sync has it)
	const mugHome = await placeInFront(A.page, ids.mug, 3);
	await A.page.evaluate(({ nodes, edges, made }) => {
		const S = window.__stores;
		let g;
		S.objectsGroup.subscribe((x) => (g = x))();
		const cat = g.getObjectByProperty('uuid', made.cat);
		cat.scale.set(0.5, 0.4, 0.8);
		cat.position.set(-8, 0.2, -8);
		const tool = g.getObjectByProperty('uuid', made.tool);
		tool.position.set(8, 1, 8); // parked aside until the mug is done
		const chair = g.getObjectByProperty('uuid', made.chair);
		chair.scale.set(1, 0.5, 1);
		chair.position.set(4, 0.25, -12);
		chair.updateMatrix();
		cat.updateMatrix();
		tool.updateMatrix();
		nodes.forEach((n, i) => {
			const data = n.type === 'objectselector' ? { selected: made[n.obj] } : n.data;
			S.nodesHandler.createFlowNode({ id: n.id, type: n.type, position: { x: (i % 3) * 240, y: Math.floor(i / 3) * 180 }, data: { type: n.type, ...data } });
		});
		for (const [source, target, targetHandle] of edges)
			S.nodesHandler.createFlowEdge({ id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''), source, target, ...(targetHandle ? { targetHandle } : {}) });
	}, { ...GRAPH, made: ids });
	const B = await h.setupPage(browser, 'B');
	// a restore offer can pop up on A while it builds (it covered the approve button on a pc run)
	for (const p of [A, B]) {
		await p.page.waitForTimeout(300);
		if (await p.page.locator('#restore-session-modal[open]').count()) await p.page.locator('#restore-session-dismiss').click({ timeout: 10000 }).catch(() => {});
	}
	await h.connect(B, A);
	const peers = [A, B];
	await h.eventually(() => Promise.all(peers.map((p) => p.page.evaluate(() => window.__stores.nodesHandler.graphHash()))), (hs) => hs[0] === hs[1], 'premise: B holds the graph', 30000);
	await h.eventually(() => Promise.all(Object.values(ids).map((u) => posOf(B, u))), (ps) => ps.every(Boolean), 'premise: B holds every object', 30000);

	// ---- N3: the same animal in the same place on both peers, walking and resting
	const poseAt = (p, T) => p.page.evaluate(([u, t]) => window.__stores.flowRuntime.effectPoseAt('cat', u, t), [ids.cat, T]);
	const T0 = (await A.page.evaluate(() => window.__stores.flowRuntime.effectClockNow())) + 0.5;
	const samples = [];
	let agree = true;
	for (let i = 0; i < 17; i++) {
		const T = T0 + i * 0.25;
		const [a, b] = await Promise.all(peers.map((p) => poseAt(p, T)));
		if (!a || !b || !near(a.pos, b.pos, 1e-6)) {
			agree = false;
			console.log(`  disagree @${T.toFixed(2)}: A ${JSON.stringify(a?.pos)} B ${JSON.stringify(b?.pos)}`);
		}
		samples.push(a?.pos ?? null);
	}
	h.check(agree, 'N3: A and B put the animal in the same place for the same 17 shared moments');
	const steps = samples.slice(1).map((p, i) => (p && samples[i] ? Math.hypot(p[0] - samples[i][0], p[2] - samples[i][2]) : -1));
	console.log('  N3 steps per 0.25 s: ' + JSON.stringify(steps.map((s) => +s.toFixed(3))));
	h.check(steps.some((s) => s === 0), 'N3: it rests (a quarter second where it does not move)');
	h.check(steps.some((s) => s > 0.01), 'N3: and walks (a quarter second where it does)');
	h.check(samples.every((p) => p && Math.abs(p[0] + 8) <= 3 + 1e-6 && Math.abs(p[2] + 8) <= 3 + 1e-6), 'N3: it stays inside its wander box (3 m around home)');
	const drawnCat = await Promise.all(peers.map((p) => posOf(p, ids.cat)));
	h.check(drawnCat.every((p) => Math.abs(p[1] - 0.2) < 0.4), `N3: it walks on the ground on both peers (${drawnCat.map((p) => p[1].toFixed(2))})`);
	const amb = await A.page.evaluate(() => window.__stores.ambientNodes.ambientNodesDebug());
	console.log('  ambient (A): ' + JSON.stringify(amb));
	h.check(Object.keys(amb).some((k) => k.startsWith('cat|' + ids.cat)), 'N3: the runtime drives the animal');

	// ---- I1: no simulation; play mode; pick the mug up, push it away, put it down: it STAYS
	await A.page.evaluate(() => window.__stores.physics.stopSimulation?.());
	await A.page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ play: { interaction: 'grab' } }));
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.waitForTimeout(500);
	h.check((await piDebug(A.page)).mode === 'grab', 'I1 premise: play mode arms the grab');
	const aim = await A.page.evaluate(() => {
		let s;
		window.__stores.playInteract.playInteractState.subscribe((v) => (s = v))();
		return s;
	});
	h.check(aim.mode === 'aiming', `I1: the crosshair offers a Grabbable with no simulation running (${aim.mode})`);
	await pointer(A.page, 'pointerdown');
	await A.page.waitForTimeout(300);
	h.check((await piDebug(A.page)).carrying === ids.mug, 'I1: pointerdown picks the mug up (kinematic, no body)');
	await wheel(A.page, -100, 8); // push it further away
	await A.page.waitForTimeout(800);
	const carried = await posOf(A, ids.mug);
	h.check(!near(carried, mugHome, 0.3), `I1: the carry moved the mug (${carried.map((v) => v.toFixed(2))})`);
	await h.eventually(() => posOf(B, ids.mug), (p) => near(p, carried, 0.05), 'I1: B sees the mug where A carries it', 10000);
	await pointer(A.page, 'pointerup');
	await A.page.waitForTimeout(300);
	const putDown = await posOf(A, ids.mug);
	h.check((await piDebug(A.page)).carrying === null, 'I1: pointerup lets go');
	await A.page.waitForTimeout(2000);
	const [mugA, mugB] = await Promise.all(peers.map((p) => posOf(p, ids.mug)));
	h.check(near(mugA, putDown, 1e-6), 'I1 stay: the mug stays where it was put down (A)');
	h.check(near(mugB, putDown, 1e-4), `I1 stay: and B draws it exactly there (${mugB.map((v) => v.toFixed(3))})`);

	// ---- I1: the tool goes back where it was taken from, on both peers
	await placeInFront(A.page, ids.mug, 9); // the mug out of the line of sight... behind the tool
	await A.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		g.getObjectByProperty('uuid', u).position.y -= 6; // ...and well below it
	}, ids.mug);
	const toolHome = await placeInFront(A.page, ids.tool, 3);
	await A.page.waitForTimeout(400);
	await pointer(A.page, 'pointerdown');
	await A.page.waitForTimeout(300);
	h.check((await piDebug(A.page)).carrying === ids.tool, 'I1: pointerdown picks the tool up');
	await wheel(A.page, -100, 8);
	await A.page.waitForTimeout(800);
	const toolCarried = await posOf(A, ids.tool);
	await h.eventually(() => posOf(B, ids.tool), (p) => near(p, toolCarried, 0.05), 'I1: B sees the tool carried', 10000);
	await pointer(A.page, 'pointerup');
	await A.page.waitForTimeout(200);
	h.check(!near(await posOf(A, ids.tool), toolHome, 0.3), 'I1 return: it waits before it goes home');
	await h.eventually(() => Promise.all(peers.map((p) => posOf(p, ids.tool))), (ps) => ps.every((p) => near(p, toolHome, 1e-3)), 'I1 return: the tool glides back home on A and B', 10000);
	h.check((await A.page.evaluate(() => window.__stores.grabReturn?.grabReturnDebug?.() ?? [])).length === 0, 'I1 return: no glide left running');

	// ---- I3: a Sit Spot — a click on the chair in play sits A down on it, facing its front; W stands A up
	const eyeOf = () =>
		A.page.evaluate(() => {
			let cam;
			window.__stores.playerCam.subscribe((v) => (cam = v))();
			return cam?.isObject3D ? cam.getWorldPosition(new cam.position.constructor()).toArray() : null;
		});
	const before = await eyeOf();
	h.check(!!before, 'I3 premise: the play camera exists');
	await A.page.evaluate((u) => window.__stores.flowRuntime.fireObjectClick(u), ids.chair);
	await A.page.waitForTimeout(600);
	const sat = await A.page.evaluate(() => window.__stores.sitSpot.sitDebug());
	console.log('  seated: ' + JSON.stringify(sat));
	h.check(!!sat && sat.uuid === ids.chair, 'I3: a click on the chair in play sits A down');
	const eye = await eyeOf();
	h.check(near(eye, [4, 0.5 + 0.7, -12], 1e-3), `I3: A's eyes are 0.7 m over the seat top, centred (${eye?.map((v) => v.toFixed(3))})`);
	h.check(!!sat && Math.abs(-Math.cos(sat.yaw) - 1) < 1e-6, 'I3: facing the seat front (+z)');
	h.check(await A.page.evaluate(() => window.__stores.inputRuntime.isClaimed('locomotion')), 'I3: walking is held while seated (the locomotion claim)');
	await A.page.keyboard.down('KeyW');
	await A.page.waitForTimeout(300);
	await A.page.keyboard.up('KeyW');
	await A.page.waitForTimeout(300);
	h.check((await A.page.evaluate(() => window.__stores.sitSpot.sitDebug())) === null, 'I3: W stands A up');
	h.check(near(await eyeOf(), before, 0.6), 'I3: back where A sat down from');
	await A.page.evaluate(() => window.__stores.isLocked.set(false));

	for (const p of peers) {
		const errs = h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p.id}: ` + JSON.stringify(errs.slice(0, 3)));
	}
	await h.finish(browser);
});
