// Phase 134: loops, timers, sensors, object actions + events. Deterministic
// nodes evaluate purely (Loop/Timer/Distance/Proximity, OnClick/Counter math);
// the object actions (Set Color/Visibility/LookAt) apply through the live
// runtime tick; OnClick/Counter ride a replicated trigger message so two peers
// agree. On-device VR click is manual.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure math: Loop / Timer / Distance / Proximity / OnClick / Counter ---
	const pure = await A.page.evaluate(() => {
		const R = window.__stores.flowRuntime;
		const THREE = window.__stores.THREE;
		const ev = (node, nodes, edges, time, ctx) => R.evalNode(node, nodes || [], edges || [], time || 0, new Set(), ctx);
		// Loop
		const loop = (mode, time) => ev({ id: 'l', type: 'loop', data: { from: 0, to: 10, rate: 1, mode } }, [], [], time);
		// Timer delay: a Time(t) wired into 'a', delay 1 -> reads the clock 1s ago
		const tNodes = [
			{ id: 'clk', type: 'time', data: { mode: 't' } },
			{ id: 'tmr', type: 'timer', data: { delay: 1 } }
		];
		const tEdges = [{ id: 'te', source: 'clk', target: 'tmr', targetHandle: 'a' }];
		const timer = ev(tNodes[1], tNodes, tEdges, 5);
		// Distance / Proximity between two Object Selectors, via a scene ctx
		const ctx = {
			pos: (u) => (u === 'A' ? new THREE.Vector3(0, 0, 0) : u === 'B' ? new THREE.Vector3(3, 4, 0) : null),
			triggers: { oc: { lastT: 99.9, count: 0 }, ocOld: { lastT: 90, count: 0 }, cnt: { count: 5, lastT: 0 } }
		};
		const dNodes = [
			{ id: 'selA', type: 'objectselector', data: { selected: 'A' } },
			{ id: 'selB', type: 'objectselector', data: { selected: 'B' } },
			{ id: 'dst', type: 'distance', data: {} },
			{ id: 'prx', type: 'proximity', data: { radius: 6 } },
			{ id: 'prx2', type: 'proximity', data: { radius: 4 } }
		];
		const dEdges = [
			{ id: 'da', source: 'selA', target: 'dst', targetHandle: 'a' },
			{ id: 'db', source: 'selB', target: 'dst', targetHandle: 'b' },
			{ id: 'pa', source: 'selA', target: 'prx', targetHandle: 'a' },
			{ id: 'pb', source: 'selB', target: 'prx', targetHandle: 'b' },
			{ id: 'pa2', source: 'selA', target: 'prx2', targetHandle: 'a' },
			{ id: 'pb2', source: 'selB', target: 'prx2', targetHandle: 'b' }
		];
		return {
			loopWrap: loop('wrap', 2.5),
			loopPingpong: loop('pingpong', 1.5),
			loopOnceMid: loop('once', 0.3),
			loopOnceClamp: loop('once', 5),
			timer,
			distance: ev(dNodes[2], dNodes, dEdges, 0, ctx),
			proxNear: ev(dNodes[3], dNodes, dEdges, 0, ctx),
			proxFar: ev(dNodes[4], dNodes, dEdges, 0, ctx),
			pulseOn: ev({ id: 'oc', type: 'onclick', data: { pulse: 0.3 } }, [], [], 100, ctx),
			pulseOff: ev({ id: 'ocOld', type: 'onclick', data: { pulse: 0.3 } }, [], [], 100, ctx),
			counter: ev({ id: 'cnt', type: 'counter', data: {} }, [], [], 0, ctx)
		};
	});
	h.check(Math.abs(pure.loopWrap - 5) < 1e-6, `Loop wrap sawtooth (${pure.loopWrap})`);
	h.check(Math.abs(pure.loopPingpong - 5) < 1e-6, `Loop pingpong triangle (${pure.loopPingpong})`);
	h.check(Math.abs(pure.loopOnceMid - 3) < 1e-6 && Math.abs(pure.loopOnceClamp - 10) < 1e-6, 'Loop once ramps then clamps');
	h.check(Math.abs(pure.timer - 4) < 1e-6, `Timer delays the clock (t=5, delay 1 -> ${pure.timer})`);
	h.check(Math.abs(pure.distance - 5) < 1e-6, `Distance between objects (3-4-5 = ${pure.distance})`);
	h.check(pure.proxNear === true && pure.proxFar === false, 'Proximity is true within radius, false outside');
	h.check(pure.pulseOn === 1 && pure.pulseOff === 0, 'OnClick pulses inside its window, else 0');
	h.check(pure.counter === 5, 'Counter outputs the running count');

	// --- object actions apply through the live tick (Set Color / Visibility / LookAt) ---
	await A.page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const [b1, b2, b3] = group.children.slice(-3);
		window.__b = [b1.uuid, b2.uuid, b3.uuid];
		b3.position.set(0, 0, 0);
		b3.rotation.set(0, 0, 0);
		window.__b3 = b3;
		const nodes = [
			{ id: 'cp', type: 'colorpicker', data: { type: 'colorpicker', color: '#00ff00' } },
			{ id: 'sc', type: 'setcolor', data: { type: 'setcolor' } },
			{ id: 'sel1', type: 'objectselector', data: { type: 'objectselector', selected: b1.uuid } },
			{ id: 'tg', type: 'toggle', data: { type: 'toggle', on: false } },
			{ id: 'vis', type: 'visibility', data: { type: 'visibility' } },
			{ id: 'sel2', type: 'objectselector', data: { type: 'objectselector', selected: b2.uuid } },
			{ id: 'v3', type: 'vector3', data: { type: 'vector3', x: 5, y: 0, z: 0 } },
			{ id: 'la', type: 'lookat', data: { type: 'lookat' } },
			{ id: 'sel3', type: 'objectselector', data: { type: 'objectselector', selected: b3.uuid } }
		];
		const edges = [
			{ id: 'x1', source: 'cp', target: 'sc', targetHandle: 'color' },
			{ id: 'x2', source: 'sc', target: 'sel1' },
			{ id: 'x3', source: 'tg', target: 'vis', targetHandle: 'on' },
			{ id: 'x4', source: 'vis', target: 'sel2' },
			{ id: 'x5', source: 'v3', target: 'la', targetHandle: 'target' },
			{ id: 'x6', source: 'la', target: 'sel3' }
		];
		s.flowNodes.set(nodes);
		s.flowEdges.set(edges);
	});
	await A.page.waitForTimeout(400);
	const effects = await A.page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const b1 = group.getObjectByProperty('uuid', window.__b[0]);
		const b2 = group.getObjectByProperty('uuid', window.__b[1]);
		const b3 = window.__b3;
		const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(b3.quaternion);
		const toTarget = new THREE.Vector3(5, 0, 0).sub(b3.getWorldPosition(new THREE.Vector3())).normalize();
		return {
			color: '#' + b1.material.color.getHexString(),
			visible: b2.visible,
			lookDot: Math.abs(fwd.dot(toTarget))
		};
	});
	h.check(effects.color === '#00ff00', `Set Color drives the material color locally (${effects.color})`);
	h.check(effects.visible === false, 'Visibility hides the object from a boolean input');
	h.check(effects.lookDot > 0.9, `LookAt orients the object toward the target (dot ${effects.lookDot.toFixed(2)})`);

	// clear the graph before the two-peer block
	await A.page.evaluate(() => {
		window.__stores.flowNodes.set([]);
		window.__stores.flowEdges.set([]);
	});

	// --- two-peer: an OnClick pulse replicates + both Counters agree ---
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);

	await A.page.evaluate(() => {
		const s = window.__stores;
		const nodes = [
			{ id: 'oc', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } },
			{ id: 'sel', type: 'objectselector', position: { x: 200, y: 0 }, data: { type: 'objectselector', selected: 'target-uuid' } },
			{ id: 'cnt', type: 'counter', position: { x: 200, y: 100 }, data: { type: 'counter', op: 'up', step: 1 } }
		];
		const edges = [
			{ id: 'oe1', source: 'oc', target: 'sel' },
			{ id: 'oe2', source: 'oc', target: 'cnt', targetHandle: 'pulse' }
		];
		s.flowNodes.set(nodes);
		s.flowEdges.set(edges);
		let peer;
		s.peers.subscribe((p) => (peer = p))();
		nodes.forEach((node) => peer.send({ type: 'nodecreate', node }));
		edges.forEach((edge) => peer.send({ type: 'edgecreate', edge }));
	});
	await B.page.waitForTimeout(2000);

	// simulate the object click on A (what raycastSelect calls)
	await A.page.evaluate(() => window.__stores.flowRuntime.fireObjectClick('target-uuid'));
	await A.page.waitForTimeout(800);

	const counts = await Promise.all(
		[A, B].map((peer) =>
			peer.page.evaluate(() => {
				let trig;
				window.__stores.flowTriggers.subscribe((v) => (trig = v))();
				return { cnt: trig.cnt?.count ?? 0, ocFired: (trig.oc?.lastT ?? -1) > 0 };
			})
		)
	);
	h.check(counts[0].ocFired && counts[0].cnt === 1, `A: the click pulses OnClick + counts (${counts[0].cnt})`);
	h.check(counts[1].ocFired && counts[1].cnt === 1, `B: the trigger replicated + its Counter agrees (${counts[1].cnt})`);

	await h.finish(browser);
});
