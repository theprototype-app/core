// 61-int (roadmap 61 G9 + the trimmed release proof): the "A guard on patrol" template PLAYS, and a
// Test with players bot sees the same guard move.
//   1. the template (scenes repo templates/guard-patrol) loads through loadRemoteScene: the guard carries ONE
//      Enemy (NPC) node patrolling the "Guard route" Path; the scene graph wires spotted -> Announce
//   2. Play, the player parked outside the walls: the guard walks its round (every sample on the Path's square)
//   3. the player steps in front of it: spotted ("Spotted!" announced) -> chase -> attack ("Caught!")
//   4. the player leaves the yard: it gives up and goes back to its round
//   5. Test with players (1 Player): the bot starts with the navigation module (its idb reads the installed
//      modules through) and its view shows the guard walking, eased from the host's snapshots; Stop removes it
// Needs MODULES_REPO's navigation.zip and SCENES_DIR's templates/guard-patrol/scene.tpscene (skips without).
//   APP_URL=https://theprototype.app:5940/ MODULES_REPO=<modules> SCENES_DIR=<scenes> node tests/e2e/guard-patrol-template.test.cjs
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_DIR = process.env.SCENES_DIR || path.resolve(__dirname, '../../../scenes');
const FILE = process.env.GUARD_TPSCENE || path.join(SCENES_DIR, 'templates/guard-patrol/scene.tpscene');
/** outside the yard's walls (2.5 m high), out of every sight line */
const OUTSIDE = [24, 1.7, 24];
/** the Path is the square x, z in [-6, 6]: how far a point is from its sides */
const offRoute = (p) => Math.abs(Math.max(Math.abs(p[0]), Math.abs(p[2])) - 6);
const dbg = (page) => page.evaluate(() => window.__navigation?.debug?.() ?? null);

/** poll until ok(value); returns the last value */
async function until(fn, ok, ms = 15000, every = 250) {
	const end = Date.now() + ms;
	let v;
	for (;;) {
		try {
			v = await fn();
		} catch (error) {
			v = { error: String(error?.message ?? error) };
		}
		let good = false;
		try {
			good = !!ok(v);
		} catch {
			good = false;
		}
		if (good || Date.now() > end) return v;
		await new Promise((r) => setTimeout(r, every));
	}
}

h.run(async () => {
	for (const [what, p] of [
		['navigation.zip', h.moduleZipPath('navigation')],
		['the guard-patrol template', FILE]
	]) {
		if (!fs.existsSync(p)) {
			console.log('SKIP: no ' + what + ' at ' + p);
			console.log('ALL PASS');
			process.exit(0);
		}
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;
	await h.answerRestore(A).catch(() => {});
	page.on('console', (m) => {
		const t = m.text();
		if (/^\[nav|recast|nav-worker/i.test(t) || (m.type() === 'error' && /navigation/i.test(t)))
			console.log('  [page ' + m.type() + '] ' + t.slice(0, 300));
	});
	await page.route('**/__e2e/guard-patrol.tpscene', (route) =>
		route.fulfill({ status: 200, contentType: 'application/zip', body: fs.readFileSync(FILE) })
	);
	// the player stays where the suite puts it (a play-mode controller may write the camera every frame)
	await page.evaluate(() => {
		const loop = () => {
			const p = window.__guardHold;
			if (p) {
				let cam;
				window.__tp.test.v1.globalCamera.subscribe((v) => (cam = v))();
				if (cam && Math.hypot(cam.position.x - p[0], cam.position.z - p[2]) > 0.01) {
					cam.position.set(p[0], p[1], p[2]);
					cam.updateMatrixWorld(true);
				}
			}
			setTimeout(loop, 50);
		};
		loop();
	});
	const hold = (p) => page.evaluate((q) => (window.__guardHold = q), p);

	// ---- 1. the template ----------------------------------------------------------------------------------
	console.log('\n=== 1. the template ===');
	h.check(await h.installModule(A, 'navigation'), 'premise: navigation.zip installs');
	await h.eventually(() => dbg(page), (d) => !!d, 'premise: the navigation module registered', 15000);
	const loaded = await page.evaluate(() =>
		window.__tp.test.v1.sceneTemplates.loadRemoteScene({ sceneUrl: '/__e2e/guard-patrol.tpscene', title: 'A guard on patrol', slug: 'guard-patrol' })
	);
	h.check(loaded === true, '1.1 the template loads (loadRemoteScene, the Templates window path)');
	const ids = await until(
		() =>
			page.evaluate(() => {
				let g;
				window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
				const out = {};
				g?.traverse((o) => {
					if (o.name && !out[o.name]) out[o.name] = o.uuid;
				});
				return out;
			}),
		(o) => o['Guard'] && o['Guard route'] && o['Storehouse'],
		20000
	);
	h.check(!!(ids['Guard'] && ids['Guard route'] && ids['Storehouse']), '1.2 the yard, the storehouse, the guard and its Path are in the scene');
	const graph = await page.evaluate((guard) => {
		const nodes = window.__tp.test.v1.allNodes?.() ?? [];
		let graphs;
		window.__tp.test.v1.flowGraphs.subscribe((v) => (graphs = v))();
		const scene = graphs?.scene ?? { nodes: [], edges: [] };
		const ev = scene.nodes.find((n) => n.type === 'navevent' && n.data?.event === 'spotted');
		const said = ev && scene.edges.filter((e) => e.source === ev.id).map((e) => scene.nodes.find((n) => n.id === e.target)?.data?.text).filter(Boolean);
		return {
			npc: nodes.filter((n) => n.type === 'navnpc').map((n) => ({ graph: n.__graph, path: n.data?.path })),
			walk: nodes.filter((n) => n.type === 'charcontroller').map((n) => n.data?.mode),
			said: said ?? [],
			guard
		};
	}, ids['Guard']);
	h.check(
		graph.npc.length === 1 && graph.npc[0].graph === ids['Guard'] && graph.npc[0].path === ids['Guard route'],
		'1.3 ONE Enemy (NPC) node, in the guard\'s own graph, patrolling the Guard route (' + JSON.stringify(graph.npc) + ')'
	);
	h.check(graph.walk.length === 1 && graph.walk[0] === 'walk', '1.4 the player walks (one Character Controller, walk) (' + JSON.stringify(graph.walk) + ')');
	h.check(graph.said.includes('Spotted!'), '1.5 On NPC Event (spotted) is wired to an Announce "Spotted!" (' + JSON.stringify(graph.said) + ')');

	// ---- 2. the round --------------------------------------------------------------------------------------
	console.log('\n=== 2. Play: the guard walks its round ===');
	await hold(OUTSIDE);
	await page.evaluate(() => window.__tp.test.v1.isLocked.set(true));
	const guard = (d) => d?.agents?.find((a) => a.uuid === ids['Guard']) ?? null;
	const onRound = await until(() => dbg(page), (d) => d?.bake?.status === 'ready' && guard(d)?.state === 'patrol', 45000);
	h.check(guard(onRound)?.state === 'patrol', '2.1 in Play the guard is on patrol (' + JSON.stringify(guard(onRound) ?? onRound?.bake ?? null) + ')');
	const samples = [];
	for (let i = 0; i < 16; i++) {
		const g = guard(await dbg(page));
		if (g) samples.push(g.feet);
		await page.waitForTimeout(500);
	}
	let walked = 0;
	for (let i = 1; i < samples.length; i++) walked += Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][2] - samples[i - 1][2]);
	const worst = Math.max(...samples.map(offRoute));
	h.check(walked > 3, '2.2 it walks (' + walked.toFixed(1) + ' m in 8 s)');
	h.check(samples.length >= 12 && worst < 1.2, '2.3 every sample is on the Path\'s square (worst ' + worst.toFixed(2) + ' m off)');

	// ---- 3. spotted, chased, caught ------------------------------------------------------------------------
	console.log('\n=== 3. spotted -> chase -> attack ===');
	const ev0 = (await dbg(page))?.stats?.events ?? {};
	await page.evaluate(() => window.__tp.test.v1.gameAnnounce?.clearAnnounceLog?.());
	const g0 = guard(await dbg(page));
	const dir = g0.target ? [g0.target[0] - g0.feet[0], g0.target[2] - g0.feet[2]] : [0, 1];
	const len = Math.hypot(dir[0], dir[1]) || 1;
	await hold([g0.feet[0] + (dir[0] / len) * 4, 1.7, g0.feet[2] + (dir[1] / len) * 4]);
	const seen = await until(() => dbg(page), (d) => (d?.stats?.events?.spotted ?? 0) > (ev0.spotted ?? 0), 15000);
	h.check((seen?.stats?.events?.spotted ?? 0) > (ev0.spotted ?? 0), '3.1 the guard SPOTS the player standing in front of it');
	const said = await until(
		() => page.evaluate(() => {
			let log = [];
			window.__tp.test.v1.gameAnnounce?.announceLog?.subscribe((v) => (log = v))();
			return log.map((l) => l.text);
		}),
		(l) => l.includes('Spotted!'),
		10000
	);
	h.check(said.includes('Spotted!'), '3.2 "Spotted!" is announced (' + JSON.stringify(said) + ')');
	const hit = await until(() => dbg(page), (d) => (d?.stats?.events?.attack ?? 0) > (ev0.attack ?? 0), 20000);
	h.check((hit?.stats?.events?.attack ?? 0) > (ev0.attack ?? 0), '3.3 it chases and ATTACKS the player (' + JSON.stringify(guard(hit)) + ')');

	// ---- 4. lost ----------------------------------------------------------------------------------------------
	console.log('\n=== 4. the player leaves: it gives up and goes back ===');
	await hold(OUTSIDE);
	const back = await until(() => dbg(page), (d) => (d?.stats?.events?.gaveup ?? 0) > (ev0.gaveup ?? 0) && guard(d)?.state === 'patrol', 45000);
	h.check((back?.stats?.events?.gaveup ?? 0) > (ev0.gaveup ?? 0), '4.1 out of sight, it GIVES UP');
	h.check(guard(back)?.state === 'patrol', '4.2 and walks its round again (' + guard(back)?.state + ')');

	// ---- 5. Test with players ---------------------------------------------------------------------------------
	console.log('\n=== 5. Test with players: a bot sees the guard ===');
	await page.evaluate(() => window.__tp.test.v1.testPlayersUi.startTestPlayers(['player']));
	const joined = await until(
		() => page.evaluate(() => window.__tp.test.v1.testPlayers.testPlayersDebug()),
		(d) => d?.bots?.[0]?.status === 'playing',
		240000,
		1000
	);
	h.check(joined?.bots?.[0]?.status === 'playing', '5.1 the Player bot joined and is in Play (' + JSON.stringify(joined?.bots) + ')');
	const frame = page.frames().find((f) => /[?&]tpbot=/.test(f.url()));
	h.check(!!frame, 'premise: the bot frame is reachable');
	if (frame) {
		const botNav = await until(() => frame.evaluate(() => window.__navigation?.debug?.() ?? null), (d) => !!d, 60000, 1000);
		h.check(!!botNav, '5.2 the bot has the navigation module (installed modules read through; no ask in a hidden frame)');
		const shown = (d) => d?.shown?.find((s) => s.uuid === ids['Guard'])?.disp ?? null;
		const first = await until(() => frame.evaluate(() => window.__navigation?.debug?.() ?? null), (d) => !!shown(d), 30000, 500);
		const a = shown(first);
		await page.waitForTimeout(4000);
		const b = shown(await frame.evaluate(() => window.__navigation?.debug?.() ?? null));
		const host = guard(await dbg(page));
		h.check(!!a && !!b && Math.hypot(a[0] - b[0], a[2] - b[2]) > 1, '5.3 in the bot\'s view the guard moves (' + JSON.stringify([a, b]) + ')');
		h.check(!!b && !!host && Math.hypot(b[0] - host.feet[0], b[2] - host.feet[2]) < 3, '5.4 where the host\'s crowd puts it (bot ' + JSON.stringify(b) + ', host ' + JSON.stringify(host?.feet) + ')');
	}
	await page.evaluate(() => window.__tp.test.v1.testPlayersUi.stopTestPlayers());
	const gone = await until(() => page.evaluate(() => window.__tp.test.v1.testPlayers.testPlayersDebug()), (d) => d === null, 30000);
	h.check(gone === null, '5.5 Stop test removes the bot');

	await hold(null);
	await h.leavePlay(A);
	await h.finish(browser);
});
