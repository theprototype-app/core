// 36-sim: buoyancy (I1), splashes (W2) and jiggle (U2b) in the real app.
// A W1 water volume is any object with userData.water (36-water's create item is not
// needed: the contract is the blob). Evidence screenshots go to SIM_SHOTS when set.
const h = require('./helpers.cjs');
const path = require('path');

const SHOTS = process.env.SIM_SHOTS || '';
/** @param {any} page @param {string} name */
async function shot(page, name) {
	if (!SHOTS) return;
	await page.screenshot({ path: path.join(SHOTS, name) });
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });

	// a pool (surface y=0), a wooden crate, a stone, and a river with a ball
	const ids = await A.page.evaluate(() => {
		const cmd = window.__stores.commandsHandler.sceneCommand;
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const last = () => g.children[g.children.length - 1];
		cmd('/create Box 8 2 8');
		const pool = last();
		pool.position.set(0, -1, 0);
		pool.material.transparent = true;
		pool.material.opacity = 0.35;
		pool.material.color.set('#3a8fd0');
		delete pool.userData.physics;
		pool.userData.water = { version: 1, shape: 'box' };
		cmd('/create Box 1 1 1');
		const crate = last();
		crate.position.set(-1.5, 2, 0);
		crate.userData.physics = { mode: 'dynamic', mass: 30, floats: { density: 600 } };
		cmd('/create Sphere 0.3');
		const stone = last();
		stone.position.set(1.5, 2, 0);
		stone.userData.physics = { mode: 'dynamic', mass: 5, collider: 'sphere', floats: { density: 2500 } };
		cmd('/create Box 40 1 3');
		const river = last();
		river.position.set(12, -0.5, 8);
		delete river.userData.physics;
		river.userData.water = { version: 1, shape: 'box', flow: [1.2, 0, 0] };
		cmd('/create Sphere 0.25');
		const ball = last();
		ball.position.set(-3, 0.5, 8);
		ball.userData.physics = { mode: 'dynamic', mass: 1, collider: 'sphere' };
		// a floor under everything (the scene ground is at 0 and would hold the pool's bottom)
		window.__stores.scenePhysics.setScenePhysics?.({ ground: { enabled: true, height: -2.1 } });
		for (const o of [pool, crate, stone, river, ball]) o.updateMatrixWorld(true);
		window.__sim = { pool, crate, stone, river, ball };
		return { pool: pool.uuid, crate: crate.uuid };
	});
	await A.page.waitForTimeout(500);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe(r)())),
		(v) => v === true,
		'simulation started'
	);

	// 1) the water volume is NOT a solid lid: the crate falls INTO it
	await h.eventually(
		() => A.page.evaluate(() => window.__sim.crate.position.y),
		(y) => y < 0.6,
		'the crate falls through the water volume surface (no fixed collider on water)',
		8000
	);
	// 2) splash: the crate's entry rippled the pool (W2, local)
	const ripples = await A.page.evaluate(() => window.__stores.sim.waterVolumes.ripplesOf(window.__sim.pool.uuid).length);
	h.check(ripples > 0, `entering the water made a ripple on the pool (${ripples})`);

	await A.page.waitForTimeout(9000);
	const r = await A.page.evaluate(() => ({
		crate: window.__sim.crate.position.y,
		stone: window.__sim.stone.position.y,
		ballX: window.__sim.ball.position.x,
		ballY: window.__sim.ball.position.y
	}));
	const draft = 0.5 - r.crate;
	h.check(Math.abs(draft - 0.6) / 0.6 < 0.1, `wood crate floats at the expected draft 0.60 ±10% (measured ${draft.toFixed(3)})`);
	h.check(r.stone < -1.4, `the stone sank to the bottom (y ${r.stone.toFixed(2)})`);
	h.check(r.ballX > 2, `the ball drifted down the river (x ${r.ballX.toFixed(2)} from -3)`);
	h.check(r.ballY > -0.4, `...and floats while it drifts (y ${r.ballY.toFixed(2)})`);
	await shot(A.page, '01-buoyancy-pool.png');

	// 3) Floats override lives on the Inspector (dynamic bodies)
	await A.page.evaluate(() => {
		localStorage.setItem('inspector:sec:Physics', 'open');
		window.__stores.objectActions.selectObject(window.__sim.crate.uuid, true);
		window.__stores.showSidebar('selection');
	});
	const floatsUi = await A.page.waitForSelector('#physics-floats', { timeout: 8000 }).then(() => true).catch(() => false);
	h.check(floatsUi, 'Inspector > Physics shows the Floats override for a dynamic body');
	const hint = await A.page.evaluate(() => document.querySelector('#physics-floats-hint')?.textContent?.trim() ?? '');
	h.check(/60% under/.test(hint), `the Floats hint reads the density (${hint})`);
	if (floatsUi) {
		await A.page.evaluate(() => document.querySelector('#physics-floats')?.scrollIntoView({ block: 'center' }));
		await A.page.waitForTimeout(300);
		await shot(A.page, '02-floats-inspector.png');
	}
	// Floats: Off -> the crate sinks (the live path: setPhysicsFor reaches the running sim)
	await A.page.evaluate(() => window.__stores.physics.setPhysicsFor(window.__sim.crate.uuid, { floats: { off: true } }));
	await h.eventually(
		() => A.page.evaluate(() => window.__sim.crate.position.y),
		(y) => y < -1.2,
		'Floats: Off makes the same crate sink (live, mid-sim)',
		10000
	);

	await A.page.evaluate(() => window.__stores.physics.stopSimulation());
	h.check(
		(await h.pageErrors(A)).length === 0,
		`no page errors (${JSON.stringify(h.pageErrors(A).slice(0, 2))})`
	);
	await browser.close();
});
