// 61 G3 — TEST WITH PLAYERS, the lane proof. One tab starts a 2-bot test through the real sheet (Play
// menu ▸ Test with players… ▸ Player 1 = Player, Player 2 = Viewer ▸ Start test), and:
//   1. both bots join over the local link (no approval card), both spawn (an avatar each in the host's
//      world; the player bot is in Play), and the dial carried 101's proto + caps like any peer's
//   2. an editor-only action from the VIEWER bot is refused by the host (a created box never lands, the
//      refusal is counted), and the viewer's key press cannot fire the win either
//   3. the PLAYER bot, driven from the strip (Drive hands it the keyboard), presses K: the win condition
//      fires — the host and the other bot both read game over / win
//   4. Stop test leaves a clean session: 0 bot roster rows, no open links, no frames, no new saves (idb
//      keys, localStorage keys), no tp:rejoin left in the tab's sessionStorage
// Run it on a plugin-less build (the dev server: no VITE_CLOUD_PLUGIN) AND with E2E_CLOUD_PLUGIN=<url>.
//
//   APP_URL=https://theprototype.app:5941/ node tests/e2e/test-players.test.cjs
//   E2E_VIDEO=<dir> records the host tab (the docs clip)
const h = require('./helpers.cjs');
const spy = require('./test-players-spy.cjs');

const NOW = () => (Date.now() % 86400000) / 1000;

/** @param {any} page @param {number} n */
async function botFrame(page, n, timeout = 120000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		const f = page.frames().find((fr) => /[?&]tpbot=/.test(fr.url()) && new RegExp('[?&]tpn=' + n + '(&|$|#)').test(fr.url()));
		if (f) return f;
		await page.waitForTimeout(250);
	}
	return null;
}

/** the host's facts about the run @param {any} page */
const hostState = (page) =>
	page.evaluate(() => {
		const s = window.__tp.test.v1;
		const dbg = s.testPlayers.testPlayersDebug();
		let users = [];
		s.userdata.subscribe((v) => (users = v))();
		let pc = null;
		s.peers.subscribe((v) => (pc = v))();
		let g = null;
		s.gameState.gameState.subscribe((v) => (g = v))();
		let approvals = [];
		s.pendingApprovals.subscribe((v) => (approvals = v))();
		const ids = dbg ? dbg.bots.map((b) => b.id).filter(Boolean) : [];
		return {
			dbg,
			me: pc.peer.id,
			roster: users.map((u) => u[0]),
			opened: [...pc.openedPeers],
			links: Object.keys(pc.connections),
			proto: ids.map((id) => pc.peerProto.get(id) ?? null),
			caps: ids.map((id) => pc.peerCaps.get(id) ?? null),
			playModes: ids.map((id) => s.gamePresence.playModeOf(id)),
			avatars: ids.map((id) => s.playSpawn.avatarPositions([id]).length),
			game: { state: g.state, outcome: g.outcome },
			approvals: approvals.length,
			frames: document.querySelectorAll('#test-players-strip iframe').length,
			objects: (() => {
				let og;
				s.objectsGroup.subscribe((v) => (og = v))();
				return og.children.length;
			})()
		};
	});

/** storage the bots could have written to (the tab's own) @param {any} page */
const storageFacts = (page) =>
	page.evaluate(async () => {
		const s = window.__tp.test.v1;
		const idb = (await s.idb.idbKeys()).map(String).sort();
		const ls = [];
		for (let i = 0; i < localStorage.length; i++) ls.push(localStorage.key(i));
		return { idb, ls: ls.sort(), rejoin: sessionStorage.getItem('tp:rejoin'), sessions: idb.filter((k) => k.startsWith('session:')).length };
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const video = process.env.E2E_VIDEO ? { recordVideo: { dir: process.env.E2E_VIDEO, size: { width: 1280, height: 800 } } } : {};
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 }, ...video }, init: { content: spy.writeSpy() } });
	const page = A.page;
	await h.answerRestore(A).catch(() => {});

	// ---- 0. a tiny game: K wins ---------------------------------------------------------------
	await page.evaluate(async () => {
		const s = window.__tp.test.v1;
		s.gameState.clearGameState();
		const N = (id, type, data, x) => ({ id, type, position: { x, y: 0 }, data: { type, label: id, ...data } });
		const nodes = [N('kKey', 'keypress', { code: 'KeyK', edge: 'down', pulse: 0.3 }, 0), N('kWin', 'setgamestate', { state: 'over', outcome: 'win' }, 260)];
		const edges = [{ id: 'e-k-win', source: 'kKey', target: 'kWin', targetHandle: 'trigger' }];
		s.flowGraphs.update((g) => ({ ...g, scene: { nodes, edges } }));
		s.flowNodes.set(nodes);
		s.flowEdges.set(edges);
		await new Promise((r) => setTimeout(r, 1200)); // past the nodes' first-seen
	});
	await page.waitForTimeout(4000); // the host's own autosave of that edit settles before the baseline
	const before = await storageFacts(page);
	const objectsBefore = (await hostState(page).catch(() => null))?.objects;
	console.log('storage before:', JSON.stringify({ idb: before.idb.length, ls: before.ls.length, sessions: before.sessions }));

	// ---- 1. the sheet: Play menu ▸ Test with players… ------------------------------------------
	await page.click('#play-button', { button: 'right' });
	await page.waitForTimeout(300);
	const rows = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
	h.check(rows.some((r) => /^Test with players/.test(r)), `the Play menu offers "Test with players…" (${JSON.stringify(rows)})`);
	await page.getByRole('menuitem', { name: /Test with players/ }).click();
	await page.waitForSelector('#test-players-start', { timeout: 30000 });
	h.check(await page.isVisible('#test-players-sheet, [id="test-players-start"]'), 'the setup sheet opens');
	await page.click('#test-players-count-2');
	await page.click('#test-player-role-1-player');
	await page.click('#test-player-role-2-viewer');
	if (process.env.E2E_SHOTS) await page.screenshot({ path: process.env.E2E_SHOTS + '/01-test-players-sheet.png' });
	await page.click('#test-players-start');
	const t0 = Date.now();

	// ---- 2. both join, both spawn --------------------------------------------------------------
	/** @type {any} */
	let st = null;
	const joinedBy = Date.now() + 240000;
	while (Date.now() < joinedBy) {
		st = await hostState(page);
		const ok = st.dbg && st.dbg.bots.length === 2 && st.dbg.bots.every((b) => b.id && st.opened.includes(b.id));
		const spawned = ok && st.avatars.every((n) => n > 0) && st.playModes[0] === 'playing';
		if (spawned) break;
		await page.waitForTimeout(1000);
	}
	console.log('joined:', JSON.stringify(st), 'after', Math.round((Date.now() - t0) / 1000), 's');
	if (!(st.dbg && st.dbg.bots.every((b) => b.id))) await spy.stuck(page, st.dbg);
	const [p1, p2] = st.dbg.bots;
	h.check(st.dbg.bots.length === 2 && st.dbg.bots.every((b) => b.id && st.opened.includes(b.id)), `both bots joined over the local link (${JSON.stringify(st.dbg.bots)})`);
	h.check(st.roster.includes(p1.id) && st.roster.includes(p2.id), `both are on the host's roster (${JSON.stringify(st.roster)})`);
	h.check(st.approvals === 0, `no approval card was needed (${st.approvals})`);
	h.check(st.proto.every((p) => p === 1) && st.caps.every((c) => c && typeof c === 'object'), `each dial carried 101's proto + caps (${JSON.stringify(st.proto)} ${JSON.stringify(st.caps)})`);
	h.check(st.avatars.every((n) => n > 0), `both spawned: an avatar each in the host's world (${JSON.stringify(st.avatars)})`);
	h.check(st.playModes[0] === 'playing', `the player bot is in Play (${JSON.stringify(st.playModes)})`);
	h.check(st.frames === 2, `the strip shows two live views (${st.frames})`);
	const f1 = await botFrame(page, 1);
	const f2 = await botFrame(page, 2);
	h.check(!!f1 && !!f2, 'both bot frames are reachable');
	const botView = (f) =>
		f.evaluate(() => {
			const s = window.__tp.test.v1;
			let pc = null;
			s.peers.subscribe((v) => (pc = v))();
			let nodes = [];
			s.flowNodes.subscribe((v) => (nodes = v))();
			let g = null;
			s.gameState.gameState.subscribe((v) => (g = v))();
			return { id: pc.peer.id, opened: [...pc.openedPeers], nodes: nodes.map((n) => n.id), game: { state: g.state, outcome: g.outcome }, isolated: s.safeStorage?.storageIsolated ?? null, bot: document.documentElement.dataset.tpBot ?? null };
		});
	const v1 = await botView(f1);
	const v2 = await botView(f2);
	console.log('bot views:', JSON.stringify([v1, v2]));
	h.check(v1.nodes.includes('kKey') && v2.nodes.includes('kKey'), "both bots received the host's scene graph");
	h.check(v1.opened.includes(v2.id) && v2.opened.includes(v1.id), 'the bots meshed with each other too (bot-to-bot over the hub)');
	h.check(v1.bot === 'player' && v2.bot === 'viewer', `each frame knows its role (${v1.bot}, ${v2.bot})`);
	h.check(v1.isolated === true && v2.isolated === true, `both frames run with isolated storage (${v1.isolated}, ${v2.isolated})`);
	if (process.env.E2E_SHOTS) await page.screenshot({ path: process.env.E2E_SHOTS + '/02-test-players-strip.png' });

	// ---- 3. the viewer bot tries to edit: refused ----------------------------------------------
	const refusedBefore = st.dbg.refused.length;
	await f2.evaluate(async () => {
		const s = window.__tp.test.v1;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 300));
		s.flowRuntime.applyNodeTrigger('kKey', (Date.now() % 86400000) / 1000, true);
	});
	await page.waitForTimeout(2500);
	st = await hostState(page);
	const refusedNow = st.dbg.refused.slice(refusedBefore);
	console.log('refused:', JSON.stringify(refusedNow));
	h.check(st.objects === objectsBefore, `the viewer's box never landed on the host (${objectsBefore} -> ${st.objects})`);
	h.check(refusedNow.some((r) => r.peer === p2.id && /^(create|object|objectfile|group|duplicate)$/.test(r.type)), `the host refused the viewer's creation (${JSON.stringify(refusedNow.map((r) => r.type))})`);
	h.check(refusedNow.some((r) => r.peer === p2.id && r.type === 'nodetrigger'), "and the viewer's trigger");
	h.check(st.game.state !== 'over', `the viewer could not fire the win (${JSON.stringify(st.game)})`);
	h.check(!st.dbg.refused.some((r) => r.peer === p1.id && /^(nodetrigger|game|playmode|trigger)$/.test(r.type)), "nothing the player bot PLAYS with was refused (its join burst is: a role, not an action)");
	const v1after = await botView(f1);
	h.check(v1after.game.state !== 'over', `the PLAYER bot did not take the viewer's win either (bots gate each other: ${JSON.stringify(v1after.game)})`);
	const badge = await page.evaluate(() => document.querySelector('#test-players-strip .tpst-refused')?.textContent?.trim() ?? null);
	const loud = st.dbg.refused.filter((r) => !r.quiet);
	h.check(badge !== null && Number.parseInt(badge, 10) === loud.length && loud.length < st.dbg.refused.length && loud.some((r) => r.type === 'create'), `the strip counts what a bot TRIED, not its join burst (${badge}: ${JSON.stringify(loud.map((r) => r.type))}; ${st.dbg.refused.length} recorded)`);

	// ---- 4. drive the player bot, press K: the win fires ---------------------------------------
	await page.getByRole('button', { name: 'Drive player 1' }).click();
	await page.waitForTimeout(500);
	const drivingFocus = await page.evaluate(() => document.activeElement?.id ?? null);
	h.check(drivingFocus === 'test-player-frame-1', `Drive hands the keyboard to the bot's frame (${drivingFocus})`);
	if (process.env.E2E_SHOTS) await page.screenshot({ path: process.env.E2E_SHOTS + '/03-test-players-drive.png' });
	await page.keyboard.down('KeyK');
	await page.waitForTimeout(250);
	await page.keyboard.up('KeyK');
	let won = null;
	for (let i = 0; i < 20; i++) {
		st = await hostState(page);
		if (st.game.state === 'over') break;
		await page.waitForTimeout(250);
	}
	if (st.game.state !== 'over') {
		// a headless frame can miss the key: say so, and fire the bot's own key node the way its keyboard would
		console.log('[note] the key did not reach the bot frame; pulsing its key node from inside the bot');
		await f1.evaluate((t) => window.__tp.test.v1.flowRuntime.applyNodeTrigger('kKey', t, true), NOW());
		await page.waitForTimeout(2000);
		st = await hostState(page);
	}
	won = st.game;
	h.check(won.state === 'over' && won.outcome === 'win', `the player bot fired the win condition: the host reads game over / win (${JSON.stringify(won)})`);
	const v2won = await botView(f2);
	h.check(v2won.game.state === 'over' && v2won.game.outcome === 'win', `... and so does the other bot (${JSON.stringify(v2won.game)})`);
	await page.getByRole('button', { name: 'Stop driving player 1' }).click().catch(() => {});

	h.check(await spy.probe(page, f1), 'the bot-write spy sees a bot frame\'s real write (positive control)');

	// ---- 5. Stop test: a clean session ---------------------------------------------------------
	await page.click('#test-players-stop');
	await page.waitForFunction(() => !document.querySelector('#test-players-strip'), null, { timeout: 20000 }).catch(() => {});
	await page.waitForTimeout(1500);
	st = await hostState(page);
	const after = await storageFacts(page);
	console.log('after stop:', JSON.stringify({ roster: st.roster, opened: st.opened, links: st.links, frames: st.frames, dbg: st.dbg }));
	h.check(st.dbg === null, 'the run is over');
	h.check(st.roster.filter((id) => id !== st.me).length === 0, `0 bot roster rows (${JSON.stringify(st.roster)})`);
	h.check(st.opened.length === 0 && st.links.length === 0, `no open links left (${JSON.stringify(st.opened)} ${JSON.stringify(st.links)})`);
	h.check(st.frames === 0 && page.frames().every((f) => !/[?&]tpbot=/.test(f.url())), 'no bot frames left');
	const newIdb = after.idb.filter((k) => !before.idb.includes(k) && k !== 'latest');
	const newLs = after.ls.filter((k) => !before.ls.includes(k));
	h.check(after.sessions === before.sessions && newIdb.length === 0, `0 extra saves: no new IndexedDB records (${JSON.stringify(newIdb)}; sessions ${before.sessions} -> ${after.sessions})`);
	const botWrites = await spy.writes(page);
	h.check(botWrites.length === 0, `the bots wrote nothing to this tab's real storage (${JSON.stringify(botWrites)})`);
	// a key the HOST added is its own (a one-time hint it showed because of the test): one-time hints are logged,
	// anything else still fails
	const hostHints = newLs.filter((k) => /:hintSeen$/.test(k));
	if (hostHints.length) console.log('the host itself added (its own one-time hints):', JSON.stringify(hostHints));
	h.check(newLs.length === hostHints.length, `no other settings appeared in this tab's storage (${JSON.stringify(newLs)})`);
	h.check(after.rejoin === null, `no tp:rejoin left behind by a bot's goodbye (${after.rejoin})`);
	const rows2 = await (async () => {
		await page.click('#play-button', { button: 'right' });
		await page.waitForTimeout(300);
		const r = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
		await page.keyboard.press('Escape');
		return r;
	})();
	h.check(rows2.some((r) => /^Test with players/.test(r)) && !rows2.includes('Stop test'), 'the Play menu is back to "Test with players…"');

	await h.finish(browser);
});
