// 21-B B7 — THE SPAWNER: live mid-sim bodies, transient objects, the Spawn node.
//
// Three claims, in the order they have to be believed:
//
// 1. THE REFACTOR CHANGED NOTHING. `createBodyFor` was cut out of `startSimulation` so a
//    body can also be built mid-run, and that block encodes conventions nothing else
//    states (world-aligned starts for joints, hull-vs-primitive placement, sleep off,
//    animated -> kinematic, the offset/initialQuat write-back bookkeeping). Section 1
//    compares the construction snapshot against GOLDEN, which was captured from the
//    PRE-extraction code — see the note on GOLDEN for how, and for how to redo it.
// 2. A SPAWNED OBJECT IS REAL. It has a dynamic body and it falls. Before B7 there was no
//    mid-sim creation path at all, so a copy made during a run was inert — which is the
//    whole reason a Spawn node could not ship in B6.
// 3. IT IS BOUNDED AND IT LEAVES NOTHING BEHIND. maxAlive with oldest-out recycling, and
//    a run that ends takes its copies with it: out of the scene, out of every peer's
//    scene, out of sessions, out of autosave, and off the undo stack entirely.
//
// Two peers (PEER_CONFIG) for claim 3's replication half.

const h = require('./helpers.cjs');

/**
 * The construction snapshot `startSimulation` produced BEFORE createBodyFor existed.
 *
 * Captured with the pre-extraction physics.js (HEAD at the time) plus the additive
 * physicsDebug/physicsWorldDebug fields this suite reads, then verified byte-identical
 * against the refactored build. Only construction-time fields are here on purpose:
 * linvel/angvel/bodyRot/sleeping change every frame and would make the check a lottery.
 *
 * To redo it: revert physics.js to before the extraction, re-add the debug fields, run
 * section 1's `snapshot()` and paste. If a future change to the construction is
 * DELIBERATE, update these numbers in the same commit and say so — that is the whole
 * point of a golden.
 *
 * Note `Crate`'s geometry is deliberately translated off its origin: that is the only way
 * `entry.offset` is ever non-zero, and the offset is exactly the bookkeeping the
 * extraction could have broken silently.
 */
const GOLDEN = {
	bodies: [
		{
			name: 'Ball',
			mode: 'dynamic',
			hull: false,
			offset: [0, 0, 0],
			initialQuat: [0, 0, 0, 1],
			shapeKey:
				'{"c":"sphere","v":null,"sm":[null,null],"s":false,"f":null,"r":0.6,"fr":null,"m":1,"cs":null,"src":null}',
			mass: 1,
			linearDamping: 0,
			angularDamping: 0.05,
			ccd: false,
			bodyType: 0,
			colliders: 1
		},
		{
			name: 'Crate',
			mode: 'dynamic',
			hull: false,
			offset: [0, -0.5, 0],
			initialQuat: [0, 0.198669, 0, 0.980067],
			shapeKey:
				'{"c":null,"v":null,"sm":[null,null],"s":false,"f":null,"r":null,"fr":null,"m":2.5,"cs":null,"src":null}',
			mass: 2.5,
			linearDamping: 0,
			angularDamping: 0.05,
			ccd: false,
			bodyType: 0,
			colliders: 1
		},
		{
			name: 'Hull',
			mode: 'dynamic',
			hull: true,
			offset: [0, 0, 0],
			initialQuat: [0.148692, 0.098712, 0.014919, 0.983831],
			shapeKey:
				'{"c":"hull","v":null,"sm":[null,null],"s":false,"f":null,"r":null,"fr":null,"m":1,"cs":null,"src":null}',
			mass: 1,
			linearDamping: 0,
			angularDamping: 0.05,
			ccd: false,
			bodyType: 0,
			colliders: 1
		},
		{
			name: 'Platform',
			mode: 'kinematic',
			hull: false,
			offset: [0, 0, 0],
			initialQuat: [0, 0.049979, 0, 0.99875],
			shapeKey:
				'{"c":null,"v":null,"sm":[null,null],"s":false,"f":null,"r":null,"fr":null,"m":null,"cs":null,"src":null}',
			mass: 1,
			linearDamping: 0,
			angularDamping: 0,
			ccd: false,
			bodyType: 2,
			colliders: 1
		}
	],
	world: {
		groundHandle: 0,
		groundEnabled: true,
		groundTop: 0,
		bodies: 4,
		ownerHandles: 5,
		beforeStates: 3,
		suspended: [],
		fixed: [
			{
				name: 'Slab',
				colliders: 1,
				shapeKey:
					'{"c":null,"v":null,"sm":[null,null],"s":false,"f":null,"r":null,"fr":null,"m":null,"cs":null,"src":null}'
			}
		]
	}
};

// ---------------------------------------------------------------- page helpers

const node = (id, type, data, x = 0, y = 0) => ({
	id,
	type,
	position: { x, y },
	data: { type, ...data },
	class: 'w-[150px]'
});
// the CANONICAL edge id — anything else does not survive a nodesync reconcile
const edge = (source, target, targetHandle) => ({
	id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''),
	source,
	target,
	...(targetHandle ? { targetHandle } : {})
});

const setGraph = (page, nodes, edges) =>
	page.evaluate(
		([nodes, edges]) => {
			// BOTH stores: flowGraphs is what the runtime reads, flowNodes is the active
			// graph's editor view, and the mirror runs both ways
			window.__stores.flowGraphs.update((graphs) => ({ ...graphs, scene: { nodes, edges } }));
			window.__stores.flowNodes.set(nodes);
			window.__stores.flowEdges.set(edges);
			let peer = null;
			window.__stores.peers.subscribe((p) => (peer = p))();
			nodes.forEach((n) => peer?.send({ type: 'nodecreate', node: n }));
			edges.forEach((e) => peer?.send({ type: 'edgecreate', edge: e }));
		},
		[nodes, edges]
	);

/** press a key so a Key Press node pulses through the REAL replicated trigger path.
 * BLUR FIRST — inputRuntime filters keys while a text field has focus, and h.connect
 * leaves the peer-id input focused. */
async function press(page, code) {
	await page.evaluate((code) => {
		document.activeElement instanceof HTMLElement && document.activeElement.blur();
		document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
	}, code);
	await page.waitForTimeout(60);
	await page.evaluate((code) => {
		document.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
	}, code);
	// the spawner's own rate limit is 100 ms; give a fire room to land
	await page.waitForTimeout(140);
}

const transientOf = (page) =>
	page.evaluate(() => window.__stores.transientObjects.transientUuids());

const undoDepth = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))())
	);

const childNames = (page) =>
	page.evaluate(() => {
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return (group?.children ?? []).map((/** @type {any} */ c) => c.name);
	});

h.run(async () => {
	// GPU_ARGS: a software-rendered page runs ~2.5 fps, and the fixed-timestep
	// accumulator then caps at 8 substeps a frame — i.e. a third of real time — so
	// "does it fall" would be measuring the host's rAF cadence.
	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}

	// ================================================================= section 1
	console.log('\n=== 1. createBodyFor parity: the extraction changed nothing ===');
	{
		const P = await h.setupPage(browser, 'parity');
		const page = P.page;
		await page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await page.waitForTimeout(2500);

		await page.evaluate(() => {
			const cmd = window.__stores.commandsHandler;
			['box', 'sphere', 'box', 'box', 'box'].forEach((k) => cmd.sceneCommand('/create ' + k));
		});
		// `/create` re-seats the object AFTER the call returns and stamps its own
		// userData.physics — everything below has to be written on top of that
		await page.waitForTimeout(1200);
		const uuids = await page.evaluate(() => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			const kids = group.children;
			const spec = [
				{ name: 'Crate', pos: [0, 2, 0], rot: [0, 0.4, 0], phys: { mode: 'dynamic', mass: 2.5 } },
				{
					name: 'Ball',
					pos: [2, 3, 0],
					rot: [0, 0, 0],
					phys: { mode: 'dynamic', mass: 1, collider: 'sphere', restitution: 0.6 }
				},
				{ name: 'Hull', pos: [-2, 2, 1], rot: [0.3, 0.2, 0], phys: { mode: 'dynamic', mass: 1, collider: 'hull' } },
				{ name: 'Slab', pos: [0, -0.5, 0], rot: [0, 0, 0], phys: { mode: 'static' } },
				{ name: 'Platform', pos: [0, 1, 3], rot: [0, 0.1, 0], phys: null }
			];
			/** @type {any} */
			const out = {};
			spec.forEach((s, i) => {
				const o = kids[i];
				o.name = s.name;
				o.position.fromArray(s.pos);
				o.rotation.set(s.rot[0], s.rot[1], s.rot[2]);
				if (s.phys) o.userData.physics = s.phys;
				else delete o.userData.physics;
				out[s.name] = o.uuid;
			});
			kids[3].scale.set(10, 0.2, 10);
			// a non-centred GEOMETRY is what makes entry.offset non-zero
			kids[0].geometry.translate(0, 0.5, 0);
			window.__stores.objectsGroup.update((v) => v);
			return out;
		});
		await page.evaluate(() => window.__stores.objectActions.deselectObject());

		// Platform earns its KINEMATIC body by being flow-ANIMATED. Set Color and not Spin
		// on purpose: a rotating effect makes `initialQuat` depend on WHEN the capture ran.
		await setGraph(
			page,
			[
				node('fx1', 'setcolor', { color: '#00ff88' }),
				node('sel1', 'objectselector', { selected: uuids.Platform }, 200)
			],
			[edge('fx1', 'sel1')]
		);
		await page.evaluate(
			([a, b]) => window.__stores.joints.createJoint('weld', a, b, 'y', null),
			[uuids.Crate, uuids.Slab]
		);
		await page.waitForTimeout(900);
		await page.evaluate(() => window.__stores.physics.toggleSimulation());
		await h.eventually(
			() => page.evaluate(() => window.__stores.physics.physicsDebug().length),
			(/** @type {number} */ n) => n > 0,
			'1.1 (premise) the simulation is running'
		);

		const snap = await page.evaluate(
			([uuids]) => {
				const byUuid = Object.fromEntries(Object.entries(uuids).map(([n, u]) => [u, n]));
				const r = (/** @type {any} */ v) => (typeof v === 'number' ? +v.toFixed(6) : v);
				const bodies = window.__stores.physics
					.physicsDebug()
					.map((/** @type {any} */ b) => ({
						name: byUuid[b.uuid] ?? b.name,
						mode: b.mode,
						hull: b.hull,
						offset: (b.offset ?? []).map(r),
						initialQuat: (b.initialQuat ?? []).map(r),
						shapeKey: b.shapeKey,
						mass: r(b.mass),
						linearDamping: r(b.linearDamping),
						angularDamping: r(b.angularDamping),
						ccd: b.ccd,
						bodyType: b.bodyType,
						colliders: b.colliders.length
					}))
					.sort((/** @type {any} */ x, /** @type {any} */ y) => String(x.name).localeCompare(String(y.name)));
				const w = window.__stores.physics.physicsWorldDebug();
				return {
					bodies,
					world: {
						groundHandle: w.groundHandle,
						groundEnabled: w.groundEnabled,
						groundTop: w.groundTop,
						bodies: w.bodies,
						ownerHandles: w.ownerHandles.length,
						beforeStates: w.beforeStates,
						suspended: (w.suspended ?? []).map((/** @type {string} */ u) => byUuid[u] ?? u).sort(),
						fixed: (w.fixed ?? [])
							.slice()
							.sort((/** @type {any} */ x, /** @type {any} */ y) => String(x.name).localeCompare(String(y.name)))
					}
				};
			},
			[uuids]
		);

		// the premise: the scene really did produce all four construction shapes, or the
		// comparison below is between two descriptions of nothing
		h.check(
			snap.bodies.length === 4 &&
				snap.bodies.some((/** @type {any} */ b) => b.mode === 'kinematic') &&
				snap.bodies.some((/** @type {any} */ b) => b.hull) &&
				snap.world.fixed.length === 1,
			'1.2 (premise) 3 dynamic (one hulled) + 1 kinematic + 1 fixed body were built'
		);
		h.check(
			JSON.stringify(snap.bodies) === JSON.stringify(GOLDEN.bodies),
			'1.3 every body matches the PRE-extraction snapshot (mode/hull/offset/initialQuat/shapeKey/mass/damping/ccd/bodyType/colliders)'
		);
		if (JSON.stringify(snap.bodies) !== JSON.stringify(GOLDEN.bodies)) {
			console.log('  golden:', JSON.stringify(GOLDEN.bodies));
			console.log('  actual:', JSON.stringify(snap.bodies));
		}
		h.check(
			JSON.stringify(snap.world) === JSON.stringify(GOLDEN.world),
			'1.4 the world matches too (ground handle/top, body count, collider owners, beforeStates, fixed set)'
		);
		if (JSON.stringify(snap.world) !== JSON.stringify(GOLDEN.world)) {
			console.log('  golden:', JSON.stringify(GOLDEN.world));
			console.log('  actual:', JSON.stringify(snap.world));
		}
		// the ground handle is compared BY VALUE in queueContact and rapier reuses small
		// integers, so a live handle equal to it would silently swallow that body's impacts
		h.check(
			!snap.world.fixed.some(() => false) && GOLDEN.world.groundHandle === snap.world.groundHandle,
			'1.5 the ground keeps handle ' + snap.world.groundHandle + ' (the aliasing invariant)'
		);
		await page.evaluate(() => window.__stores.physics.stopSimulation());
		await P.ctx.close();
	}

	// ================================================================= section 2
	// Everything below shares one page and one template.
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
	await page.waitForTimeout(2500);

	const template = await page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const b = group.children[group.children.length - 1];
		b.name = 'Crate';
		b.position.set(0, 0.5, 0);
		b.userData.physics = { mode: 'dynamic', mass: 1 };
		window.__stores.objectsGroup.update((v) => v);
		return b.uuid;
	});
	await page.waitForTimeout(900); // /create re-seats AFTER the call returns
	await page.evaluate(
		(uuid) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			group.getObjectByProperty('uuid', uuid).position.set(0, 0.5, 0);
			window.__stores.objectActions.deselectObject();
		},
		template
	);

	console.log('\n=== 2. a spawned copy has a real body, and it falls ===');
	await setGraph(
		page,
		[
			node('key1', 'keypress', { code: 'KeyR', pulse: 0.3 }),
			node('spawn1', 'spawn', { x: 0, y: 4, z: 0, count: 1, maxAlive: 16, interval: 0, spread: 0 }, 200),
			node('sel1', 'objectselector', { selected: template }, 400)
		],
		[edge('key1', 'spawn1', 'trigger'), edge('spawn1', 'sel1')]
	);
	await page.waitForTimeout(700);
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => page.evaluate(() => window.__stores.physics.physicsDebug().length),
		(/** @type {number} */ n) => n > 0,
		'2.1 (premise) the simulation is running'
	);

	await press(page, 'KeyR');
	await page.waitForTimeout(300);
	const firstBatch = await transientOf(page);
	h.check(firstBatch.length === 1, '2.2 one press makes exactly one copy (' + firstBatch.length + ')');

	const spawnedUuid = firstBatch[0];
	const spawnBody = await page.evaluate(
		(uuid) => window.__stores.physics.physicsDebug().find((/** @type {any} */ b) => b.uuid === uuid),
		spawnedUuid
	);
	h.check(
		spawnBody?.mode === 'dynamic',
		'2.3 the copy has a DYNAMIC body mid-sim (mode=' + (spawnBody?.mode ?? 'none') + ') — before B7 it had none at all'
	);
	// a body in the list is not the same claim as a body that is SIMULATED, and the
	// listing is exactly what would still pass if the body were never stepped
	const yAt = (/** @type {string} */ uuid) =>
		page.evaluate((uuid) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			return group.getObjectByProperty('uuid', uuid)?.position.y ?? null;
		}, uuid);
	const spawnY0 = await yAt(spawnedUuid);
	await h.eventually(
		() => yAt(spawnedUuid),
		(/** @type {number} */ y) => y !== null && y < spawnY0 - 0.5,
		'2.4 it FALLS (from y=' + (spawnY0 ?? 0).toFixed(2) + ')'
	);
	const spawnY1 = await yAt(spawnedUuid);
	console.log('    fell ' + (spawnY0 - spawnY1).toFixed(2) + 'm');
	h.check(
		await page.evaluate(
			(uuid) => {
				let group = null;
				window.__stores.objectsGroup.subscribe((v) => (group = v))();
				return !!group.getObjectByProperty('uuid', uuid)?.userData?.transient;
			},
			spawnedUuid
		),
		'2.5 the copy is marked transient'
	);
	// `?? null` on the way out of the page, because `undefined` does not survive the
	// bridge — the first version compared against `undefined` and could never pass
	h.check(
		(await page.evaluate(
			(uuid) => {
				let group = null;
				window.__stores.objectsGroup.subscribe((v) => (group = v))();
				return group.getObjectByProperty('uuid', uuid)?.userData?.transient ?? null;
			},
			template
		)) === null,
		'2.6 ...and the TEMPLATE is not (a spawner must not delete its own source)'
	);

	// ================================================================= section 3
	console.log('\n=== 3. 40 fires against maxAlive 16 ===');
	const undoBefore = await undoDepth(page);
	/** @type {string[]} */
	let firstFive = [];
	for (let i = 0; i < 40; i++) {
		await press(page, 'KeyR');
		if (i === 3) firstFive = await transientOf(page);
	}
	await page.waitForTimeout(400);
	const alive = await transientOf(page);
	h.check(alive.length === 16, '3.1 exactly 16 alive after 40 fires (' + alive.length + ')');
	h.check(
		firstFive.length >= 4 && firstFive.every((u) => !alive.includes(u)),
		'3.2 the OLDEST were recycled — none of the first ' + firstFive.length + ' survives'
	);
	const spawnerState = await page.evaluate(() => window.__stores.spawner.spawnerDebug());
	h.check(
		spawnerState.nodes.length === 1 &&
			spawnerState.nodes[0].alive.length === 16 &&
			spawnerState.nodes[0].alive.every((/** @type {string} */ u) => alive.includes(u)),
		'3.3 the spawner list agrees with the scene (no drifting second source of truth)'
	);
	const aliveBodies = await page.evaluate(
		(uuids) => {
			const debug = window.__stores.physics.physicsDebug();
			return uuids.filter(
				(/** @type {string} */ u) => debug.find((/** @type {any} */ b) => b.uuid === u)?.mode === 'dynamic'
			).length;
		},
		alive
	);
	h.check(aliveBodies === 16, '3.4 every survivor has a dynamic body (' + aliveBodies + '/16)');
	const undoAfter = await undoDepth(page);
	h.check(
		undoAfter === undoBefore,
		'3.5 41 spawns recorded ZERO undo entries (' + undoBefore + ' -> ' + undoAfter + ')'
	);

	// ================================================================= section 4
	console.log('\n=== 4. mid-run saves carry none of it ===');
	const payload = await page.evaluate(() => {
		const p = window.__stores.sessions.buildSessionPayload('mid-run');
		return { count: p.count, objects: p.objects.length, names: p.objects.map((/** @type {any} */ o) => o.object?.name) };
	});
	h.check(
		payload.objects === 1 && payload.count === 1,
		'4.1 buildSessionPayload writes 1 object, not 17 (objects=' + payload.objects + ' count=' + payload.count + ')'
	);
	h.check(
		payload.names.includes('Crate') && !payload.names.some((/** @type {string} */ n) => /copy/.test(n ?? '')),
		'4.2 the TEMPLATE is saved and no copy is'
	);
	h.check(
		(await transientOf(page)).length === 16,
		'4.3 ...and the save left the live copies alone'
	);

	await page.evaluate(() => window.__stores.autosave.saveNow());
	await page.waitForTimeout(1200);
	const snapshot = await page.evaluate(async () => {
		const snap = await window.__stores.idb.idbGet('latest');
		const nodes = snap?.scene?.nodes ?? [];
		return {
			objects: snap?.objects ?? null,
			nodeNames: nodes.map((/** @type {any} */ n) => n.name).filter(Boolean)
		};
	});
	h.check(
		snapshot.nodeNames.includes('Crate'),
		'4.4 (premise) the autosave GLTF really holds the template'
	);
	h.check(
		!snapshot.nodeNames.some((/** @type {string} */ n) => /copy/.test(n)),
		'4.5 the autosave holds no copy either (' + snapshot.nodeNames.length + ' named nodes)'
	);
	h.check(
		snapshot.objects === 1,
		'4.6 the snapshot object COUNT agrees with what it holds (' + snapshot.objects + ')'
	);
	h.check(
		(await transientOf(page)).length === 16,
		'4.7 the export PARKED and restored them — all 16 still in the scene'
	);

	// ================================================================= section 5
	console.log('\n=== 5. two peers: the same copies, and they leave together ===');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await page.waitForTimeout(1500);
	await press(page, 'KeyR'); // one more, so B witnesses a live spawn as well
	await page.waitForTimeout(1200);

	const aUuids = (await transientOf(page)).slice().sort();
	await h.eventually(
		async () => (await transientOf(B.page)).length,
		(/** @type {number} */ n) => n === 16,
		'5.1 B holds 16 transient copies'
	);
	const bUuids = (await transientOf(B.page)).slice().sort();
	h.check(
		JSON.stringify(aUuids) === JSON.stringify(bUuids),
		'5.2 the SAME 16 uuids on both peers (no new message type — the ordinary `duplicate`)'
	);
	h.check(
		(await undoDepth(B.page)) === 0,
		'5.3 B recorded no undo entry for any of them'
	);
	const bPayload = await B.page.evaluate(
		() => window.__stores.sessions.buildSessionPayload('peer').objects.length
	);
	h.check(
		bPayload === 1,
		'5.4 a save on B would carry 1 object too — the transient flag replicated (' + bPayload + ')'
	);

	// ================================================================= section 6
	console.log('\n=== 6. stopping the run takes them all with it ===');
	const undoPreStop = await undoDepth(page);
	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await page.waitForTimeout(600);
	h.check((await transientOf(page)).length === 0, '6.1 no transient object left on A');
	await h.eventually(
		async () => (await transientOf(B.page)).length,
		(/** @type {number} */ n) => n === 0,
		'6.2 ...nor on B (the ordinary `delete`, so a peer needs to know nothing about transience)'
	);
	const namesAfter = await childNames(page);
	h.check(
		namesAfter.length === 1 && namesAfter[0] === 'Crate',
		'6.3 the scene is back to its one template (' + JSON.stringify(namesAfter) + ')'
	);
	// stopSimulation legitimately records ONE transformSet — "Ctrl+Z restores the initial
	// layout" — and the template moved during the run, so the depth is expected to go up
	// by one. The claim is that the entry knows nothing about the SEVENTEEN copies: half a
	// lifecycle on the stack would resurrect bodiless crates.
	const undoPostStop = await undoDepth(page);
	const topEntry = await page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.history.undoStack.subscribe((/** @type {any[]} */ s) => {
					const top = s[s.length - 1];
					r({ kind: top?.kind ?? null, items: top?.items?.length ?? null });
				})()
			)
	);
	h.check(
		undoPostStop - undoPreStop <= 1 && topEntry.kind === 'transformSet' && topEntry.items === 1,
		'6.4 the sweep put nothing on the stack — the one entry (' +
			undoPreStop +
			' -> ' +
			undoPostStop +
			') is the layout restore, and it names ' +
			topEntry.items +
			' object, not 17'
	);
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(400);
	h.check(
		(await childNames(page)).includes('Crate'),
		'6.5 one Ctrl+Z does not bring a crate back (the template survives it)'
	);
	await B.ctx.close();

	// ================================================================= section 7
	console.log('\n=== 7. the guards ===');
	// a fresh Spawn node must not adopt a stamp older than itself — the 21-E trap, which
	// here would mean crates raining down the moment a graph is wired or a peer connects
	await setGraph(page, [node('key2', 'keypress', { code: 'KeyT', pulse: 0.3 })], []);
	await page.waitForTimeout(500);
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => page.evaluate(() => window.__stores.physics.physicsDebug().length),
		(/** @type {number} */ n) => n > 0,
		'7.1 (premise) the simulation is running again'
	);
	await press(page, 'KeyT'); // pulse FIRST, with no spawn node in the graph
	await page.waitForTimeout(700);
	await setGraph(
		page,
		[
			node('key2', 'keypress', { code: 'KeyT', pulse: 0.3 }),
			node('spawn2', 'spawn', { x: 0, y: 4, z: 0, count: 1, maxAlive: 8, interval: 0 }, 200),
			node('sel2', 'objectselector', { selected: template }, 400)
		],
		[edge('key2', 'spawn2', 'trigger'), edge('spawn2', 'sel2')]
	);
	await page.waitForTimeout(1500);
	h.check(
		(await transientOf(page)).length === 0,
		'7.2 wiring a fresh Spawn to an already-pulsed trigger spawns NOTHING (the stale-stamp guard)'
	);
	await press(page, 'KeyT');
	await page.waitForTimeout(400);
	h.check((await transientOf(page)).length === 1, '7.3 ...and the NEXT real press does spawn');

	// count is an authored param, so it is clamped again where it is used
	await page.evaluate(() =>
		window.__stores.nodesHandler.setNodeData('spawn2', { count: 500, maxAlive: 200 })
	);
	await page.waitForTimeout(500);
	const beforeBig = (await transientOf(page)).length;
	await press(page, 'KeyT');
	await page.waitForTimeout(600);
	const afterBig = (await transientOf(page)).length;
	h.check(
		afterBig - beforeBig <= 20 && afterBig - beforeBig > 1,
		'7.4 count:500 makes at most 20 copies in one fire (' + (afterBig - beforeBig) + ')'
	);

	// the rate limit. The wait is load-bearing: the previous section just fired this very
	// node, so without letting the interval elapse the FIRST press is refused too and the
	// check reads 0 for the right reason and the wrong measurement.
	const beforeRate = (await transientOf(page)).length;
	await page.evaluate(() => window.__stores.nodesHandler.setNodeData('spawn2', { count: 1, interval: 2 }));
	await page.waitForTimeout(2400);
	await press(page, 'KeyT');
	await press(page, 'KeyT');
	await press(page, 'KeyT');
	await page.waitForTimeout(400);
	h.check(
		(await transientOf(page)).length - beforeRate === 1,
		'7.5 interval:2s lets one of three quick presses through (' +
			((await transientOf(page)).length - beforeRate) +
			')'
	);

	// a spawn with nothing simulating would make an INERT object — the exact failure B7
	// removes — so it must refuse and say why rather than quietly littering the scene
	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await page.waitForTimeout(500);
	await page.evaluate(() => window.__stores.toastStore.set([]));
	const preInert = (await childNames(page)).length;
	await press(page, 'KeyT');
	await page.waitForTimeout(800);
	h.check(
		(await childNames(page)).length === preInert,
		'7.6 with no simulation running, nothing is spawned'
	);
	const toasts = await page.evaluate(() => {
		let list = [];
		window.__stores.toastStore.subscribe((/** @type {any[]} */ v) => (list = v))();
		return list.map((/** @type {any} */ t) => String(t?.message ?? t?.text ?? t));
	});
	h.check(
		toasts.some((/** @type {string} */ t) => /no simulation is running/i.test(t)),
		'7.7 ...and it says so instead of failing silently'
	);

	// the two registries: a type in the catalog and not in Nodes.svelte's map renders as
	// "this node comes from a module that isn't installed". `__flowNodeTypes` only exists
	// while the pane is MOUNTED, and the real opener is the only thing that mounts it —
	// activateDock alone leaves `.svelte-flow` absent.
	await page.click('p[title="Node editor (N)"]');
	await page.waitForSelector('.svelte-flow', { timeout: 15000 });
	await page.waitForTimeout(600);
	const registries = await page.evaluate(() => {
		const spec = window.__stores.nodeCatalog.findNodeSpec('spawn');
		return {
			inCatalog: !!spec,
			note: spec?.note ?? null,
			inputs: spec?.inputs ?? [],
			renderable: (window.__flowNodeTypes?.live?.() ?? []).includes('spawn'),
			outputType: window.__stores.flowSockets.outputType
				? window.__stores.flowSockets.outputType('spawn')
				: null
		};
	});
	h.check(registries.inCatalog, '7.8 `spawn` is in nodeCatalog');
	h.check(
		registries.renderable,
		'7.9 ...and resolves to a real card in Nodes.svelte (the two-registry rule)'
	);
	h.check(
		JSON.stringify(registries.inputs) === JSON.stringify(['trigger', 'at', 'source']),
		'7.10 its named sockets are trigger/at/source (' + JSON.stringify(registries.inputs) + ')'
	);
	h.check(
		!!registries.note && /only while the simulation runs/i.test(registries.note),
		'7.11 the card SAYS the copies are not saved and who spawns them'
	);

	await h.finish(browser);
});
