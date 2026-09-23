// 29-F ACCEPTANCE, rewritten for Waves 2.x (roadmap 30b: "Waves becomes a VR shooter") — the
// Waves game template composed from TWO modules (`health` holds the hit points, `waves` runs
// the levels, walks the enemies and owns the guns) on the REAL artefacts, nothing authored
// in-test:
//   the scene — games/waves/scene.tpscene from the scenes FEED (core's own SCENES_BASE
//               fallback, read out of src/lib/sceneTemplates.js so a ref move follows by
//               construction — #230), or WAVES_TPSCENE=<path>, or a sibling scenes checkout
//   the zips  — health.zip + waves.zip: HEALTH_ZIP / WAVES_ZIP, the MODULES_REPO checkout,
//               a packed sibling modules checkout, or the modules CDN
// installed on TWO peers plus a LATE JOINER. Skip-never-fail when a source is missing.
//
// The GAME itself (guns, abilities, the five levels, breaches, the VR start board, the
// Meshy figures) is proven by the modules repo's own flight `waves-shooter` (118 checks);
// this suite is core's side of the template: the card, the file, the handshake, the shell.
//   1 THE GAMES TAB: the card is picked in the real Templates modal and replaces the world —
//     17 objects (10 enemies in their three kinds), both modules in the requirement list, the
//     custom sky, the play block (click, grounded, sim on play, a SPAWN in front of the
//     crystal, no teleport and no fly — 30b C1), the menu shell, and the module's derivation
//   2 B receives it over the handshake: same uuids, the same derivation, the HUD document
//   3 play: Play -> the shell is playing on both, the HUD screen, the enemies WALK and B
//     places them where A does, the HUD reads Wave 1
//   4 a shot's worth of hits (the module's own engine.hit, the path its guns take) kills an
//     enemy on A and B agrees (the replicated ledger)
//   5 the late joiner: C reads the same run and the game shell
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

/** core's own feed base — the fallback literal in sceneTemplates.js (#230: the ref is
 * moving off `v2`, and a suite that pins its own copy would be the next stale reader) */
function coreScenesBase() {
	try {
		const src = fs.readFileSync(path.resolve(__dirname, '../../src/lib/sceneTemplates.js'), 'utf8');
		const m = src.match(/SCENES_BASE = contentBase\([^,]+,\s*'([^']+)'\)/);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}
const SCENES_BASE = (process.env.WAVES_SCENES_BASE || coreScenesBase() || 'https://cdn.jsdelivr.net/gh/theprototype-app/scenes@main').replace(/\/$/, '');
const MODULES_BASE = (process.env.WAVES_MODULES_BASE || 'https://cdn.jsdelivr.net/gh/theprototype-app/modules@main').replace(/\/$/, '');
const ROOT = path.resolve(__dirname, '../../..');
const ENEMIES = ['Enemy 01', 'Enemy 02', 'Enemy 03', 'Enemy 04', 'Enemy 05 Runner', 'Enemy 06 Runner', 'Enemy 07', 'Enemy 08 Tank', 'Enemy 09 Runner', 'Enemy 10 Tank'];
const OBJECTS = ['Ground', 'Goal', 'Spawn 1', 'Spawn 2', 'Spawn 3', ...ENEMIES, 'Home', 'Arena'];

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
	if (process.env.WAVES_TPSCENE) {
		const p = process.env.WAVES_TPSCENE;
		return fs.existsSync(p) ? { bytes: fs.readFileSync(p), from: p } : null;
	}
	const feed = await fetchBytes(SCENES_BASE + '/games/waves/scene.tpscene');
	if (feed) return { bytes: feed, from: SCENES_BASE };
	for (const dir of ['theprototype.app-scenes', 'scenes']) {
		const p = path.join(ROOT, dir, 'games/waves/scene.tpscene');
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

/** the waves module's derivation of the ONE Waves node (its debug hook) */
const snap = (page) => page.evaluate(() => window.__waves?.snapshot()[0] ?? null);
/** the health module's rows: hp per target */
const healthSnap = (page) => page.evaluate(() => window.__health?.snapshot() ?? []);
/** name -> uuid for every object in the replicated group */
const namesOf = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return Object.fromEntries((g?.children ?? []).map((c) => [c.name, c.uuid]));
	});
const posOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g?.getObjectByProperty('uuid', uuid)?.position.toArray() ?? null;
	}, uuid);
const gameOf = (page) =>
	page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return { state: g?.state ?? null, outcome: g?.outcome ?? '' };
	});
const gameStateOf = async (page) => (await gameOf(page)).state;
const screenOf = (page) => page.evaluate(() => window.__stores.hudDocs.visibleScreen('scene')?.id ?? null);
const hudText = async (page) => (await page.locator('#hud-layer').textContent().catch(() => '')) ?? '';
const hudRuntime = (page) =>
	page.evaluate(() => {
		let r;
		window.__stores.hudDocs.hudRuntime.subscribe((v) => (r = v))();
		return r ?? {};
	});
const simOf = (page) =>
	page.evaluate(() => {
		const p = window.__stores.physics;
		let own, remote;
		p.simulating.subscribe((v) => (own = v))();
		p.remoteSimulating.subscribe((v) => (remote = v))();
		return { own: !!own, remote: remote ?? null };
	});
const hudButton = (page, name) => page.getByRole('button', { name, exact: true });
const myVar = (page, name) => page.evaluate((n) => window.__stores.peerVars.myPeerVar(n, null), name);

const hpOf = async (page, uuid) => (await healthSnap(page)).find((s) => s.uuid === uuid)?.hp ?? null;

h.run(async () => {
	const scene = await sceneBytes();
	if (!scene) {
		console.log('SKIP: games/waves/scene.tpscene unreachable (feed ' + SCENES_BASE + ', no WAVES_TPSCENE, no sibling scenes checkout)');
		return;
	}
	const healthZip = await zipBytes('health', 'HEALTH_ZIP');
	const wavesZip = await zipBytes('waves', 'WAVES_ZIP');
	if (!healthZip || !wavesZip) {
		console.log('SKIP: health.zip / waves.zip unreachable (no env override, no MODULES_REPO, no packed sibling checkout, CDN ' + MODULES_BASE + ')');
		return;
	}
	console.log('  scene from ' + scene.from + ' (' + scene.bytes.length + ' bytes)');
	console.log('  health from ' + healthZip.from + ' (' + healthZip.bytes.length + ' bytes), waves from ' + wavesZip.from + ' (' + wavesZip.bytes.length + ' bytes)');

	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B');
	for (const peer of [A, B]) {
		await installZip(peer, 'health', healthZip.bytes, peer === A ? 'A' : 'B');
		await installZip(peer, 'waves', wavesZip.bytes, peer === A ? 'A' : 'B');
	}

	// ---- 1. THE GAMES TAB ------------------------------------------------------------------------
	// the feed is served through a route: the real index shape with the waves row, and the
	// scene bytes this run resolved — so the card exists in the modal before the row is
	// released, and the SAME path a user takes (pickEntry -> loadRemoteScene) is what loads it
	await A.page.route('**/cdn.jsdelivr.net/**', (route) => {
		const url = route.request().url();
		if (!url.includes('/theprototype-app/scenes@')) return route.continue();
		if (url.endsWith('/index.json'))
			return route.fulfill({
				json: {
					version: 2,
					templates: [],
					examples: [],
					games: [
						{
							slug: 'waves',
							title: 'Waves',
							description: 'Wave survival: hold the goal against waves of enemies walking in from the spawn points.',
							author: 'theprototype',
							license: 'CC0-1.0',
							tags: ['vr', 'co-op', 'survival'],
							modules: [
								{ id: 'health', version: '1.0.0' },
								{ id: 'waves', version: '2.1.0' }
							],
							bytes: scene.bytes.length,
							scene: 'games/waves/scene.tpscene',
							thumb: 'games/waves/thumb.webp'
						}
					]
				}
			});
		if (url.includes('games/waves/scene.tpscene')) return route.fulfill({ body: scene.bytes, contentType: 'application/zip' });
		if (url.endsWith('.webp')) return route.fulfill({ status: 404 });
		return route.continue();
	});
	// the counterfactual premise: the world is NOT empty before the card is picked
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		window.__stores.objectActions.deselectObject();
	});
	const before = await namesOf(A.page);
	h.check(Object.keys(before).length === 1, '1.0 (premise) one box stands before the card is picked');
	await A.page.evaluate(() => window.__stores.templatesModalOpen.set(true));
	await A.page.waitForTimeout(400);
	await A.page.locator('#templates-tab-games').click();
	const card = A.page.locator('#templates-modal .tpl-card', { hasText: 'Waves' });
	await h.eventually(() => card.count(), (n) => n === 1, '1.1 the Games tab lists the Waves card', 15000);
	const needs = (await A.page.locator('#templates-modal .tpl-needs[data-needs="waves"]').textContent().catch(() => '')) ?? '';
	h.check(/health/i.test(needs) && /waves/i.test(needs), '1.2 the card names both modules it needs (' + needs.trim() + ')');
	await card.click();
	await h.eventually(() => namesOf(A.page).then((n) => Object.keys(n)), (n) => n.length === OBJECTS.length && !n.includes('Box'), '1.3 picking the card loads the scene: the box is gone, ' + OBJECTS.length + ' objects stand', 30000);
	await A.page.waitForTimeout(1500);
	const names = await namesOf(A.page);
	h.check(OBJECTS.every((n) => !!names[n]), '1.4 the ground, the goal, three spawn pads, ten enemies (grunts, runners, tanks), the home pad and the arena (' + Object.keys(names).join(', ') + ')');
	const modules = await A.page.evaluate(() => {
		let m;
		window.__stores.moduleRequirements.sceneModules.subscribe((v) => (m = v))();
		return (m ?? []).map((e) => e.id + '@' + e.version);
	});
	h.check(modules.some((m) => m.startsWith('health@')) && modules.some((m) => /^waves@2\./.test(m)), '1.5 the file\'s requirement list names health and waves 2.x (' + modules.join(',') + ')');
	const env = await A.page.evaluate(() => {
		let e;
		window.__stores.environment.environment.subscribe((v) => (e = v))();
		return e?.preset ?? null;
	});
	h.check(env === 'custom', '1.6 the custom sky (' + env + ')');
	const phys = await A.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug());
	h.check(phys.play?.interaction === 'click' && phys.play?.grounded === true && phys.play?.simOnPlay === true, '1.7 play block: click, grounded, sim on play (' + JSON.stringify(phys.play) + ')');
	h.check(
		JSON.stringify(phys.play?.spawn?.position) === '[0,0,9]' && phys.play?.locomotion?.teleport === false && phys.play?.locomotion?.fly === false,
		'1.8 30b C1 in the file: a spawn in front of the crystal, no teleport, no fly (' + JSON.stringify({ spawn: phys.play?.spawn, loco: phys.play?.locomotion }) + ')'
	);
	h.check((await gameStateOf(A.page)) === 'menu' && (await screenOf(A.page)) === 'menu', '1.9 the game shell starts in menu with the menu screen');
	await h.eventually(() => A.page.evaluate(() => ({ chip: !!document.querySelector('#game-chip'), buttons: document.querySelectorAll('#hud-layer button').length })), (v) => v.chip && v.buttons === 0, '1.10 in the editor the game chip stands in for the menu (30 P1: no live menu over the editor)', 6000);
	await h.eventually(() => snap(A.page), (s) => !!s && s.enemies.length === ENEMIES.length && !s.running && !!s.goal && s.spawns === 3, '1.11 waves derives from the file: ten enemies, idle, a goal, three spawn points', 10000);
	const a1 = await snap(A.page);
	const order = a1.enemies.map((e) => e.uuid);
	h.check(order.every((u) => Object.values(names).includes(u)), '1.12 the run\'s enemies are the file\'s Enemy objects by uuid');
	await h.eventually(() => healthSnap(A.page), (all) => all.filter((s) => s.scope === 'object').length >= ENEMIES.length && all.filter((s) => s.scope === 'object').every((s) => s.hp > 0 && !s.dead), '1.13 health derives a row per enemy, every one alive');

	// ---- 2. B receives it over the handshake ------------------------------------------------------
	await h.connect(A, B);
	await h.eventually(() => namesOf(B.page).then((n) => ({ uuids: Object.values(n), count: Object.keys(n).length })), (v) => v.count === OBJECTS.length && order.every((u) => v.uuids.includes(u)), '2.1 B received the ' + OBJECTS.length + ' objects with the same enemy uuids', 30000);
	await h.eventually(() => snap(B.page), (s) => !!s && s.enemies.length === ENEMIES.length && !s.running && s.enemies.map((e) => e.uuid).join() === order.join(), '2.2 B: the graph replicated and its Waves node derives the SAME arena', 20000);
	await h.eventually(() => screenOf(B.page), (v) => v === 'menu', '2.3 B: the HUD document arrived (menu screen)', 10000);

	// ---- 3. play: the shell, the HUD, the enemies walk ---------------------------------------------
	await A.page.locator('#play-button').click();
	await h.eventually(() => simOf(A.page), (v) => v.own === true, '3.1 A simulates on entering play (simOnPlay)', 15000);
	await B.page.locator('#play-button').click();
	await A.page.waitForTimeout(500);
	await h.eventually(async () => (await hudText(A.page)) ?? '', (t) => /WAVES/i.test(t) && /Play/.test(t) && /How to play/.test(t), '3.1b in play the menu renders its title, Play and How to play');
	await A.page.locator('#hud-layer button', { hasText: /^\W*Play$/ }).first().click();
	await h.eventually(() => gameStateOf(A.page), (v) => v === 'playing', '3.2 Play flips the shell to playing on A');
	await h.eventually(() => gameStateOf(B.page), (v) => v === 'playing', '3.3 ...and on B (the replicated state)');
	await h.eventually(() => screenOf(A.page), (v) => v === 'hud', '3.4 A sees the HUD screen', 6000);
	await h.eventually(() => snap(A.page), (s) => s?.running && s.started && s.alive >= 1, '3.5 the run is ON with enemies alive', 15000);
	const walking = async (page) => {
		const s = await snap(page);
		const out = {};
		for (const e of s?.enemies ?? []) out[e.uuid] = await posOf(page, e.uuid);
		return out;
	};
	const w0 = await walking(A.page);
	await A.page.waitForTimeout(2500);
	const w1 = await walking(A.page);
	const moved = order.filter((u) => w0[u] && w1[u] && Math.hypot(w1[u][0] - w0[u][0], w1[u][2] - w0[u][2]) > 1);
	h.check(moved.length >= 1, '3.6 THE REPORT: the enemies WALK (' + moved.length + ' moved > 1 m in 2.5 s)');
	const u0 = moved[0];
	const pA = u0 ? await posOf(A.page, u0) : null;
	const pB = u0 ? await posOf(B.page, u0) : null;
	h.check(!!pA && !!pB && Math.hypot(pA[0] - pB[0], pA[2] - pB[2]) < 1.5, '3.7 B places a walker where A does (same stamp, same clock): ' + JSON.stringify([pA?.map((v) => +v.toFixed(1)), pB?.map((v) => +v.toFixed(1))]));
	await h.eventually(() => hudRuntime(A.page), (r) => /Wave 1/.test(r['wv-wave']?.text ?? ''), '3.8 HUD Text reads the Waves Value node: Wave 1', 8000);

	// ---- 4. a kill: the gun's own path (engine.hit), both peers agree -------------------------------
	const prey = moved[0] ?? order[0];
	const pre = (await snap(A.page)).enemies.find((e) => e.uuid === prey);
	h.check(!!pre, '4.0 (premise) a walking enemy to shoot (' + (pre?.label ?? '?') + ', hp ' + (pre?.hp ?? '?') + ')');
	await A.page.evaluate((u) => window.__waves.engine.hit(u, 12), prey);
	await h.eventually(() => snap(A.page), (s) => (s?.enemies.find((e) => e.uuid === prey)?.kills ?? 0) >= 1, '4.1 enough hits kill it on A (kills 1)', 8000);
	await h.eventually(() => snap(B.page), (s) => (s?.enemies.find((e) => e.uuid === prey)?.kills ?? 0) >= 1, '4.2 and on B (the replicated ledger)', 8000);
	await h.eventually(() => myVar(A.page, 'kills'), (v) => v >= 1, '4.3 A\'s own kills row counts it');

	// ---- 5. the late joiner ------------------------------------------------------------------------
	// A approves the join, and a peer cannot approve from inside Play (the documented gotcha):
	// A steps out; B still plays, so the shell stays playing (the 10 s window)
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(500);
	const C = await h.setupPage(browser, 'C');
	await installZip(C, 'health', healthZip.bytes, 'C');
	await installZip(C, 'waves', wavesZip.bytes, 'C');
	await h.connect(C, A);
	await h.eventually(() => namesOf(C.page).then((n) => Object.keys(n).length), (n) => n === OBJECTS.length, '5.1 C received the arena', 30000);
	await h.eventually(() => snap(C.page), (s) => !!s && s.enemies.length === ENEMIES.length && (s.enemies.find((e) => e.uuid === prey)?.kills ?? 0) >= 1, '5.2 C reads the same ledger (the kill arrived in the triggers handshake)', 30000);
	await h.eventually(() => gameStateOf(C.page), (v) => v === 'playing', '5.3 C: the game shell reads playing');
	h.check((await myVar(C.page, 'kills')) === null, '5.4 the joiner has no kills row yet');

	for (const p of [A, B, C]) await p.page.evaluate(() => window.__stores.isLocked.set(false)).catch(() => {});
	await h.finish(browser);
});
