// 36 X5: collision groups in the real app — the Inspector's Group / Collides-with
// chips write userData.physics (replicated to a peer), the running world honours
// them (a wall that leaves a group out lets that group's ball through; the same
// ball in Default is stopped — the counterfactual), a mid-sim group change
// rebuilds live, and a W1 water volume is a pass-through Water/trigger by default
// (a ball falls INTO it; the same box without userData.water catches it).
const h = require('./helpers.cjs');

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
	await h.connect(B, A);

	// a wall across z = 0 and a ball 3 m in front of it
	await A.page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Box 4 3 0.2');
		cmd('/create Sphere 0.2');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__wall = g.children[g.children.length - 2];
		window.__ball = g.children[g.children.length - 1];
		window.__wall.position.set(0, 1.5, 0);
		window.__wall.updateMatrixWorld(true);
		window.__park = () => {
			window.__ball.position.set(0, 0.25, -3);
			window.__ball.quaternion.set(0, 0, 0, 1);
			window.__ball.updateMatrixWorld(true);
		};
		window.__park();
		window.__stores.physics.setPhysicsFor(window.__wall.uuid, { mode: 'static' });
		window.__stores.physics.setPhysicsFor(window.__ball.uuid, { mode: 'dynamic', mass: 1, collider: 'sphere' });
	});

	// --- 1) the Inspector chips write group + collides-with, and they replicate
	await A.page.evaluate(() => window.__stores.objectActions.selectObject(window.__wall.uuid, true));
	await h.eventually(
		() => A.page.evaluate(() => !!document.querySelector('#physics-group-row')),
		(v) => v,
		'the Group row renders in Inspector > Physics',
		15000
	);
	const chips = await A.page.evaluate(() => ({
		groups: [...document.querySelectorAll('#physics-group-row [data-group]')].map((b) => b.textContent.trim()),
		pressed: document.querySelector('#physics-group-row [aria-pressed="true"]')?.dataset.group ?? null,
		collides: [...document.querySelectorAll('#physics-collides-row [aria-pressed="true"]')].map((b) => b.dataset.collides)
	}));
	h.check(JSON.stringify(chips.groups) === '["Default","A","B","C","D","Water"]', `group chips (${JSON.stringify(chips.groups)})`);
	h.check(chips.pressed === 'default', `a fresh object is in Default (${chips.pressed})`);
	h.check(chips.collides.length === 7, `and collides with all seven (${chips.collides.join(',')})`);
	await A.page.locator('#physics-group-row [data-group="a"]').click();
	await A.page.locator('#physics-collides-row [data-collides="player"]').click();
	await A.page.waitForTimeout(300);
	const written = await A.page.evaluate(() => window.__wall.userData.physics);
	h.check(written.group === 'a', `clicking A writes group a (${written.group})`);
	h.check(
		JSON.stringify(written.collidesWith) === '["default","a","b","c","d","water"]',
		`unticking Player writes the filter without it (${JSON.stringify(written.collidesWith)})`
	);
	const uuid = await A.page.evaluate(() => window.__wall.uuid);
	await h.eventually(
		() =>
			B.page.evaluate((u) => {
				let g;
				window.__stores.objectsGroup.subscribe((v) => (g = v))();
				const p = g?.getObjectByProperty('uuid', u)?.userData.physics;
				return p ? { group: p.group, cw: p.collidesWith } : null;
			}, uuid),
		(v) => !!v && v.group === 'a' && Array.isArray(v.cw) && !v.cw.includes('player'),
		'the peer receives the group and filter'
	);
	await A.page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.closeSelectionInspector?.();
	});

	// --- sim helpers
	const start = async () => {
		await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
		await h.eventually(
			() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
			(v) => v === true,
			'simulation started'
		);
	};
	const stop = async () => {
		await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
		await A.page.waitForTimeout(400);
		await A.page.evaluate(() => window.__park());
	};
	const roll = () =>
		A.page.evaluate(async () => {
			const p = window.__stores.physics;
			await new Promise((r) => setTimeout(r, 300));
			p.setBodyVelocity(window.__ball.uuid, [0, 0, 4], [0, 0, 0]);
			const t0 = Date.now();
			let still = 0;
			while (Date.now() - t0 < 20000) {
				await new Promise((r) => setTimeout(r, 200));
				const z = window.__ball.position.z;
				if (z > 2) return { z, rest: false };
				const v = p.physicsDebug().find((b) => b.uuid === window.__ball.uuid)?.linvel;
				const speed = v ? Math.hypot(v.x, v.y, v.z) : 0;
				still = Date.now() - t0 > 800 && speed < 0.05 ? still + 1 : 0;
				if (still >= 3) return { z, rest: true };
			}
			return { z: window.__ball.position.z, rest: false };
		});

	// --- 2) the ghost wall (A, everything but Player) still stops a Default ball
	await start();
	const stopped = await roll();
	h.check(stopped.rest && stopped.z < -0.2, `a Default ball is stopped by the ghost wall (${JSON.stringify(stopped)})`);
	await stop();

	// --- 3) a wall that leaves B out lets a group-B ball through; the Default ball (2) is the counterfactual
	await A.page.evaluate(() => {
		window.__stores.physics.setPhysicsFor(window.__wall.uuid, { collidesWith: ['default', 'a', 'c', 'd', 'water', 'player'] });
		window.__stores.physics.setPhysicsFor(window.__ball.uuid, { group: 'b' });
	});
	await start();
	const passed = await roll();
	h.check(passed.z > 2, `a group-B ball passes a wall that leaves B out (z ${passed.z.toFixed(2)})`);

	// --- 4) live: put the ball back in Default MID-SIM — the next roll is stopped
	await A.page.evaluate(() => {
		window.__park(); // a write the deviation check turns into a short kinematic hold
	});
	await A.page.waitForTimeout(600);
	await A.page.evaluate(() => window.__stores.physics.setPhysicsFor(window.__ball.uuid, { group: null }));
	await A.page.waitForTimeout(300);
	const sim = await A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)()));
	h.check(sim === true, 'the simulation kept running through the group change');
	const relive = await roll();
	h.check(relive.rest && relive.z < -0.2, `after the live switch to Default the ball is stopped (${JSON.stringify(relive)})`);
	await stop();

	// --- 5) a W1 water volume is a pass-through Water/trigger by default
	await A.page.evaluate(() => {
		window.__stores.physics.setPhysicsFor(window.__wall.uuid, { group: null, collidesWith: null });
		window.__wall.position.set(20, 1.5, 20); // out of the way
		window.__wall.updateMatrixWorld(true);
		const cmd = window.__stores.commandsHandler.sceneCommand;
		cmd('/create Box 2 1 2');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__tank = g.children[g.children.length - 1];
		window.__tank.name = 'Tank';
		window.__tank.position.set(0, 0.5, 0);
		window.__tank.updateMatrixWorld(true);
		delete window.__tank.userData.physics;
		window.__dropBall = () => {
			window.__ball.position.set(0, 3, 0);
			window.__ball.updateMatrixWorld(true);
		};
		window.__dropBall();
		window.__stores.physics.setPhysicsFor(window.__ball.uuid, { group: null });
	});
	const drop = () =>
		A.page.evaluate(async () => {
			window.__stores.physics.toggleSimulation();
			await new Promise((r) => setTimeout(r, 300));
			const t0 = Date.now();
			let y = window.__ball.position.y;
			while (Date.now() - t0 < 15000) {
				await new Promise((r) => setTimeout(r, 250));
				const v = window.__stores.physics.physicsDebug().find((b) => b.uuid === window.__ball.uuid)?.linvel;
				y = window.__ball.position.y;
				if (Date.now() - t0 > 1500 && v && Math.hypot(v.x, v.y, v.z) < 0.05) break;
			}
			const tank = window.__stores.physics.physicsWorldDebug().fixed.find((f) => f.name === 'Tank');
			window.__stores.physics.toggleSimulation();
			await new Promise((r) => setTimeout(r, 400));
			window.__dropBall();
			return { y, key: tank ? JSON.parse(tank.shapeKey) : null };
		});
	const solid = await drop();
	h.check(solid.y > 1, `COUNTERFACTUAL: a plain box catches the ball on its lid (y ${solid.y.toFixed(2)})`);
	await A.page.evaluate(() => {
		window.__tank.userData.water = { version: 1, shape: 'box', level: null };
	});
	const wet = await drop();
	h.check(wet.y < 0.4, `the same box as a W1 water volume lets the ball fall in (y ${wet.y.toFixed(2)})`);
	h.check(wet.key?.g === 'water' && wet.key?.s === true, `the volume is built as a Water-group sensor (${JSON.stringify(wet.key)})`);

	await h.finish(browser);
});
