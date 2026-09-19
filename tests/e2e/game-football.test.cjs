// 24-B B4 ACCEPTANCE — the Football game (VR football on the knock; the RULES are the
// `football` module, the physics is the template's data). Driven through the REAL
// artefacts and nothing authored in-test:
//   the scene  — games/football/scene.tpscene from the scenes FEED (SCENES_BASE, tag v2),
//                or FOOTBALL_TPSCENE=<path>, or a sibling scenes checkout as the fallback
//   the module — football.zip: FOOTBALL_ZIP=<path>, a sibling modules checkout's packed zip
//                (`npm run pack -- football` there), or the modules CDN
// installed on TWO peers plus a LATE JOINER. Skip-never-fail: when the scene or the zip
// cannot be reached the suite prints why and exits green — authored content and the
// network must never turn a bare checkout red.
//
// What it proves (the modules test-flight's cases, on the real file, plus the HUD):
//   1 the world arrives whole: 41 objects, the knock block ON, zero-g, the module owns
//     ball / two gates / four buttons, and B receives it all over the handshake
//   2 the HUD: the menu screen, joining through a real HUD button click (A) and through
//     the physical button's click path (B), Start -> the playing screen, P toggles the
//     pause menu and Resume closes it
//   3 the match: Start serves, B's hit sets lastTouch on BOTH, the ball into the red gate
//     scores for blue in B's OWN row only, a defender's touch is an own goal, a goal
//     with NO touch scores for the team and credits NOBODY (counterfactual), `ignore`
//     own goals, duel refuses a second red, the lamps and the DOM HUD list agree
//   4 the late joiner: C joins mid-match, reads score/slots, and is told the sim runs
//     (the A2 handshake `simulate` push) — so its OWN knock is live and attributes;
//     counterfactual: with that push's effect removed, C's probe is dead
//   5 time mode ends the match for all three -> the over screen, the saved log; New
//     match on the over screen resets to menu
// Game-shell transitions are asserted on the TRIGGER LOG (the fbevent stamps), never on
// a perRound flowValue (the Stars Room lesson: a perRound read flips back the instant a
// round ends).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_BASE = (process.env.FOOTBALL_SCENES_BASE || 'https://cdn.jsdelivr.net/gh/theprototype-app/scenes@v2').replace(/\/$/, '');
const MODULES_BASE = (process.env.FOOTBALL_MODULES_BASE || 'https://cdn.jsdelivr.net/gh/theprototype-app/modules@main').replace(/\/$/, '');
const ROOT = path.resolve(__dirname, '../../..');

/** bytes from a URL, or null with the reason logged (never throws) */
async function fetchBytes(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
		if (!res.ok) {
			console.log('  (source) ' + url + ' -> HTTP ' + res.status);
			return null;
		}
		return Buffer.from(await res.arrayBuffer());
	} catch (error) {
		console.log('  (source) ' + url + ' -> ' + error.message);
		return null;
	}
}

/** the scene: env override -> the feed -> a sibling scenes checkout */
async function sceneBytes() {
	if (process.env.FOOTBALL_TPSCENE) {
		const p = process.env.FOOTBALL_TPSCENE;
		return fs.existsSync(p) ? { bytes: fs.readFileSync(p), from: p } : null;
	}
	const feed = await fetchBytes(SCENES_BASE + '/games/football/scene.tpscene');
	if (feed) return { bytes: feed, from: SCENES_BASE };
	for (const dir of ['theprototype.app-scenes', 'scenes']) {
		const p = path.join(ROOT, dir, 'games/football/scene.tpscene');
		if (fs.existsSync(p)) return { bytes: fs.readFileSync(p), from: p };
	}
	return null;
}

/** the module zip: env override -> a packed sibling modules checkout -> the modules CDN */
async function zipBytes() {
	if (process.env.FOOTBALL_ZIP) {
		const p = process.env.FOOTBALL_ZIP;
		return fs.existsSync(p) ? { bytes: fs.readFileSync(p), from: p } : null;
	}
	const local = [h.moduleZipPath('football')];
	for (const dir of fs.readdirSync(ROOT)) if (/^(theprototype\.app-)?modules/.test(dir)) local.push(path.join(ROOT, dir, 'football.zip'));
	for (const p of local) if (p && fs.existsSync(p)) return { bytes: fs.readFileSync(p), from: p };
	const cdn = await fetchBytes(MODULES_BASE + '/football.zip');
	return cdn ? { bytes: cdn, from: MODULES_BASE } : null;
}

/** h.installModule with the bytes in hand (the helper only knows one folder) */
async function installZip(peer, bytes, label) {
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(true));
	await peer.page.waitForTimeout(400);
	await peer.page.getByRole('tab', { name: /^User/ }).click();
	await peer.page.waitForTimeout(200);
	await peer.page.locator('#install-module-zip').setInputFiles({ name: 'football.zip', mimeType: 'application/zip', buffer: bytes });
	await h.eventually(
		() => peer.page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id)),
		(ids) => ids.includes('football'),
		label + ': the football module installed from the real zip',
		20000
	);
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(false));
	await peer.page.waitForTimeout(300);
}

// ---- page probes -------------------------------------------------------------------------

const snap = (page) => page.evaluate(() => window.__football?.snapshot() ?? null);

/** name -> uuid for every object in the replicated group */
const namesOf = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return Object.fromEntries((g?.children ?? []).map((c) => [c.name, c.uuid]));
	});

/** an object clicked through the SAME dispatch the viewport and a VR ray use */
const clickObject = (page, uuid) =>
	page.evaluate((uuid) => {
		let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) return false;
		return window.__stores.moduleSDK.moduleClickHandlers.some((handler) => handler(object));
	}, uuid);

const posOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g?.getObjectByProperty('uuid', uuid)?.position.toArray() ?? null;
	}, uuid);

const speedOf = (page, uuid) =>
	page.evaluate((uuid) => {
		const b = window.__stores.physics.physicsDebug().find((e) => e.uuid === uuid);
		return b?.linvel ? Math.hypot(b.linvel.x, b.linvel.y, b.linvel.z) : null;
	}, uuid);

/** a knock probe swept along +x through the ball's CURRENT position at `speed` m/s —
 * core's feedProbe, the same code a hand runs */
const hitBall = (page, uuid, speed = 4) =>
	page.evaluate(
		({ uuid, speed }) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g?.getObjectByProperty('uuid', uuid);
			if (!o) return { hits: 0, armed: false };
			const k = window.__stores.knock;
			const id = 'gf-' + Math.random().toString(36).slice(2, 7);
			k.dropProbe(id);
			const [bx, by, bz] = o.position.toArray();
			let hits = 0;
			let armed = true;
			let t = 1000;
			const step = (speed * 16) / 1000;
			for (let x = bx - 1.2; x <= bx + 0.05; x += step) {
				const r = k.feedProbe(id, [x, by, bz], t);
				hits += r.hits;
				armed = armed && r.armed;
				t += 16;
			}
			k.dropProbe(id);
			return { hits, armed };
		},
		{ uuid, speed }
	);

/** A TOUCH that cannot miss: the authority parks the ball still at the centre, the hitter
 * waits until ITS copy of the ball is there, then sweeps. A sweep at a ball still flying
 * (a serve, a bounce) is refused BY DESIGN when it is not approaching fast enough, and on a
 * receiver the pose is the smoothed stream — so a bare sweep is a coin. Three tries. */
const touch = async (authority, hitter, uuid) => {
	let last = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		await h.eventually(() => snap(authority), (s) => s?.started && s.serveAt === 0, '  (premise) no serve pending', 10000);
		await authority.evaluate((uuid) => window.__stores.physics.applyThrow({ uuid, pos: [0, 1.35, 0], rot: [0, 0, 0], linvel: [0, 0, 0], angvel: [0, 0, 0] }), uuid);
		await h.eventually(() => posOf(hitter, uuid), (p) => !!p && Math.hypot(p[0], p[1] - 1.35, p[2]) < 0.05, '  (premise) the hitter sees the ball parked', 6000);
		await hitter.waitForTimeout(150);
		last = await hitBall(hitter, uuid, 4);
		if (last.hits >= 1) return last;
	}
	return last;
};

/** park the ball inside a gate sensor on the initiator — through the centre first, since
 * the goal detector is an ENTER edge per gate (the flight's lesson) */
const teleport = async (page, uuid, pos) => {
	await h.eventually(() => snap(page), (s) => s?.started && s.serveAt === 0, '  (premise) no serve pending', 10000);
	await page.evaluate(({ uuid, y }) => window.__stores.physics.applyThrow({ uuid, pos: [0, y, 0], rot: [0, 0, 0], linvel: [0, 0, 0], angvel: [0, 0, 0] }), { uuid, y: pos[1] });
	await page.waitForTimeout(400);
	await page.evaluate(({ uuid, pos }) => window.__stores.physics.applyThrow({ uuid, pos, rot: [0, 0, 0], linvel: [0, 0, 0], angvel: [0, 0, 0] }), { uuid, pos });
};

const myVar = (page, name) => page.evaluate((name) => window.__stores.peerVars.peerVarsDebug().mine[name] ?? 0, name);
const rowOf = (page, name, id) => page.evaluate(({ name, id }) => window.__stores.peerVars.leaderboardRows(name).find((r) => r.id === id)?.value ?? 0, { name, id });

/** a rule edit on the live Match Rules node (the replicated nodedata merge) */
const setRules = (page, patch) =>
	page.evaluate((patch) => {
		let graphs;
		window.__stores.flowGraphs.subscribe((g) => (graphs = g))();
		for (const [graphId, graph] of Object.entries(graphs ?? {}))
			for (const n of graph.nodes ?? [])
				if (n.type === 'fbrules') {
					window.__stores.nodesHandler.setNodeData(n.id, patch, graphId);
					return true;
				}
		return false;
	}, patch);

/** the trigger log's stamp for a node, or null */
const stampOf = (page, id) =>
	page.evaluate((id) => {
		let t;
		window.__stores.flowTriggers.subscribe((v) => (t = v))();
		const s = t?.[id]?.lastT;
		return typeof s === 'number' ? s : null;
	}, id);

const gameStateOf = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return g?.state ?? null;
	});
const screenOf = (page) => page.evaluate(() => window.__stores.hudDocs.visibleScreen('scene')?.id ?? null);
const hudText = async (page) => (await page.locator('#hud-layer').textContent().catch(() => '')) ?? '';
const pressP = (page) =>
	page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', bubbles: true }));
	});
/** whether this page steps a world, and whose world it believes it is watching */
const simOf = (page) =>
	page.evaluate(() => {
		const p = window.__stores.physics;
		let own, remote;
		p.simulating.subscribe((v) => (own = v))();
		p.remoteSimulating.subscribe((v) => (remote = v))();
		return { own: !!own, remote: remote ?? null };
	});
const hudButton = (page, name) => page.getByRole('button', { name, exact: true });

h.run(async () => {
	const scene = await sceneBytes();
	if (!scene) {
		console.log('SKIP: games/football/scene.tpscene unreachable (feed ' + SCENES_BASE + ', no FOOTBALL_TPSCENE, no sibling scenes checkout)');
		return;
	}
	const zip = await zipBytes();
	if (!zip) {
		console.log('SKIP: football.zip unreachable (no FOOTBALL_ZIP, no packed sibling modules checkout, modules CDN ' + MODULES_BASE + ')');
		return;
	}
	console.log('  scene from ' + scene.from + ' (' + scene.bytes.length + ' bytes)');
	console.log('  module from ' + zip.from + ' (' + zip.bytes.length + ' bytes)');

	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B');
	await installZip(A, zip.bytes, 'A');
	await installZip(B, zip.bytes, 'B');

	// ---- 1. the world ------------------------------------------------------------------------
	await A.page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, Array.from(scene.bytes));
	await A.page.waitForTimeout(2000);
	const names = await namesOf(A.page);
	const ball = names['Football'];
	const redGate = names['Red gate'];
	const blueGate = names['Blue gate'];
	h.check(Object.keys(names).length === 41, `1.1 the file restored 41 objects (${Object.keys(names).length})`);
	const phys = await A.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug());
	h.check(phys.gravity === 0 && phys.ground?.enabled === false && phys.ccd === true, `1.2 zero-g, no ground, CCD on (${phys.gravity}, ${phys.ground?.enabled}, ${phys.ccd})`);
	h.check(phys.knock?.enabled === true && phys.knock.maxSpeed === 10 && Math.abs(phys.knock.spin - 0.8) < 1e-9, `1.3 the knock block ON from the file — the ball curls (${JSON.stringify(phys.knock)})`);
	h.check(phys.play?.simOnPlay === true, '1.4 simOnPlay: entering play starts the sim');
	await h.eventually(() => snap(A.page), (s) => s?.ball === ball && Object.keys(s.gates).length === 2 && s.buttons.length === 4, '1.5 A: the module owns the file\'s ball, two gates and four buttons (its nodes are in the graph)');
	const a0 = await snap(A.page);
	h.check(a0.gates[redGate]?.team === 'red' && a0.gates[blueGate]?.team === 'blue', '1.6 the Team Gate nodes target the right sensors');
	h.check(a0.hitSource === 'api.onHit', `1.7 the module reads hits through api.onHit (${a0.hitSource})`);
	h.check((await gameStateOf(A.page)) === 'menu', '1.8 the game shell starts in menu');

	// the template's damping (0.35) lets a served ball score on its own inside the 5 m box,
	// which is the game working and makes an expected score a lottery: the flight's value
	await A.page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ damping: { linear: 1.2, angular: 0.5 } }));
	h.check(await setRules(A.page, { serveSpeed: 0.8 }), '1.9 a gentle kick-off written on the live Match Rules node');

	await h.connect(A, B);
	await h.eventually(() => namesOf(B.page).then((n) => n['Football']), (u) => u === ball, '1.10 B received the pitch with the same ball uuid', 30000);
	await h.eventually(() => snap(B.page), (s) => s?.ball === ball && Object.keys(s.gates).length === 2 && s.buttons.length === 4 && s.rules.serveSpeed === 0.8, '1.11 B: the graph replicated — same ball, gates, buttons and rules', 20000);
	await h.eventually(() => B.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug()), (p) => p.gravity === 0 && p.knock?.enabled === true, '1.12 B: the physics block reached B');

	// ---- 2. play + the menu screen -----------------------------------------------------------
	// Play is entered in ORDER: A first, and B only once it has HEARD that A simulates.
	// Two Play presses inside the sim's start-up window both pass maybeSimOnPlay's
	// "nothing is running anywhere" guard (the `simulate` message has not landed yet), so
	// BOTH peers simulate and every body is fought over by two authorities — measured
	// here: a parked ball snapped back under a permanent `hold: external` fed by the other
	// simulator's 30 Hz moves, and no goal could score. A core race, recorded for the
	// integrator; this suite asserts the single-simulator premise instead of riding it.
	await A.page.locator('#play-button').click();
	await h.eventually(() => simOf(A.page), (v) => v.own === true, '2.1 A simulates (simOnPlay)');
	await h.eventually(() => simOf(B.page), (v) => v.remote === A.id, '2.2 B knows A simulates');
	await B.page.locator('#play-button').click();
	await B.page.waitForTimeout(1500);
	const bSim = await simOf(B.page);
	h.check(bSim.own === false && bSim.remote === A.id, `2.2b B entering play does NOT start a second simulation (${JSON.stringify(bSim)})`);
	await h.eventually(() => snap(A.page), (s) => s?.authority === true, '2.3 A is the match authority');
	await h.eventually(() => screenOf(A.page), (v) => v === 'menu', '2.4 A sees the menu screen', 6000);
	h.check(/FOOTBALL/.test(await hudText(A.page)) && /Join RED/.test(await hudText(A.page)), '2.5 the menu renders its title and the Join buttons');

	// A joins through the DOM HUD button (perPlayer press -> Match Button), B through the
	// physical button's click path (the one a VR ray and a viewport click share)
	await hudButton(A.page, 'Join RED').click();
	h.check(await clickObject(B.page, names['Join blue']), '2.6 B clicks the physical Join blue button (a module click handler consumed it)');
	await h.eventually(() => snap(A.page), (s) => s?.slots.red[0] === A.id && s?.slots.blue[0] === B.id, '2.7 A: red = A (HUD button), blue = B (physical button)');
	await h.eventually(() => snap(B.page), (s) => s?.slots.red[0] === A.id && s?.slots.blue[0] === B.id, '2.8 B agrees');
	h.check(!(await snap(A.page)).slots.blue.includes(A.id), '2.9 counterfactual: the perPlayer HUD press moved only its presser');

	// ---- 3. Start: the trigger log, the playing screen, the serve -----------------------------
	const startBefore = await stampOf(B.page, 'evstart');
	await hudButton(A.page, 'Start match').click();
	await h.eventually(() => snap(B.page), (s) => s?.started === true, '3.1 B: the match started');
	await h.eventually(() => stampOf(B.page, 'evstart'), (t) => t !== null && t !== startBefore, '3.2 B: the "On match start" stamp landed in the TRIGGER LOG');
	await h.eventually(() => gameStateOf(B.page), (v) => v === 'playing', '3.3 ...and its Set Game State flipped the shell to playing on B');
	await h.eventually(() => screenOf(A.page), (v) => v === 'hud', '3.4 A sees the playing HUD', 6000);
	await h.eventually(() => snap(A.page), (s) => s?.serves >= 1, '3.5 A served the kick-off (serveDelay)', 8000);
	await h.eventually(() => speedOf(A.page, ball), (v) => v != null && v > 0.2, '3.6 the ball moves on the initiator');
	await h.eventually(() => hudText(A.page), (t) => /RED 0 — 0 BLUE/.test(t), '3.7 the HUD score list reads RED 0 — 0 BLUE');

	// ---- 3b. the P menu ------------------------------------------------------------------------
	const simState = (pg) => pg.evaluate(() => { const p = window.__stores.physics; let a, b, l, f; p.simulating.subscribe((v) => (a = v))(); p.remoteSimulating.subscribe((v) => (b = v))(); window.__stores.isLocked.subscribe((v) => (l = v))(); window.__stores.playPointerFree?.subscribe?.((v) => (f = v))(); return { sim: a, remote: b, locked: l, free: f }; });
	await pressP(A.page);
	await h.eventually(() => screenOf(A.page), (v) => v === 'pause', '3.8 P opens the pause menu', 6000);
	h.check(/PAUSED/.test(await hudText(A.page)) && /Quit to menu/.test(await hudText(A.page)), '3.9 the pause menu offers Resume / New match / Quit');
	// FINDING, recorded rather than wished away: the template's P is a Key Press node, whose
	// pulse REPLICATES (it is a trigger), so its Toggle-pause hudscreen acts on every peer —
	// one player's P opens the pause menu for the whole session (Resume closes it for all).
	await h.eventually(() => screenOf(B.page), (v) => v === 'pause', '3.10 P is SESSION-WIDE in this template: B\'s pause menu opened too (the keypress pulse replicates)', 6000);
	await hudButton(A.page, 'Resume').click();
	await h.eventually(() => screenOf(A.page), (v) => v === 'hud', '3.11 Resume closes it', 6000);
	await h.eventually(() => screenOf(B.page), (v) => v === 'hud', '3.11b ...for B too', 6000);
	h.check((await snap(A.page)).started === true, '3.12 the match kept running through the menu');


	// ---- 4. goals ---------------------------------------------------------------------------------
	const bHit = await touch(A.page, B.page, ball);
	await A.page.waitForTimeout(2000);
	h.check(bHit.armed && bHit.hits >= 1, `4.1 B's 4 m/s probe knocks the ball (${JSON.stringify(bHit)})`);
	await h.eventually(() => snap(A.page), (s) => s?.lastTouch?.by === B.id && s.lastTouch.team === 'blue', '4.2 A: lastTouch = B (blue) — the hit crossed the wire');
	await h.eventually(() => A.page.evaluate((u) => window.__stores.knock.lastHitOf(u)?.by ?? null, ball), (by) => by === B.id, '4.3 A\'s knock hit log names B (stamped from the connection)');
	const redPos = await posOf(A.page, redGate);
	await teleport(A.page, ball, redPos);
	await h.eventually(() => snap(B.page), (s) => s?.score.blue === 1 && s.score.red === 0, '4.4 the ball into the RED gate scores for BLUE (on B)');
	await h.eventually(() => myVar(B.page, 'goals'), (v) => v === 1, '4.5 B\'s OWN goals row = 1');
	h.check((await myVar(A.page, 'goals')) === 0, '4.6 A\'s goals row stays 0');
	await h.eventually(() => rowOf(A.page, 'goals', B.id), (v) => v === 1, '4.7 A\'s leaderboard shows B = 1');
	await h.eventually(() => hudText(A.page), (t) => /RED 0 — 1 BLUE/.test(t), '4.8 the DOM HUD score follows');
	const lamp = (page, name) =>
		page.evaluate((uuid) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g?.getObjectByProperty('uuid', uuid);
			return o ? { lit: o.material.userData.fbLit === true, intensity: o.material.emissiveIntensity } : null;
		}, names[name]);
	await h.eventually(() => lamp(B.page, 'Blue lamp 1'), (l) => l?.lit && l.intensity > 1, '4.9 B: Blue lamp 1 lit — the headset scoreboard reads the same score');
	h.check(!(await lamp(B.page, 'Blue lamp 2'))?.lit && !(await lamp(B.page, 'Red lamp 1'))?.lit, '4.10 counterfactual: Blue lamp 2 and Red lamp 1 stay dim');

	// a goal with NO touch since the serve: the team scores, NOBODY's sheet moves
	await h.eventually(() => snap(A.page), (s) => s?.started && s.serveAt === 0 && s.lastTouch === null, '4.11 (premise) re-served, and the serve cleared lastTouch', 8000);
	await teleport(A.page, ball, redPos);
	await h.eventually(() => snap(B.page), (s) => s?.score.blue === 2, '4.12 counterfactual: an untouched ball into the red gate still scores for blue');
	await B.page.waitForTimeout(600);
	h.check((await myVar(B.page, 'goals')) === 1 && (await myVar(A.page, 'goals')) === 0 && (await myVar(A.page, 'owngoals')) === 0, '4.13 ...and credits nobody: no attribution row moved (B goals 1, A goals 0, A owngoals 0)');

	// a defender's last touch is an own goal on the sheet
	await h.eventually(() => snap(A.page), (s) => s?.started && s.serveAt === 0, '  (premise) re-served', 8000);
	const aHit = await touch(A.page, A.page, ball);
	h.check(aHit.hits >= 1, `4.14 A (red) knocks the ball (${JSON.stringify(aHit)})`);
	await h.eventually(() => snap(B.page), (s) => s?.lastTouch?.by === A.id, '4.15 B: lastTouch = A');
	await teleport(A.page, ball, redPos);
	await h.eventually(() => snap(A.page), (s) => s?.score.blue === 3, '4.16 blue 3 — the own goal counts for blue');
	await h.eventually(() => myVar(A.page, 'owngoals'), (v) => v === 1, '4.17 A\'s owngoals row = 1, A\'s goals row still 0');
	h.check((await myVar(A.page, 'goals')) === 0, '4.18 (own goal is not a goal)');

	// ownGoals: ignore — the same shot scores nothing
	h.check(await setRules(A.page, { ownGoals: 'ignore' }), '4.19 ownGoals: ignore on the live node');
	await h.eventually(() => snap(B.page), (s) => s?.rules.ownGoals === 'ignore', '4.20 B reads it');
	await h.eventually(() => snap(A.page), (s) => s?.started && s.serveAt === 0, '  (premise) re-served', 8000);
	await touch(A.page, A.page, ball);
	await h.eventually(() => snap(A.page), (s) => s?.lastTouch?.by === A.id, '4.21 A touched it');
	const serves = (await snap(A.page)).serves;
	await teleport(A.page, ball, redPos);
	await h.eventually(() => snap(A.page), (s) => s?.serves > serves, '4.22 the goal was seen (re-served)...', 8000);
	h.check((await snap(A.page)).score.blue === 3 && (await myVar(A.page, 'owngoals')) === 1, '4.23 ...but neither the score nor the sheet moved');
	await setRules(A.page, { ownGoals: 'count' });

	// duel refuses a second red
	await setRules(A.page, { mode: 'duel' });
	await h.eventually(() => snap(B.page), (s) => s?.rules.mode === 'duel', '4.24 B reads mode duel');
	h.check(await clickObject(B.page, names['Join red']), '4.25 B presses Join red...');
	await B.page.waitForTimeout(800);
	const d = await snap(B.page);
	h.check(d.slots.red.length === 1 && d.slots.red[0] === A.id && d.slots.blue[0] === B.id, '4.26 ...and is refused: red is A alone, B still blue');
	await setRules(A.page, { mode: 'teams' });
	await h.eventually(() => snap(B.page), (s) => s?.rules.mode === 'teams', '4.27 back to teams');

	// ---- 5. the late joiner -------------------------------------------------------------------------
	const C = await h.setupPage(browser, 'C');
	await installZip(C, zip.bytes, 'C');
	// a peer in play cannot approve a request (the documented gotcha), and A must keep playing
	// to keep simulating — so B steps out of play and admits C; the mesh then links C to A,
	// whose handshake is what must tell C that a sim runs
	await B.page.evaluate(() => window.__stores.isLocked.set(false));
	await B.page.waitForTimeout(2500);
	await h.connect(C, B);
	await h.eventually(
		() => snap(C.page),
		(s) => !!s && s.started && s.score.blue === 3 && s.slots.red[0] === A.id && s.slots.blue[0] === B.id && s.ball === ball,
		'5.1 C reads the match mid-flight: started, blue 3, the slots, the ball',
		30000
	);
	await h.eventually(() => rowOf(C.page, 'goals', B.id), (v) => v === 1, '5.2 C sees B\'s goals row');
	await h.eventually(() => C.page.evaluate(() => new Promise((r) => window.__stores.physics.remoteSimulating.subscribe(r)())), (v) => v === A.id, '5.3 C was TOLD A simulates — no start happened since it joined (the handshake simulate push)');
	await h.eventually(() => gameStateOf(C.page), (v) => v === 'playing', '5.4 C\'s shell reads playing');
	await C.page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => screenOf(C.page), (v) => v === 'hud', '5.5 C lands on the playing HUD with no transition witnessed (showWhile)', 6000);
	await h.eventually(() => snap(A.page), (s) => s?.started && s.serveAt === 0, '  (premise) re-served', 8000);
	const cHit = await touch(A.page, C.page, ball);
	h.check(cHit.armed && cHit.hits >= 1, `5.6 C's knock is LIVE (${JSON.stringify(cHit)})`);
	await h.eventually(() => snap(A.page), (s) => s?.lastTouch?.by === C.id && s.lastTouch.team === null, '5.7 A: lastTouch = C, a spectator (no team)');
	// counterfactual: C as it would stand WITHOUT the push (remoteSimulating never set)
	await C.page.evaluate(() => window.__stores.physics.remoteSimulating.set(null));
	const dead = await hitBall(C.page, ball, 4);
	h.check(!dead.armed && dead.hits === 0, `5.8 counterfactual: without the simulate push C's probe is DEAD (${JSON.stringify(dead)})`);
	await C.page.evaluate((id) => window.__stores.physics.applySimulate({ running: true, paused: false, peerId: id }), A.id);
	await h.eventually(() => C.page.evaluate(() => new Promise((r) => window.__stores.physics.remoteSimulating.subscribe(r)())), (v) => v === A.id, '5.9 (restored)');

	// ---- 6. time mode ends the match for everyone ---------------------------------------------------
	const overBefore = await stampOf(C.page, 'evover');
	await setRules(A.page, { winBy: 'time', matchSeconds: 30 });
	await h.eventually(() => snap(A.page), (s) => s?.started === false && s.outcome?.reason === 'time' && s.outcome.winner === 'blue', '6.1 A: time is up — blue wins', 45000);
	await h.eventually(() => snap(B.page), (s) => s?.started === false && s.outcome?.winner === 'blue', '6.2 B: over');
	await h.eventually(() => snap(C.page), (s) => s?.started === false && s.outcome?.winner === 'blue', '6.3 C (the late joiner): over');
	await h.eventually(() => stampOf(C.page, 'evover'), (t) => t !== null && t !== overBefore, '6.4 C: the "On match over" stamp is in the TRIGGER LOG');
	await h.eventually(() => gameStateOf(B.page), (v) => v === 'over', '6.5 the shell reads over');
	await h.eventually(() => snap(B.page), (s) => s?.log.length === 1 && s.log[0].blue === 3 && s.log[0].winner === 'blue', '6.6 the saved match log carries the sheet (gameState.vars)');
	await h.eventually(() => screenOf(A.page), (v) => v === 'over', '6.7 A sees the over screen', 6000);
	h.check(/MATCH OVER/.test(await hudText(A.page)), '6.8 the over screen renders');

	// New match on the over screen: back to the menu, the sheet survives
	const newBefore = await stampOf(B.page, 'evnew');
	await hudButton(A.page, 'New match').click();
	await h.eventually(() => snap(B.page), (s) => s?.score.blue === 0 && s.started === false && s.outcome === null, '6.9 B: New match — score 0');
	await h.eventually(() => stampOf(B.page, 'evnew'), (t) => t !== null && t !== newBefore, '6.10 B: the "On new match" stamp landed in the trigger log');
	await h.eventually(() => gameStateOf(C.page), (v) => v === 'menu', '6.11 C: the shell is back in menu');
	await h.eventually(() => screenOf(A.page), (v) => v === 'menu', '6.12 A sees the menu again', 6000);
	h.check((await myVar(B.page, 'goals')) === 1 && (await snap(B.page)).log.length === 1, '6.13 the session sheet and the saved log survive a new match');

	for (const p of [A, B, C]) await p.page.evaluate(() => window.__stores.isLocked.set(false)).catch(() => {});
	await A.page.waitForTimeout(400);
	await h.finish(browser);
});
