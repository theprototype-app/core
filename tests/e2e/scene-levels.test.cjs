// 21-F4a — SCENES AS LEVELS, the asset + travel core (the travel NODE and the debug
// element are F4b, on top of this):
//
//   levels.saveSceneAsLevel   the current scene as a content-hashed .tpscene in a
//                             `Levels` Explorer folder (workspace stripped)
//   levels.newLevel           an empty level asset that captures NOTHING
//   levels.travelToLevel      a LOCAL, silent scene replace: no backup stash, no
//                             replication (the deterministic model — the trigger is
//                             what replicates), the file's `game` EXCLUDED and the
//                             live state re-asserted (fork 3: campaign semantics),
//                             and a missing hash PULLED from peers first (the LUT
//                             watch — ask once, then watch until the bytes land)
//
// TIMING: h.GPU_ARGS — the two-peer pull section measures a real asset round trip.
// Run: APP_URL='https://localhost:5204/' PEER_CONFIG=... npm run e2e -- scene-levels
const h = require('./helpers.cjs');

// ---- reading the world -----------------------------------------------------------
const childUuids = (peer) =>
	peer.page.evaluate(() => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return (group?.children ?? []).map((c) => c.uuid).sort();
	});

const gstate = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.gameState.gameState.subscribe((v) => (g = v))();
		return g;
	});

const levelItemsOf = (peer) =>
	peer.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return items.filter((i) => i.kind === 'scene').map((i) => ({ name: i.name, hash: i.hash }));
	});

const sessionCount = (peer) =>
	peer.page.evaluate(async () => {
		await window.__stores.sessions.loadSessions();
		let list;
		window.__stores.sessions.sessions.subscribe((v) => (list = v))();
		return list.length;
	});

const makeBoxes = (peer, count) =>
	peer.page.evaluate(async (n) => {
		const s = window.__stores;
		const uuids = [];
		for (let i = 0; i < n; i++) {
			s.commandsHandler.sceneCommand('/create box');
			await new Promise((r) => setTimeout(r, 1100));
			let group;
			s.objectsGroup.subscribe((v) => (group = v))();
			uuids.push(group.children[group.children.length - 1].uuid);
		}
		s.objectActions.deselectObject();
		return uuids;
	}, count);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// =====================================================================
	// 1. THE ENTRY POINT — the Explorer grid menu, driven as a user would
	// =====================================================================
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(600);
	A.page.once('dialog', (d) => d.accept('UI Level'));
	await A.page.locator('#explorer-list [role="region"]').first()
		.click({ button: 'right', position: { x: 200, y: 140 } });
	await A.page.waitForTimeout(300);
	const rows = await A.page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] button, [role="menu"] [role="menuitem"]')].map(
			(el) => el.textContent?.trim()
		)
	);
	h.check(
		rows.some((r) => r?.includes('Save scene as level')) && rows.some((r) => r?.includes('New scene')),
		`the grid menu offers both level entries (${JSON.stringify(rows)})`
	);
	await A.page.getByText('Save scene as level…', { exact: false }).click();
	await h.eventually(
		() => levelItemsOf(A),
		(items) => items.some((i) => i.name.includes('UI Level')),
		'the UI path saved a level item (empty scene is a valid level)'
	);

	// =====================================================================
	// 2. SAVE AS LEVEL + NEW SCENE, store-driven
	// =====================================================================
	const one = await makeBoxes(A, 2);
	const savedOne = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Level One'));
	h.check(!!savedOne?.hash, `Level One saved with a content hash (${savedOne?.hash?.slice(0, 8)})`);
	const foldersA = await A.page.evaluate(() => {
		let f;
		window.__stores.explorer.explorerFolders.subscribe((v) => (f = v))();
		return f.map((x) => x.name);
	});
	h.check(foldersA.includes('Levels'), `the Levels folder exists by convention (${JSON.stringify(foldersA)})`);
	const items2 = await levelItemsOf(A);
	h.check(
		items2.some((i) => i.name === 'Level One.tpscene'),
		`the level is an ordinary .tpscene item (${JSON.stringify(items2.map((i) => i.name))})`
	);
	h.check(
		(await A.page.evaluate(() => {
			let c;
			window.__stores.levels.currentLevel.subscribe((v) => (c = v))();
			return c?.name;
		})) === 'Level One',
		'currentLevel names the save'
	);

	const blank = await A.page.evaluate(() => window.__stores.levels.newLevel('Blank'));
	h.check(!!blank?.hash && blank.hash !== savedOne.hash, 'New scene… makes a distinct empty asset');

	// =====================================================================
	// 3. TRAVEL: local, silent, carried state, no backup
	// =====================================================================
	// Level Three carries a BAKED game state, to prove the file's game is EXCLUDED
	await A.page.evaluate(() => {
		window.__stores.gameState.setGameState('playing');
		window.__stores.gameState.setGameState('over');
	});
	await A.page.evaluate(() => window.__stores.commandsHandler.clearSceneLocal());
	const three = await makeBoxes(A, 3);
	const savedThree = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Level Three'));
	h.check(!!savedThree?.hash, 'Level Three saved (its file bakes state=over)');

	// now a LIVE campaign state that must survive the hop
	await A.page.evaluate(() => {
		window.__stores.gameState.setGameState('playing');
		window.__stores.gameState.setGameVar('gems', 7);
	});
	const liveBefore = await gstate(A);
	h.check(liveBefore.state === 'playing' && liveBefore.vars.gems === 7, 'premise: a live round with a score');

	const sessionsBefore = await sessionCount(A);
	const traveled = await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Level One'), savedOne.hash);
	h.check(traveled === true, 'travelToLevel reports a load');
	h.check(
		JSON.stringify(await childUuids(A)) === JSON.stringify([...one].sort()),
		'the scene is Level One again, ORIGINAL uuids preserved'
	);
	const liveAfter = await gstate(A);
	h.check(
		liveAfter.state === 'playing' && liveAfter.round === liveBefore.round && liveAfter.vars.gems === 7,
		`fork 3: the live game state CARRIED across the hop — the file's baked 'over' never applied (${liveAfter.state}, round ${liveAfter.round}, gems ${liveAfter.vars.gems})`
	);
	h.check((await sessionCount(A)) === sessionsBefore, 'no backup session was stashed by the hop');

	// travel to the EMPTY level: a blank slate, state still carried
	await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Blank'), blank.hash);
	h.check((await childUuids(A)).length === 0, 'the empty level really is empty');
	h.check((await gstate(A)).vars.gems === 7, 'and the score still carried');

	// =====================================================================
	// 4. TWO PEERS: the pull-then-load watch, and travel stays LOCAL
	// =====================================================================
	// back onto Level Three content so the peers have a scene to share
	await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Level Three'), savedThree.hash);
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);
	await h.eventually(
		() => childUuids(B),
		(ids) => ids.length === 3,
		'premise: B received the current scene through the ordinary handshake'
	);
	const missing = await B.page.evaluate(
		(hash) => !window.__stores.explorer.itemByHash(hash),
		savedOne.hash
	);
	h.check(missing, "premise: B does NOT hold Level One's bytes");

	const aBefore = await childUuids(A);
	const bSessionsBefore = await sessionCount(B);
	// fire and WATCH — the pull resolves when the bytes land (the LUT precedent)
	await B.page.evaluate((hash) => {
		void window.__stores.levels.travelToLevel(hash, 'Level One');
	}, savedOne.hash);
	await h.eventually(
		() => childUuids(B),
		(ids) => JSON.stringify(ids) === JSON.stringify([...one].sort()),
		'B pulled the level from A and loaded it — ask once, then watch until the bytes land',
		30000
	);
	h.check(
		(await B.page.evaluate((hash) => !!window.__stores.explorer.itemByHash(hash), savedOne.hash)),
		"the pulled bytes are in B's library now (content-hash dedupe)"
	);
	h.check(
		JSON.stringify(await childUuids(A)) === JSON.stringify(aBefore),
		"A's scene is untouched — B's travel applied LOCALLY, nothing was broadcast"
	);
	h.check((await sessionCount(B)) === bSessionsBefore, 'and B stashed no backup either');

	h.check((await h.pageErrors(A)).length === 0, `no page errors on A (${JSON.stringify(await h.pageErrors(A))})`);
	h.check((await h.pageErrors(B)).length === 0, `no page errors on B (${JSON.stringify(await h.pageErrors(B))})`);
	await h.finish(browser);
});
