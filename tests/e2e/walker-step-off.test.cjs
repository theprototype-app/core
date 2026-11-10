// 78-int u2 — a walker that steps OFF a platform lands ON the ground plane: no pop.
// 5198fea5 stands a grounded walker on the enabled ground plane when the character controller's
// capsule has settled up to 5 cm into it. This suite pins the cases that rule must not change:
//   1. standing on a static platform (top 0.4 m) the feet stay on the PLATFORM (the rule only acts
//      under the plane's top, never above it);
//   2. walking off its edge, the feet fall and land on the plane with no upward jump on landing
//      (a "pop" of up to 5 cm would show as a rise between two frames) and settle at 0;
//   3. the default walker (walk mode, no controller node) on the plane reads 0, not 1-3 cm under it.
//   APP_URL=https://theprototype.app:5802/ node tests/e2e/walker-step-off.test.cjs
const h = require('./helpers.cjs');

/** @param {any} page @param {boolean} controller */
const buildLevel = (page, controller) =>
	page.evaluate((withNode) => {
		const s = window.__stores;
		const T = s.THREE;
		s.commandsHandler.sceneCommand('/clear all');
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const m = new T.Mesh(new T.BoxGeometry(3, 0.4, 3), new T.MeshStandardMaterial({ color: 0x888888 }));
		m.name = 'Platform';
		m.position.set(0, 0.2, -2.5); // top 0.4 m, spans z -4 .. -1
		m.userData.physics = { mode: 'static' };
		g.add(m);
		s.objectsGroup.update((v) => v);
		s.scenePhysics.setScenePhysics({
			ground: { enabled: true, height: 0 },
			play: { simOnPlay: true, grounded: !withNode, spawn: { position: [0, 0.45, -2.2], yaw: 0 } }
		});
		const walk = { id: 'walk', type: 'charcontroller', position: { x: 40, y: 40 }, data: { label: 'Character Controller', mode: 'walk', speed: 0.06, jumpHeight: 1.1, eyeHeight: 1.7, gravity: true } };
		s.flowNodes.set(withNode ? [walk] : []);
		s.flowEdges.set([]);
	}, controller);

/** @param {any} page */
const walker = (page) =>
	page.evaluate(() => {
		let st;
		window.__stores.charController.walkerState.subscribe((v) => (st = v))();
		return st;
	});
/** @param {any} page */
const simulating = (page) => page.evaluate(() => { let v; window.__stores.physics.simulating.subscribe((x) => (v = x))(); return v; });

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---- 1. on the platform ------------------------------------------------------------------
	await buildLevel(page, true);
	await page.waitForTimeout(1200);
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => simulating(page), (v) => v === true, 'premise: Play starts the physics world', 12000);
	await h.eventually(
		() => walker(page),
		(s) => s && s.source === 'rapier' && s.grounded && Math.abs(s.ground - 0.4) < 0.03,
		'1.1 the walker stands on the 0.4 m platform (rapier tier, grounded)',
		10000
	);
	console.log('on the platform', JSON.stringify(await walker(page)));

	// ---- 2. walk off the far edge (z -4), sampling the feet every frame -----------------------
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__feet = [];
		w.__feetOn = true;
		const tick = () => {
			if (!w.__feetOn) return;
			let st;
			w.__stores.charController.walkerState.subscribe((v) => (st = v))();
			w.__feet.push({ y: st.ground, g: st.grounded, src: st.source });
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	await page.keyboard.down('KeyW');
	await h.eventually(() => walker(page), (s) => s && s.ground < 0.02 && s.grounded, 'premise: the walker walked off the edge and landed', 15000);
	await page.waitForTimeout(1200); // keep walking on the plane for a while after the landing
	await page.keyboard.up('KeyW');
	await page.waitForTimeout(600);
	const log = await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__feetOn = false;
		return w.__feet;
	});
	const ys = log.map((/** @type {any} */ s) => s.y);
	const left = ys.findIndex((y) => y < 0.35); // first frame below the platform top
	const land = ys.findIndex((y, i) => i > left && left >= 0 && y < 0.02);
	h.check(left > 0 && land > left, `premise: the log has the fall (${ys.length} frames, left at ${left}, landed at ${land})`);
	// during the fall and after the landing the feet never RISE by more than 1 cm between frames
	let rise = 0;
	for (let i = Math.max(1, left); i < ys.length; i++) rise = Math.max(rise, ys[i] - ys[i - 1]);
	h.check(rise <= 0.01, `2.1 no pop: the feet never rise more than 1 cm in a frame after leaving the platform (max rise ${(rise * 100).toFixed(1)} cm)`);
	const after = ys.slice(land);
	const lo = Math.min(...after);
	const hi = Math.max(...after);
	h.check(lo >= -0.01 && hi <= 0.01, `2.2 after the landing the feet stay on the plane (${(lo * 100).toFixed(1)} .. ${(hi * 100).toFixed(1)} cm)`);
	await h.leavePlay(A);
	await page.evaluate(() => window.__stores.physics.stopSimulation?.());
	await page.waitForTimeout(800);

	// ---- 3. the default walker on the plane ---------------------------------------------------
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await page.evaluate(() => {
		const s = window.__stores;
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0 }, play: { simOnPlay: true, grounded: true, spawn: { position: [0, 0.05, 1], yaw: 0 } } });
		s.flowNodes.set([]);
		s.flowEdges.set([]);
	});
	await page.waitForTimeout(800);
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(1500);
	await page.keyboard.down('KeyW');
	const samples = [];
	for (let i = 0; i < 8; i++) {
		await page.waitForTimeout(250);
		samples.push(await walker(page));
	}
	await page.keyboard.up('KeyW');
	const feet = samples.map((s) => s?.ground ?? NaN);
	h.check(
		samples.every((s) => s && Math.abs(s.ground) <= 0.01),
		`3.1 the default walker walks ON the plane, not in it (feet cm: ${feet.map((y) => (y * 100).toFixed(1)).join(' ')}; ${samples[0]?.source})`
	);
	await h.leavePlay(A);
	await h.finish(browser);
});
