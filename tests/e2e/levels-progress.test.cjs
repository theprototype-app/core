// 93 — LEVELS AND PROGRESS on real pages (roadmap 93's proof list; the rules themselves are unit tests:
// levelsTable / levelsKeep / levelsPortals / levelsAgent / levelsPortalShow).
//
//   1. ONE TABLE, TWO WRITERS, TWO PEERS: the agent's game_setup {levels} (set_levels) writes the Levels
//      table on A; a Kit: Levels "Next level" node acting on B moves BOTH peers to level 2 of that same
//      table (78 F19: no module code). The agent's set_checkpoint places the two start pads.
//   2. A PORTAL WITH KEPT STATE (one player): walking into a portal hops this player to another project
//      scene; the keep list carries the score, the inventory and `coins` and drops what it does not name; the arrival is a checkpoint.
//   3. THE LOADING SCREEN ON REAL PROGRESS: the hop to a 200-object scene shows the author's screen with
//      progress the load itself reports (several values between 0 and 1, rising), at least 0.4 s; a second
//      trip to a scene already loaded shows none.
//   4. CHECKPOINTS: stepping on a pad makes it this player's respawn point; "Back to checkpoint" (the kit
//      node's path) flies them back there.
//   5. NEW GAME: the first level again, the kept score / inventory / variables reset, the checkpoint forgotten.
//
// The export half (a checkpoint surviving a reload, an old save with a removed level) is levels-export.
// TIMING: h.GPU_ARGS (two pages + a 200-object load).
const h = require('./helpers.cjs');

const tool = (peer, name, args) =>
	peer.page.evaluate(([n, a]) => window.__stores.aiTools.executeAiTool(n, a), [name, args]);

const read = (peer, fn, arg) => peer.page.evaluate(fn, arg);

const kitLevel = (peer) => read(peer, () => window.__stores.kit.kit.impls.levels?.current?.() ?? null);
const tableIds = (peer) =>
	read(peer, () => {
		let s;
		window.__stores.scenePhysics.scenePhysicsState_.subscribe((v) => (s = v))();
		return (s?.levels?.list ?? []).map((r) => r.id);
	});
const spawnOf = (peer) =>
	read(peer, () => {
		let s;
		window.__stores.playSettings.runtimeSpawn.subscribe((v) => (s = v))();
		return s ? { position: s.position, owner: s.owner } : null;
	});
const sceneName = (peer) =>
	read(peer, () => {
		let c;
		window.__stores.levels.currentLevel.subscribe((v) => (c = v))();
		return c?.name ?? '';
	});
const vars = (peer) =>
	read(peer, () => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return { ...(g?.vars ?? {}) };
	});
const point = (peer) => read(peer, () => window.__stores.levelsCheckpoints.checkpointsForTest().point);
const camAt = (peer) =>
	read(peer, () => {
		let cam;
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		return cam.position.toArray().map((n) => Math.round(n * 100) / 100);
	});
/** put this player's eye at a spot (Interact: the editor camera IS the player) */
const stand = (peer, eye) =>
	read(peer, (e) => {
		let cam;
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		cam.position.set(e[0], e[1], e[2]);
		cam.updateMatrixWorld(true);
	}, eye);
const near = (a, b, tol) => !!a && !!b && Math.hypot(a[0] - b[0], a[2] - b[2]) <= tol;

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// =====================================================================
	// 1. the agent's table + the Next level node, two peers
	// =====================================================================
	console.log('\n=== 1. one Levels table: the agent writes it, a node on the other peer drives it ===');
	const pad1 = await tool(A, 'set_checkpoint', { position: [0, 0, 0], name: 'Start pad' });
	const pad2 = await tool(A, 'set_checkpoint', { position: [6, 0, -6], name: 'Ledge pad', yaw: Math.PI / 2 });
	h.check(!pad1.error && !pad2.error && !!pad1.uuid && !!pad2.uuid, `set_checkpoint placed two pads (${pad1.error || pad1.name} / ${pad2.error || pad2.name})`);
	const set = await tool(A, 'set_levels', { levels: [{ name: 'Start', spawn: 'Start pad' }, { name: 'Ledge', spawn: 'Ledge pad', goal: 'Reach the ledge' }], keep: ['score'] });
	h.check(!set.error && set.levels?.list?.length === 2, 'set_levels wrote a two-level table: ' + (set.error || set.note));
	await h.eventually(() => tableIds(B), (ids) => ids.join() === 'start,ledge', 'B holds the agent\'s table (the scene-settings singleton replicated)', 10000);
	await h.eventually(
		() => read(B, (u) => !!window.__stores.objectsGroup && (() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return !!g.getObjectByProperty('uuid', u)?.userData?.checkpoint; })(), pad2.uuid),
		(v) => v === true,
		'B holds the agent\'s checkpoint pad with its record',
		10000
	);
	await A.page.evaluate(() => window.__stores.kit.kit.impls.levels.select('start'));
	await h.eventually(() => Promise.all([A, B].map(kitLevel)), (v) => v[0] === 'start' && v[1] === 'start', 'premise: both peers on level 1 (start)', 10000);
	// the node's own path into the kit (what a pulsed "Kit: Levels ▸ Next level" node runs), on B
	await B.page.evaluate(() => window.__stores.kit.kit.runNodeAction('kit-levels-next', {}, { rid: 'node:e2e-next:1' }));
	await h.eventually(() => Promise.all([A, B].map(kitLevel)), (v) => v[0] === 'ledge' && v[1] === 'ledge', 'Next level on B: BOTH peers on level 2 (ledge) of the agent\'s table', 10000);
	await h.eventually(
		() => Promise.all([A, B].map(spawnOf)),
		(v) => v.every((s) => s?.owner === 'levels' && near(s.position, [6, 0, -6], 0.3)),
		'…and each peer\'s own spawn is the Ledge pad (the row\'s start object)',
		10000
	);
	await h.closePeer(B);

	// =====================================================================
	// 2-4. one player: a portal hop with the keep list, the loading screen, a checkpoint
	// =====================================================================
	const C = await h.setupPage(browser, 'C');
	console.log('\n=== 2. a portal with kept state ===');
	// the Cave: 200 boxes (a load that takes a moment) and its entrance pad
	for (let k = 0; k < 2; k++) {
		const objects = Array.from({ length: 100 }, (_, i) => ({ kind: 'primitive', primitive: 'Box', params: [0.4, 0.4, 0.4], position: [(i % 10) * 1.2 - 6 + k * 0.3, 0.2, Math.floor(i / 10) * 1.2 + 4] }));
		const made = await tool(C, 'create_objects', { objects });
		h.check(!made.error, `premise: 100 boxes for the Cave (${made.error || 'ok'})`);
	}
	const entrance = await tool(C, 'set_checkpoint', { position: [0, 0, -2], name: 'Cave entrance' });
	h.check(!entrance.error, 'premise: the Cave entrance pad');
	const cave = await C.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Cave'));
	h.check(!!cave?.hash, 'premise: the Cave saved as a project scene');
	const blank = await C.page.evaluate(() => window.__stores.levels.newLevel('Hub'));
	await C.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Hub'), blank.hash);
	await h.eventually(() => sceneName(C), (n) => n === 'Hub', 'premise: standing in an empty Hub', 15000);
	const hubSet = await tool(C, 'set_levels', { levels: [{ name: 'Hub', scene: 'Hub' }, { name: 'Cave', scene: 'Cave', spawn: 'Cave entrance' }], keep: ['score', 'inventory', 'var:coins'] });
	h.check(!hubSet.error, 'the Hub\'s table: Hub, Cave; keep score, inventory, coins (' + (hubSet.error || hubSet.note) + ')');
	const load = await tool(C, 'set_loading', { preset: 'bar', tips: ['Mind the stalactites'], title: 'Into the cave' });
	h.check(!load.error && load.loading?.preset === 'bar', 'set_loading: the bar with a tip (' + (load.error || load.note) + ')');
	const portal = await tool(C, 'set_portal', { position: [0, 0, -20], level: 'Cave', transition: 'iris' });
	h.check(!portal.error && portal.portal?.level === 'cave', 'set_portal: a doorway to the Cave level (' + (portal.error || portal.note) + ')');
	const hub = await C.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Hub'));
	h.check(!!hub?.hash, 'premise: the Hub saved');
	await C.page.evaluate(() => {
		const g = window.__stores.gameState;
		g.setGameVar('coins', 3);
		g.setGameVar('inventory', ['lamp']);
		g.setGameVar('junk', 9);
		window.__stores.kit.kit.impls.score.set(4);
		// the loading screen's samples, as the overlay sees them
		window.__lvSamples = [];
		window.__stores.levelsLoading.levelLoading.subscribe((s) => window.__lvSamples.push({ active: s.active, progress: s.progress, t: Date.now(), tips: s.config?.tips?.length ?? 0 }));
		window.__stores.objectActions.setEditorMode('interact');
	});
	await C.page.waitForTimeout(600);
	// a slower device (6x CPU) for the cold hop: on a fast GPU box the 200-object build finishes inside the
	// screen's first frames, and the bar has nothing between 0 and 1 to show
	const cdp = await C.page.context().newCDPSession(C.page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
	// straight into the doorway from far away (no preload first: the hop loads the scene cold)
	await stand(C, [0, 1.6, -20]);
	await h.eventually(() => sceneName(C), (n) => n === 'Cave', 'walking into the portal took this player to the Cave', 60000);
	await C.page.waitForFunction(() => window.__lvSamples.length > 0 && !window.__lvSamples[window.__lvSamples.length - 1].active, null, { timeout: 30000 }).catch(() => {});
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
	await h.eventually(() => kitLevel(C), (l) => l === 'cave', '…and the kit\'s current level is the Cave row', 10000);
	const v = await vars(C);
	h.check(v.coins === 3 && JSON.stringify(v.inventory) === '["lamp"]' && !('junk' in v), `the keep list carried coins and the inventory, and dropped junk (${JSON.stringify(v)})`);
	const score = () => read(C, () => window.__stores.kit.kit.impls.score.total());
	await h.eventually(score, (t) => t === 4, 'the kept score came through the hop (4)', 8000);
	await h.eventually(() => point(C), (a) => a?.kind === 'portal' || a?.name === 'Cave entrance', 'the arrival counts as a checkpoint', 8000);
	await h.eventually(() => spawnOf(C), (s) => near(s?.position, [0, 0, -2], 0.4), 'this player\'s spawn is the Cave entrance pad', 8000);

	console.log('\n=== 3. the loading screen ===');
	const samples = await C.page.evaluate(() => window.__lvSamples);
	const shown = samples.filter((s) => s.active);
	const mids = [...new Set(shown.map((s) => s.progress).filter((p) => p > 0 && p < 1))];
	const first = shown[0]?.t ?? 0;
	const off = samples.find((s, i) => i > 0 && !s.active && samples[i - 1].active)?.t ?? 0;
	h.check(shown.length > 0 && shown[0].tips === 1, `the author's screen showed during the cold hop (${shown.length} samples, tips ${shown[0]?.tips})`);
	h.check(mids.length >= 2, `its progress came from the load: ${mids.length} values between 0 and 1 (${mids.slice(0, 8).map((p) => p.toFixed(2))})`);
	h.check(shown.every((s, i) => i === 0 || s.progress >= shown[i - 1].progress), 'progress only rises');
	h.check(shown.some((s) => s.progress === 1), 'it reached 1 before going away');
	h.check(off - first >= 380, `shown at least ~0.4 s (${off - first} ms)`);

	// back to the Hub and into the Cave again: the Cave is loaded already, so no screen
	await C.page.evaluate(() => window.__stores.levelsTravel.goToLevel('hub'));
	await h.eventually(() => sceneName(C), (n) => n === 'Hub', 'premise: back in the Hub (Go to level)', 30000);
	await C.page.evaluate(() => (window.__lvSamples = []));
	await C.page.evaluate(() => window.__stores.levelsTravel.goToLevel('cave'));
	await h.eventually(() => sceneName(C), (n) => n === 'Cave', 'premise: the Cave again', 30000);
	const again = await C.page.evaluate(() => window.__lvSamples.filter((s) => s.active).length);
	h.check(again === 0, `a scene already loaded shows no loading screen (${again} samples)`);

	console.log('\n=== 4. a checkpoint, and Back to checkpoint ===');
	const mid = await tool(C, 'set_checkpoint', { position: [8, 0, 8], name: 'Mid', label: 'Halfway' });
	h.check(!mid.error, 'premise: a Mid checkpoint in the Cave');
	await C.page.waitForTimeout(700); // the trigger scan picks it up (twice a second)
	await stand(C, [8, 1.6, 8]);
	await h.eventually(() => point(C), (p) => p?.kind === 'checkpoint' && p.name === 'Mid', 'stepping on it made Mid this player\'s checkpoint', 8000);
	const flash = await C.page.evaluate(() => {
		let f;
		window.__stores.levelsCheckpoints.checkpointFlash.subscribe((v) => (f = v))();
		return f?.name ?? '';
	});
	h.check(flash === 'Halfway', `the flash says its label (${flash})`);
	await stand(C, [-12, 1.6, -12]);
	await C.page.waitForTimeout(400);
	await C.page.evaluate(() => window.__stores.kit.kit.runNodeAction('kit-levels-respawn', {}, { rid: 'node:e2e-respawn:1' }));
	await h.eventually(() => camAt(C), (p) => near(p, [8, 0, 8], 3), 'Back to checkpoint flew this player back to Mid', 8000);

	console.log('\n=== 4b. the save cap, told to the author ===');
	// a kept variable past 256 KB: the editor measures the save at the checkpoint (writes nothing) and the
	// Levels panel says why an exported game would not keep it
	await C.page.evaluate(() => window.__stores.gameState.setGameVar('coins', 'x'.repeat(300 * 1024)));
	await C.page.evaluate(() => window.__stores.levelsCheckpoints.saveProgress());
	await C.page.evaluate(() => window.__stores.openSceneSection('Levels'));
	await h.eventually(
		() => C.page.evaluate(() => document.getElementById('levels-save-problem')?.textContent ?? ''),
		(t) => /over the 256 KB/.test(t),
		'the Levels panel tells the author the save is over 256 KB',
		10000
	);
	await C.page.evaluate(() => window.__stores.gameState.setGameVar('coins', 3));
	await C.page.evaluate(() => window.__stores.levelsCheckpoints.saveProgress());
	await h.eventually(() => C.page.evaluate(() => !!document.getElementById('levels-save-problem')), (on) => !on, '…and the warning goes once it fits again', 8000);

	console.log('\n=== 5. New game ===');
	await C.page.evaluate(() => window.__stores.kit.kit.runNodeAction('kit-levels-newGame', {}, { rid: 'node:e2e-new:1' }));
	await h.eventually(() => sceneName(C), (n) => n === 'Hub', 'New game: back at the first level (the Hub)', 30000);
	const fresh = await vars(C);
	h.check(!('coins' in fresh) && !('inventory' in fresh), `New game reset the kept variables (${JSON.stringify(fresh)})`);
	await h.eventually(score, (t) => t === 0, 'New game reset the kept score', 8000);
	h.check(!(await point(C)), 'New game forgot the checkpoint');

	await h.finish(browser);
});
