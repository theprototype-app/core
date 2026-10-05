// 36-backlog-21c (plan 21-C8) ACCEPTANCE — the Race game template, loaded from its REAL authored
// .tpscene (RACE_TPSCENE=<path>, else the lane's evidence folder, else the sibling scenes
// checkout), on TWO peers: the circuit and its Main graph arrive, both peers take a car, Start
// runs the kit round (3-2-1, then the clock), the cars stand on the grid DERIVED from the road,
// a remote driver's input moves its car on the simulating peer, a scripted lap counts once while
// reversing over the line counts nothing, the race ends on the last lap with the results board
// derived from the per-player rows on both peers, and moving a road point moves the race.
// Skip-never-fail when no authored scene is found.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
	process.env.RACE_TPSCENE,
	'/home/deck/.code/lanes-30/after-36/36-backlog-21c/scenes/games/race/scene.tpscene',
	path.resolve(__dirname, '../../../scenes/games/race/scene.tpscene'),
	path.resolve(__dirname, '../../../theprototype.app-scenes/games/race/scene.tpscene')
].filter(Boolean);
const TPSCENE = CANDIDATES.find((p) => fs.existsSync(p));
const SHOTS = process.env.RACE_SHOTS || '';

const snap = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const group = g(s.objectsGroup);
		const r = window.__race;
		return {
			names: group.children.map((c) => c.name),
			state: g(s.gameState.gameState)?.state ?? null,
			screen: s.hudDocs.visibleScreen('scene')?.id ?? null,
			phase: r ? r.phase() : null,
			claims: r ? r.claims() : {},
			mine: r ? r.mine() : null
		};
	});
const phaseOf = (page) => page.evaluate(() => window.__race.phase());
const simOf = (page) =>
	page.evaluate(() => {
		const p = window.__stores.physics;
		let own, remote;
		p.simulating.subscribe((v) => (own = v))();
		p.remoteSimulating.subscribe((v) => (remote = v))();
		return { own: !!own, remote: remote ?? null };
	});
/** a car's world pose on a page */
const carPose = (page, name) =>
	page.evaluate((name) => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByName(name);
		if (!o) return null;
		const e = o.rotation;
		return { pos: o.position.toArray().map((n) => +n.toFixed(2)), rot: [e.x, e.y, e.z].map((n) => +n.toFixed(3)), uuid: o.uuid };
	}, name);
const setRules = (page, patch) =>
	page.evaluate((patch) => {
		let graphs;
		window.__stores.flowGraphs.subscribe((g) => (graphs = g))();
		for (const [graphId, graph] of Object.entries(graphs ?? {}))
			for (const n of graph.nodes ?? [])
				if (n.type === 'racerules') {
					window.__stores.nodesHandler.setNodeData(n.id, patch, graphId);
					return true;
				}
		return false;
	}, patch);
const hudText = async (page) => (await page.locator('#hud-layer').textContent()) ?? '';
const shot = async (page, name) => {
	if (!SHOTS) return;
	await page.waitForTimeout(400);
	await page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {});
};

h.run(async () => {
	if (!TPSCENE) {
		console.log('SKIP: no authored games/race/scene.tpscene (set RACE_TPSCENE)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await A.page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, Array.from(fs.readFileSync(TPSCENE)));
	await A.page.waitForTimeout(2000);

	console.log('\n=== 1. the circuit and its Main graph ===');
	let st = await snap(A.page);
	h.check(st.names.includes('Race game'), 'the marker that wakes the race module is in the scene');
	const need = ['Race road', 'Race car 1', 'Race car 2', 'Race car 3', 'Race car 4', 'Finish line', 'Mountains', 'Track ground'];
	h.check(need.every((n) => st.names.includes(n)), `road, four cars, finish line, mountains, ground (${need.filter((n) => !st.names.includes(n)).join(', ') || 'all present'})`);
	const road = await A.page.evaluate(() => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const r = g.getObjectByName('Race road');
		const t = g.getObjectByName('Mountains');
		return { closed: !!r?.userData?.spline?.closed, points: r?.userData?.spline?.points?.length ?? 0, terrain: t?.userData?.geometryParams?.gtype ?? null, falloff: t?.userData?.geometryParams?.params?.falloff ?? null };
	});
	h.check(road.closed && road.points >= 10, `the road is a closed spline (${road.points} points)`);
	h.check(road.terrain === 'Terrain' && road.falloff === 'bowl', `the mountains are a PARAMETRIC terrain, falloff bowl (${road.terrain}/${road.falloff})`);
	const graph = await A.page.evaluate(() => {
		const types = window.__stores.allNodes().map((n) => n.type);
		return { rules: types.filter((t) => t === 'racerules').length, info: types.filter((t) => t === 'raceinfo').length, board: types.includes('leaderboard'), restart: types.includes('kit-round-restart'), enter: types.includes('onenter') };
	});
	h.check(graph.rules === 1 && graph.info >= 8 && graph.board && graph.restart && graph.enter, `Main: Race rules, Race info x${graph.info}, Leaderboard, Kit: Restart round, On Enter (${JSON.stringify(graph)})`);
	const rules0 = await A.page.evaluate(() => window.__race.rules());
	h.check(rules0.laps === 3 && rules0.maxSpeed === 18, `the module reads its numbers off the Race rules node (${JSON.stringify(rules0)})`);
	const meshes = await A.page.evaluate(() => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		let n = 0;
		g.traverse((o) => { if (o.isMesh) n++; });
		return n;
	});
	h.check(meshes <= 150, `a small scene: ${meshes} meshes before pack pieces resolve (draw-call budget 150)`);
	h.check(st.state === 'menu', `starts on the menu (${st.state})`);

	console.log('\n=== 2. a second peer joins ===');
	await h.connect(A, B);
	const carUuid = (await carPose(A.page, 'Race car 1'))?.uuid;
	await h.eventually(() => carPose(B.page, 'Race car 1').then((p) => p?.uuid), (u) => u === carUuid, 'B received the circuit with the same car uuid', 30000);
	await h.eventually(() => B.page.evaluate(() => window.__stores.allNodes().filter((n) => n.type === 'racerules').length), (n) => n === 1, 'B holds the Main graph (its Race rules node)', 20000);

	console.log('\n=== 3. Play, seats ===');
	await A.page.locator('#play-button').click();
	await h.eventually(() => simOf(A.page), (v) => v.own === true, 'A simulates (simOnPlay)', 15000);
	await h.eventually(() => simOf(B.page), (v) => v.remote === A.id, 'B knows A simulates', 15000);
	await B.page.locator('#play-button').click();
	await B.page.waitForTimeout(1500);
	h.check((await simOf(B.page)).own === false, 'B entering play does NOT start a second simulation');
	await h.eventually(() => hudText(A.page), (t) => /RACE/.test(t) && /Click a car/.test(t), 'A: the menu says to click a car', 8000);
	await A.page.evaluate(() => window.__race.claim('Race car 1'));
	await B.page.evaluate(() => window.__race.claim('Race car 2'));
	const car2 = (await carPose(A.page, 'Race car 2'))?.uuid;
	await h.eventually(() => snap(A.page).then((s) => s.claims), (c) => c[carUuid] === A.id && c[car2] === B.id, 'A: car 1 is A\'s, car 2 is B\'s', 8000);
	await h.eventually(() => snap(B.page).then((s) => s.claims), (c) => c[carUuid] === A.id && c[car2] === B.id, 'B agrees on the seats', 8000);
	await shot(A.page, '10-race-menu.png');

	console.log('\n=== 4. Start: the 3-2-1, the grid derived from the road ===');
	// move car 3 off the grid first: Start must put it back
	await A.page.evaluate(() => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByName('Race car 3');
		window.__stores.physics.physicsRemoveBody?.(o.uuid);
		o.position.set(-20, 0.6, -5);
		window.__stores.physics.physicsAddBody?.(o.uuid);
	});
	await A.page.getByRole('button', { name: 'Start', exact: true }).click();
	await h.eventually(() => phaseOf(A.page), (p) => p === 'intro', 'Start runs the intro (the countdown)', 6000);
	await h.eventually(() => hudText(A.page), (t) => /\b[123]\b/.test(t), 'the HUD counts down', 4000);
	await h.eventually(() => phaseOf(B.page), (p) => p === 'intro' || p === 'playing', 'B is in the same round', 6000);
	const grid = await A.page.evaluate(() => {
		const r = window.__race;
		return [1, 2, 3, 4].map((n) => {
			let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByName('Race car ' + n);
			const p = r.progressOf(o.position.toArray());
			return { u: +p.u.toFixed(3), d: +p.distance.toFixed(2) };
		});
	});
	h.check(grid.every((c) => c.u > 0.85 && c.d < 3.5), `every car stands on the road just behind the line (${JSON.stringify(grid)})`);
	await h.eventually(() => phaseOf(A.page), (p) => p === 'playing', 'then the race runs', 8000);
	await h.eventually(() => hudText(A.page), (t) => /Lap 1 \/ 3/.test(t), 'A\'s HUD: Lap 1 / 3', 4000);
	await shot(A.page, '11-race-start.png');

	console.log('\n=== 5. driving: a REMOTE driver\'s input moves its car on the simulating peer ===');
	const b0 = await carPose(A.page, 'Race car 2');
	await B.page.evaluate(() => window.__race.drive(1, 0));
	await A.page.waitForTimeout(2500);
	await B.page.evaluate(() => window.__race.drive(0, 0));
	const b1 = await carPose(A.page, 'Race car 2');
	const moved = Math.hypot(b1.pos[0] - b0.pos[0], b1.pos[2] - b0.pos[2]);
	h.check(moved > 4 && b1.pos[0] < b0.pos[0], `B's throttle drove car 2 forward on A (toward -X: ${b0.pos} -> ${b1.pos}, ${moved.toFixed(1)} m)`);
	h.check(Math.abs(b1.rot[0]) < 0.05 && Math.abs(b1.rot[2]) < 0.05, `the car stays upright — pitch and roll frozen (${b1.rot})`);
	await h.eventually(() => carPose(B.page, 'Race car 2'), (p) => Math.hypot(p.pos[0] - b1.pos[0], p.pos[2] - b1.pos[2]) < 2, 'B sees car 2 where A has it (the physics move stream)', 6000);
	// an unclaimed car is never driven: it holds its grid slot while the others race
	const idle0 = await carPose(A.page, 'Race car 4');
	await A.page.waitForTimeout(1000);
	const idle1 = await carPose(A.page, 'Race car 4');
	h.check(Math.hypot(idle1.pos[0] - idle0.pos[0], idle1.pos[2] - idle0.pos[2]) < 0.3, `an unclaimed car stays where it is (${idle0.pos} -> ${idle1.pos})`);

	console.log('\n=== 6. laps: judged per driver from the arc length ===');
	await setRules(A.page, { laps: 2 });
	await h.eventually(() => B.page.evaluate(() => window.__race.rules().laps), (n) => n === 2, 'laps set to 2 on the Race rules node reach B', 6000);
	// cheat first: reverse back and forth over the line 10 times
	for (let i = 0; i < 10; i++) {
		await A.page.evaluate(() => window.__race.putMyCarAt(0.985));
		await A.page.waitForTimeout(120);
		await A.page.evaluate(() => window.__race.putMyCarAt(0.02));
		await A.page.waitForTimeout(120);
	}
	h.check((await A.page.evaluate(() => window.__race.mine().lap.laps)) === 0, 'ANTI-CHEAT: reversing over the line ten times counts no lap');
	// a real lap: the car round the whole road in steps
	const lap = async () => {
		for (let u = 0.04; u < 1.0; u += 0.04) {
			await A.page.evaluate((u) => window.__race.putMyCarAt(u), u);
			await A.page.waitForTimeout(90);
		}
		await A.page.evaluate(() => window.__race.putMyCarAt(0.01));
		await A.page.waitForTimeout(200);
	};
	await lap();
	await h.eventually(() => A.page.evaluate(() => window.__race.mine().lap.laps), (n) => n === 1, 'driving the whole road counts ONE lap', 4000);
	await h.eventually(() => hudText(A.page), (t) => /Lap 2 \/ 2/.test(t), 'A\'s HUD: Lap 2 / 2', 4000);
	await h.eventually(() => B.page.evaluate(() => window.__race.board()), (rows) => rows[0]?.laps === 1 && rows[0].id !== '', 'B\'s standings put A ahead with a lap — derived from A\'s own row, nothing new sent', 8000);
	await lap();
	await h.eventually(() => A.page.evaluate(() => window.__race.mine().finish), (t) => t > 0, 'the second lap finishes A\'s race', 4000);

	console.log('\n=== 7. the end: the results on both peers ===');
	// B never finishes: the kit authority ends the race 30 s after the first finisher — shorten the
	// wait by finishing B's race by its own rows (a driver writes only ITS row)
	await B.page.evaluate(() => {
		window.__stores.peerVars?.setPeerVar?.('rcLaps', 2);
		window.__stores.peerVars?.setPeerVar?.('rcFinish', 999);
	});
	await h.eventually(() => snap(A.page).then((s) => s.state + '/' + s.screen), (v) => v === 'over/over', 'every driver finished: the round is won, the results screen shows', 15000);
	await h.eventually(() => hudText(A.page), (t) => /You win in \d:\d\d\.\d/.test(t) && /Race again/.test(t), 'A (the winner) reads "You win in m:ss.t" and is offered Race again', 6000);
	await h.eventually(() => hudText(B.page), (t) => /wins in \d:\d\d\.\d/.test(t) && !/You win/.test(t) && !/^Me wins/.test(t), 'B reads the same race worded for B (the winner\'s name, not "You" or "Me")', 8000);
	await h.eventually(() => hudText(B.page), (t) => /2 laps/.test(t), 'the Laps board (the Leaderboard node over rcLaps) lists the laps on B', 6000);
	const best = await A.page.evaluate(() => window.__race.info({ read: 'menuBest' }));
	h.check(/Your best race \d+:\d\d\.\d/.test(best), `the best race + lap are saved on this device (${best})`);
	await shot(A.page, '12-race-results.png');

	console.log('\n=== 8. the road IS the race: move a point and the judge follows ===');
	await h.leavePlay(A);
	const before = await A.page.evaluate(() => window.__race.progressOf([-56, 0.6, 4]));
	await A.page.evaluate(() => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const r = g.getObjectByName('Race road');
		const sp = JSON.parse(JSON.stringify(r.userData.spline));
		// pull the far-left corner 20 m outward (record frame = mesh frame)
		sp.points[3].pos[0] -= 20;
		r.userData.spline = sp;
	});
	const after = await A.page.evaluate(() => window.__race.progressOf([-56, 0.6, 4]));
	h.check(before.distance < 2 && after.distance > 8, `the projector follows the edited road (distance ${before.distance.toFixed(1)} -> ${after.distance.toFixed(1)} m)`);

	await h.finish(browser);
});
