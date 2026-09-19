// ROADMAP 22 R4 — SESSIONS AND SCENE TAGS, in the locked vocabulary: a SESSION is the
// mesh (one per invite link) and owns the project; a SCENE is where a peer currently is
// inside it, a TAG on the peer rather than a second connection; a ROOM stays the
// PocketBase discovery record. `peerScenes` already carries the tags (P2b) and the
// popover already groups by them (round 30) — what R4 adds is the roster ON THE SCENE
// CARDS and a way to JOIN somebody from there.
//
//   §1  `peersAtScene`, the roster of one scene, us included — pure over the map.
//   §2  Solo: the card of the scene you are in says "You are here"; the other says nothing.
//   §3  A joiner: both cards agree on who is where; the card menu offers "Join <peer>".
//   §4  Travel moves the roster (the counterfactual the brief asks for), and Join from a
//       card you do not even hold the bytes of travels you there.
//   §5  Strip the tag → the roster empties; re-publish → it fills. The badge derives from
//       presence and nothing else.
//   §6  A late joiner converges from the handshake alone.
//   §7  The invite link IS the session — its shape carries no scene hint.
//
// Run: APP_URL='https://theprototype.app:5211/' npm run e2e -- session-scenes
const h = require('./helpers.cjs');

const at = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});

const scenesOfPeers = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.peerScenes.peerScenes.subscribe((x) => (m = x))();
		return Object.fromEntries(Object.entries(m).map(([id, r]) => [id, r.scene]));
	});

/** the presence badge on every scene card: title -> count (the DOM, not the store) */
const badges = (p) =>
	p.page.evaluate(() => {
		const out = {};
		for (const card of document.querySelectorAll('.explorer-card')) {
			const title = card.getAttribute('title');
			const here = card.querySelector('.explorer-here');
			out[title] = here ? { count: Number(here.getAttribute('data-here')), title: here.getAttribute('title') } : null;
		}
		return out;
	});

const menuOn = async (p, title) => {
	await p.page.locator(`.explorer-card[title="${title}"]`).first().click({ button: 'right' });
	await p.page.waitForTimeout(400);
	return p.page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => el.textContent?.trim() ?? '')
	);
};

const closeMenu = async (p) => {
	await p.page.keyboard.press('Escape');
	await p.page.waitForTimeout(300);
};

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

const openExplorer = async (p) => {
	await p.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await p.page.locator('#explorer-slot').click();
	await p.page.waitForTimeout(700);
	await p.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
};

const nameOf = (p, id) => p.page.evaluate((id) => window.__stores.lockControl.nameOf(id), id);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await openExplorer(A);

	// =====================================================================
	// 1. THE ROSTER, PURE OVER THE MAP
	// =====================================================================
	const pure = await A.page.evaluate(() => {
		const s = window.__stores.peerScenes;
		const map = { b: { scene: 'Arena', hash: '', at: 1 }, c: { scene: 'Forge', hash: '', at: 1 }, d: { scene: '', hash: '', at: 1 }, e: { scene: '', hash: '', at: 1, private: true } };
		return {
			arenaMe: s.peersAtScene(map, 'Arena', 'Arena', null),
			arenaAway: s.peersAtScene(map, 'Arena', 'Forge', null),
			// we host and stand in Forge: the UNNAMED peer d resolves into OUR room (round 36's rule)
			forgeHost: s.peersAtScene(map, 'Forge', 'Forge', null),
			// a private us is nobody's "me"
			privateMe: s.peersAtScene(map, 'Arena', '', null),
			nothing: s.peersAtScene(map, '', 'Arena', null)
		};
	});
	h.check(
		pure.arenaMe.me === true && pure.arenaMe.peerIds.join() === 'b,d',
		`§1 the roster of the scene I am in names the peer there and me — and the UNNAMED peer d, who stands in the host's room, which is ours (${JSON.stringify(pure.arenaMe)})`
	);
	h.check(
		pure.arenaAway.me === false && pure.arenaAway.peerIds.join() === 'b',
		`§1 …and leaves me out when I am elsewhere (${JSON.stringify(pure.arenaAway)})`
	);
	h.check(
		pure.forgeHost.me === true && pure.forgeHost.peerIds.join() === 'c,d',
		`§1 an unnamed peer counts as standing in the host's room — the popover's own rule (${JSON.stringify(pure.forgeHost)})`
	);
	h.check(
		pure.privateMe.me === false && !pure.forgeHost.peerIds.includes('e'),
		'§1 a private peer is on nobody\'s card, and a private me is "here" for nobody'
	);
	h.check(pure.nothing.peerIds.length === 0 && pure.nothing.me === false, '§1 no scene, no roster');

	// =====================================================================
	// 2. SOLO: "YOU ARE HERE"
	// =====================================================================
	await wipe(A);
	await addBox(A);
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	await h.eventually(() => at(A), (v) => v?.name === 'Arena', 'premise: A saved and stands in Arena');
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Forge'));
	await h.eventually(() => at(A), (v) => v?.name === 'Forge', 'premise: A saved a second scene, Forge, and stands in it');
	await A.page.evaluate(() => window.__stores.levels.travelToScene('Arena'));
	await h.eventually(() => at(A), (v) => v?.name === 'Arena', 'premise: A travelled back to Arena');
	await h.eventually(
		() => badges(A),
		(b) => b['Arena.tpscene']?.count === 1 && b['Forge.tpscene'] === null,
		'§2 the card of the scene I am in carries a badge of ONE, the other card none'
	);
	const solo = await badges(A);
	h.check(solo['Arena.tpscene']?.title === 'You are here', `§2 …and it says so in words ("${solo['Arena.tpscene']?.title}")`);
	// the badge is drawn in the LIST view too
	await A.page.evaluate(() => window.__stores.explorerView?.explorerViewMode?.set?.('list'));
	await A.page.waitForTimeout(400);
	const listBadge = await A.page.evaluate(() => {
		const row = [...document.querySelectorAll('.explorer-card')].find((el) => el.getAttribute('title') === 'Arena.tpscene');
		const here = row?.querySelector('.explorer-here');
		return { row: !!row, here: here?.textContent?.trim() ?? null, count: here?.getAttribute('data-here') ?? null };
	});
	h.check(
		listBadge.row && listBadge.count === '1' && /1 here/.test(listBadge.here ?? ''),
		`§2 the list row carries the same reading (${JSON.stringify(listBadge)})`
	);
	await A.page.evaluate(() => window.__stores.explorerView?.explorerViewMode?.set?.('thumbnails'));
	await A.page.waitForTimeout(400);

	// =====================================================================
	// 3. A JOINER: BOTH CARDS AGREE, AND THE MENU OFFERS JOIN
	// =====================================================================
	const B = await h.setupPage(browser, 'B');
	await openExplorer(B);
	await h.connect(B, A);
	await h.eventually(() => scenesOfPeers(A), (m) => m[B.id] === 'Arena', 'premise: B adopted Arena on connect (A1)');
	await h.eventually(
		() => badges(A),
		(b) => b['Arena.tpscene']?.count === 2,
		'§3 on the host, Arena counts two: me and the joiner'
	);
	const bName = await nameOf(A, B.id);
	const aName = await nameOf(B, A.id);
	const hostBadge = await badges(A);
	h.check(
		hostBadge['Arena.tpscene']?.title === 'You and ' + bName + ' are here',
		`§3 …named in the title ("${hostBadge['Arena.tpscene']?.title}")`
	);
	await h.eventually(
		() => badges(B),
		(b) => b['Arena.tpscene']?.count === 2 && b['Forge.tpscene'] === null,
		'§3 the joiner\'s (not-on-this-device) Arena card counts the same two people, Forge none'
	);
	const joinerBadge = await badges(B);
	h.check(
		joinerBadge['Arena.tpscene']?.title === 'You and ' + aName + ' are here',
		`§3 …and names the host ("${joinerBadge['Arena.tpscene']?.title}")`
	);
	const hostMenu = await menuOn(A, 'Arena.tpscene');
	h.check(
		hostMenu.some((t) => t === 'Join ' + bName),
		`§3 the host's Arena card offers "Join ${bName}" (${JSON.stringify(hostMenu)})`
	);
	await closeMenu(A);
	const forgeMenu = await menuOn(A, 'Forge.tpscene');
	h.check(
		!forgeMenu.some((t) => /^Join /.test(t)),
		`§3 …and the empty Forge card offers nobody to join (${JSON.stringify(forgeMenu)})`
	);
	await closeMenu(A);

	// =====================================================================
	// 4. TRAVEL MOVES THE ROSTER; JOIN FROM A CARD TRAVELS YOU THERE
	// =====================================================================
	await A.page.evaluate(() => window.__stores.levels.travelToScene('Forge'));
	await h.eventually(() => at(A), (v) => v?.name === 'Forge', 'premise: A travelled to Forge');
	await h.eventually(
		() => badges(A),
		(b) => b['Forge.tpscene']?.count === 1 && b['Arena.tpscene']?.count === 1,
		'§4 THE COUNTERFACTUAL THE BRIEF ASKS FOR: travel moves the roster — Forge is me, Arena is the joiner'
	);
	await h.eventually(
		() => badges(B),
		(b) => b['Forge.tpscene']?.count === 1 && b['Arena.tpscene']?.count === 1,
		'§4 …and the joiner reads the same two rosters'
	);
	const bForge = await badges(B);
	h.check(bForge['Forge.tpscene']?.title === aName + ' is here', `§4 the joiner's Forge card names the host alone ("${bForge['Forge.tpscene']?.title}")`);
	// JOIN from the card the joiner does not even hold the bytes of
	const remoteMenu = await menuOn(B, 'Forge.tpscene');
	h.check(
		remoteMenu.some((t) => t === 'Join ' + aName) && remoteMenu.some((t) => /Open here/.test(t)),
		`§4 a not-on-this-device scene card offers Join beside Open (${JSON.stringify(remoteMenu)})`
	);
	await B.page.evaluate((name) => {
		const el = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((x) => x.textContent?.trim() === 'Join ' + name);
		el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	}, aName);
	await answerGuard(B, 'discard');
	await h.eventually(() => at(B), (v) => v?.name === 'Forge', '§4 Join travelled the joiner to Forge (the bytes were fetched on the way)', 30000);
	await h.eventually(
		() => badges(A),
		(b) => b['Forge.tpscene']?.count === 2 && b['Arena.tpscene'] === null,
		'§4 …and the host now counts both in Forge, nobody in Arena'
	);

	// =====================================================================
	// 5. STRIP THE TAG → THE ROSTER EMPTIES; RE-PUBLISH → IT FILLS
	// =====================================================================
	await A.page.evaluate((id) => {
		window.__stores.peerScenes.peerScenes.update((m) => {
			const out = { ...m };
			delete out[id];
			return out;
		});
	}, B.id);
	await h.eventually(
		() => badges(A),
		(b) => b['Forge.tpscene']?.count === 1,
		'§5 COUNTERFACTUAL: with the joiner\'s tag stripped, the card counts only me — the badge is presence and nothing else'
	);
	await B.page.evaluate(() => window.__stores.peerScenes.publishMyScene(true));
	await h.eventually(
		() => badges(A),
		(b) => b['Forge.tpscene']?.count === 2,
		'§5 …and the next tag restores it'
	);

	// =====================================================================
	// 6. A LATE JOINER CONVERGES FROM THE HANDSHAKE ALONE
	// =====================================================================
	const C = await h.setupPage(browser, 'C');
	await openExplorer(C);
	await h.connect(C, A);
	await h.eventually(() => at(C), (v) => v?.name === 'Forge', 'premise: the late joiner adopted Forge');
	await h.eventually(
		() => scenesOfPeers(C),
		(m) => m[A.id] === 'Forge' && m[B.id] === 'Forge',
		'§6 the late joiner knows where BOTH peers stand from the handshake (getmodulestate replies), no travel needed',
		20000
	);
	await h.eventually(
		() => badges(C),
		(b) => b['Forge.tpscene']?.count === 3,
		'§6 …so its Forge card counts three'
	);
	await h.eventually(
		() => badges(A),
		(b) => b['Forge.tpscene']?.count === 3,
		'§6 …and the host counts three too'
	);
	const roomsOnC = await C.page.evaluate(() => {
		const s = window.__stores.peerScenes;
		let m, host;
		s.peerScenes.subscribe((x) => (m = x))();
		window.__stores.connectionState.sessionHost.subscribe((x) => (host = x))();
		return s.roomsOfSession(m, s.myScene(), host).map((r) => ({ scene: r.scene, peers: r.peerIds.length, mine: r.mine }));
	});
	h.check(
		roomsOnC.length === 1 && roomsOnC[0].scene === 'Forge' && roomsOnC[0].peers === 2 && roomsOnC[0].mine,
		`§6 the session's room list on the late joiner: one room, Forge, two peers plus me (${JSON.stringify(roomsOnC)})`
	);

	// =====================================================================
	// 7. THE INVITE LINK IS THE SESSION
	// =====================================================================
	const link = await A.page.evaluate(() => {
		const s = window.__stores;
		let st, p;
		s.peerServer.peerServerStatus.subscribe((x) => (st = x))();
		s.peers.subscribe((x) => (p = x))();
		return window.location.origin + '#' + String(p.peer.id).toUpperCase() + s.peerServer.inviteServerParam(st);
	});
	h.check(
		/^https?:\/\/[^#]+#[A-Z0-9]+(~srv=[^&?]*)?$/.test(link) && !/scene/i.test(link),
		`§7 the invite link is the peer id (plus an optional server tail) and carries NO scene hint — a joiner adopts the host's scene over the handshake (${link})`
	);

	h.check((await h.pageErrors(A)).length === 0, `no page errors on A (${JSON.stringify(await h.pageErrors(A))})`);
	h.check((await h.pageErrors(B)).length === 0, `no page errors on B (${JSON.stringify(await h.pageErrors(B))})`);
	h.check((await h.pageErrors(C)).length === 0, `no page errors on C (${JSON.stringify(await h.pageErrors(C))})`);
	await h.finish(browser);
});
