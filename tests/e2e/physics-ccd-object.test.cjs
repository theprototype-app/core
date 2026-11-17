// 49 P1: per-object CONTINUOUS COLLISION (Inspector ▸ Physics ▸ Continuous collision:
// Scene default / On / Off). A 0.05 m ball fired at 60 m/s (Set Velocity's path, which —
// unlike a throw — never turns CCD on by itself) moves a metre per step and passes through
// a 4 cm wall with the scene default (CCD off): that is the counterfactual, measured in the
// same run. Picking On in the real Inspector stops it, on this peer and on a PEER that runs
// the simulation (the pick replicates), and a mid-run pick takes effect without a restart.
// Off beats a scene that has CCD on. Scene default writes NO key, so an old scene saves as
// it did. Red on v1.39.0: there is no row and no per-body CCD.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__tp.test.v1.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const ids = await A.page.evaluate(() => {
		const s = window.__tp?.test.v1;
		const cmd = s.commandsHandler.sceneCommand;
		cmd('/create Box 3 3 0.04');
		cmd('/create Sphere 0.05');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const [wall, ball] = g.children.slice(-2);
		wall.name = 'Thin wall';
		ball.name = 'Bullet';
		s.physics.setPhysicsFor(wall.uuid, { mode: 'static' });
		s.physics.setPhysicsFor(ball.uuid, { mode: 'dynamic', mass: 0.1, collider: 'sphere', restitution: 0 });
		return { wall: wall.uuid, ball: ball.uuid };
	});
	await h.eventually(
		() => B.page.evaluate((u) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			return g.getObjectByProperty('uuid', u.ball)?.userData?.physics?.mode ?? null;
		}, ids),
		(m) => m === 'dynamic',
		'premise: the peer holds the wall and the ball',
		15000
	);

	/** put the wall at z 0 and the ball 2.37 m in front of it, on a page (no broadcast) */
	const place = (page) =>
		page.evaluate((u) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			const wall = g.getObjectByProperty('uuid', u.wall);
			const ball = g.getObjectByProperty('uuid', u.ball);
			wall.position.set(0, 1.5, 0);
			ball.position.set(0, 1.5, -2.37); // z steps of 1 m never land inside the wall
			ball.quaternion.set(0, 0, 0, 1);
			wall.updateMatrixWorld(true);
			ball.updateMatrixWorld(true);
		}, ids);
	const simOn = (page) => page.evaluate(() => new Promise((r) => window.__tp.test.v1.physics.simulating.subscribe(r)()));
	/** start a run on `page`, fire the ball at 60 m/s, return {z, ccd} after it has flown */
	const fire = async (page, label, { stop = true, beforeFire = null } = {}) => {
		if (!(await simOn(page))) await page.evaluate(() => window.__tp.test.v1.physics.toggleSimulation());
		await h.eventually(
			() => page.evaluate((u) => window.__tp.test.v1.physics.physicsDebug().some((e) => e.uuid === u.ball), ids),
			(v) => v,
			`${label}: the ball has a body`,
			15000
		);
		if (beforeFire) await beforeFire();
		const ok = await page.evaluate((u) => window.__tp.test.v1.physics.setBodyVelocity(u.ball, [0, 0, 60], [0, 0, 0]), ids);
		await page.waitForTimeout(400);
		const out = await page.evaluate((u) => {
			const e = window.__tp.test.v1.physics.physicsDebug().find((x) => x.uuid === u.ball);
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			return { z: g.getObjectByProperty('uuid', u.ball).position.z, ccd: e?.ccd ?? null };
		}, ids);
		out.fired = ok;
		if (stop) await page.evaluate(() => window.__tp.test.v1.physics.stopSimulation({ reset: true }));
		return out;
	};
	const readCcd = (page) =>
		page.evaluate((u) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			const p = g.getObjectByProperty('uuid', u.ball)?.userData?.physics;
			return p ? ('ccd' in p ? p.ccd : 'absent') : null;
		}, ids);

	// 1) the counterfactual: scene default (off) — the ball tunnels
	const sceneCcd = await A.page.evaluate(() => {
		let d;
		window.__tp.test.v1.scenePhysics.scenePhysicsDefaults.subscribe((v) => (d = v))();
		return d.ccd;
	});
	h.check(sceneCcd === false, `premise: the scene default is CCD off (${sceneCcd})`);
	await place(A.page);
	const tunnel = await fire(A.page, 'scene default');
	h.check(tunnel.fired && tunnel.ccd === false, `premise: fired with CCD off (${JSON.stringify(tunnel)})`);
	h.check(tunnel.z > 0.3, `COUNTERFACTUAL: with the scene default the ball passes through the 4 cm wall (z ${tunnel.z.toFixed(2)})`);

	// 2) the real Inspector row
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u.ball, true), ids);
	await h.eventually(() => A.page.evaluate(() => !!document.querySelector('#physics-object-ccd')), (v) => v, 'the Continuous collision row renders for a dynamic body', 15000);
	const opts = await A.page.evaluate(async () => {
		const sel = document.querySelector('#physics-object-ccd');
		const label = sel.textContent.trim();
		sel.click();
		await new Promise((r) => setTimeout(r, 250));
		const list = [...document.querySelectorAll('.ts-list .ts-opt')];
		const names = list.map((o) => o.textContent.trim());
		list.find((o) => o.textContent.trim() === 'On')?.click();
		await new Promise((r) => setTimeout(r, 300));
		return { label, names, after: document.querySelector('#physics-object-ccd')?.textContent.trim() };
	});
	h.check(/Scene default \(off\)/.test(opts.label), `the row starts on "Scene default (off)" (${opts.label})`);
	h.check(['On', 'Off'].every((n) => opts.names.includes(n)) && opts.names.length === 3, `three choices (${JSON.stringify(opts.names)})`);
	h.check(/^On\b/.test(opts.after ?? ''), `picking On shows On (${opts.after})`);
	h.check((await readCcd(A.page)) === true, 'the pick is saved on the object (userData.physics.ccd = true)');
	await h.eventually(() => readCcd(B.page), (v) => v === true, 'the pick replicates to the peer', 10000);
	await A.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());

	// 3) On stops the ball at the wall
	await place(A.page);
	const stopped = await fire(A.page, 'ccd on');
	h.check(stopped.ccd === true, `the body runs with CCD (${stopped.ccd})`);
	h.check(stopped.z < 0, `with Continuous collision On the ball stops at the wall (z ${stopped.z.toFixed(2)})`);

	// 4) a PEER simulating reads the same pick from the replicated object
	await place(A.page);
	await place(B.page);
	const peer = await fire(B.page, 'peer run', { stop: false });
	h.check(peer.ccd === true && peer.z < 0, `the peer's own run stops the ball too (z ${peer.z.toFixed(2)}, ccd ${peer.ccd})`);
	await h.eventually(
		() => A.page.evaluate((u) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			return g.getObjectByProperty('uuid', u.ball).position.z;
		}, ids),
		(z) => z < 0 && z > -2.3,
		'the first peer sees the ball stopped at the wall through the move stream',
		8000
	);
	await B.page.evaluate(() => window.__tp.test.v1.physics.stopSimulation({ reset: true }));
	await A.page.waitForTimeout(1500);

	// 5) back to Scene default mid-run: the live body drops CCD with no restart (and tunnels)
	await place(A.page);
	const live = await fire(A.page, 'live pick', {
		beforeFire: () =>
			A.page.evaluate((u) => window.__tp.test.v1.physics.setPhysicsFor(u.ball, { ccd: null }), ids)
	});
	h.check(live.ccd === false && live.z > 0.3, `a mid-run pick reaches the live body: Scene default tunnels again (z ${live.z.toFixed(2)}, ccd ${live.ccd})`);
	h.check((await readCcd(A.page)) === 'absent', 'Scene default writes NO key — an untouched scene saves byte-identical');

	// 6) Off beats a scene that has CCD on
	await A.page.evaluate((u) => {
		window.__tp.test.v1.scenePhysics.setScenePhysics({ ccd: true });
		window.__tp.test.v1.physics.setPhysicsFor(u.ball, { ccd: false });
	}, ids);
	await place(A.page);
	const off = await fire(A.page, 'ccd off');
	h.check(off.ccd === false && off.z > 0.3, `Off wins over the scene's CCD on: the ball tunnels (z ${off.z.toFixed(2)}, ccd ${off.ccd})`);
	await A.page.evaluate((u) => window.__tp.test.v1.physics.setPhysicsFor(u.ball, { ccd: null }), ids);
	await place(A.page);
	const sceneOn = await fire(A.page, 'scene on');
	h.check(sceneOn.ccd === true && sceneOn.z < 0, `and Scene default follows the scene's On (z ${sceneOn.z.toFixed(2)})`);

	await h.finish(browser);
});
