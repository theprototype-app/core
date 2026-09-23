// 29-F ACCEPTANCE — the Waves game template: wave survival composed from TWO modules
// (`health` holds the hit points, `waves` derives the wave from the enemies' counters and
// walks the living ones at the goal) on the REAL artefacts and nothing authored in-test:
//   the scene — games/waves/scene.tpscene from the scenes FEED (core's own SCENES_BASE
//               fallback, read out of src/lib/sceneTemplates.js so a ref move follows by
//               construction — #230), or WAVES_TPSCENE=<path>, or a sibling scenes checkout
//   the zips  — health.zip + waves.zip: HEALTH_ZIP / WAVES_ZIP, the MODULES_REPO checkout,
//               a packed sibling modules checkout, or the modules CDN
// installed on TWO peers plus a LATE JOINER. Skip-never-fail when a source is missing.
//
// What it proves:
//   1 THE GAMES TAB: the card is picked in the real Templates modal (the feed's index.json
//     and the scene are served through a route so the row exists before its release) and
//     loadRemoteScene replaces the world — 10 objects, both modules in the requirement
//     list, the sunset env, the play block (grab, grounded, sim on play), the knock block
//     ON, the menu screen, and the modules' derivations: 4 enemies on a 3-wave curve, a
//     goal, three spawn points, five health rows
//   2 B receives it over the handshake: same uuids, the same derivation, the HUD document
//   3 play: Start -> the shell is playing on both -> the HUD screen; the run is ON (wave 1
//     uses two of the four enemies), the first enemy WALKS toward the goal (+z) and B
//     places it where A does; the parked enemies stand where the file put them; the HUD
//     Text elements read the Waves Value nodes and the bar reads the player's health
//   4 kills are KNOCKS (the template's damage source is `hit`, scaled by speed): a slow
//     sweep is one pulse (3 -> 2), a hard one three (dead) — core's feedProbe, the code a
//     hand runs — the hit lands in B's hit log and B's ledger agrees (its own local pulses
//     off the replicated `hit`); B's knock (a non-initiator) completes wave 1; the kills
//     rows are per peer; after the interval wave 2 heals the survivors (3 alive)
//   5 the late joiner: C reads WAVE 2 from the counters in the triggers handshake, the same
//     ledger, and the game shell
//   6 the last waves fall on A's knocks -> DONE on all three -> `over`
//     -> Set Game State (outcome won) -> the over screen; ONE run logged on every peer;
//     Again -> a new round with every enemy back at full health
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
const ENEMIES = ['Enemy 1', 'Enemy 2', 'Enemy 3', 'Enemy 4'];
const OBJECTS = ['Ground', 'Goal', 'Spawn 1', 'Spawn 2', 'Spawn 3', ...ENEMIES, 'Home'];
const ENEMY_HP = 3;
const INTERVAL_S = 3;

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
const lastHitOf = (page, uuid) => page.evaluate((u) => window.__stores.knock.hitLogSnapshot().last[u]?.at ?? null, uuid);

/** a knock probe swept along +x through the enemy's CURRENT position at `speed` m/s —
 * core's feedProbe, the same code a hand (or the desktop head probe) runs. The sweep is
 * one synchronous loop, so the enemy the module walks every frame holds still under it. */
const knock = (page, uuid, speed) =>
	page.evaluate(
		({ uuid, speed }) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g?.getObjectByProperty('uuid', uuid);
			if (!o) return { hits: 0, armed: false };
			const k = window.__stores.knock;
			const id = 'gw-' + Math.random().toString(36).slice(2, 7);
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
/** a knock that cannot miss: up to three sweeps, the first that lands wins */
async function knockUntil(page, uuid, speed, label) {
	let last = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		last = await knock(page, uuid, speed);
		if (last.hits >= 1) break;
		await page.waitForTimeout(250);
	}
	h.check(!!last && last.hits >= 1 && last.armed, label + ' (hits ' + (last?.hits ?? 0) + ', armed ' + (last?.armed ?? false) + ')');
	return last;
}
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
								{ id: 'waves', version: '1.0.0' }
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
	await h.eventually(() => namesOf(A.page).then((n) => Object.keys(n)), (n) => n.length === 11 && !n.includes('Box'), '1.3 picking the card loads the scene: the box is gone, 11 objects stand (10 + the Arena group)', 30000);
	await A.page.waitForTimeout(1500);
	const names = await namesOf(A.page);
	h.check(OBJECTS.every((n) => !!names[n]), '1.4 the ground, the goal, three spawn pads, four enemies and the home pad (' + Object.keys(names).join(', ') + ')');
	const modules = await A.page.evaluate(() => {
		let m;
		window.__stores.moduleRequirements.sceneModules.subscribe((v) => (m = v))();
		return (m ?? []).map((e) => e.id);
	});
	h.check(modules.includes('health') && modules.includes('waves'), '1.5 the file\'s requirement list names BOTH modules (' + modules.join(',') + ')');
	const env = await A.page.evaluate(() => {
		let e;
		window.__stores.environment.environment.subscribe((v) => (e = v))();
		return e?.preset ?? null;
	});
	h.check(env === 'custom', '1.6 the custom sunset sky (' + env + ')');
	const phys = await A.page.evaluate(() => window.__stores.scenePhysics.scenePhysicsDebug());
	h.check(phys.play?.interaction === 'grab' && phys.play?.grounded === true && phys.play?.simOnPlay === true, '1.7 play block: grab, grounded, sim on play (' + JSON.stringify(phys.play) + ')');
	h.check(phys.knock?.enabled === true && phys.knock?.maxSpeed === 10, '1.8 the knock block is ON (a hand knocks an enemy) (' + JSON.stringify(phys.knock) + ')');
	h.check((await gameStateOf(A.page)) === 'menu' && (await screenOf(A.page)) === 'menu', '1.9 the game shell starts in menu with the menu screen');
	await h.eventually(() => A.page.evaluate(() => ({ chip: !!document.querySelector('#game-chip'), buttons: document.querySelectorAll('#hud-layer button').length })), (v) => v.chip && v.buttons === 0, '1.10 in the editor the game chip stands in for the menu (30 P1: no live menu over the editor)', 6000);
	await h.eventually(() => snap(A.page), (s) => !!s && s.enemies.length === 4 && s.wave === 1 && !s.running && !!s.goal && s.spawns === 3 && s.waves === 3, '1.11 waves derives from the file: 4 enemies, wave 1 of 3, idle, a goal, three spawn points', 10000);
	const a1 = await snap(A.page);
	h.check(a1.enemies.map((e) => e.label).join() === ENEMIES.join(), '1.12 enemy order is by name (' + a1.enemies.map((e) => e.label).join(', ') + ')');
	await h.eventually(() => healthSnap(A.page), (all) => all.length === 5 && all.filter((s) => s.scope === 'object').every((s) => s.hp === ENEMY_HP && !s.dead), '1.13 health derives five rows: four enemies at ' + ENEMY_HP + ' hp and the player');
	const order = a1.enemies.map((e) => e.uuid);
	h.check(order.every((u, i) => names[ENEMIES[i]] === u), '1.14 the health targets are the four Enemy objects by uuid');

	// ---- 2. B receives it over the handshake ------------------------------------------------------
	await h.connect(A, B);
	await h.eventually(() => namesOf(B.page).then((n) => ({ uuids: Object.values(n), count: Object.keys(n).length })), (v) => v.count === 11 && order.every((u) => v.uuids.includes(u)), '2.1 B received the 11 objects with the same enemy uuids', 30000);
	await h.eventually(() => snap(B.page), (s) => !!s && s.enemies.length === 4 && s.wave === 1 && !s.running && s.spawns === 3 && s.enemies.map((e) => e.uuid).join() === order.join(), '2.2 B: the graph replicated and its Waves node derives the SAME arena', 20000);
	await h.eventually(() => healthSnap(B.page), (all) => all.length === 5, '2.3 B: five health rows');
	await h.eventually(() => screenOf(B.page), (v) => v === 'menu', '2.4 B: the HUD document arrived (menu screen)', 10000);

	// ---- 3. play: Start -> the shell -> the run is on, the enemies walk ---------------------------
	await A.page.locator('#play-button').click();
	await h.eventually(() => simOf(A.page), (v) => v.own === true, '3.1 A simulates on entering play (simOnPlay)', 15000);
	await B.page.locator('#play-button').click();
	await A.page.waitForTimeout(500);
	await h.eventually(async () => (await hudText(A.page)) ?? '', (t) => /WAVES/.test(t) && /Start/.test(t), '3.1b in play the menu renders its title and Start');
	await hudButton(A.page, 'Start').click();
	await h.eventually(() => gameStateOf(A.page), (v) => v === 'playing', '3.2 Start flips the shell to playing on A');
	await h.eventually(() => gameStateOf(B.page), (v) => v === 'playing', '3.3 ...and on B (the replicated state)');
	await h.eventually(() => screenOf(A.page), (v) => v === 'hud', '3.4 A sees the HUD screen', 6000);
	await h.eventually(() => snap(A.page), (s) => s?.running && s.started && s.wave === 1 && s.size === 2 && s.alive === 2, '3.5 the run is ON: wave 1 uses two of the four enemies, both alive', 10000);
	await h.eventually(() => snap(B.page), (s) => s?.running && s.started && s.wave === 1 && s.alive === 2, '3.6 B agrees', 10000);
	const p0 = await posOf(A.page, order[0]);
	await A.page.waitForTimeout(1500);
	const p1 = await posOf(A.page, order[0]);
	h.check(!!p0 && !!p1 && p1[2] > p0[2] + 1, '3.7 the first enemy walks toward the goal (+z): ' + p0?.[2].toFixed(1) + ' -> ' + p1?.[2].toFixed(1));
	const pA = await posOf(A.page, order[0]);
	const pB = await posOf(B.page, order[0]);
	h.check(!!pA && !!pB && Math.abs(pA[2] - pB[2]) < 1.0, '3.8 B places it where A does (same stamp, same clock): ' + pA?.[2].toFixed(1) + ' vs ' + pB?.[2].toFixed(1));
	const p3 = await posOf(A.page, order[3]);
	h.check(!!p3 && Math.abs(p3[2] - -8) < 0.3, '3.9 the fourth enemy is not in wave 1: parked where the file put it (z ' + p3?.[2].toFixed(1) + ')');
	await h.eventually(() => hudRuntime(A.page), (r) => r['wv-wave']?.text === 'Wave 1' && r['wv-left']?.text === '2 left', '3.10 HUD Text reads the Waves Value nodes: Wave 1, 2 left');
	await h.eventually(() => hudRuntime(A.page), (r) => Math.abs((r['wv-hp']?.value ?? 0) - 1) < 0.01, '3.11 the HUD bar reads the player\'s health (full)');

	// ---- 4. kills are knocks: speed-scaled pulses, both peers, the wave advances -------------------
	const hitBefore = await lastHitOf(B.page, order[0]);
	await knockUntil(A.page, order[0], 1, '4.1 A sweeps a SLOW probe through Enemy 1');
	await h.eventually(() => hpOf(A.page, order[0]), (v) => v === ENEMY_HP - 1, '4.2 a slow knock is ONE pulse: ' + ENEMY_HP + ' -> ' + (ENEMY_HP - 1));
	await h.eventually(() => lastHitOf(B.page, order[0]), (t) => t !== null && t !== hitBefore, '4.3 the hit landed in B\'s hit log (the replicated `hit`)');
	await h.eventually(() => hpOf(B.page, order[0]), (v) => v === ENEMY_HP - 1, '4.4 B\'s ledger agrees (its own local pulse off the same hit)');
	await knockUntil(A.page, order[0], 9, '4.5 A sweeps a HARD probe through Enemy 1');
	await h.eventually(() => snap(A.page), (s) => s?.alive === 1 && s.enemies[0].kills === 1, '4.6 a hard knock is three pulses: Enemy 1 is dead, one left in wave 1');
	await h.eventually(() => myVar(A.page, 'kills'), (v) => v === 1, '4.7 A\'s own kills row reads 1 (the killing blow was its hand)');
	await h.eventually(() => hudRuntime(A.page), (r) => r['wv-left']?.text === '1 left', '4.8 HUD Text: 1 left');
	await knockUntil(B.page, order[1], 9, '4.9 B (not the initiator) sweeps a hard probe through Enemy 2');
	await h.eventually(() => snap(A.page), (s) => s?.completed === 1, '4.10 wave 1 is complete on A (B\'s hit replicated, A fired its own pulses)', 10000);
	await h.eventually(() => myVar(B.page, 'kills'), (v) => v === 1, '4.11 B\'s own kills row reads 1');
	h.check((await myVar(A.page, 'kills')) === 1, '4.12 ...and A\'s is still 1: one writer per row');
	await h.eventually(() => snap(A.page), (s) => s?.wave === 2 && s.started && s.alive === 3, '4.13 after the interval: wave 2, three alive (the survivors healed with local pulses)', (INTERVAL_S + 6) * 1000);
	await h.eventually(() => snap(B.page), (s) => s?.wave === 2 && s.started && s.alive === 3, '4.14 B: wave 2 too', 10000);
	// the slow knock's one pulse plus the hard knock's three is FOUR hits; wave 2 heals one
	// death's worth (3), so the survivor comes back at 2 — heals bank per death, they do not
	// top up (the health module's documented rule)
	await h.eventually(() => snap(A.page), (s) => s && s.enemies[0].hits === ENEMY_HP + 1 && s.enemies[0].heals === ENEMY_HP && s.enemies[0].hp === ENEMY_HP - 1 && s.enemies[3].hits === 0, '4.15 the ledger: Enemy 1 has ' + (ENEMY_HP + 1) + ' hits and ' + ENEMY_HP + ' heals (hp ' + (ENEMY_HP - 1) + ', the overkill pulse counted), Enemy 4 untouched');
	await h.eventually(() => hudRuntime(B.page), (r) => r['wv-wave']?.text === 'Wave 2' && r['wv-left']?.text === '3 left', '4.16 B\'s HUD Text: Wave 2, 3 left');

	// ---- 5. the late joiner ------------------------------------------------------------------------
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(500);
	const C = await h.setupPage(browser, 'C');
	await installZip(C, 'health', healthZip.bytes, 'C');
	await installZip(C, 'waves', wavesZip.bytes, 'C');
	await h.connect(C, A);
	await A.page.locator('#play-button').click();
	await h.eventually(() => namesOf(C.page).then((n) => Object.keys(n).length), (n) => n === 11, '5.1 C received the arena', 30000);
	await h.eventually(() => snap(C.page), (s) => !!s && s.wave === 2 && s.enemies.length === 4 && s.enemies[0].hits === ENEMY_HP + 1 && s.enemies[0].heals === ENEMY_HP, '5.2 C reads WAVE 2 with the same ledger — the counts arrived in the triggers handshake', 30000);
	await h.eventually(() => gameStateOf(C.page), (v) => v === 'playing', '5.3 C: the game shell reads playing');
	h.check((await myVar(C.page, 'kills')) === null, '5.4 the joiner has no kills row yet');
	await C.page.locator('#play-button').click();
	await h.eventually(() => hudRuntime(C.page), (r) => r['wv-wave']?.text === 'Wave 2', '5.5 C\'s HUD Text reads Wave 2', 10000);

	// ---- 6. the last waves, over, the log, Again ------------------------------------------------------
	// (the template wires no pause: P is the editor's sim toggle and does nothing to the run)
	// wave 2 uses three enemies; wave 3 all four. A's hand clears both — ONE enemy at a
	// time, as early in the wave as it can (the walkers converge on the goal and, held
	// kinematic, stand co-located there, where one sweep hits every body it overlaps —
	// run 2 measured hits 3 on a sweep aimed at one), waiting for each to fall and skipping
	// any a shared sweep already took, and never swinging again until the next wave is ON
	// (a knock in the interval lands on a body the next wave is about to heal).
	const clearWave = async (n, indices, label) => {
		// the heals into a new wave land a tick or two after it starts (local pulses, counters
		// republished ~6/s): swing only once every enemy the wave uses reads healed, or a body
		// still at 0 from the last wave is skipped as "down"
		await h.eventually(() => snap(A.page), (s) => s?.wave === n && s.started && indices.every((i) => s.enemies[i].hp > 0), label + ' (premise) wave ' + n + ' is on and its enemies are healed', 12000);
		for (const i of indices) {
			const before = await snap(A.page);
			if (before.completed >= n) break;
			if (before.enemies[i].hp <= 0) continue;
			const kills = before.enemies[i].kills;
			await knockUntil(A.page, order[i], 9, label + ' A knocks down ' + ENEMIES[i] + ' (wave ' + n + ')');
			await h.eventually(() => snap(A.page), (s) => s.enemies[i].kills > kills || s.completed >= n, label + ' ...' + ENEMIES[i] + ' is down', 8000);
		}
		await h.eventually(() => snap(A.page), (s) => s?.completed >= n, label + ' wave ' + n + ' is complete', 8000);
	};
	await clearWave(2, [0, 1, 2], '6.1');
	await h.eventually(() => snap(A.page), (s) => s?.wave === 3 && s.started && s.alive === 4, '6.2 wave 3: all four alive', (INTERVAL_S + 8) * 1000);
	await h.eventually(() => snap(C.page), (s) => s?.wave === 3 && s.alive === 4, '6.3 C: wave 3, four alive', 10000);
	await clearWave(3, [0, 1, 2, 3], '6.4');
	await h.eventually(() => snap(A.page), (s) => s?.done === true && s.alive === 0, '6.5 the last enemy falls: DONE on A', 10000);
	await h.eventually(() => snap(B.page), (s) => s?.done === true, '6.6 done on B', 8000);
	await h.eventually(() => snap(C.page), (s) => s?.done === true, '6.7 done on C', 8000);
	await h.eventually(() => gameOf(A.page), (g) => g.state === 'over' && g.outcome === 'won', '6.8 `over` -> Set Game State: the shell is OVER (won) on A', 8000);
	await h.eventually(() => gameOf(B.page), (g) => g.state === 'over' && g.outcome === 'won', '6.9 ...and on B');
	await h.eventually(() => gameOf(C.page), (g) => g.state === 'over' && g.outcome === 'won', '6.10 ...and on C');
	await h.eventually(() => screenOf(A.page), (v) => v === 'over', '6.11 A sees the over screen', 6000);
	h.check(/ARENA CLEARED/.test(await hudText(A.page)) && /Again/.test(await hudText(A.page)), '6.12 the over screen renders its title and Again');
	await h.eventually(() => snap(A.page), (s) => s?.log.length === 1 && s.log[0].cleared && s.log[0].waves === 3 && s.log[0].reached === 3, '6.13 ONE run logged in gameState.vars: cleared, 3 waves', 8000);
	const logA = (await snap(A.page)).log[0];
	const kills = [await myVar(A.page, 'kills'), await myVar(B.page, 'kills'), await myVar(C.page, 'kills')].map((v) => (v === null ? 'none' : String(v)));
	// nine kills in a round (2 + 3 + 4); B's hand took one, C's none, so A's took the rest —
	// however many bodies one of A's sweeps caught at the goal, every kill is credited to a hand
	h.check(kills.join() === '8,1,none', '6.14 kills rows: A 8, B 1, C none — each peer credited only its own blows (' + kills.join() + ')');
	await h.eventually(() => snap(B.page), (s) => s?.log.length === 1 && JSON.stringify(s.log[0]) === JSON.stringify(logA), '6.15 B holds the SAME run entry (idempotent by its stamp)', 8000);
	await h.eventually(() => snap(C.page), (s) => s?.log.length === 1 && s.log[0].at === logA.at, '6.16 and so does C');
	await h.eventually(() => hudRuntime(A.page), (r) => (r['wv-kills,wv-kills-over']?.rows ?? []).length >= 2, '6.17 the leaderboard rows list the scorers (one node feeds both lists)');
	await hudButton(A.page, 'Again').click();
	await h.eventually(() => gameStateOf(B.page), (v) => v === 'playing', '6.18 Again -> a new round on B', 8000);
	await h.eventually(() => snap(A.page), (s) => s?.running && s.wave === 1 && s.completed === 0 && s.enemies.every((e) => e.hp === ENEMY_HP), '6.19 A: wave 1 again, every enemy back at full health (the reset chains)', 10000);
	await h.eventually(() => snap(C.page), (s) => s?.running && s.wave === 1 && s.enemies.every((e) => e.hp === ENEMY_HP), '6.20 C agrees', 10000);
	h.check((await snap(A.page)).log.length === 1, '6.21 the log keeps the finished run');

	for (const p of [A, B, C]) await p.page.evaluate(() => window.__stores.isLocked.set(false)).catch(() => {});
	await h.finish(browser);
});
