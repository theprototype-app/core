// 78 F11 — PLAY COLLIDES IN AN ALL-STATIC LEVEL. A level is static colliders and a player; before
// 78 `startSimulation` refused it ("Nothing to simulate" — no dynamic body), so no physics world
// existed in Play, the character controller fell back to the flat ground plane and the player
// walked through every wall. And a scene set to walk (play.grounded) with no Character Controller
// node had no gravity, no jump and no world either.
//   1. All-static level + a walk Character Controller + Run physics on Play: Play starts the
//      world (static bodies only) and the wall stops the walker.
//   2. All-static level, play set to walk, NO controller node, Run physics on Play OFF: Play gets
//      the default walker (charControl walk) and starts the static world by itself — the wall
//      stops the player.
//   3. Counterfactual kept: in the editor, Simulate in a scene with no dynamic body and no
//      controller still says "Nothing to simulate" (and starts nothing).
//
//   APP_URL=https://theprototype.app:5802/ node tests/e2e/static-level-play.test.cjs
const h = require('./helpers.cjs');

/** @param {any} page @param {{controller: boolean, simOnPlay: boolean}} opt */
const buildLevel = (page, opt) =>
	page.evaluate((o) => {
		const s = window.__stores;
		const T = s.THREE;
		s.commandsHandler.sceneCommand('/clear all');
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = (name, x, y, z, w, hgt, d) => {
			const m = new T.Mesh(new T.BoxGeometry(w, hgt, d), new T.MeshStandardMaterial({ color: 0x888888 }));
			m.name = name;
			m.position.set(x, y, z);
			m.userData.physics = { mode: 'static' };
			g.add(m);
			return m;
		};
		box('Wall', 0, 1.2, -4, 8, 2.4, 0.4);
		box('Pillar', 5, 1, 5, 0.5, 2, 0.5);
		s.objectsGroup.update((v) => v);
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0 }, play: { simOnPlay: o.simOnPlay, grounded: !o.controller, spawn: { position: [0, 0.1, 1], yaw: 0 } } });
		const walk = { id: 'walk', type: 'charcontroller', position: { x: 40, y: 40 }, data: { label: 'Character Controller', mode: 'walk', speed: 0.08, jumpHeight: 1.1, eyeHeight: 1.7, gravity: true } };
		s.flowNodes.set(o.controller ? [walk] : []);
		s.flowEdges.set([]);
	}, opt);

/** @param {any} page */
const simulating = (page) => page.evaluate(() => { let v; window.__stores.physics.simulating.subscribe((x) => (v = x))(); return v; });
/** @param {any} page */
const rig = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let cam;
		s.playerCam.subscribe((c) => (cam = c))();
		const w = cam.getWorldPosition(new s.THREE.Vector3());
		let state, ctrl;
		s.charController.walkerState.subscribe((v) => (state = v))();
		s.charController.charControl.subscribe((v) => (ctrl = v))();
		return { z: w.z, source: state?.source, mode: ctrl?.mode ?? null, from: ctrl?.sourceNodeId ?? null };
	});

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

	/** walk forward for a while and report where the rig ended @param {string} label */
	const walkInto = async (label) => {
		const from = await rig(page);
		await page.keyboard.down('KeyW');
		// until the rig is well past the wall (no world: it walks through) or 12 s (stopped)
		for (let t = 0; t < 30; t++) {
			await page.waitForTimeout(400);
			if ((await rig(page)).z < -4.6) break;
		}
		await page.keyboard.up('KeyW');
		await page.waitForTimeout(400);
		const r = await rig(page);
		console.log(`${label}: rig z ${from.z.toFixed(2)} -> ${r.z.toFixed(2)} (${r.source}, ${r.mode} from ${r.from})`);
		h.check(from.z - r.z > 2.5, `premise (${label}): the player really walked toward the wall (${(from.z - r.z).toFixed(2)} m)`);
		return r;
	};

	// 1. a walk controller node + Run physics on Play, every body static
	await buildLevel(page, { controller: true, simOnPlay: true });
	await page.waitForTimeout(1200);
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => simulating(page), (v) => v === true, 'Play starts the physics world in an all-static level (Run physics on Play, a walk controller)', 12000);
	await page.waitForTimeout(1000);
	const r1 = await walkInto('controller');
	h.check(r1.source === 'rapier', `the walker sweeps through the physics world (${r1.source})`);
	h.check(r1.z > -3.75, `the wall at z -4 STOPS the walker (z ${r1.z.toFixed(2)})`);
	await h.leavePlay(A);
	await page.evaluate(() => window.__stores.physics.stopSimulation?.());
	await page.waitForTimeout(800);

	// 2. play set to walk, NO controller node, Run physics on Play off
	await buildLevel(page, { controller: false, simOnPlay: false });
	await page.waitForTimeout(1200);
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => simulating(page), (v) => v === true, 'a walk-mode all-static level starts its static world on Play by itself', 12000);
	await page.waitForTimeout(1200);
	const r2a = await rig(page);
	h.check(r2a.mode === 'walk' && r2a.from === 'default', `walk mode with no controller node gets the DEFAULT walker (${r2a.mode} from ${r2a.from})`);
	const r2 = await walkInto('default walker');
	h.check(r2.z > -3.75, `the wall at z -4 STOPS the default walker (z ${r2.z.toFixed(2)})`);
	await h.leavePlay(A);
	const after = await rig(page);
	h.check(after.mode === null, `leaving Play drops the default walker (${after.mode})`);
	await page.evaluate(() => window.__stores.physics.stopSimulation?.());
	await page.waitForTimeout(800);

	// 3. the editor's Simulate in a scene with nothing to simulate still refuses
	await page.evaluate(() => {
		const s = window.__stores;
		s.flowNodes.set([]);
		s.selectedObject.set(null);
		s.selectedObjects?.set?.([]);
	});
	await page.waitForTimeout(500);
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await page.waitForTimeout(1500);
	h.check((await simulating(page)) !== true, 'COUNTERFACTUAL: Simulate in the editor with no dynamic body and no controller still starts nothing');
	await h.finish(browser);
});
