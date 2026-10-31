// fix-batch-1 #14: On Impact fires on a hit from ANY side, not only on a landing. A ball rolled
// sideways into a STATIC wall and a KINEMATIC (flow-animated) target fires its own On Impact
// and theirs (other = the ball) — up to 1.43 the rule was "pre-step downward velocity ≥ 1.2
// m/s", so neither fired. Old scenes keep behaving: a node saved WITHOUT `direction` and one
// set to 'down' stay quiet on the sideways hits and still fire on a landing. Every fire is
// counted from the trigger log. Red on origin/feat/52 (4cd3dafc): the 'any' nodes never fire
// on the wall/target hit. EVIDENCE_DIR for the log line.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));

	const spec = await A.page.evaluate(async () => {
		const cat = await window.__stores.nodeCatalog;
		const s = (cat.findNodeSpec ?? cat.default?.findNodeSpec)?.('onimpact');
		return {
			defaults: s?.defaults ?? null,
			direction: s?.params?.find((p) => p.key === 'direction') ?? null
		};
	});
	h.check(
		spec.defaults?.direction === 'any',
		`a NEW On Impact node is seeded direction 'any' (${JSON.stringify(spec.defaults)})`
	);
	h.check(
		spec.direction?.legacy === 'down',
		`the Flow panel reads a node saved without it as 'down' (${JSON.stringify(spec.direction)})`
	);

	const ids = await A.page.evaluate(() => {
		const s = window.__stores;
		const cmd = s.commandsHandler.sceneCommand;
		cmd('/create Box 0.4 2 3'); // wall (static)
		cmd('/create Box 0.4 1 1.2'); // target (kinematic: a slow Spin animates it)
		cmd('/create Sphere 0.2'); // ballW -> rolled into the wall
		cmd('/create Sphere 0.2'); // ballT -> rolled into the target
		cmd('/create Sphere 0.2'); // ballD -> dropped onto the ground (the landing control)
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const [wall, target, ballW, ballT, ballD] = g.children.slice(-5);
		const place = (o, name, x, y, z, physics) => {
			o.name = name;
			o.position.set(x, y, z);
			o.updateMatrixWorld(true);
			if (physics) s.physics.setPhysicsFor(o.uuid, physics);
		};
		// restitution 0: a bounce would hit a second time, and this suite counts hits
		const ball = { mode: 'dynamic', mass: 1, collider: 'sphere', restitution: 0 };
		place(wall, 'Wall', 3, 1, 0, { mode: 'static', restitution: 0 });
		place(target, 'Target', 3, 0.5, 6, { mode: 'auto', mass: undefined, restitution: 0 }); // /create stamps dynamic
		place(ballW, 'Ball to wall', 0, 0.2, 0, ball);
		place(ballT, 'Ball to target', 0, 0.2, 6, ball);
		place(ballD, 'Ball dropped', -6, 3, 0, ball);
		window.__fx = { wall, target, ballW, ballT, ballD };
		return Object.fromEntries(Object.entries(window.__fx).map(([k, o]) => [k, o.uuid]));
	});

	await A.page.evaluate((u) => {
		const sel = (id, uuid, y) => ({
			id,
			type: 'objectselector',
			position: { x: 300, y },
			data: { label: 'Object', selected: uuid }
		});
		// direction: 'any' | 'down' | undefined (= a node saved before the option existed)
		const imp = (id, y, direction) => ({
			id,
			type: 'onimpact',
			position: { x: 0, y },
			data: {
				label: 'On Impact',
				pulse: 0.3,
				minStrength: 0.5,
				...(direction ? { direction } : {})
			}
		});
		const rows = [
			['impWallAny', u.wall, 'any'],
			['impWallOld', u.wall, undefined],
			['impTargetAny', u.target, 'any'],
			['impTargetDown', u.target, 'down'],
			['impBallWAny', u.ballW, 'any'],
			['impBallWOld', u.ballW, undefined],
			['impBallWDown', u.ballW, 'down'],
			['impBallTAny', u.ballT, 'any'],
			['impBallDAny', u.ballD, 'any'],
			['impBallDOld', u.ballD, undefined]
		];
		const nodes = [];
		const edges = [];
		rows.forEach(([id, uuid, dir], i) => {
			nodes.push(imp(id, i * 140, dir), sel('s' + id, uuid, i * 140));
			edges.push({ id: `e-${id}-s${id}`, source: id, target: 's' + id });
		});
		// a slow Spin makes the target flow-animated -> a KINEMATIC body for the run
		nodes.push({
			id: 'spin1',
			type: 'spin',
			position: { x: 0, y: 1600 },
			data: { label: 'Spin', speed: 0.02, axis: 'y' }
		});
		nodes.push(sel('sSpin', u.target, 1600));
		edges.push({ id: 'e-spin1-sSpin', source: 'spin1', target: 'sSpin' });
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set(edges);
		// count every fire WITH what it hit: the trigger log keeps only the latest stamp per
		// node, and `other` is set just before the stamp (fireContact). A rolling ball that
		// hits a wall can climb it on its spin and LAND again — a real landing (other = the
		// ground), which a 'down' node rightly fires on; the claims below are about the hit
		window.__fires = {};
		const fr = window.__stores.flowRuntime;
		window.__stores.flowTriggers.subscribe((log) => {
			for (const [id, e] of Object.entries(log ?? {})) {
				if (!id.startsWith('imp')) continue;
				const seen = (window.__fires[id] ??= []);
				if (typeof e?.lastT === 'number' && seen[seen.length - 1]?.t !== e.lastT)
					seen.push({ t: e.lastT, other: fr.contactOtherOf(id) });
			}
		});
	}, ids);
	await A.page.waitForTimeout(600);

	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	// the dropped ball lands; the rolling balls settle on the ground first
	await h.eventually(
		() => A.page.evaluate(() => window.__fx.ballD.position.y),
		(y) => y < 0.25,
		'premise: the dropped ball lands on the ground',
		15000
	);
	await A.page.waitForTimeout(400);
	const beforeRoll = await A.page.evaluate(() => JSON.parse(JSON.stringify(window.__fires)));
	const n0 = (id) => beforeRoll[id]?.length ?? 0;
	h.check(
		n0('impBallWAny') + n0('impBallTAny') + n0('impWallAny') + n0('impTargetAny') === 0,
		`premise: nothing fired on the resting balls or the wall before the roll (${JSON.stringify(beforeRoll)})`
	);

	const pushed = await A.page.evaluate(() => {
		const p = window.__stores.physics;
		return [
			p.setBodyVelocity(window.__fx.ballW.uuid, [6, 0, 0], null),
			p.setBodyVelocity(window.__fx.ballT.uuid, [6, 0, 0], null)
		];
	});
	h.check(pushed[0] && pushed[1], `premise: both balls were rolled sideways at 6 m/s (${pushed})`);
	await h.eventually(
		() => A.page.evaluate(() => [window.__fx.ballW.position.x, window.__fx.ballT.position.x]),
		(xs) => xs[0] > 2.4 && xs[1] > 2.4,
		'premise: each ball reached its wall / target',
		10000
	);
	await A.page.waitForTimeout(800);

	const r = await A.page.evaluate(() => {
		const kinds = Object.fromEntries(
			window.__stores.physics.physicsDebug().map((e) => [e.uuid, e.mode])
		);
		return {
			fires: window.__fires,
			targetMode: kinds[window.__fx.target.uuid] ?? null,
			ballWx: window.__fx.ballW.position.x
		};
	});
	console.log('fires', JSON.stringify(r));
	const f = (id) => r.fires[id] ?? [];
	/** fires of node `id` whose other is `uuid` */
	const hits = (id, uuid) => f(id).filter((e) => e.other === uuid).length;
	h.check(
		r.targetMode === 'kinematic',
		`premise: the target is a kinematic body (${r.targetMode})`
	);
	h.check(
		r.ballWx < 2.85,
		`premise: the ball stopped at the wall, not through it (x ${r.ballWx.toFixed(2)})`
	);
	h.check(
		hits('impBallWAny', ids.wall) === 1,
		`a ball rolled into a wall fires its 'any' On Impact once with other = Wall (${hits('impBallWAny', ids.wall)})`
	);
	h.check(
		hits('impWallAny', ids.ballW) === 1 && f('impWallAny').length === 1,
		`the STATIC wall hit sideways fires its 'any' On Impact once, other = the ball (${f('impWallAny').length})`
	);
	h.check(
		hits('impBallTAny', ids.target) === 1,
		`a ball rolled into a target fires once with other = Target (${hits('impBallTAny', ids.target)})`
	);
	h.check(
		hits('impTargetAny', ids.ballT) === 1 && f('impTargetAny').length === 1,
		`the KINEMATIC target hit sideways fires once, other = the ball (${f('impTargetAny').length})`
	);
	h.check(
		hits('impBallWOld', ids.wall) === 0 && f('impWallOld').length === 0,
		`nodes saved before the option (no direction) stay quiet on the sideways hit (${hits('impBallWOld', ids.wall)}, ${f('impWallOld').length})`
	);
	h.check(
		hits('impBallWDown', ids.wall) === 0 && f('impTargetDown').length === 0,
		`'down' nodes stay quiet on the sideways hit (${hits('impBallWDown', ids.wall)}, ${f('impTargetDown').length})`
	);
	h.check(
		f('impBallDOld').length === 1 && hits('impBallDOld', '') === 1,
		`a legacy node still fires once on a landing, other = the ground (${f('impBallDOld').length})`
	);
	h.check(
		f('impBallDAny').length === 1,
		`an 'any' node fires once on a landing too (${f('impBallDAny').length})`
	);

	await A.page.evaluate(() => window.__stores.physics.stopSimulation({ reset: true }));
	await h.finish(browser);
});
