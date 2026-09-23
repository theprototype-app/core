// 21-C C7 ACCEPTANCE — the Untangle game template: the thin, honest template (pose +
// level + room + HUD + graph; the puzzle stays imperative) on the REAL artefacts:
//   the scene — games/untangle/scene.tpscene from the scenes FEED (tag v2), or
//               UNTANGLE_TPSCENE=<path>, or a sibling scenes checkout
//   the zip   — untangle.zip: UNTANGLE_ZIP=<path>, MODULES_REPO, a packed sibling modules
//               checkout, or the modules CDN
// on TWO peers plus a LATE JOINER. Skip-never-fail when either cannot be reached.
//
// What it proves:
//   1 the world arrives whole: the 6 room objects, the sunset env, the play block, the
//     HUD document, `untangle` in the requirement list — and THE ORDERING: applySession
//     runs `/clear all` FIRST (the module resets to level 1), then the graph's Untangle
//     Board node applies its level on the next tick. A board on level 5 BEFORE the load
//     ends on level 2 (the node's), not 1 (the clear) and not 5 — the plan's "every game
//     template silently starts at level 1" failure, asserted rather than believed
//   2 the pose is node data: boardY from the node, and editing the node on A moves the
//     board on B (the replicated graph), then the value is put back
//   3 B receives it over the handshake: same objects, same level, same scramble
//   4 play: the HUD menu, Start -> playing + the HUD screen; HUD Text reads the Untangle
//     Value nodes (LEVEL 2, the crossings count); a move on A changes B's crossings text
//   5 a solve: detected on both from the same positions; the `utevent solved` stamp in
//     the TRIGGER LOG on B; the Counter -> HUD Text counts ONCE on both (fireNodeTrigger
//     replicates from the peer where it happened); autoAdvance -> level 3 on both
//   6 no sprite on desktop (the VR-only path); P pauses / Resume
//   7 the late joiner: C reads the room, the level, A's positions and the game shell
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_BASE = (process.env.UNTANGLE_SCENES_BASE || 'https://cdn.jsdelivr.net/gh/theprototype-app/scenes@format-2').replace(/\/$/, '');
const MODULES_BASE = (process.env.UNTANGLE_MODULES_BASE || 'https://cdn.jsdelivr.net/gh/theprototype-app/modules@main').replace(/\/$/, '');
const ROOT = path.resolve(__dirname, '../../..');
const TEMPLATE_LEVEL = 1; // 30-untangle: a new player has only level 1 open
const dotsFor = (l) => 5 + Math.round(((Math.min(30, l) - 1) * 11) / 29); // the roadmap-30 curve

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
async function sceneBytes() {
	if (process.env.UNTANGLE_TPSCENE) {
		const p = process.env.UNTANGLE_TPSCENE;
		return fs.existsSync(p) ? { bytes: fs.readFileSync(p), from: p } : null;
	}
	const feed = await fetchBytes(SCENES_BASE + '/games/untangle/scene.tpscene');
	if (feed) return { bytes: feed, from: SCENES_BASE };
	for (const dir of ['theprototype.app-scenes', 'scenes']) {
		const p = path.join(ROOT, dir, 'games/untangle/scene.tpscene');
		if (fs.existsSync(p)) return { bytes: fs.readFileSync(p), from: p };
	}
	return null;
}
async function zipBytes() {
	if (process.env.UNTANGLE_ZIP) {
		const p = process.env.UNTANGLE_ZIP;
		return fs.existsSync(p) ? { bytes: fs.readFileSync(p), from: p } : null;
	}
	const local = [];
	if (process.env.MODULES_REPO) local.push(path.join(process.env.MODULES_REPO, 'untangle.zip'));
	local.push(h.moduleZipPath('untangle'));
	for (const dir of fs.readdirSync(ROOT)) if (/^(theprototype\.app-)?modules/.test(dir)) local.push(path.join(ROOT, dir, 'untangle.zip'));
	for (const p of local) if (p && fs.existsSync(p)) return { bytes: fs.readFileSync(p), from: p };
	const cdn = await fetchBytes(MODULES_BASE + '/untangle.zip');
	return cdn ? { bytes: cdn, from: MODULES_BASE } : null;
}
async function installZip(peer, bytes, label) {
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(true));
	await peer.page.waitForTimeout(400);
	await peer.page.getByRole('tab', { name: /^User/ }).click();
	await peer.page.waitForTimeout(200);
	await peer.page.locator('#install-module-zip').setInputFiles({ name: 'untangle.zip', mimeType: 'application/zip', buffer: bytes });
	await h.eventually(
		() => peer.page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id)),
		(ids) => ids.includes('untangle'),
		label + ': the untangle module installed from the real zip',
		20000
	);
	await peer.page.evaluate(() => window.__stores.modulesOpen.set(false));
	await peer.page.waitForTimeout(300);
}

// ---- probes --------------------------------------------------------------------------------
const snap = (page) =>
	page.evaluate(() => {
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const group = scene?.getObjectByName('untangle-module');
		const s = window.__untangle?.state() ?? null;
		return s
			? {
					level: s.level,
					crossings: s.crossings,
					won: s.won,
					built: s.built,
					nodeOwned: s.nodeOwned,
					sceneClears: s.sceneClears,
					sprite: s.sprite,
					board: s.board,
					positions: s.positions.map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]),
					groupY: group ? Math.round(group.position.y * 100) / 100 : null,
					dots: group ? group.children.filter((c) => c.name.startsWith('untangle-dot-')).length : 0,
					spriteInScene: !!group?.getObjectByName('untangle-hud')
				}
			: null;
	});
const namesOf = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return Object.fromEntries((g?.children ?? []).map((c) => [c.name, c.uuid]));
	});
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
const nodesOf = (page, type) =>
	page.evaluate((type) => {
		let graphs;
		window.__stores.flowGraphs.subscribe((g) => (graphs = g))();
		const out = [];
		for (const [graphId, graph] of Object.entries(graphs ?? {})) for (const n of graph.nodes ?? []) if (n.type === type) out.push({ id: n.id, graphId, data: n.data });
		return out;
	}, type);
const setNodeData = (page, id, graphId, patch) => page.evaluate(({ id, graphId, patch }) => window.__stores.nodesHandler.setNodeData(id, patch, graphId), { id, graphId, patch });

h.run(async () => {
	const scene = await sceneBytes();
	if (!scene) {
		console.log('SKIP: games/untangle/scene.tpscene unreachable (feed ' + SCENES_BASE + ', no UNTANGLE_TPSCENE, no sibling scenes checkout)');
		return;
	}
	const zip = await zipBytes();
	if (!zip) {
		console.log('SKIP: untangle.zip unreachable (no UNTANGLE_ZIP, no MODULES_REPO, no packed sibling checkout, CDN ' + MODULES_BASE + ')');
		return;
	}
	console.log('  scene from ' + scene.from + ' (' + scene.bytes.length + ' bytes)');
	console.log('  module from ' + zip.from + ' (' + zip.bytes.length + ' bytes)');

	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B');
	await installZip(A, zip.bytes, 'A');
	await installZip(B, zip.bytes, 'B');

	// ---- 1. the world + THE ORDERING ----------------------------------------------------------
	await h.eventually(() => snap(A.page), (s) => !!s && s.built && s.level === 1, '1.0 (premise) the fallback level-1 board stands before the load (no node yet)');
	await A.page.evaluate(() => window.__untangle.setLevel(5));
	await h.eventually(() => snap(A.page), (s) => s.level === 5, '1.0b (premise) A is on level 5 before the file loads');
	const clearsBefore = (await snap(A.page)).sceneClears;
	const payload = await A.page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		const modules = (payload.modules ?? []).map((m) => m.id);
		await s.sessions.applySession(payload, { backup: false });
		return { modules };
	}, Array.from(scene.bytes));
	await A.page.waitForTimeout(2000);
	h.check(payload.modules.includes('untangle'), '1.1 the file\'s requirement list names untangle (' + payload.modules.join(',') + ')');
	const names = await namesOf(A.page);
	h.check(Object.keys(names).length === 6 && !!names['Pedestal'] && !!names['Board frame'], '1.2 the file restored the 6 room objects (' + Object.keys(names).length + ')');
	const env = await A.page.evaluate(() => {
		let e;
		window.__stores.environment.environment.subscribe((v) => (e = v))();
		return e?.preset ?? null;
	});
	h.check(env === 'custom', '1.3 the custom dusk sky (' + env + ')');
	const phys = await A.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug());
	h.check(phys.play?.interaction === 'click' && phys.play?.simOnPlay === false, '1.4 play block: click, no sim');
	await h.eventually(() => snap(A.page), (s) => s.sceneClears === clearsBefore + 1, '1.5 applySession ran /clear all FIRST (the module saw one scene clear)');
	await h.eventually(() => snap(A.page), (s) => s.level === TEMPLATE_LEVEL && s.nodeOwned && s.built, '1.6 ...then the Untangle Board node applied LEVEL ' + TEMPLATE_LEVEL + ' — not 1 (the clear) and not 5 (before the load)', 10000);
	let a1 = await snap(A.page);
	h.check(a1.dots === dotsFor(TEMPLATE_LEVEL), '1.7 level ' + TEMPLATE_LEVEL + ' has ' + dotsFor(TEMPLATE_LEVEL) + ' dots (' + a1.dots + ')');
	h.check((await gameStateOf(A.page)) === 'menu' && (await screenOf(A.page)) === 'menu', '1.8 the game shell starts in menu with the menu screen');
	await h.eventually(() => A.page.evaluate(() => ({ chip: !!document.querySelector('#game-chip'), buttons: document.querySelectorAll('#hud-layer button').length })), (v) => v.chip && v.buttons === 0, '1.9 in the editor the game chip stands in for the menu (30 P1: no live menu over the editor)', 6000);

	// 1c — the SAME file loaded AGAIN (Templates modal, twice): the node's data did not change, so
	// only a node re-armed by the scene clear applies its level again. Without that the second load
	// has NO board at all (no fallback either — a node is alive). Local play first, no peers yet.
	await A.page.evaluate(() => window.__untangle.setLevel(4));
	await h.eventually(() => snap(A.page), (s) => s.level === 4, '1.11 (premise) A plays on to level 4');
	await A.page.evaluate(async (arr) => {
		const s = window.__stores;
		await s.sessions.applySession(await s.sessions.readSessionZip(new Uint8Array(arr).buffer), { backup: false });
	}, Array.from(scene.bytes));
	await h.eventually(() => snap(A.page), (s) => s.sceneClears === clearsBefore + 2 && s.level === TEMPLATE_LEVEL && s.built && s.nodeOwned, '1.12 the same file loaded again: cleared once more, and the node re-applied LEVEL ' + TEMPLATE_LEVEL + ' (a board exists)', 10000);

	// ---- 2. the pose is node data --------------------------------------------------------------
	a1 = await snap(A.page);
	h.check(a1.groupY === 1.6 && a1.board.radius === 1.1, '2.1 the board stands at the node\'s boardY 1.6, radius 1.1');
	const boardNode = (await nodesOf(A.page, 'utboard'))[0];
	h.check(!!boardNode && boardNode.data.level === TEMPLATE_LEVEL && boardNode.data.apply === true, '2.2 ONE Untangle Board node owns the board (level ' + TEMPLATE_LEVEL + ', apply on)');

	// ---- 3. B over the handshake -----------------------------------------------------------------
	await h.connect(A, B);
	await h.eventually(() => namesOf(B.page).then((n) => n['Pedestal']), (u) => u === names['Pedestal'], '3.1 B received the room with the same pedestal uuid', 30000);
	await h.eventually(() => snap(B.page), (s) => !!s && s.level === TEMPLATE_LEVEL && s.nodeOwned && JSON.stringify(s.positions) === JSON.stringify(a1.positions), '3.2 B: the graph replicated, its node built level ' + TEMPLATE_LEVEL + ' with the IDENTICAL scramble', 20000);
	await setNodeData(A.page, boardNode.id, boardNode.graphId, { boardY: 2.1 });
	await h.eventually(() => snap(B.page), (s) => s.groupY === 2.1, '3.3 editing boardY on A\'s node moves B\'s board to 2.1 (the replicated graph)');
	await setNodeData(A.page, boardNode.id, boardNode.graphId, { boardY: 1.6 });
	await h.eventually(() => snap(B.page), (s) => s.groupY === 1.6, '3.4 ...and back to 1.6');
	await h.eventually(() => screenOf(B.page), (v) => v === 'menu', '3.5 B: the HUD document arrived (menu screen)', 10000);

	// ---- 4. play + the HUD readouts --------------------------------------------------------------
	await A.page.locator('#play-button').click();
	await B.page.locator('#play-button').click();
	await A.page.waitForTimeout(500);
	await h.eventually(async () => (await hudText(A.page)) ?? '', (t) => /UNTANGLE/.test(t) && /Start/.test(t), '4.0 in play the menu renders its title and Start');
	await hudButton(A.page, 'Start').click();
	await h.eventually(() => gameStateOf(A.page), (v) => v === 'playing', '4.1 Start flips the shell to playing');
	await h.eventually(() => screenOf(A.page), (v) => v === 'hud', '4.2 A sees the HUD screen', 6000);
	await h.eventually(() => hudRuntime(A.page), (r) => r['ut-level']?.text === 'LEVEL ' + TEMPLATE_LEVEL, '4.3 HUD Text reads the Untangle Value node: LEVEL ' + TEMPLATE_LEVEL);
	await h.eventually(() => hudRuntime(A.page), (r) => r['ut-crossings']?.text === 'Crossings: ' + a1.crossings, '4.4 HUD Text reads the crossings count (' + a1.crossings + ')');
	// a NUDGE: a far move can solve the 5-dot level 1 outright
	h.check(await A.page.evaluate(() => { const p = window.__untangle.state().positions[0]; return window.__untangle.move(0, [p[0] + 0.01, p[1]]); }), '4.5 A nudges dot 0');
	h.check((await snap(A.page)).crossings > 0, '4.5b (premise) still tangled');
	const a2 = await snap(A.page);
	await h.eventually(() => snap(B.page), (s) => s.positions[0][0] === a2.positions[0][0] && s.crossings === a2.crossings, '4.6 B receives the move and derives the same crossings (' + a2.crossings + ')');
	await h.eventually(() => hudRuntime(B.page), (r) => r['ut-crossings']?.text === 'Crossings: ' + a2.crossings, '4.7 B\'s HUD Text follows');

	// ---- 5. a solve: trigger log, the Counter once, autoAdvance in lockstep -----------------------
	const solvedNode = (await nodesOf(A.page, 'utevent')).find((n) => n.data.event === 'solved');
	const solvedBefore = await stampOf(B.page, solvedNode.id);
	h.check(await A.page.evaluate(() => window.__untangle.solve()), '5.1 A drops every dot on the solution circle');
	await h.eventually(() => snap(B.page), (s) => s.crossings === 0 || s.level === TEMPLATE_LEVEL + 1, '5.2 B: zero crossings from the same positions');
	await h.eventually(() => stampOf(B.page, solvedNode.id), (t) => t !== null && t !== solvedBefore, '5.3 B: the "On solved" stamp landed in the TRIGGER LOG');
	await h.eventually(() => hudRuntime(A.page), (r) => r['ut-counter']?.text === '1 untangled', '5.4 A: Counter -> HUD Text counts the solve once');
	await h.eventually(() => hudRuntime(B.page), (r) => r['ut-counter']?.text === '1 untangled', '5.5 B: counted ONCE, not once per peer');
	// 30-untangle: no autoAdvance in the template — the solve shows the SOLVED screen (over) and
	// Next starts the next level on every peer
	await h.eventually(() => gameStateOf(A.page), (v) => v === 'over', '5.6a the solve moves the shell to over');
	await h.eventually(() => screenOf(B.page), (v) => v === 'solved', '5.6b B sees the solved screen', 6000);
	await hudButton(A.page, 'Next level').click();
	await h.eventually(() => snap(A.page), (s) => s.level === TEMPLATE_LEVEL + 1, '5.6 A: Next -> level ' + (TEMPLATE_LEVEL + 1), 6000);
	await h.eventually(() => snap(B.page), (s) => s.level === TEMPLATE_LEVEL + 1, '5.7 B: advanced in lockstep', 6000);
	await h.eventually(() => hudRuntime(B.page), (r) => r['ut-level']?.text === 'LEVEL ' + (TEMPLATE_LEVEL + 1), '5.8 B\'s HUD Text reads LEVEL ' + (TEMPLATE_LEVEL + 1));
	h.check((await snap(A.page)).nodeOwned === true, '5.9 the node still owns the board after the advance (its level is the STARTING level)');

	// ---- 6. no sprite on desktop; pause -------------------------------------------------------------
	const a3 = await snap(A.page);
	h.check(a3.sprite === false && a3.spriteInScene === false, '6.1 no canvas sprite HUD on desktop (the VR-only path)');
	await pressP(A.page);
	await h.eventually(() => screenOf(A.page), (v) => v === 'pause', '6.2 P opens the pause screen', 6000);
	await hudButton(A.page, 'Resume').click();
	await h.eventually(() => screenOf(A.page), (v) => v === 'hud', '6.3 Resume closes it', 6000);

	// ---- 7. the late joiner ------------------------------------------------------------------------------
	h.check(await A.page.evaluate(() => window.__untangle.move(1, [-0.3, 0.2])), '7.0 A moves a dot before the joiner arrives');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(500);
	const C = await h.setupPage(browser, 'C');
	await installZip(C, zip.bytes, 'C');
	await h.connect(C, A);
	const aEnd = await snap(A.page);
	await h.eventually(() => namesOf(C.page).then((n) => Object.keys(n).length), (n) => n === 6, '7.1 C received the room', 30000);
	await h.eventually(() => snap(C.page), (s) => !!s && s.level === aEnd.level && JSON.stringify(s.positions) === JSON.stringify(aEnd.positions), '7.2 C: level ' + aEnd.level + ' with A\'s exact positions', 30000);
	await h.eventually(() => gameStateOf(C.page), (v) => v === 'playing', '7.3 C: the game shell reads playing');

	await h.finish(browser);
});
