// 21-C C6-b ACCEPTANCE — the Dungeon Realms game template: the TWO-MODULE case (the
// `dungeon` Kit generates + renders the world from the graph's Dungeon node; the
// `dungeon-realms` module plays it) on the REAL artefacts and nothing authored in-test:
//   the scene  — games/dungeon-realms/scene.tpscene from the scenes FEED (SCENES_BASE,
//                ref format-2), or DUNGEON_REALMS_TPSCENE=<path>, or a sibling scenes checkout
//   the zips   — dungeon.zip + dungeon-realms.zip: DUNGEON_KIT_ZIP / DUNGEON_REALMS_ZIP,
//                the MODULES_REPO checkout, a packed sibling modules checkout, or the CDN
// installed on TWO peers plus a LATE JOINER. Skip-never-fail: when the scene or a zip
// cannot be reached the suite prints why and exits green.
//
// What it proves:
//   1 the world arrives whole: the 6 arch objects, night env, the play block (click,
//     grounded, no sim), the HUD document, both modules in the file's requirement list —
//     and the Kit regenerated SEED 1337 FROM THE NODE after applySession's `/clear all`
//     (counterfactual: a menu-seeded dungeon loaded before the file is replaced, so the
//     "every game template silently starts elsewhere" failure is asserted, not believed)
//   2 B receives it over the handshake: same objects, same Kit checksum, same graph
//   3 play: the module menu, P1/P2 through it, Start -> the `drevent start` stamp in the
//     TRIGGER LOG -> Set Game State flips the shell to playing on BOTH -> the HUD screen;
//     the HUD Text elements read the Realms Value nodes (gems, need, level), the lists
//     read Realms HUD Rows (players, objective), grounded resolves true from the contract
//   4 a gem on A -> B's HUD text; the replicated gem EVENT counts once per pickup on both
//     (Counter -> HUD Text) — the fireNodeTrigger contract
//   5 P pauses / Resume; unseal -> portal click -> floor 2 on both (LEVEL 2 in the HUD);
//     the top floor's gems -> victory -> `drevent victory` -> the shell is `over`
//   6 the late joiner: C joins mid-game, reads the objects, the Kit seed + floor, the
//     collected gems and the game shell
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_BASE = (process.env.DUNGEON_REALMS_SCENES_BASE || 'https://cdn.jsdelivr.net/gh/theprototype-app/scenes@format-2').replace(/\/$/, '');
const MODULES_BASE = (process.env.DUNGEON_REALMS_MODULES_BASE || 'https://cdn.jsdelivr.net/gh/theprototype-app/modules@main').replace(/\/$/, '');
const ROOT = path.resolve(__dirname, '../../..');
const SEED = 1337;

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
	if (process.env.DUNGEON_REALMS_TPSCENE) {
		const p = process.env.DUNGEON_REALMS_TPSCENE;
		return fs.existsSync(p) ? { bytes: fs.readFileSync(p), from: p } : null;
	}
	const feed = await fetchBytes(SCENES_BASE + '/games/dungeon-realms/scene.tpscene');
	if (feed) return { bytes: feed, from: SCENES_BASE };
	for (const dir of ['theprototype.app-scenes', 'scenes']) {
		const p = path.join(ROOT, dir, 'games/dungeon-realms/scene.tpscene');
		if (fs.existsSync(p)) return { bytes: fs.readFileSync(p), from: p };
	}
	return null;
}

/** a module zip: env override -> MODULES_REPO -> a packed sibling modules checkout -> the CDN
 * @param {string} id @param {string} envKey */
async function zipBytes(id, envKey) {
	if (process.env[envKey]) {
		const p = process.env[envKey];
		return fs.existsSync(p) ? { bytes: fs.readFileSync(p), from: p } : null;
	}
	const local = [];
	if (process.env.MODULES_REPO) local.push(path.join(process.env.MODULES_REPO, id + '.zip'));
	local.push(h.moduleZipPath(id));
	for (const dir of fs.readdirSync(ROOT)) if (/^(theprototype\.app-)?modules/.test(dir)) local.push(path.join(ROOT, dir, id + '.zip'));
	for (const p of local) if (p && fs.existsSync(p)) return { bytes: fs.readFileSync(p), from: p };
	const cdn = await fetchBytes(MODULES_BASE + '/' + id + '.zip');
	return cdn ? { bytes: cdn, from: MODULES_BASE } : null;
}

/** install zip bytes through the REAL manager (the helper only knows one folder) */
async function installZip(peer, id, bytes, label) {
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(true));
	await peer.page.waitForTimeout(400);
	await peer.page.getByRole('tab', { name: /^User/ }).click();
	await peer.page.waitForTimeout(200);
	await peer.page.locator('#install-module-zip').setInputFiles({ name: id + '.zip', mimeType: 'application/zip', buffer: bytes });
	await h.eventually(
		() => peer.page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id)),
		(ids) => ids.includes(id),
		label + ': ' + id + ' installed from the real zip',
		20000
	);
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(false));
	await peer.page.waitForTimeout(300);
}

// ---- page probes -------------------------------------------------------------------------

/** the Kit world + the Realms game on a page */
const snap = (page) =>
	page.evaluate(() => {
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const kitGroup = scene?.getObjectByName('dungeon-module');
		const overlay = scene?.getObjectByName('dungeon-realms');
		const game = window.__dungeonRealms?.game ?? null;
		const floors = kitGroup?.getObjectByName('dk-floors');
		const portal = overlay?.getObjectByName('dr-portal-up');
		const play = kitGroup?.userData?.play;
		return {
			kit: !!kitGroup?.userData?.kit,
			seed: kitGroup?.userData?.seed ?? null,
			floorIndex: kitGroup?.userData?.floorIndex ?? null,
			levelCount: kitGroup?.userData?.levelCount ?? null,
			checksum: kitGroup?.userData?.checksum ?? null,
			campaignChecksum: kitGroup?.userData?.campaignChecksum ?? null,
			floorInstances: floors ? floors.count : 0,
			grounded: play?.grounded ?? null,
			markers: Array.isArray(play?.markers) ? play.markers.length : null,
			overlay: !!overlay,
			started: !!game?.state.started,
			won: !!game?.state.wonAt,
			p1: game?.state.slots.p1?.peerId ?? null,
			p2: game?.state.slots.p2?.peerId ?? null,
			collected: game ? Object.values(game.state.collected).reduce((sum, set) => sum + set.size, 0) : 0,
			sealedUp: portal ? portal.userData.portal.sealed : null,
			need: game?.gemTotals().need ?? 0,
			total: game?.gemTotals().total ?? 0,
			gameFloor: game?.state.floorIndex ?? null,
			menu: !!document.getElementById('dr-menu'),
			resolvedGrounded: window.__stores.playSettings.resolvePlaySettings(scene).grounded
		};
	});

/** name -> uuid for every object in the replicated group */
const namesOf = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return Object.fromEntries((g?.children ?? []).map((c) => [c.name, c.uuid]));
	});

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
const hudRuntime = (page) =>
	page.evaluate(() => {
		let r;
		window.__stores.hudDocs.hudRuntime.subscribe((v) => (r = v))();
		return r ?? {};
	});
const pressP = (page) =>
	page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', bubbles: true }));
	});
const hudButton = (page, name) => page.getByRole('button', { name, exact: true });
/** click a module MENU button by its action id (the module DOM menu) */
const clickMenu = (page, id) =>
	page.evaluate((id) => {
		const button = document.querySelector('#dr-menu .dr-btn[data-id="' + id + '"]');
		if (!button) return false;
		button.click();
		return true;
	}, id);
/** every graph node of a type, `{id, data}` */
const nodesOf = (page, type) =>
	page.evaluate((type) => {
		let graphs;
		window.__stores.flowGraphs.subscribe((g) => (graphs = g))();
		const out = [];
		for (const graph of Object.values(graphs ?? {})) for (const n of graph.nodes ?? []) if (n.type === type) out.push({ id: n.id, data: n.data });
		return out;
	}, type);
/** collect `count` gems on the current floor through the module's debug hook */
const collect = (page, count) =>
	page.evaluate((count) => {
		const g = window.__dungeonRealms.game;
		const floor = g.state.floorIndex;
		let done = 0;
		for (let i = 0; i < g.gemTotals().total && done < count; i++) {
			if (g.state.collected[floor]?.has(i)) continue;
			g.collectGem(floor, i);
			done++;
		}
		return done;
	}, count);

h.run(async () => {
	const scene = await sceneBytes();
	if (!scene) {
		console.log('SKIP: games/dungeon-realms/scene.tpscene unreachable (feed ' + SCENES_BASE + ', no DUNGEON_REALMS_TPSCENE, no sibling scenes checkout)');
		return;
	}
	const kitZip = await zipBytes('dungeon', 'DUNGEON_KIT_ZIP');
	const realmsZip = await zipBytes('dungeon-realms', 'DUNGEON_REALMS_ZIP');
	if (!kitZip || !realmsZip) {
		console.log('SKIP: dungeon.zip / dungeon-realms.zip unreachable (no env override, no MODULES_REPO, no packed sibling checkout, CDN ' + MODULES_BASE + ')');
		return;
	}
	console.log('  scene from ' + scene.from + ' (' + scene.bytes.length + ' bytes)');
	console.log('  kit from ' + kitZip.from + ' (' + kitZip.bytes.length + ' bytes), realms from ' + realmsZip.from + ' (' + realmsZip.bytes.length + ' bytes)');

	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B');
	for (const peer of [A, B]) {
		await installZip(peer, 'dungeon', kitZip.bytes, peer === A ? 'A' : 'B');
		await installZip(peer, 'dungeon-realms', realmsZip.bytes, peer === A ? 'A' : 'B');
	}

	// ---- 1. the world -------------------------------------------------------------------------
	// the counterfactual premise: a dungeon with ANOTHER seed exists before the file loads
	await A.page.evaluate(() => window.__dungeonKit.kit.generate(777, {}));
	await h.eventually(() => snap(A.page), (s) => s.seed === 777 && s.floorInstances > 0, '1.0 (premise) a menu-seeded dungeon (777) stands before the file loads');
	const payload = await A.page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		const modules = (payload.modules ?? []).map((m) => m.id);
		await s.sessions.applySession(payload, { backup: false });
		return { modules };
	}, Array.from(scene.bytes));
	await A.page.waitForTimeout(2500);
	h.check(payload.modules.includes('dungeon') && payload.modules.includes('dungeon-realms'), '1.1 the file\'s requirement list names BOTH modules (' + payload.modules.join(',') + ')');
	const names = await namesOf(A.page);
	h.check(Object.keys(names).length === 6 && !!names['Entrance plinth'] && !!names['Arch lintel'], '1.2 the file restored the 6 arch objects (' + Object.keys(names).length + ')');
	const env = await A.page.evaluate(() => {
		let e;
		window.__stores.environment.environment.subscribe((v) => (e = v))();
		return e?.preset ?? null;
	});
	h.check(env === 'night', '1.3 the night environment preset (' + env + ')');
	const phys = await A.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug());
	h.check(phys.play?.interaction === 'click' && phys.play?.grounded === true && phys.play?.simOnPlay === false, '1.4 play block: click, grounded, no sim (' + JSON.stringify(phys.play) + ')');
	await h.eventually(() => snap(A.page), (s) => s.seed === SEED && s.floorInstances > 0 && s.overlay, '1.5 the Kit regenerated SEED ' + SEED + ' FROM THE NODE after /clear all (777 is gone) and Realms overlaid it', 15000);
	const a1 = await snap(A.page);
	h.check(a1.levelCount === 5 && a1.floorIndex === 1 && a1.total >= 4, '1.6 five floors, floor 1, ' + a1.total + ' gems (need ' + a1.need + ')');
	const dungeonNodes = await nodesOf(A.page, 'dkdungeon');
	h.check(dungeonNodes.length === 1 && dungeonNodes[0].data.apply === true && dungeonNodes[0].data.seed === SEED, '1.7 ONE Dungeon node owns the recipe (apply on, seed ' + SEED + ')');
	h.check((await gameStateOf(A.page)) === 'menu' && (await screenOf(A.page)) === 'menu', '1.8 the game shell starts in menu with the menu screen');
	await h.eventually(() => A.page.evaluate(() => ({ chip: !!document.querySelector('#game-chip'), buttons: document.querySelectorAll('#hud-layer button').length })), (v) => v.chip && v.buttons === 0, '1.9 in the editor the game chip stands in for the menu (30 P1: no live menu over the editor)', 6000);
	h.check(a1.resolvedGrounded === true && a1.grounded === true, '1.10 grounded resolves TRUE from the Kit contract (playSettings)');

	// ---- 2. B receives it over the handshake ---------------------------------------------------
	await h.connect(A, B);
	// by UUID, not name: a mesh name with a space arrives underscored on the peer
	// ("Entrance_plinth" — the light keeps its space), and the graph binds by uuid anyway
	await h.eventually(
		() => namesOf(B.page).then((n) => ({ uuids: Object.values(n), count: Object.keys(n).length })),
		(v) => v.count === 6 && v.uuids.includes(names['Entrance plinth']),
		'2.1 B received the 6 arch objects with the same plinth uuid',
		30000
	);
	await h.eventually(() => snap(B.page), (s) => s.seed === SEED && s.checksum === a1.checksum && s.campaignChecksum === a1.campaignChecksum && s.overlay, '2.2 B: the graph replicated and its Dungeon node built the SAME world (checksums match)', 20000);
	await h.eventually(() => nodesOf(B.page, 'drevent').then((n) => n.length), (n) => n === 4, '2.3 B: the four Realms Event nodes are in the graph');
	await h.eventually(() => screenOf(B.page), (v) => v === 'menu', '2.4 B: the HUD document arrived (menu screen)', 10000);

	// ---- 3. play, the module menu, Start -> trigger log -> game shell -> HUD ----------------------
	await A.page.locator('#play-button').click();
	await B.page.locator('#play-button').click();
	await h.eventually(() => snap(A.page), (s) => s.menu, '3.1 A: the module start menu appears in play mode');
	await h.eventually(async () => (await hudText(A.page)) ?? '', (t) => /DUNGEON REALMS/.test(t), '3.1b in play the HUD menu screen renders its title');
	await h.eventually(() => snap(B.page), (s) => s.menu, '3.2 B: the module start menu appears');
	h.check(await clickMenu(A.page, 'join-p1'), '3.3 A joins as Player 1 (module menu)');
	h.check(await clickMenu(B.page, 'join-p2'), '3.4 B joins as Player 2');
	await h.eventually(() => snap(B.page), (s) => s.p1 === A.id && s.p2 === B.id, '3.5 B sees both slots');
	const startNode = (await nodesOf(A.page, 'drevent')).find((n) => n.data.event === 'start');
	const startBefore = await stampOf(B.page, startNode.id);
	await clickMenu(A.page, 'start');
	await h.eventually(() => snap(B.page), (s) => s.started, '3.6 B: the game started');
	await h.eventually(() => stampOf(B.page, startNode.id), (t) => t !== null && t !== startBefore, '3.7 B: the "On start" stamp landed in the TRIGGER LOG');
	await h.eventually(() => gameStateOf(B.page), (v) => v === 'playing', '3.8 ...and its Set Game State flipped the shell to playing on B');
	await h.eventually(() => gameStateOf(A.page), (v) => v === 'playing', '3.9 ...and on A');
	await h.eventually(() => screenOf(A.page), (v) => v === 'hud', '3.10 A sees the playing HUD screen', 6000);
	await h.eventually(() => hudRuntime(A.page), (r) => r['dr-gems']?.text === '0' && r['dr-need']?.text === '/ ' + a1.need + ' needed', '3.11 HUD Text reads the Realms Value nodes: gems 0, need ' + a1.need);
	await h.eventually(() => hudRuntime(A.page), (r) => r['dr-level']?.text === 'LEVEL 1' && r['dr-levels']?.text === '/ 5', '3.12 HUD Text: LEVEL 1 / 5');
	await h.eventually(() => hudRuntime(A.page), (r) => (r['dr-players']?.rows ?? []).length === 2 && (r['dr-objective']?.rows ?? []).length === 1, '3.13 HUD lists read Realms HUD Rows: 2 player pills, 1 objective line');
	await h.eventually(() => hudText(A.page), (t) => /LEVEL 1/.test(t) && /needed/.test(t) && /more gem/.test(t), '3.14 the HUD layer renders the level, the gem line and the objective');

	// ---- 4. a gem: HUD text on B, the replicated EVENT counts once per pickup -------------------
	const takenBefore = (await hudRuntime(B.page))['dr-taken']?.text ?? '';
	h.check(await collect(A.page, 1) === 1, '4.1 A collects one gem');
	await h.eventually(() => hudRuntime(B.page), (r) => r['dr-gems']?.text === '1', '4.2 B\'s HUD Text reads 1 gem');
	await h.eventually(() => hudRuntime(A.page), (r) => r['dr-taken']?.text === '1 gems taken', '4.3 A: the gem EVENT counted once (Counter -> HUD Text)');
	await h.eventually(() => hudRuntime(B.page), (r) => r['dr-taken']?.text === '1 gems taken', '4.4 B: the replicated event counted ONCE, not once per peer (was "' + takenBefore + '")');
	await h.eventually(() => snap(B.page), (s) => s.markers === a1.total - 1 + 1, '4.5 B: one minimap marker fewer (gems + the portal)');

	// ---- 5. pause, unseal, travel, victory -------------------------------------------------------
	await pressP(A.page);
	await h.eventually(() => screenOf(A.page), (v) => v === 'pause', '5.1 P opens the pause screen', 6000);
	await hudButton(A.page, 'Resume').click();
	await h.eventually(() => screenOf(A.page), (v) => v === 'hud', '5.2 Resume closes it', 6000);
	await collect(A.page, a1.need);
	await h.eventually(() => snap(A.page), (s) => s.sealedUp === false, '5.3 A: the UP portal unseals at the threshold');
	await h.eventually(() => snap(B.page), (s) => s.sealedUp === false, '5.4 B: unseal replicated');
	const travelled = await A.page.evaluate(() => {
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const ring = scene.getObjectByName('dungeon-realms').getObjectByName('dr-portal-up').children[0];
		return window.__stores.moduleSDK.moduleClickHandlers.some((handler) => handler(ring));
	});
	h.check(travelled, '5.5 A clicks the portal (module click handler consumed it)');
	await h.eventually(() => snap(A.page), (s) => s.floorIndex === 2 && s.gameFloor === 2, '5.6 A: floor 2 (Kit + game agree)');
	const a2 = await snap(A.page);
	await h.eventually(() => snap(B.page), (s) => s.floorIndex === 2 && s.checksum === a2.checksum, '5.7 B: floor 2, same checksum');
	await h.eventually(() => hudRuntime(B.page), (r) => r['dr-level']?.text === 'LEVEL 2', '5.8 B\'s HUD Text reads LEVEL 2');
	// climb to the top: collect the threshold and step up, floor by floor
	for (let floor = 2; floor < 5; floor++) {
		await collect(A.page, (await snap(A.page)).need);
		await h.eventually(() => snap(A.page), (s) => s.sealedUp === false, '5.9 floor ' + floor + ' unseals');
		await A.page.evaluate((next) => window.__dungeonRealms.game.travel(next), floor + 1);
		await h.eventually(() => snap(A.page), (s) => s.floorIndex === floor + 1 && s.gameFloor === floor + 1, '5.10 A reaches floor ' + (floor + 1));
	}
	const winNode = (await nodesOf(A.page, 'drevent')).find((n) => n.data.event === 'victory');
	const winBefore = await stampOf(B.page, winNode.id);
	await collect(A.page, (await snap(A.page)).need);
	await h.eventually(() => snap(A.page), (s) => s.won, '5.11 A: victory on the top floor');
	await h.eventually(() => snap(B.page), (s) => s.won, '5.12 B: victory replicated');
	await h.eventually(() => stampOf(B.page, winNode.id), (t) => t !== null && t !== winBefore, '5.13 B: the "On victory" stamp landed in the TRIGGER LOG');
	await h.eventually(() => gameStateOf(B.page), (v) => v === 'over', '5.14 ...and the shell is OVER on B');
	await h.eventually(() => screenOf(A.page), (v) => v === 'over', '5.15 A sees the victory screen', 6000);
	h.check(/HOARD IS YOURS/.test(await hudText(A.page)), '5.16 the victory screen renders');

	// ---- 6. the late joiner ------------------------------------------------------------------------
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(500);
	const C = await h.setupPage(browser, 'C');
	await installZip(C, 'dungeon', kitZip.bytes, 'C');
	await installZip(C, 'dungeon-realms', realmsZip.bytes, 'C');
	await h.connect(C, A);
	const aEnd = await snap(A.page);
	await h.eventually(() => namesOf(C.page).then((n) => Object.keys(n).length), (n) => n === 6, '6.1 C received the arch', 30000);
	await h.eventually(() => snap(C.page), (s) => s.seed === SEED && s.floorIndex === 5 && s.checksum === aEnd.checksum && s.overlay, '6.2 C: the Kit rebuilt seed ' + SEED + ' on floor 5 (same checksum) with the overlay', 30000);
	await h.eventually(() => snap(C.page), (s) => s.collected === aEnd.collected && s.started && s.won, '6.3 C: the game state caught up (gems, started, won)', 20000);
	await h.eventually(() => gameStateOf(C.page), (v) => v === 'over', '6.4 C: the game shell reads over');

	await h.finish(browser);
});
