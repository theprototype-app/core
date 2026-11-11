// 49 P2: On Impact fires on the body that was HIT too, when that body cannot register an
// impact for itself — a STATIC plate and a KINEMATIC (flow-animated) platform each get the
// event with `other` = the ball that landed on them. A DYNAMIC body that is landed on keeps
// its own rule (it is not falling, so it does not fire), which is what keeps two dynamic
// bodies from firing twice for one contact. Every fire is counted from the trigger log, so
// "once" is measured rather than assumed. Red on v1.39.0: the plate and the platform never
// fire. EVIDENCE_DIR for the log line.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__tp.test.v1.physics.warmup().catch(() => {}));

	const ids = await A.page.evaluate(() => {
		const s = window.__tp?.test.v1;
		const cmd = s.commandsHandler.sceneCommand;
		cmd('/create Box 2 0.2 2'); // plate (static)
		cmd('/create Box 2 0.2 2'); // platform (kinematic: a Spin node animates it)
		cmd('/create Box 0.8 0.8 0.8'); // crate (dynamic, resting on the ground)
		cmd('/create Sphere 0.2'); // ballP -> plate
		cmd('/create Sphere 0.2'); // ballK -> platform
		cmd('/create Sphere 0.2'); // ballC -> crate
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const [plate, platform, crate, ballP, ballK, ballC] = g.children.slice(-6);
		const place = (o, name, x, y, z, physics) => {
			o.name = name;
			o.position.set(x, y, z);
			o.updateMatrixWorld(true);
			if (physics) s.physics.setPhysicsFor(o.uuid, physics);
		};
		// restitution 0: a bounce would land a second time, and this suite counts landings
		const ball = { mode: 'dynamic', mass: 1, collider: 'sphere', restitution: 0 };
		place(plate, 'Plate', 0, 0.1, 0, { mode: 'static', restitution: 0 });
		place(platform, 'Platform', 5, 0.6, 0, { mode: 'auto', mass: undefined, restitution: 0 }); // /create stamps dynamic
		place(crate, 'Crate', -5, 0.4, 0, { mode: 'dynamic', mass: 1, restitution: 0 });
		place(ballP, 'Ball on plate', 0, 3, 0, ball);
		place(ballK, 'Ball on platform', 5, 3.5, 0, ball);
		place(ballC, 'Ball on crate', -5, 3.5, 0, ball);
		window.__p2 = { plate, platform, crate, ballP, ballK, ballC };
		return Object.fromEntries(Object.entries(window.__p2).map(([k, o]) => [k, o.uuid]));
	});

	await A.page.evaluate((u) => {
		const sel = (id, uuid, x, y) => ({ id, type: 'objectselector', position: { x, y }, data: { label: 'Object', selected: uuid } });
		const imp = (id, y) => ({ id, type: 'onimpact', position: { x: 0, y }, data: { label: 'On Impact', pulse: 0.3, minStrength: 0.5 } });
		const nodes = [
			imp('impPlate', 0), sel('sPlate', u.plate, 300, 0),
			imp('impPlatform', 160), sel('sPlatform', u.platform, 300, 160),
			imp('impCrate', 320), sel('sCrate', u.crate, 300, 320),
			imp('impBallP', 480), sel('sBallP', u.ballP, 300, 480),
			imp('impBallK', 640), sel('sBallK', u.ballK, 300, 640),
			imp('impBallC', 800), sel('sBallC', u.ballC, 300, 800),
			// a slow Spin makes the platform flow-animated -> a KINEMATIC body for the run
			{ id: 'spin1', type: 'spin', position: { x: 0, y: 960 }, data: { label: 'Spin', speed: 0.05, axis: 'y' } },
			sel('sSpin', u.platform, 300, 960)
		];
		const edges = ['Plate', 'Platform', 'Crate', 'BallP', 'BallK', 'BallC', 'Spin'].map((k) => ({
			id: `e-${k === 'Spin' ? 'spin1' : 'imp' + k}-s${k}`,
			source: k === 'Spin' ? 'spin1' : 'imp' + k,
			target: 's' + k
		}));
		window.__tp.test.v1.flowNodes.set(nodes);
		window.__tp.test.v1.flowEdges.set(edges);
		// count every fire: the trigger log keeps only the latest stamp per node
		window.__fires = {};
		window.__tp.test.v1.flowTriggers.subscribe((log) => {
			for (const [id, e] of Object.entries(log ?? {})) {
				if (!id.startsWith('imp')) continue;
				const seen = (window.__fires[id] ??= []);
				if (typeof e?.lastT === 'number' && seen[seen.length - 1] !== e.lastT) seen.push(e.lastT);
			}
		});
	}, ids);
	await A.page.waitForTimeout(600);

	await A.page.evaluate(() => window.__tp.test.v1.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => {
			const { ballP, ballK, ballC } = window.__p2;
			return [ballP.position.y, ballK.position.y, ballC.position.y];
		}),
		(ys) => ys[0] < 0.45 && ys[0] > 0.2 && ys[1] < 0.95 && ys[1] > 0.7 && ys[2] < 1.15 && ys[2] > 0.9,
		'premise: each ball rests on what it fell onto (plate, platform, crate)',
		20000
	);
	await A.page.waitForTimeout(800);

	const r = await A.page.evaluate(() => {
		const fr = window.__tp.test.v1.flowRuntime;
		const n = (id) => window.__fires[id]?.length ?? 0;
		const kinds = Object.fromEntries(window.__tp.test.v1.physics.physicsDebug().map((e) => [e.uuid, e.mode]));
		return {
			plate: n('impPlate'), platform: n('impPlatform'), crate: n('impCrate'),
			ballP: n('impBallP'), ballK: n('impBallK'), ballC: n('impBallC'),
			otherPlate: fr.contactOtherOf('impPlate'), otherPlatform: fr.contactOtherOf('impPlatform'),
			otherBallP: fr.contactOtherOf('impBallP'), otherBallC: fr.contactOtherOf('impBallC'),
			platformMode: kinds[window.__p2.platform.uuid] ?? null,
			crateMode: kinds[window.__p2.crate.uuid] ?? null
		};
	});
	console.log('fires', JSON.stringify(r));
	h.check(r.platformMode === 'kinematic' && r.crateMode === 'dynamic', `premise: the platform is kinematic, the crate dynamic (${r.platformMode}, ${r.crateMode})`);
	h.check(r.ballP === 1 && r.otherBallP === ids.plate, `the falling ball fires its own On Impact once, other = Plate (${r.ballP})`);
	h.check(r.plate === 1, `the STATIC plate fires On Impact once (${r.plate})`);
	h.check(r.otherPlate === ids.ballP, `the plate's other = the ball that hit it (${r.otherPlate === ids.ballP ? 'ball' : r.otherPlate})`);
	h.check(r.platform === 1 && r.otherPlatform === ids.ballK, `the KINEMATIC platform fires once, other = its ball (${r.platform})`);
	h.check(r.ballC === 1 && r.otherBallC === ids.crate, `the ball landing on the crate fires once, other = Crate (${r.ballC})`);
	h.check(r.crate === 0, `the DYNAMIC crate that was landed on does not fire — no double event (${r.crate})`);

	await A.page.evaluate(() => window.__tp.test.v1.physics.stopSimulation({ reset: true }));
	await h.finish(browser);
});
