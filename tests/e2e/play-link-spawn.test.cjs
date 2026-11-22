// fix-late-joiners row 3 — PLAYERS WHO PRESS PLAY AT THE SAME MOMENT NEVER SPAWN INSIDE EACH OTHER.
//
// A host holds a scene with a spawn point, a wall 2 m to its right (the ring spots behind it must be refused:
// "never inside geometry") and a floor. JOINERS (LJ_JOINERS, default "2,8") join the host, then all press Play
// in the SAME instant, before any of them has seen another's avatar in play. Measured on every joiner: where its
// play camera stands.
//   1. every pair of joiners at least 1 m apart (horizontally), for 2 and for 8 at once;
//   2. nobody behind or inside the wall, everybody's eye at the floor + 1.7 m;
//   3. a joiner who RELOADS and presses Play again lands clear of everyone still standing.
// Local signaling (localSignal.cjs): nine pages are not sent to the public PeerJS server.
// Counterfactual (v1.74.0): with two joiners both stand on the bare spawn (0 m apart), red at row 1.
// Run: e2e-slot --dev <lane> 7204 -- env APP_URL=https://theprototype.app:7204/ node tests/e2e/play-link-spawn.test.cjs
const h = require('./helpers.cjs');
const { LOCAL_PEER_STORAGE, ensureSignalServer, stopSignalServer } = require('./localSignal.cjs');

const SIZES = (process.env.LJ_JOINERS || '2,8').split(',').map(Number).filter((n) => n >= 2);
const WALL_X = 2.0;

h.run(async () => {
	const signal = await ensureSignalServer();
	// a red run exits from inside h.run: the server it started must not outlive it (a stale one on the shared
	// :9001 swallowed the next run's dials — measured, the second joiner's offer never reached the host)
	process.on('exit', () => stopSignalServer(signal));
	const browser = await h.launch();
	const opts = { storage: LOCAL_PEER_STORAGE };
	const A = await h.setupPage(browser, 'A', opts);
	await A.page.evaluate(async (wallX) => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		const THREE = await s.THREE;
		const sp = await s.scenePhysics;
		sp.setScenePhysics({ play: { spawn: { position: [0, 0, 0], yaw: 0 } } });
		let g;
		/** @type {any} */ (window).__stores.objectsGroup.subscribe((v) => (g = v))();
		const floor = new THREE.Mesh(new THREE.BoxGeometry(30, 0.2, 30), new THREE.MeshStandardMaterial({ color: 0x888888 }));
		floor.name = 'Floor';
		floor.position.set(0, -0.1, 0);
		g.add(floor);
		const wall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3, 12), new THREE.MeshStandardMaterial({ color: 0x884444 }));
		wall.name = 'Wall';
		wall.position.set(wallX + 0.2, 1.5, 0);
		g.add(wall);
		g.updateMatrixWorld(true);
	}, WALL_X);

	const where = (P) =>
		P.page.evaluate(() => {
			const s = /** @type {any} */ (window).__tp.test.v1;
			let cam;
			s.playerCam.subscribe((v) => (cam = v))();
			const v = cam.getWorldPosition(new cam.position.constructor());
			const pick = s.playSpawn?.lastSpawnPick?.() ?? null;
			return { at: [v.x, v.y, v.z], pick };
		});
	const locked = (P) => P.page.evaluate(() => { let v; /** @type {any} */ (window).__tp.test.v1.isLocked.subscribe((x) => (v = x))(); return v; });
	const play = (P) => P.page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.playMode.requestPlay({ flat: true }));

	const linked = (P, id) =>
		P.page.evaluate((peerId) => new Promise((r) => /** @type {any} */ (window).__tp.test.v1.peers.subscribe((p) => r(!!p?.connections?.[peerId]?.open))()), id).catch(() => false);
	/** h.connect, and when its click raced the pill (the request already went out: the pill says Cancel), approve it */
	const join = async (J) => {
		try {
			await h.connect(J, A, 3000);
		} catch (e) {
			console.log(`  connect ${J.id}: ${String(e?.message ?? e).split('\n')[0]} -- approving on the host instead`);
			await h.approveButton(A.page).click({ timeout: 30000 });
		}
		await h.eventually(async () => (await linked(J, A.id)) && (await linked(A, J.id)), (v) => v === true, `${J.id} and the host are linked`, 45000);
	};

	// everybody joins first (in the editor), then each size presses Play together; the others stay in the
	// editor, so they count as arriving too (the rule's worst case: the set is the whole roster)
	const all = [];
	for (let i = 0; i < Math.max(...SIZES); i++) {
		const J = await h.setupPageQuiet(browser, 'J' + i, [A, ...all], opts);
		await join(J);
		all.push(J);
	}
	let joiners = [];
	for (const n of SIZES) {
		console.log(`\n=== ${n} joiners at once ===`);
		joiners = all.slice(0, n);
		// everybody back in the editor, then Play in the same instant
		for (const J of all) if ((await locked(J)) === true) await J.page.evaluate(() => /** @type {any} */ (window).__tp.test.v1.playMode.exitPlay());
		await A.page.waitForTimeout(2500);
		await Promise.all(joiners.map((J) => play(J)));
		for (const J of joiners) await h.eventually(() => locked(J), (v) => v === true, `${J.id} is in play`, 20000);
		await A.page.waitForTimeout(1000);
		const spots = [];
		for (const J of joiners) spots.push(await where(J));
		console.log('spots', JSON.stringify(spots.map((s) => ({ at: s.at.map((v) => +v.toFixed(2)), slot: s.pick?.slot }))));
		let closest = Infinity;
		for (let i = 0; i < spots.length; i++)
			for (let j = i + 1; j < spots.length; j++) closest = Math.min(closest, Math.hypot(spots[i].at[0] - spots[j].at[0], spots[i].at[2] - spots[j].at[2]));
		h.check(closest >= 1.0 - 1e-6, `${n} at once: every pair of players at least 1 m apart (closest ${closest.toFixed(2)} m)`);
		h.check(spots.every((s) => s.at[0] < WALL_X), `${n} at once: nobody behind or inside the wall (max x ${Math.max(...spots.map((s) => s.at[0])).toFixed(2)})`);
		h.check(spots.every((s) => Math.abs(s.at[1] - 1.7) < 0.15), `${n} at once: every eye on the floor + 1.7 m (${spots.map((s) => s.at[1].toFixed(2)).join(', ')})`);
	}

	{
		console.log('\n=== a joiner reloads and plays again ===');
		const J = joiners[0];
		await h.freshReload(J);
		await h.answerRestore(J).catch(() => {});
		let back = false;
		for (const until = Date.now() + 45000; Date.now() < until && !back; await J.page.waitForTimeout(500))
			back = await J.page
				.evaluate((hid) => new Promise((r) => /** @type {any} */ (window).__tp.test.v1.peers.subscribe((p) => r(!!p?.connections?.[hid]?.open))()), A.id)
				.catch(() => false);
		if (!back) await join(J);
		// the others' avatars must be on its page before it plays (a joiner into a game under way)
		await J.page.waitForTimeout(4000);
		await play(J);
		await h.eventually(() => locked(J), (v) => v === true, 'the reloaded joiner is in play', 20000);
		await J.page.waitForTimeout(1000);
		const mine = await where(J);
		const others = [];
		for (const K of joiners.slice(1)) others.push((await where(K)).at);
		const closest = Math.min(...others.map((o) => Math.hypot(o[0] - mine.at[0], o[2] - mine.at[2])));
		h.check(closest >= 1.0 - 1e-6, `after a reload: clear of everyone standing (closest ${closest.toFixed(2)} m)`);
		h.check(mine.at[0] < WALL_X, `after a reload: not behind the wall (x ${mine.at[0].toFixed(2)})`);
	}
	await h.finish(browser);
	stopSignalServer(signal);
});
