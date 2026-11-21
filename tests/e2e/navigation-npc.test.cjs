// 61-nav (roadmap 61 G1 / G5 / G6 / G7 / G10): the `navigation` module in the real app.
// The zip comes from the modules checkout (MODULES_REPO / helpers.moduleZipPath); skip-never-fail
// without it. The world is built through the agent tools, the enemy through game_setup {npc}
// (set_npc) AND through the object menu's "Make this an enemy…" sheet — the same recipe.
//   1 install + boot gate: the module loads; no worker / wasm until a navigation node exists
//   2 the guard: set_npc and the sheet build the same node; remove makes it ordinary again
//   3 Play, senses: a noise behind a wall -> heard -> it walks ROUND the wall -> spotted -> chase ->
//     attack; the player vanishes -> lost -> gave up -> it walks back home
//   4 unreachable: a player in a low-walled cage (seen over the walls, no way in) -> it stops at the
//     closest point, "unreachable" with a reason, the label says why, no jitter
//   5 patrol on a Path (path "new"); moving the Path moves the patrol
//   6 a crate blocks the pen's door (Move To = unreachable, blocked) then frees it (arrived)
//   7 debug view: the NPC labels draw in Play when the toggle is on, never when off
//   8 two peers: B sees the guard where A's crowd puts it (snapshots + easing), one stepper
const h = require('./helpers.cjs');
const fs = require('fs');

const dbg = (page) => page.evaluate(() => window.__navigation?.debug?.() ?? null);
const agentOf = (d, uuid) => d?.agents?.find((a) => a.uuid === uuid) ?? null;
const near = (a, b, r) => !!a && !!b && Math.hypot(a[0] - b[0], a[2] - b[2]) <= r;

/** poll `fn` until `ok(value)`; checks once and RETURNS the last value (h.eventually returns nothing) */
async function until(fn, ok, label, ms = 10000, every = 250) {
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
		if (good || Date.now() > end) {
			h.check(good, label + (good ? '' : ' (last: ' + JSON.stringify(v)?.slice(0, 600) + ')'));
			return v;
		}
		await new Promise((r) => setTimeout(r, every));
	}
}

/** park this page's player (the camera api.players() reads) at a world point */
async function setPlayer(page, p) {
	await page.evaluate((p) => {
		let cam;
		window.__tp.test.v1.globalCamera.subscribe((v) => (cam = v))();
		cam.position.set(p[0], p[1], p[2]);
		cam.updateMatrixWorld(true);
		window.__navPlayerHold = p;
	}, p);
}

h.run(async () => {
	if (!fs.existsSync(h.moduleZipPath('navigation'))) {
		console.log('SKIP: no navigation.zip at ' + h.moduleZipPath('navigation') + ' (npm run pack -- navigation in the modules checkout)');
		console.log('ALL PASS');
		process.exit(0);
	}
	const browser = await h.launch({});
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const exec = (tool, args) => page.evaluate(([t, a]) => window.__tp.test.v1.aiTools.executeAiTool(t, a), [tool, args]);
	page.on('console', (m) => {
		const t = m.text();
		if (/^\[nav|recast|nav-worker/i.test(t) || (m.type() === 'error' && /navigation/i.test(t))) console.log('  [page ' + m.type() + '] ' + t.slice(0, 300));
	});
	// the camera keeps the parked spot: a play-mode controller may write it every frame
	await page.evaluate(() => {
		const loop = () => {
			const p = window.__navPlayerHold;
			if (p) {
				let cam;
				window.__tp.test.v1.globalCamera.subscribe((v) => (cam = v))();
				if (cam && (Math.abs(cam.position.x - p[0]) > 0.01 || Math.abs(cam.position.z - p[2]) > 0.01 || Math.abs(cam.position.y - p[1]) > 0.01)) {
					cam.position.set(p[0], p[1], p[2]);
					cam.updateMatrixWorld(true);
				}
			}
			setTimeout(loop, 50);
		};
		loop();
	});

	// ---- 1. install + boot gate ----------------------------------------------------------------------
	const installed = await h.installModule(A, 'navigation');
	h.check(installed, '1.1 navigation.zip installs (Modules > User > install from zip)');
	await h.eventually(() => dbg(page), (d) => !!d, '1.2 the module registered (window.__navigation)', 15000);
	const d0 = await dbg(page);
	h.check(d0?.navNodes === 0 && d0?.worker?.started !== true && d0?.bake?.status === 'idle', '1.3 no navigation node -> no worker, no wasm, no bake (' + JSON.stringify({ n: d0?.navNodes, w: d0?.worker, b: d0?.bake?.status }) + ')');

	// ---- 2. the world + the guard ---------------------------------------------------------------------
	const made = await exec('create_objects', {
		objects: [
			{ kind: 'primitive', primitive: 'Box', name: 'Nav ground', params: [30, 0.5, 30], position: [0, -0.25, 0], physics: 'static' },
			{ kind: 'primitive', primitive: 'Box', name: 'Nav wall', params: [0.5, 2, 10], position: [0, 1, 0], physics: 'static' },
			{ kind: 'primitive', primitive: 'Box', name: 'Guard', params: [0.6, 1.6, 0.6], position: [-6, 0.8, 0], color: '#d04040' },
			{ kind: 'primitive', primitive: 'Box', name: 'Sheet guard', params: [0.6, 1.6, 0.6], position: [-10, 0.8, -10], color: '#d08040' },
			// a 4 m cage with knee-high walls south of the guard's home: seen over, not walked into
			{ kind: 'primitive', primitive: 'Box', name: 'Cage N', params: [4.3, 0.7, 0.3], position: [-6, 0.35, 10], physics: 'static' },
			{ kind: 'primitive', primitive: 'Box', name: 'Cage S', params: [4.3, 0.7, 0.3], position: [-6, 0.35, 6], physics: 'static' },
			{ kind: 'primitive', primitive: 'Box', name: 'Cage E', params: [0.3, 0.7, 4.3], position: [-4, 0.35, 8], physics: 'static' },
			{ kind: 'primitive', primitive: 'Box', name: 'Cage W', params: [0.3, 0.7, 4.3], position: [-8, 0.35, 8], physics: 'static' }
		]
	});
	const ids = Object.fromEntries((made?.created ?? []).map((c) => [c.name, c.uuid]));
	h.check(['Guard', 'Nav wall', 'Sheet guard', 'Cage N'].every((n) => !!ids[n]), '2.1 the test world exists (' + Object.keys(ids).join(', ') + ')');
	const npc = await exec('set_npc', { object: ids['Guard'], path: 'none' });
	h.check(!npc?.error && npc?.updated?.[0]?.ok && npc?.npc?.sight?.range === 12, '2.2 set_npc makes the Guard an enemy with the defaults (' + (npc?.error ?? npc?.note) + ')');
	await h.eventually(() => dbg(page), (d) => d?.navNodes === 1, '2.3 the module sees one navigation node', 10000);

	// the object menu's row -> the module's sheet -> Make enemy, on a second object
	const opened = await page.evaluate((uuid) => {
		const m = window.__tp.test.v1.objectMenu;
		const item = m.flattenMenuItems(m.buildObjectMenuItems(uuid)).find((i) => /Make this an enemy/.test(i.label ?? ''));
		if (!item) return 'no row';
		item.action();
		return 'ok';
	}, ids['Sheet guard']);
	h.check(opened === 'ok', '2.4 the object menu lists "Make this an enemy…" (' + opened + ')');
	await page.locator('#nav-sheet-apply').waitFor({ state: 'visible', timeout: 10000 });
	h.check(/Sheet guard/.test((await page.locator('#nav-sheet-target').textContent()) ?? ''), '2.5 the sheet opens on that object');
	await page.locator('#nav-sheet-path').selectOption('none');
	await page.locator('#nav-sheet-apply').click();
	const pair = await until(
		() =>
			page.evaluate(([a, b]) => {
				const api = window.__navigation.api;
				const nodes = api.flow.nodes('navnpc');
				const strip = (n) => (n ? JSON.stringify(Object.fromEntries(Object.entries(n.data ?? {}).filter(([k]) => !k.startsWith('__')).sort())) : null);
				return { a: strip(nodes.find((n) => n.graphId === a)), b: strip(nodes.find((n) => n.graphId === b)) };
			}, [ids['Guard'], ids['Sheet guard']]),
		(v) => !!v.b,
		'2.6 the sheet built a navigation node on the Sheet guard',
		8000
	);
	h.check(!!pair?.a && pair.a === pair.b, '2.7 the sheet builds the same guard as set_npc (' + pair?.a + ' vs ' + pair?.b + ')');
	const rm = await exec('set_npc', { object: ids['Sheet guard'], remove: true });
	await h.eventually(() => dbg(page), (d) => d?.navNodes === 1, '2.8 set_npc remove makes it an ordinary object again (' + (rm?.error ?? rm?.note) + ')', 8000);
	await page.evaluate(() => window.__tp.test.v1.moduleToolboxes?.closeModuleToolbox?.(window.__navigation.sheet.id));

	// ---- 3. Play: hears, goes round the wall, spots, chases, attacks, loses, returns ------------------
	await setPlayer(page, [6, 1.6, 0]); // behind the wall: out of the cone, out of sight, 12 m away
	await page.locator('#play-button').click();
	await h.eventually(() => dbg(page), (d) => d?.active === true, '3.1 Play makes the runtime active', 15000);
	await h.eventually(() => dbg(page), (d) => d?.bake?.status === 'ready' && d.bake.triangles > 0, '3.2 the navmesh bakes in the worker', 30000);
	const d1 = await dbg(page);
	console.log('  bake: ' + JSON.stringify({ ms: d1?.bake?.ms, tris: d1?.bake?.triangles, area: Math.round(d1?.bake?.area ?? 0), worker: d1?.worker }));
	h.check(d1?.worker?.started === true && d1.worker.errors === 0, '3.2b the worker started only now, with no errors');
	await page.waitForTimeout(2500);
	const g0 = agentOf(await dbg(page), ids['Guard']);
	h.check(g0?.state === 'idle' && near(g0.feet, [-6, 0, 0], 0.5), '3.3 a player behind the wall goes unseen: the guard stays home, idle (' + JSON.stringify({ s: g0?.state, f: g0?.feet }) + ')');

	await page.evaluate(() => window.__navigation.rt.noise([6, 0, 0], 3));
	/** @type {number[][]} */
	const track = [];
	let crossed = null;
	const t0 = Date.now();
	let last = null;
	while (Date.now() - t0 < 40000) {
		const d = await dbg(page);
		const g = agentOf(d, ids['Guard']);
		if (g?.feet && track.length % 8 === 0) console.log('    t+' + Math.round((Date.now() - t0) / 1000) + 's ' + JSON.stringify({ s: g.state, l: g.label, f: g.feet, goal: g.goal, reach: g.reach }));
		if (g?.feet) {
			if (track.length && track[track.length - 1][0] < 0 && g.feet[0] >= 0 && crossed === null) crossed = g.feet[2];
			track.push(g.feet);
		}
		last = d;
		if ((d?.stats?.events?.attack ?? 0) > 0) break;
		await page.waitForTimeout(250);
	}
	const ev = last?.stats?.events ?? {};
	console.log('  events: ' + JSON.stringify(ev) + ' crossed x=0 at z=' + crossed + ' (' + track.length + ' samples)');
	h.check((ev.heard ?? 0) > 0, '3.4 it HEARD the noise (loud noises reach further than its 6 m)');
	h.check(crossed !== null && Math.abs(crossed) > 5.2, '3.5 it walked ROUND the wall (crossed x = 0 at z = ' + crossed + ', the wall ends at |z| = 5)');
	h.check((ev.spotted ?? 0) > 0, '3.6 round the corner it SAW the player (spotted)');
	h.check((ev.attack ?? 0) > 0, '3.7 it chased and attacked in range (attack events: ' + (ev.attack ?? 0) + ')');
	const gA = agentOf(last, ids['Guard']);
	h.check(near(gA?.feet, [6, 0, 0], 2.2), '3.8 it stands by the player when it attacks (' + JSON.stringify(gA?.feet) + ')');

	await setPlayer(page, [0, 60, 0]); // gone: out of sight, out of hearing, past the chase range
	const back = await until(
		async () => {
			const d = await dbg(page);
			return { ev: d?.stats?.events ?? {}, g: agentOf(d, ids['Guard']) };
		},
		(v) => (v.ev.returned ?? 0) > (ev.returned ?? 0) && v.g?.state === 'idle',
		'3.9 it lost the player, gave up and walked back home (returned)',
		45000
	);
	h.check((back?.ev?.lost ?? 0) > (ev.lost ?? 0) && (back?.ev?.gaveup ?? 0) > (ev.gaveup ?? 0), '3.10 lost then gave up, in that story (' + JSON.stringify(back?.ev) + ')');
	h.check(near(back?.g?.feet, [-6, 0, 0], 0.7), '3.11 it is home again (' + JSON.stringify(back?.g?.feet) + ')');

	// ---- 4. unreachable: the player in the cage, in plain sight ------------------------------------------
	await setPlayer(page, [-6, 1.6, 8]);
	const un = await until(
		async () => {
			const d = await dbg(page);
			return { ev: d?.stats?.events ?? {}, g: agentOf(d, ids['Guard']), shown: d?.shown?.find((s) => s.uuid === ids['Guard']) };
		},
		(v) => (v.ev.unreachable ?? 0) > 0 && !!v.g?.why,
		'4.1 a player it cannot reach fires "unreachable"',
		30000
	);
	console.log('  unreachable: ' + JSON.stringify({ g: un?.g, shown: un?.shown }));
	h.check(/off mesh|blocked|too far/.test(un?.g?.why ?? ''), '4.2 with a reason (' + un?.g?.why + ')');
	h.check(/can.t reach|unreachable/.test(un?.shown?.label ?? '') && (un?.shown?.why ?? '') === un?.g?.why, '4.3 every peer\'s label says why (' + un?.shown?.label + ' / ' + un?.shown?.why + ')');
	await until(async () => agentOf(await dbg(page), ids['Guard']), (g) => !!g?.goal && near(g.feet, g.goal, 0.6), '4.3b it walks to the closest point it can reach (outside the cage)', 30000);
	await page.waitForTimeout(1000);
	const s1 = agentOf(await dbg(page), ids['Guard'])?.feet;
	const samples = [];
	for (let i = 0; i < 8; i++) {
		await page.waitForTimeout(250);
		samples.push(agentOf(await dbg(page), ids['Guard'])?.feet);
	}
	const drift = Math.max(...samples.map((f) => (f && s1 ? Math.hypot(f[0] - s1[0], f[2] - s1[2]) : 99)));
	h.check(near(s1, [-6, 0, 5.6], 1.2) && drift < 0.08, '4.4 it waits at the closest point with no jitter (' + JSON.stringify(s1) + ', drift ' + drift.toFixed(3) + ' m over 2 s)');
	await setPlayer(page, [0, 60, 0]);

	// ---- 5. patrol on a Path; moving the Path moves the patrol ------------------------------------------
	const madeW = await exec('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Walker', params: [0.6, 1.6, 0.6], position: [8, 0.8, -9], color: '#4080d0' }] });
	ids['Walker'] = madeW?.created?.[0]?.uuid;
	const w = await exec('set_npc', { object: ids['Walker'], path: 'new' });
	const pathUuid = w?.npc?.path;
	h.check(!w?.error && typeof pathUuid === 'string' && pathUuid.length > 8, '5.1 path "new" draws a loop Path and patrols it (' + (w?.error ?? w?.note) + ')');
	const pts0 = await page.evaluate((p) => window.__navigation.api.paths.of(p)?.points?.map((q) => q.pos) ?? null, pathUuid);
	const pat = await until(
		async () => agentOf(await dbg(page), ids['Walker']),
		(a) => a?.state === 'patrol' && a.wp >= 0 && !!a.target,
		'5.2 the Walker patrols (a waypoint target)',
		20000
	);
	h.check(!!pts0 && pts0.some((p) => near(p, pat?.target, 0.4)), '5.3 its target is a point of the Path (' + JSON.stringify(pat?.target) + ')');
	await exec('update_objects', { updates: [{ uuid: pathUuid, position: [4, 0, 0] }] });
	const pts1 = await until(() => page.evaluate((p) => window.__navigation.api.paths.of(p)?.points?.map((q) => q.pos) ?? null, pathUuid), (p) => !!p && Math.hypot(p[0][0] - pts0[0][0], p[0][2] - pts0[0][2]) > 3, '5.4 the Path moved', 8000);
	const pat2 = await until(
		async () => agentOf(await dbg(page), ids['Walker']),
		(a) => !!a?.target && pts1.some((p) => near(p, a.target, 0.4)),
		'5.5 the patrol follows the edited Path (its next target is a moved point)',
		20000
	);
	console.log('  patrol target after the edit: ' + JSON.stringify(pat2?.target));

	// ---- 6. a crate blocks the pen's door, then frees it --------------------------------------------------
	// the pen: x 4..8, z 6..10 (inside the ground), door 1.4 m wide on the west wall at z = 8
	const bakedAt = (await dbg(page))?.bake?.at ?? 0;
	const pen = await exec('create_objects', {
		objects: [
			{ kind: 'primitive', primitive: 'Box', name: 'Pen N', params: [4.4, 2, 0.3], position: [6, 1, 10.1], physics: 'static' },
			{ kind: 'primitive', primitive: 'Box', name: 'Pen S', params: [4.4, 2, 0.3], position: [6, 1, 5.9], physics: 'static' },
			{ kind: 'primitive', primitive: 'Box', name: 'Pen E', params: [0.3, 2, 4.4], position: [8.1, 1, 8], physics: 'static' },
			{ kind: 'primitive', primitive: 'Box', name: 'Pen W1', params: [0.3, 2, 1.3], position: [3.9, 1, 6.55], physics: 'static' },
			{ kind: 'primitive', primitive: 'Box', name: 'Pen W2', params: [0.3, 2, 1.3], position: [3.9, 1, 9.45], physics: 'static' },
			{ kind: 'primitive', primitive: 'Box', name: 'Crate', params: [1.2, 1.2, 1.6], position: [3.9, 0.6, 8], physics: 'dynamic' },
			{ kind: 'primitive', primitive: 'Box', name: 'Goal', params: [0.3, 0.3, 0.3], position: [6, 0.15, 8], color: '#40d080' },
			{ kind: 'primitive', primitive: 'Box', name: 'Runner', params: [0.5, 1.2, 0.5], position: [-2, 0.6, 9], color: '#d0d040' }
		]
	});
	for (const c of pen?.created ?? []) ids[c.name] = c.uuid;
	// the pen is new scenery: the navmesh rebakes (debounced) before anyone may walk it
	await until(async () => (await dbg(page))?.bake, (b) => b?.status === 'ready' && b.at > bakedAt, '6.0 the navmesh rebakes with the pen in it', 30000);
	const added = await page.evaluate(([runner, goal]) => window.__navigation.api.flow.addNodes({ graphId: runner, nodes: [{ type: 'navmoveto', x: 0, y: 0, data: { target: goal, speed: 2.5, enabled: true } }] }), [ids['Runner'], ids['Goal']]);
	h.check(Array.isArray(added) && added.length === 1, '6.1 a Move To node on the Runner (into a graph it did not have)');
	const blocked = await until(
		async () => {
			const d = await dbg(page);
			return { a: agentOf(d, ids['Runner']), obstacles: d?.obstacles, ev: d?.stats?.events ?? {} };
		},
		(v) => !!v.a && v.obstacles > 0 && !!v.a.why,
		'6.2 the crate is a moving obstacle and the Goal is cut off',
		40000
	);
	console.log('  blocked: ' + JSON.stringify(blocked));
	h.check(/blocked|off mesh/.test(blocked?.a?.why ?? ''), '6.3 the Runner says why (' + blocked?.a?.why + ')');
	await exec('update_objects', { updates: [{ uuid: ids['Crate'], position: [0, 0.6, 12] }] });
	const freed = await until(
		async () => {
			const d = await dbg(page);
			return { a: agentOf(d, ids['Runner']), ev: d?.stats?.events ?? {} };
		},
		(v) => (v.ev.arrived ?? 0) > 0 && near(v.a?.feet, [6, 0, 8], 1.0),
		'6.4 the crate moved out of the door: the Runner walks in and arrives',
		40000
	);
	console.log('  freed: ' + JSON.stringify(freed?.a));

	// ---- 7. the debug view -------------------------------------------------------------------------------
	const ov0 = (await dbg(page))?.overlay;
	h.check(!(ov0?.npcLabels?.length > 0), '7.1 debug view off: no NPC labels (' + JSON.stringify(ov0?.npcLabels) + ')');
	await page.evaluate(() => window.__navigation.sheet.open(''));
	await page.locator('#nav-sheet-debug').check();
	const ov1 = await until(async () => (await dbg(page))?.overlay, (o) => (o?.npcLabels?.length ?? 0) >= 2, '7.2 debug view on: a label per NPC', 10000);
	console.log('  labels: ' + JSON.stringify(ov1?.npcLabels));
	h.check(ov1?.npcLabels?.some((l) => /idle|patrol|chase|return|alert|attack|unreachable|arrived|move/.test(JSON.stringify(l))), '7.3 the labels say each NPC\'s state');
	await page.locator('#nav-sheet-debug').uncheck();
	await h.eventually(async () => (await dbg(page))?.overlay, (o) => !(o?.npcLabels?.length > 0), '7.4 off again: the labels go', 10000);

	// ---- 8. two peers ------------------------------------------------------------------------------------
	await h.leavePlay(A);
	const B = await h.setupPage(browser, 'B');
	await h.installModule(B, 'navigation');
	await h.connect(A, B);
	await h.eventually(() => dbg(B.page), (d) => d?.navNodes >= 3, '8.1 B has the scene and its navigation nodes', 30000);
	await B.page.evaluate(() => {
		const loop = () => {
			const p = window.__navPlayerHold;
			if (p) {
				let cam;
				window.__tp.test.v1.globalCamera.subscribe((v) => (cam = v))();
				if (cam) {
					cam.position.set(p[0], p[1], p[2]);
					cam.updateMatrixWorld(true);
				}
			}
			setTimeout(loop, 50);
		};
		loop();
	});
	await setPlayer(B.page, [0, 60, 0]);
	await page.locator('#play-button').click();
	await B.page.locator('#play-button').click();
	await h.eventually(async () => [await dbg(page), await dbg(B.page)], ([a, b]) => a?.active && b?.active && a.authority === b.authority, '8.2 both play and agree on ONE stepper', 20000);
	const [da, db] = [await dbg(page), await dbg(B.page)];
	const stepper = da.authority === da.me ? 'A' : 'B';
	console.log('  stepper: ' + stepper + ' (A ' + da.me + ', B ' + db.me + ')');
	const S = stepper === 'A' ? page : B.page;
	const V = stepper === 'A' ? B.page : page;
	await setPlayer(V, [0, 60, 0]);
	await setPlayer(S, [0, 60, 0]);
	const agreed = await until(
		async () => {
			const s = agentOf(await dbg(S), ids['Walker']);
			const v = (await dbg(V))?.shown?.find((x) => x.uuid === ids['Walker']);
			return { s: s?.feet, v: v?.disp, state: v?.state };
		},
		(x) => !!x.s && !!x.v && near(x.s, x.v, 0.8),
		'8.3 the other peer draws the patrolling Walker where the stepper\'s crowd has it',
		30000
	);
	console.log('  agree: ' + JSON.stringify(agreed));
	const vs0 = (await dbg(V))?.stats;
	await V.waitForTimeout(6000);
	const vs1 = (await dbg(V))?.stats;
	const vs = { snapsGot: (vs1?.snapsGot ?? 0) - (vs0?.snapsGot ?? 0), steps: (vs1?.steps ?? 0) - (vs0?.steps ?? 0) };
	h.check(vs.snapsGot >= 2 && vs.steps === 0, '8.4 the viewer only eases between snapshots, it never steps (' + JSON.stringify({ got: vs?.snapsGot, steps: vs?.steps }) + ')');

	await h.finish(browser);
});
