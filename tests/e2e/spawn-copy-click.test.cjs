// 92-correct row 2 — a click on a SPAWNED COPY reaches the template's own On Click, with
// "this object" = the copy: the template's flow is On Click -> Latch -> NOT -> Visibility (no
// Object Selector: the implicit owner), so clicking a copy hides THAT copy, on both peers, and
// leaves the template and the other copy alone. A late joiner sees the same.
//
// Red on v1.74.0: a copy carries no flow, and fireObjectClick only matched the template's own
// graph by its owner uuid — the click reached nothing (2.0-eval2 finding 2).
//
// Run: APP_URL=https://localhost:5927/ npm run e2e -- spawn-copy-click
const h = require('./helpers.cjs');

const E = (/** @type {any} */ p, /** @type {Function} */ fn, /** @type {any} */ arg) => p.page.evaluate(fn, arg);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** visible? of each uuid on a page @param {any} p @param {string[]} uuids */
const shown = (p, uuids) =>
	E(
		p,
		(ids) => {
			/** @type {any} */
			let g;
			/** @type {any} */ (window).__tp.test.v1.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			return ids.map((/** @type {string} */ id) => {
				const o = g?.getObjectByProperty('uuid', id);
				return o ? o.visible : null;
			});
		},
		uuids
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);
	await E(A, () => /** @type {any} */ (window).__tp.test.v1.physics.warmup().catch(() => {}));

	// the template: a box with its own flow, On Click -> Latch(set) -> NOT -> Visibility (owner)
	const T = await E(A, async () => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		/** @type {any} */
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		const t = g.children[g.children.length - 1];
		t.name = 'Enemy';
		t.position.set(0, 1, 0);
		t.userData.physics = { mode: 'static' };
		return t.uuid;
	});
	await E(
		A,
		({ t, b }) => {
			const s = /** @type {any} */ (window).__tp.test.v1;
			const node = (/** @type {string} */ id, /** @type {string} */ type, /** @type {any} */ data = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, ...data } });
			s.updateGraph(t, () => ({
				nodes: [node('click', 'onclick', { pulse: 0.3 }), node('latch', 'latch', { initial: false }), node('gate', 'gate', { op: 'not' }), node('vis', 'visibility', { on: true })],
				edges: [
					{ id: 'e1', source: 'click', target: 'latch', targetHandle: 'set' },
					{ id: 'e2', source: 'latch', target: 'gate', targetHandle: 'a' },
					{ id: 'e3', source: 'gate', target: 'vis', targetHandle: 'on' }
				]
			}));
			s.nodesHandler.sendNodes(b);
		},
		{ t: T, b: B.id }
	);
	await sleep(1500);
	await E(A, () => /** @type {any} */ (window).__tp.test.v1.physics.toggleSimulation());
	await h.eventually(() => E(A, () => /** @type {any} */ (window).__tp.test.v1.physics.physicsDebug().length), (n) => n > 0, 'premise: the simulation runs', 20000);

	// two copies from the Spawn path (the initiator spawns, peers get `duplicate`)
	const spawned = await E(A, (t) => /** @type {any} */ (window).__tp.test.v1.spawner.spawnFrom('sp1', t, { count: 2, spread: 3 }), T);
	h.check(spawned?.spawned === 2, `two copies spawned (${JSON.stringify(spawned)})`);
	const copies = await E(A, () => /** @type {any} */ (window).__tp.test.v1.transientObjects.transientUuids());
	h.check(copies.length === 2, `two transient copies (${copies.length})`);
	await h.eventually(() => shown(B, copies), (v) => v.every((x) => x === true), 'the peer has both copies', 15000);
	await h.eventually(
		() => E(A, () => /** @type {any} */ (window).__tp.test.v1.flowRuntime.runtimeGraphDebug().nodeIds.filter((/** @type {string} */ id) => id.includes('~')).length),
		(n) => n === 8,
		'each copy runs an instance of the template event flow (4 nodes each)',
		10000
	);

	// click copy 0
	const reached = await E(A, (c) => /** @type {any} */ (window).__tp.test.v1.flowRuntime.fireObjectClick(c), copies[0]);
	h.check(reached >= 1, `the click on a copy reaches an On Click (${reached}; red on v1.74.0: 0)`);
	await h.eventually(() => shown(A, [T, copies[0], copies[1]]), (v) => v[0] === true && v[1] === false && v[2] === true, 'A: the clicked copy hides, the template and the other copy stay', 8000);
	await h.eventually(() => shown(B, [T, copies[0], copies[1]]), (v) => v[0] === true && v[1] === false && v[2] === true, 'B: the same copy hides on the peer', 8000);

	// the template's own click still works on the template only
	const reachedT = await E(A, (t) => /** @type {any} */ (window).__tp.test.v1.flowRuntime.fireObjectClick(t), T);
	console.log('  template click reached ' + reachedT + '; log keys ' + JSON.stringify(await E(A, () => {
		/** @type {any} */
		let m;
		/** @type {any} */ (window).__tp.test.v1.flowTriggers.subscribe((/** @type {any} */ x) => (m = x))();
		return Object.keys(m ?? {});
	})));
	await h.eventually(() => shown(A, [T, copies[1]]), (v) => v[0] === false && v[1] === true, 'clicking the template hides the template, not the copy', 8000);

	// a late joiner: the instance stamps ride the trigger log reply
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(() => shown(C, [copies[0], copies[1]]), (v) => v[0] === false && v[1] === true, 'a late joiner sees the clicked copy hidden and the other shown', 30000);

	await browser.close();
});
