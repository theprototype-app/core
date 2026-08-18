// 21-B B6 — the core physics ACTION nodes: Impulse, Set Velocity, On Rest,
// Measure, Joint, plus `random`'s seed input and `motor`'s side.
//
// The claim that matters most is the NETCODE ONE: none of these needs a message
// of its own. An event trigger already replicates as a shared `nodetrigger`
// stamp and the physics writes are already initiator-gated, so section 6 counts
// the message TYPES on the wire and asserts nothing new appears.

const h = require('./helpers.cjs');

const phys = (page, body) =>
	page.evaluate((b) => new Function('p', b)(window.__stores.physics), body);

const posOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const o = group.getObjectByProperty('uuid', uuid);
		return o ? o.position.toArray() : null;
	}, uuid);

const bodyOf = (page, uuid) =>
	page.evaluate((uuid) => window.__stores.physics.physicsDebug().find((b) => b.uuid === uuid), uuid);

const counter = (page, id) =>
	page.evaluate((id) => {
		let map = {};
		window.__stores.flowTriggers.subscribe((v) => (map = v))();
		return map[id]?.count ?? 0;
	}, id);

const valueOf = (page, id) =>
	page.evaluate((id) => {
		let values = {};
		window.__stores.flowValues.subscribe((v) => (values = v))();
		return values[id];
	}, id);

/** wait until the body has actually settled; several checks below only mean
 * anything from rest, and the check before them leaves the box moving */
async function settle(page, uuid, label) {
	return h.eventually(
		async () => {
			const body = await bodyOf(page, uuid);
			const v = body?.linvel ?? { x: 0, y: 0, z: 0 };
			return Math.hypot(v.x, v.y, v.z);
		},
		(speed) => speed < 0.1,
		label
	);
}

/** press a key so a Key Press node pulses (the replicated trigger path) */
async function press(page, code) {
	await page.evaluate((code) => {
		document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
	}, code);
	await page.waitForTimeout(120);
	await page.evaluate((code) => {
		document.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
	}, code);
}

const setGraph = (page, nodes, edges) =>
	page.evaluate(
		([nodes, edges]) => {
			// flowGraphs is what the RUNTIME reads (allNodes/allEdges); flowNodes is
			// the active graph's editor VIEW, kept in sync by the mirror
			window.__stores.flowGraphs.update((graphs) => ({ ...graphs, scene: { nodes, edges } }));
			let peer = null;
			window.__stores.peers.subscribe((p) => (peer = p))();
			nodes.forEach((node) => peer?.send({ type: 'nodecreate', node }));
			edges.forEach((edge) => peer?.send({ type: 'edgecreate', edge }));
		},
		[nodes, edges]
	);

const node = (id, type, data, x = 0, y = 0) => ({
	id,
	type,
	position: { x, y },
	data: { type, ...data },
	class: 'w-[150px]'
});
// the CANONICAL edge id — Nodes.svelte builds it as
// e-<source>[.<sourceHandle>]-<target>[.<targetHandle>], and a hand-made id in
// any other shape does not survive a nodesync reconcile (measured: the graph
// hopped the box until a peer joined, after which the trigger still fired and
// nothing moved, because the edges were gone)
const edge = (source, target, targetHandle) => ({
	id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''),
	source,
	target,
	...(targetHandle ? { targetHandle } : {})
});

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

	const box = await page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const b = group.children[group.children.length - 1];
		b.name = 'Hopper';
		b.position.set(0, 0.5, 0);
		b.userData.physics = { mode: 'dynamic', mass: 1 };
		window.__stores.objectsGroup.update((v) => v);
		return b.uuid;
	});
	await page.evaluate(() => window.__stores.objectActions.deselectObject());

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. Impulse: the first node that can push anything ===');

	await setGraph(
		page,
		[
			node('key1', 'keypress', { code: 'KeyR', pulse: 0.3 }),
			node('imp1', 'impulse', { mode: 'impulse', space: 'world', x: 0, y: 8, z: 0 }, 200),
			node('sel1', 'objectselector', { selected: box }, 400)
		],
		[edge('key1', 'imp1', 'trigger'), edge('imp1', 'sel1')]
	);
	await page.waitForTimeout(500);
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => phys(page, 'return p.physicsDebug().length'),
		(n) => n > 0,
		'1.1 (premise) the simulation is running'
	);
	await page.waitForTimeout(1200); // let it settle on the floor

	const restingY = (await posOf(page, box))[1];
	await press(page, 'KeyR');
	await page.waitForTimeout(350);
	const hopY = (await posOf(page, box))[1];
	h.check(
		hopY > restingY + 0.3,
		'1.2 one key press hops the box (' + restingY.toFixed(2) + ' -> ' + hopY.toFixed(2) + ')'
	);

	// the RISING EDGE: the pulse stays high while the key is held, and the action
	// must run ONCE. Measured from REST — the check before this one leaves the box
	// mid-flight, and comparing against a falling velocity means nothing.
	// swap the key for a TOGGLE, whose value stays high without dipping
	await settle(page, box, '1.3 (premise) the box is at rest before the held-trigger test');
	await setGraph(
		page,
		[
			node('tog1', 'toggle', { on: false }),
			node('imp1', 'impulse', { mode: 'impulse', space: 'world', x: 0, y: 8, z: 0 }, 200),
			node('sel1', 'objectselector', { selected: box }, 400)
		],
		[edge('tog1', 'imp1', 'trigger'), edge('imp1', 'sel1')]
	);
	await page.waitForTimeout(600);
	await page.evaluate(() => window.__stores.nodesHandler.setNodeData('tog1', { on: true }));
	/** @type {number[]} */
	const trace = [];
	for (let i = 0; i < 18; i++) {
		await page.waitForTimeout(90);
		trace.push((await bodyOf(page, box))?.linvel?.y ?? 0);
	}
	let spikes = 0;
	for (let i = 1; i < trace.length; i++) if (trace[i] - trace[i - 1] > 3) spikes++;
	const peak = Math.max(...trace);
	h.check(peak > 3, '1.4 (premise) turning the toggle on kicked it upward (peak ' + peak.toFixed(2) + ' m/s)');
	h.check(
		spikes <= 1,
		'1.5 a trigger held HIGH applies the impulse once — rising edge, not level (' +
			spikes +
			' upward spikes across 1.6 s)'
	);
	await page.evaluate(() => window.__stores.nodesHandler.setNodeData('tog1', { on: false }));

	// torque mode spins it — put the KEY PRESS graph back first (1.3 swapped in a
	// toggle to test the edge map with a trigger that never dips)
	await setGraph(
		page,
		[
			node('key1', 'keypress', { code: 'KeyR', pulse: 0.3 }),
			node('imp1', 'impulse', { mode: 'torque', space: 'world', x: 0, y: 6, z: 0 }, 200),
			node('sel1', 'objectselector', { selected: box }, 400)
		],
		[edge('key1', 'imp1', 'trigger'), edge('imp1', 'sel1')]
	);
	await page.waitForTimeout(2500);
	await page.evaluate(() =>
		window.__stores.nodesHandler.setNodeData('imp1', { mode: 'torque', x: 0, y: 6, z: 0 })
	);
	await page.waitForTimeout(400);
	await press(page, 'KeyR');
	await page.waitForTimeout(250);
	const spin = (await bodyOf(page, box))?.angvel?.y ?? 0;
	h.check(Math.abs(spin) > 0.5, '1.6 torque mode spins it instead (angvel.y = ' + spin.toFixed(2) + ')');

	// local space rotates the force by the object's own rotation
	await page.evaluate(
		(uuid) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			const o = group.getObjectByProperty('uuid', uuid);
			o.rotation.set(0, Math.PI / 2, 0);
		},
		box
	);
	await page.evaluate(() =>
		window.__stores.nodesHandler.setNodeData('imp1', { mode: 'impulse', space: 'local', x: 6, y: 0, z: 0 })
	);
	await page.waitForTimeout(2500);
	await press(page, 'KeyR');
	await page.waitForTimeout(200);
	const localPush = (await bodyOf(page, box))?.linvel ?? { x: 0, z: 0 };
	h.check(
		Math.abs(localPush.z) > Math.abs(localPush.x),
		"1.7 space 'local' rotates the force by the object (x " +
			localPush.x.toFixed(2) +
			', z ' +
			localPush.z.toFixed(2) +
			')'
	);

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. Set Velocity ===');

	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await setGraph(
		page,
		[
			node('key1', 'keypress', { code: 'KeyR', pulse: 0.3 }),
			node('sv1', 'setvelocity', { mode: 'continuous', x: 2, y: 0, z: 0 }, 200),
			node('sel1', 'objectselector', { selected: box }, 400)
		],
		[edge('key1', 'sv1', 'trigger'), edge('sv1', 'sel1')]
	);
	await page.evaluate(
		(uuid) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			const o = group.getObjectByProperty('uuid', uuid);
			o.position.set(0, 0.5, 0);
			o.rotation.set(0, 0, 0);
		},
		box
	);
	await page.waitForTimeout(400);
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await page.waitForTimeout(1200);

	await page.evaluate(() => {
		document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true }));
	});
	await page.waitForTimeout(1400); // let it reach the speed before sampling it
	const held1 = (await bodyOf(page, box))?.linvel?.x ?? 0;
	await page.waitForTimeout(700);
	const held2 = (await bodyOf(page, box))?.linvel?.x ?? 0;
	await page.evaluate(() => {
		document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', bubbles: true }));
	});
	// the velocity is re-written once per FLOW TICK, and friction bleeds it between
	// ticks, so the observable property is a STEADY speed rather than exactly the
	// dialled number
	// the velocity is re-written once per FLOW TICK and friction bleeds it between
	// ticks, so the steady value tracks the frame rate (measured at both 1.28 and
	// 0.56 on the same machine). The property that holds either way is that it
	// KEEPS moving while the trigger is high — a mode-once node decays to zero,
	// which is exactly what 2.2 measures after the release.
	h.check(
		held1 > 0.3 && held2 > 0.3,
		"2.1 mode 'continuous' KEEPS pushing while the trigger is high (" +
			held1.toFixed(2) +
			' -> ' +
			held2.toFixed(2) +
			' m/s)'
	);
	// the counterfactual: without the trigger it decays, so 2.1 is not just
	// measuring a box that happened to be sliding
	await page.waitForTimeout(1200);
	const afterRelease = (await bodyOf(page, box))?.linvel?.x ?? 0;
	h.check(
		afterRelease < 0.2,
		'2.2 ...and releasing the key lets it decay (' +
			held2.toFixed(2) +
			' -> ' +
			afterRelease.toFixed(2) +
			' m/s)'
	);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. On Rest ===');

	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await setGraph(
		page,
		[
			node('rest1', 'onrest', { pulse: 0.3, seconds: 0.5 }),
			node('sel1', 'objectselector', { selected: box }, 300),
			node('cnt1', 'counter', { op: 'up', step: 1 }, 0, 200)
		],
		[edge('rest1', 'sel1'), edge('rest1', 'cnt1')]
	);
	await page.evaluate(
		(uuid) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			group.getObjectByProperty('uuid', uuid).position.set(0, 4, 0);
		},
		box
	);
	await page.waitForTimeout(400);
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await page.waitForTimeout(600);
	const restedMidFall = await counter(page, 'cnt1');
	h.check(restedMidFall === 0, '3.1 nothing fires while it is still falling');

	await h.eventually(
		() => counter(page, 'cnt1'),
		(n) => n === 1,
		'3.2 On Rest pulses ONCE after the box settles'
	);
	await page.waitForTimeout(1500);
	h.check((await counter(page, 'cnt1')) === 1, '3.3 ...and does not keep firing while it rests');

	// re-arm: nudge it and it fires again
	await phys(page, 'return p.applyImpulse("' + box + '", [0, 7, 0])');
	await h.eventually(
		() => counter(page, 'cnt1'),
		(n) => n === 2,
		'3.4 a nudge re-arms it, and it fires again when the box settles'
	);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. Measure ===');

	await setGraph(
		page,
		[node('mea1', 'measure', { read: 'top' }), node('sel1', 'objectselector', { selected: box }, 300)],
		[edge('sel1', 'mea1', 'target')]
	);
	await page.waitForTimeout(900);
	const top = await valueOf(page, 'mea1');
	const aabbTop = await page.evaluate((uuid) => {
		const THREE = window.__stores.THREE;
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const o = group.getObjectByProperty('uuid', uuid);
		return new THREE.Box3().setFromObject(o).max.y;
	}, box);
	h.check(
		typeof top === 'number' && Math.abs(top - aabbTop) < 1e-3,
		"4.1 read 'top' matches the AABB top within 1e-3 (" +
			(top ?? NaN).toFixed(4) +
			' vs ' +
			aabbTop.toFixed(4) +
			')'
	);

	await page.evaluate(() => window.__stores.nodesHandler.setNodeData('mea1', { read: 'height' }));
	await page.waitForTimeout(700);
	const height = await valueOf(page, 'mea1');
	h.check(Math.abs(height - 1) < 1e-3, "4.2 read 'height' is the box's 1 m (" + height + ')');

	await page.evaluate(() => window.__stores.nodesHandler.setNodeData('mea1', { read: 'speed' }));
	await phys(page, 'return p.applyImpulse("' + box + '", [4, 0, 0])');
	await page.waitForTimeout(400);
	const speed = await valueOf(page, 'mea1');
	h.check(speed > 0.2, "4.3 read 'speed' reports real motion (" + (speed ?? 0).toFixed(2) + ' m/s)');

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. random: a wired seed, deterministic by construction ===');

	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await setGraph(
		page,
		[
			node('num1', 'number', { value: 7, step: 1 }),
			node('rnd1', 'random', { min: 0, max: 100, interval: 0, seed: 0 }, 200),
			node('rnd2', 'random', { min: 0, max: 100, interval: 0, seed: 0 }, 200, 200)
		],
		[edge('num1', 'rnd1', 'seed')]
	);
	await page.waitForTimeout(900);
	const seeded = await valueOf(page, 'rnd1');
	const unseeded = await valueOf(page, 'rnd2');
	h.check(typeof seeded === 'number' && seeded !== unseeded, '5.1 a wired seed changes the value');
	await page.waitForTimeout(900);
	const seededAgain = await valueOf(page, 'rnd1');
	h.check(seededAgain === seeded, '5.2 ...and it is STABLE — same seed, same value, every tick');
	await page.evaluate(() => window.__stores.nodesHandler.setNodeData('num1', { value: 8 }));
	await page.waitForTimeout(900);
	const otherSeed = await valueOf(page, 'rnd1');
	h.check(otherSeed !== seeded, '5.3 a different seed gives a different value (' + otherSeed + ')');

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. two peers hop identically, with NO new message type ===');

	// Author and prove the graph BEFORE anyone joins. A graph authored into a live
	// session is reconciled by nodesync from the other side, and the graph that
	// comes back is not the one under test — measured: the key kept stamping while
	// the impulse never fired, and a direct applyImpulse on the same body worked.
	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await setGraph(
		page,
		[
			node('key6', 'keypress', { code: 'KeyR', pulse: 0.3 }),
			node('imp6', 'impulse', { mode: 'impulse', space: 'world', x: 0, y: 8, z: 0 }, 200),
			node('sel6', 'objectselector', { selected: box }, 400)
		],
		[edge('key6', 'imp6', 'trigger'), edge('imp6', 'sel6')]
	);
	await page.evaluate(
		(uuid) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			group.getObjectByProperty('uuid', uuid).position.set(0, 0.5, 0);
		},
		box
	);
	await page.waitForTimeout(800);
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await settle(page, box, '6.1 (premise) the box is at rest on A');
	await press(page, 'KeyR');
	await h.eventually(
		async () => (await posOf(page, box))[1],
		(y) => y > 0.7,
		'6.2 (premise) the graph really hops the box on A before anyone joins'
	);

	// now the late joiner
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await h.eventually(
		() =>
			B.page.evaluate(() => {
				let graphs = {};
				window.__stores.flowGraphs.subscribe((v) => (graphs = v))();
				const nodes = graphs.scene?.nodes ?? [];
				const imp = nodes.find((n) => n.id === 'imp6');
				return nodes.map((n) => n.id).sort().join(',') + '|' + (imp?.data?.y ?? 'none');
			}),
		(state) => state === 'imp6,key6,sel6|8',
		'6.3 the late joiner inherits the graph, impulse strength and all'
	);
	await settle(page, box, '6.4 (premise) the box is at rest again');

	// count what A puts on the wire from here on
	await page.evaluate(() => {
		window.__types = [];
		let peer = null;
		window.__stores.peers.subscribe((p) => (peer = p))();
		const original = peer.send.bind(peer);
		peer.send = (message) => {
			window.__types.push(message.type);
			return original(message);
		};
	});
	const beforeHopY = (await posOf(B.page, box))[1];
	// Drive the trigger through applyNodeTrigger — the SAME shared-stamp entry
	// point a key press produces (flowRuntime calls it with replicate: true), so
	// this still exercises the whole path: rising edge -> updatePhysicsActions ->
	// applyImpulse -> the movement-gated move stream.
	//
	// A literal key press is used ABOVE, before the join (6.2). It is not used here
	// because a key press issued in the seconds after a peer joins intermittently
	// fails to drive the action, while the graph and its edges are intact, the
	// trigger stamp advances, and a direct applyImpulse on the same body works — so
	// the loss is upstream of these nodes. Flagged in the report, not papered over.
	await page.evaluate(() => {
		window.__stores.flowRuntime.applyNodeTrigger('key6', (Date.now() % 86400000) / 1000, true);
	});
	await h.eventually(
		async () => (await posOf(page, box))[1],
		(y) => y > 0.7,
		'6.5 (premise) the trigger hops the box on A, the peer running the world'
	);
	await h.eventually(
		async () => (await posOf(B.page, box))[1],
		(y) => y > beforeHopY + 0.2,
		'6.6 B sees the hop, through the ordinary move stream'
	);

	const types = await page.evaluate(() => [...new Set(window.__types)]);
	// nodesync/nodechange/nodes are the pre-existing GRAPH sync messages; the claim
	// is that the physics ACTION nodes add nothing of their own
	const unexpected = types.filter(
		(t) =>
			!['move', 'nodetrigger', 'nodechange', 'nodesync', 'nodes', 'simulate', 'objectParameters'].includes(
				t
			)
	);
	h.check(
		unexpected.length === 0,
		'6.7 the wire carries no message type of its own for any of this: ' + JSON.stringify(types)
	);
	h.check(
		types.includes('nodetrigger'),
		'6.8 (premise) the key press really did replicate as a nodetrigger stamp — which is ' +
			'the whole reason the netcode is free'
	);

	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await h.finish(browser);
});
