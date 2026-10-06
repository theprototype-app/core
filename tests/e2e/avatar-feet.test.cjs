// 37-avatar-fix R23 — feet on the ground, between two REAL peers. A watches B.
//  1. B in Play (the grounded pin): A's copy of B stands on the floor — the camera stream now
//     carries B's WORLD eye (Play's camera lives in a group at y = 0.9; the local position sank
//     every walking player 0.9 m), plus B's walker's `feet`. The lowest sole of A's copy is within
//     ±3 cm of the floor, standing AND mid-stride.
//  2. B walks with a Character Controller (walk mode) over a floor raised to 0.3 m (a step):
//     A's copy stands on the step, not a body-height under B's 1.7 m eye.
//  3. B flies (no walker): no `feet` on the wire, A falls back to the head-height guess.
// The per-clip proof (every character × every ground clip, ±3 cm) is the headless vitest
// `avatarRig`; this suite proves the WIRE and the placement on a real second page.
const h = require('./helpers.cjs');

const SHOTS = process.env.AVATAR_SHOTS || '';
const FLOOR_TOL = 0.03;

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);

	const stateOn = (page, id) => page.evaluate((id) => window.__stores.avatars.avatarsDebug()[id] ?? null, id);
	const rootY = (page, id) =>
		page.evaluate((id) => {
			let scene;
			window.__stores.globalScene.subscribe((x) => (scene = x))();
			return scene.getObjectByName(id)?.position.y ?? null;
		}, id);
	/** h.eventually, handing back the value that satisfied it */
	const until = async (fn, pred, label, t) => {
		let v;
		await h.eventually(async () => (v = await fn()), pred, label, t);
		return v;
	};
	/** the lowest sole of A's copy of B, world y (feet origin + the sole after the clamp) */
	const soleWorld = (s) => s.feet[1] + s.soleY;

	// ---- B picks the Knight (userdata slot 5, the real panel) --------------------------------
	await B.page.evaluate(() => window.__stores.characterModalOpen.set(true));
	await B.page.waitForSelector('#character-panel');
	await B.page.click('[data-character="knight"]');
	await B.page.click('#character-apply');
	await B.page.waitForSelector('#character-panel', { state: 'detached' });
	await B.page.evaluate(() => window.__stores.objectActions.flyTo([0, 1.6, 0], [0, 1.6, -5], 0));
	await h.eventually(() => stateOn(A.page, B.id), (s) => s && s.ready && s.character === 'knight', '0.1 (premise) A draws B as the Knight', 20000);

	// ---- 1. B in Play on the grounded pin -----------------------------------------------------
	await B.page.evaluate(() => {
		window.__stores.scenePhysics.setScenePhysics({ play: { grounded: true } });
		window.__stores.isLocked.set(true);
	});
	const s1 = await until(
		() => stateOn(A.page, B.id),
		(s) => s && s.anchor === 'wire' && Math.abs(s.feet[1]) < 0.02,
		"1.1 A anchors B's body to B's walker (feet on the wire, y 0)",
		8000
	);
	const ry = await rootY(A.page, B.id);
	h.check(ry !== null && Math.abs(ry - 1.7) < 0.05, `1.2 the head A receives is B's WORLD eye (${ry?.toFixed(3)} m, was 0.8 = the local position)`);
	h.check(s1 && Math.abs(soleWorld(s1)) <= FLOOR_TOL, `1.3 standing: B's lowest sole is on the floor (${s1 && (soleWorld(s1) * 100).toFixed(1)} cm)`);

	// B walks forward (W held) — sample A's copy mid-stride, several times
	await B.page.keyboard.down('KeyW');
	await A.page.waitForTimeout(900);
	const strides = [];
	for (let i = 0; i < 8; i++) {
		strides.push(await stateOn(A.page, B.id));
		await A.page.waitForTimeout(110);
	}
	if (SHOTS) {
		const s = strides[strides.length - 1];
		await A.page.evaluate((f) => window.__stores.objectActions.flyTo([f[0] + 3.2, 0.6, f[2]], [f[0], 0.6, f[2]], 0), s.feet);
		await A.page.waitForTimeout(400);
		await A.page.screenshot({ path: SHOTS + '/01-feet-walking-side.png' });
	}
	await B.page.keyboard.up('KeyW');
	const walking = strides.filter((s) => s && (s.top === 'walk' || s.top === 'run'));
	h.check(walking.length >= 3, `1.4 (premise) A plays B's walk while B moves (${walking.length}/8 samples walking)`);
	const soles = strides.map((s) => soleWorld(s));
	const lo = Math.min(...soles);
	h.check(lo >= -FLOOR_TOL, `1.5 mid-stride no sole goes more than 3 cm into the floor (lowest ${(lo * 100).toFixed(1)} cm)`);
	// a WALK always has a foot down; a RUN has a flight phase with both feet up (measured headless:
	// up to 11.8 cm), so only the walking samples must touch the floor
	const walkSoles = strides.filter((s) => s.top === 'walk').map(soleWorld);
	const runSoles = strides.filter((s) => s.top !== 'walk').map(soleWorld);
	const hiWalk = walkSoles.length ? Math.max(...walkSoles) : 0;
	const hiRun = runSoles.length ? Math.max(...runSoles) : 0;
	h.check(hiWalk <= FLOOR_TOL, `1.6 ...a walking stance foot stays on it (${walkSoles.length} walk samples, highest lowest-sole ${(hiWalk * 100).toFixed(1)} cm)`);
	h.check(hiRun <= 0.13, `1.6b ...a run's flight phase stays a hop (${runSoles.length} run samples, highest ${(hiRun * 100).toFixed(1)} cm <= 13)`);
	h.check(strides.every((s) => Math.abs(s.feet[1]) < 0.02), '1.7 the body origin stays on the floor while walking (no sinking)');

	// ---- 2. a Character Controller on a raised floor (a 0.3 m step) ---------------------------
	// a REAL Character Controller node (the flow runtime re-declares charControl from the graph
	// every tick, so a direct setCharControl would be wiped)
	await B.page.evaluate(() => {
		window.__stores.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0.3 }, play: { grounded: false } });
		window.__stores.setActiveGraph(window.__stores.SCENE_GRAPH);
		window.__stores.flowNodes.set([
			{ id: 'cc', type: 'charcontroller', position: { x: 0, y: 0 }, data: { type: 'charcontroller', mode: 'walk', speed: 0.05, jumpHeight: 1, eyeHeight: 1.7, gravity: true }, class: 'w-[150px]' }
		]);
		window.__stores.flowEdges.set([]);
	});
	const s2 = await until(
		() => stateOn(A.page, B.id),
		(s) => s && s.anchor === 'wire' && Math.abs(s.feet[1] - 0.3) < 0.02,
		"2.1 B's walker stands on the 0.3 m floor and A's copy of B stands there too",
		8000
	);
	h.check(s2 && Math.abs(soleWorld(s2) - 0.3) <= FLOOR_TOL, `2.2 the sole is on the raised floor (${s2 && ((soleWorld(s2) - 0.3) * 100).toFixed(1)} cm off)`);
	if (SHOTS) {
		await A.page.evaluate((f) => window.__stores.objectActions.flyTo([f[0] + 3.2, 0.9, f[2]], [f[0], 0.9, f[2]], 0), s2.feet);
		await A.page.waitForTimeout(400);
		await A.page.screenshot({ path: SHOTS + '/02-feet-raised-floor-side.png' });
	}

	// ---- 3. no walker: the head-height guess ---------------------------------------------------
	await B.page.evaluate(() => {
		window.__stores.flowNodes.set([]);
		window.__stores.scenePhysics.setScenePhysics({ ground: { enabled: false, height: 0 } });
	});
	await h.leavePlay(B);
	await B.page.evaluate(() => window.__stores.objectActions.flyTo([0, 1.6, -2], [0, 1.6, -7], 0));
	await h.eventually(
		() => stateOn(A.page, B.id),
		(s) => s && s.anchor === 'head',
		'3.1 out of Play B sends no feet and A hangs the body under the head again',
		8000
	);

	await h.finish(browser);
});
