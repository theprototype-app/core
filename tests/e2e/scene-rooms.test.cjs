// P2 — PROJECT SCENES EVERYONE CAN SEE, AND WHO IS IN WHICH ONE.
//
// Reported as three symptoms: "when a user connects they will not see project scenes",
// "if a peer opens another scene, peers would not see where he is", and "if peers create
// a scene in the project they also would disappear". All three are ONE seam — the
// manifest replicates and names every scene, while the library (placement AND bytes) is
// local, so a peer could TRAVEL to a scene it could not SEE, and nothing said where
// anybody was standing.
//
//   §1  Saving a LOOSE scene adopts the file it came from as version 1 — the reported
//       "another cube2.tpscene appeared". Both cards were real and different; the source
//       was simply left OUTSIDE the history, where the one-card invariant cannot reach.
//   §2  P2a: a peer sees the project's scenes as cards holding none of the bytes, and
//       opening one fetches it.
//   §3  P2b: who is where — published on travel, symmetric, dropped on disconnect.
//   §4  Rooms, DERIVED. A session is the mesh, a scene is the tag, a room is the
//       grouping; nothing stores one.
//
// Named `scene-rooms` and not `scene-presence`: that suite already exists and covers
// 21-G5's CROSS-room bridge through the cloud plugin. This one is same-mesh and must
// work with no cloud tier at all.
//
// Run: APP_URL='https://localhost:5202/' PEER_CONFIG=... npm run e2e -- scene-rooms
const h = require('./helpers.cjs');

const at = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});

const itemNames = (p) =>
	p.page.evaluate(() => {
		const s = window.__stores.explorer;
		let v, hid;
		s.explorerItems.subscribe((x) => (v = x))();
		s.hiddenItems.subscribe((x) => (hid = x))();
		return { visible: v.map((i) => i.name).sort(), hidden: hid.map((i) => i.name).sort() };
	});

const historyOf = (p, name) =>
	p.page.evaluate((n) => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
		return m.scenes[n]?.history ?? [];
	}, name);

const cardsOn = (p) =>
	p.page.evaluate(() =>
		[...document.querySelectorAll('.explorer-card')].map((el) => ({
			title: el.getAttribute('title'),
			remote: el.className.includes('explorer-remote'),
			dot: !!el.querySelector('.explorer-remote-dot')
		}))
	);

const scenesOfPeers = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.peerScenes.peerScenes.subscribe((x) => (m = x))();
		return Object.fromEntries(Object.entries(m).map(([id, r]) => [id, r.scene]));
	});

const rooms = (p) =>
	p.page.evaluate(() => {
		const s = window.__stores.peerScenes;
		let m;
		s.peerScenes.subscribe((x) => (m = x))();
		return s
			.roomsOfSession(m, s.myScene())
			.map((r) => ({ scene: r.scene, peers: r.peerIds.length, mine: r.mine }));
	});

/** answer the unsaved-changes guard if it appears; report whether it did */
const answerGuard = async (p, value) => {
	await p.page.waitForTimeout(700);
	const open = await p.page.evaluate(() => {
		let d;
		window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
		return !!d;
	});
	if (open) await p.page.evaluate((v) => window.__stores.confirmDialog.resolveConfirm(v), value);
	return open;
};

const addBox = (p) =>
	p.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		window.__stores.objectActions.deselectObject();
	});

const wipe = async (p) => {
	await p.page.evaluate(async () => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const uuids = (g?.children ?? []).map((c) => c.uuid);
		if (uuids.length) s.objectActions.deleteObjectsByUuid(uuids);
		await s.explorer.clearLibrary();
		s.projectManifest.manifestRestore({ scenes: {}, assets: [], changedAt: 1 }, false);
		s.levels.currentLevel.set(null);
	});
	await p.page.waitForTimeout(700);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(700);
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));

	// =====================================================================
	// 1. SAVING A LOOSE SCENE ADOPTS THE FILE IT CAME FROM
	// =====================================================================
	await wipe(A);
	const looseBytes = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		s.objectActions.deselectObject();
		const payload = s.sessions.buildSessionPayload('cube');
		delete payload.workspace;
		const b = await s.sessions.exportSessionZip(payload, { assets: true, packs: false, flow: true });
		return Array.from(b);
	});
	await wipe(A);
	await A.page.evaluate((arr) => {
		const f = new File([new Uint8Array(arr)], 'cube.tpscene', { type: 'application/zip' });
		const dt = new DataTransfer();
		dt.items.add(f);
		document
			.querySelector('#explorer-list')
			.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
	}, looseBytes);
	await h.eventually(
		() => itemNames(A),
		(n) => n.visible.includes('cube.tpscene'),
		'premise: a loose cube.tpscene is in the library'
	);
	const sourceHash = await A.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.find((i) => i.name === 'cube.tpscene').hash;
	});
	await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash), sourceHash);
	await h.eventually(
		() => at(A),
		(v) => v?.name === 'cube' && v?.unsaved === true,
		'premise: it opens LOOSE — the project has never heard of it'
	);
	await addBox(A); // the reported "moved object"
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('cube'));
	await h.eventually(
		() => historyOf(A, 'cube'),
		(hist) => hist.length >= 2,
		'premise: the save published a version'
	);

	const after = await itemNames(A);
	h.check(
		after.visible.filter((n) => n === 'cube.tpscene').length === 1,
		`THE FIX: ONE card for the scene, not a twin beside it (${JSON.stringify(after.visible)})`
	);
	const hist = await historyOf(A, 'cube');
	h.check(
		hist.length === 2 && hist[0] === sourceHash,
		`the file we came from is version 1, not an orphan (${hist.length} versions, source first: ${hist[0] === sourceHash})`
	);
	h.check(
		after.hidden.includes('cube.tpscene'),
		'…FOLDED rather than deleted — the bytes are still here'
	);
	h.check(
		(await A.page.evaluate((hash) => !!window.__stores.explorer.itemByHash(hash), sourceHash)) === true,
		'…and still resolvable by hash, so Version history can restore it'
	);
	h.check((await at(A))?.unsaved !== true, 'the scene is a project member now, no longer loose');

	// a save from NOWHERE adopts nothing — the guard must not fire on every save
	await addBox(A);
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('cube'));
	await h.eventually(
		() => historyOf(A, 'cube'),
		(x) => x.length === 3,
		'a later ordinary save appends exactly one version, adopting nothing'
	);

	// =====================================================================
	// 2. P2a — A PEER SEES THE PROJECT'S SCENES WITH NONE OF THE BYTES
	// =====================================================================
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	await h.eventually(
		() => historyOf(A, 'Arena'),
		(x) => x.length === 1,
		'premise: a second project scene exists'
	);

	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await B.page.locator('#explorer-slot').click();
	await B.page.waitForTimeout(600);
	await B.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await h.connect(B, A);

	h.check(
		(await B.page.evaluate(() => {
			let v;
			window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
			return v.length;
		})) === 0,
		'premise: the joiner holds NO library items of its own'
	);
	await h.eventually(
		() =>
			B.page.evaluate(() => {
				let m;
				window.__stores.projectManifest.projectManifest.subscribe((x) => (m = x))();
				return Object.keys(m.scenes).sort();
			}),
		(k) => k.includes('Arena') && k.includes('cube'),
		'premise: the manifest reached the joiner (it always did — that was never the gap)'
	);

	await h.eventually(
		() => cardsOn(B),
		(c) =>
			c.some((x) => x.title === 'Arena.tpscene' && x.remote) &&
			c.some((x) => x.title === 'cube.tpscene' && x.remote),
		'P2a: the project scenes are CARDS on the joiner, with none of the bytes'
	);
	const bCards = await cardsOn(B);
	h.check(
		bCards.filter((c) => c.remote).every((c) => c.dot),
		'…each marked as not-on-this-device rather than passed off as a local file'
	);
	// no CRUD on a card there is no record behind
	await B.page.locator('.explorer-card[title="Arena.tpscene"]').first().click({ button: 'right' });
	await B.page.waitForTimeout(400);
	const bMenu = await B.page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) =>
			el.textContent?.trim()
		)
	);
	h.check(
		bMenu.length === 1 && /Open here/.test(bMenu[0] ?? ''),
		`…offering only what it can actually do (${JSON.stringify(bMenu)})`
	);
	await B.page.keyboard.press('Escape');
	await B.page.waitForTimeout(300);

	// opening one FETCHES it
	await B.page.locator('.explorer-card[title="Arena.tpscene"]').first().dblclick();
	// a JOINER's world arrived over the wire and has no scene identity, so P1's guard
	// correctly asks before replacing it. Worth asserting rather than working around:
	// it is the same protection a local unsaved scene gets.
	h.check(await answerGuard(B, 'open'), 'a joiner is asked before its synced world is replaced');
	await h.eventually(
		() => at(B),
		(v) => v?.name === 'Arena',
		'opening a not-held project scene pulls it from a peer and loads it',
		30000
	);
	await h.eventually(
		() => itemNames(B),
		(n) => n.visible.includes('Arena.tpscene'),
		'…and the bytes land, so it becomes a real library item'
	);
	// "gave way" means the DERIVED card is gone, not that a card sits at the root: a
	// pulled asset lands in the Shared folder (assetShare's own rule), so the real item
	// is somewhere the root view does not list. What must never happen is BOTH.
	const arenaCards = (await cardsOn(B)).filter((c) => c.title === 'Arena.tpscene');
	h.check(
		arenaCards.every((c) => !c.remote),
		`the derived card gave way to the real item rather than doubling up (${JSON.stringify(arenaCards)})`
	);

	// =====================================================================
	// 3. P2b — WHO IS WHERE
	// =====================================================================
	// saving Arena MOVED A into it (saveSceneAsLevel sets currentLevel), so put A back
	// in cube deliberately — presence is only meaningful when the two peers differ
	await A.page.evaluate(() => window.__stores.levels.travelToScene('cube'));
	await h.eventually(
		() => at(A),
		(v) => v?.name === 'cube',
		'premise: A is somewhere else, so this is a real difference'
	);
	await h.eventually(
		() => scenesOfPeers(A),
		(m) => Object.values(m).includes('Arena'),
		'THE FIX: A can see that B is standing in Arena'
	);
	await h.eventually(
		() => scenesOfPeers(B),
		(m) => Object.values(m).includes('cube'),
		'…and B can see A is in cube — presence is symmetric'
	);

	await B.page.evaluate(() => window.__stores.levels.travelToScene('cube'));
	await h.eventually(
		() => scenesOfPeers(A),
		(m) => Object.values(m).includes('cube') && !Object.values(m).includes('Arena'),
		'when a peer opens another scene, the change reaches everyone'
	);

	// the peer list SAYS so, not just the store
	await A.page.evaluate(() => document.querySelector('#peers-trigger')?.click());
	await A.page.waitForTimeout(700);
	const chips = await A.page.evaluate(() =>
		[...document.querySelectorAll('.scene-chip')].map((el) => el.textContent?.trim())
	);
	h.check(
		chips.length >= 2 && chips.every((c) => c && c.length),
		`the peer list SHOWS a scene for every row, not only the store (${JSON.stringify(chips)})`
	);
	await A.page.evaluate(() => document.querySelector('#peers-trigger')?.click());
	await A.page.waitForTimeout(300);

	// =====================================================================
	// 4. ROOMS ARE DERIVED
	// =====================================================================
	const rmsA = await rooms(A);
	h.check(
		rmsA.length === 1 && rmsA[0].scene === 'cube' && rmsA[0].mine === true,
		`both peers in one scene is ONE room (${JSON.stringify(rmsA)})`
	);
	await A.page.evaluate(() => window.__stores.levels.travelToScene('Arena'));
	await h.eventually(
		() => rooms(A),
		(r) =>
			r.length === 2 &&
			r.some((x) => x.scene === 'Arena' && x.mine) &&
			r.some((x) => x.scene === 'cube' && !x.mine),
		'…and two scenes are two rooms, mine marked — a session with a list of rooms'
	);

	// a peer that leaves takes its row with it
	await B.page.close();
	await h.eventually(
		() => scenesOfPeers(A),
		(m) => Object.keys(m).length === 0,
		'a disconnected peer is dropped, not left standing in a scene forever',
		40000
	);
	h.check((await rooms(A)).length === 1, '…so the room list collapses back to the one I am in');

	h.check(
		(await h.pageErrors(A)).length === 0,
		`no page errors on A (${JSON.stringify(await h.pageErrors(A))})`
	);
	await h.finish(browser);
});
