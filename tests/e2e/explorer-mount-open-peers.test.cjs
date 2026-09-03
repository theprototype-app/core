// R22 ROUND 14 — OPENING A MOUNTED PROJECT'S SCENE, WITH SOMEBODY ELSE IN THE ROOM.
//
// The single-peer half — that it opens at all, the unsaved-changes guard, the identity,
// saving it in afterwards, and every other kind keeping its refusal — is section 21 of
// `explorer-mounts`. This file is the half that needs two browsers, and it is its own
// file for the reason every two-peer suite is: signaling is slow and the runner gives one
// file 8 minutes (`explorer-mounts` is already at ~320s of its 480).
//
// WHAT IS ACTUALLY BEING VERIFIED, and why it was not taken on trust. The mount opener
// hands its payload to `openScenePayload`, which hands it to `requestLoadPayload` — the
// function `requestLoadSession` was split into so that a caller holding a payload and no
// saved slot could reach the SAME proposal machinery. The claim "it replicates exactly as
// any session apply does" is therefore a claim about a code path, and the way to read it
// is to watch the room: the press must become a PROPOSAL rather than a unilateral wipe,
// the answer must be what applies it, and both worlds must end up carrying the scene.
//
// AND THE PROPERTY THAT IS SPECIFIC TO A MOUNT: the objects travel, the FILE does not. A
// mounted file's bytes exist on the opener's machine only — no peer can resolve them by
// hash, which is exactly why this route may not be the library card's silent local travel
// — so B must end up standing in the same world with nothing new in its library.
//
// Premise traps paid for up front:
//  · Connect with an EMPTY scene on the dialer, or `connectDecisionApplies` asks its own
//    blocking question and this suite is not about that dialog.
//  · A proposal is answered from a TOAST action, not a dialog.
//  · The marker is deliberately NOT written when the load became a proposal ("marking a
//    scene we may never load would lie"), so A's identity stays null here — that is the
//    documented behaviour, asserted rather than worked around.
//
// Run: PEER_CONFIG='…' APP_URL='https://localhost:5205/' npm run e2e -- explorer-mount-open-peers
const h = require('./helpers.cjs');

const room = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.peers.subscribe((x) => (v = x))();
		return v?.openedPeers ? [...v.openedPeers] : null;
	});

const worldNames = (p) =>
	p.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		return (g?.children ?? []).map((c) => c.name || c.type).sort();
	});

const level = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v ?? null;
	});

const libraryNames = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return (v ?? []).map((i) => i.name).sort();
	});

const toasts = (p) =>
	p.page.evaluate(() => [...document.querySelectorAll('.tp-toast')].map((t) => t.innerText.trim()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const peer of [A, B]) {
		await peer.page.waitForFunction(
			() => !!window.__stores?.mountedVolumes && !!window.__stores?.explorer && !!window.__stores?.sessions,
			null,
			{ timeout: 30000 }
		);
		await peer.page.evaluate(async () => {
			const s = window.__stores;
			await s.explorer.loadExplorer();
			await s.explorer.clearLibrary();
			await s.mountedVolumes.loadMountedVolumes();
			let mv;
			s.mountedVolumes.mountedVolumes.subscribe((x) => (mv = x))();
			for (const v of mv) await s.mountedVolumes.unmountVolume(v.id);
			s.levels.currentLevel.set(null);
		});
	}

	// ---- the fixture, built on A while it is still alone -----------------------------
	// A scene of two objects, saved as a .tpscene, carried into a PROJECT record, and then
	// removed from the live library — so the only copy left on this machine is the one
	// inside the mount, and no copy at all exists on B.
	const vaultNames = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1300));
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1300));
		s.objectActions.deselectObject();
		await s.levels.saveSceneAsLevel('Vault', null);
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		return (g?.children ?? []).map((c) => c.name || c.type).sort();
	});
	h.check(vaultNames.length === 2, `premise: "Vault" is a real scene of two objects (${vaultNames.join(', ')})`);
	await A.page.evaluate(() => window.__stores.sessions.saveSessionWithLibrary('Cellar'));
	await A.page.waitForTimeout(2000);
	const mounted = await A.page.evaluate(async () => {
		const s = window.__stores;
		await s.explorer.clearLibrary();
		let list;
		s.sessions.sessions.subscribe((x) => (list = x))();
		const rec = (list ?? []).find((m) => m.name === 'Cellar');
		if (!rec) return null;
		const vol = await s.mountedVolumes.mountVolume(rec.id);
		return vol && { id: vol.id, items: vol.items.map((i) => i.name).sort() };
	});
	h.check(
		!!mounted && mounted.items.includes('Vault.tpscene'),
		`premise: the project is mounted and holds the scene (${mounted && mounted.items.join(', ')})`
	);
	h.check(
		(await libraryNames(A)).length === 0,
		'premise: and A\'s own library is empty — the mount holds the only copy of those bytes'
	);

	// an EMPTY scene with no identity on the dialer before connecting: this suite is about
	// the proposal, not about the connect-time decision an unnamed world full of objects
	// would raise
	await A.page.evaluate(async () => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const uuids = (g?.children ?? []).map((c) => c.uuid);
		if (uuids.length) s.objectActions.deleteObjectsByUuid(uuids);
		s.levels.currentLevel.set(null);
	});
	await A.page.waitForTimeout(800);
	await h.connect(A, B);
	h.check((await room(A))?.length === 1, `premise: A is connected to one peer (${JSON.stringify(await room(A))})`);
	h.check(
		(await worldNames(A)).length === 0 && (await worldNames(B)).length === 0,
		'premise: both worlds are empty, so anything that arrives came from the open'
	);

	// ---- 1. the press becomes a PROPOSAL, not a unilateral wipe -----------------------
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(900);
	await A.page.evaluate((key) => window.__stores.explorer.activeFolder.set(key), 'vol:' + mounted.id);
	await A.page.waitForTimeout(700);
	const card = A.page.locator('.ex-cards .explorer-card').filter({ hasText: 'Vault.tpscene' }).first();
	h.check((await card.count()) === 1, 'premise: the scene card is on screen inside the mount');
	await card.dblclick();
	await h.eventually(
		() => toasts(A),
		(t) => t.some((x) => /Asked 1 peer/.test(x)),
		'opening a mounted scene with somebody in the room ASKS them — the same proposal a session load makes',
		25000
	);
	await h.eventually(
		() => toasts(B),
		(t) => t.some((x) => /wants to load session "Vault"/.test(x)),
		'…and the peer is the one asked, by the scene\'s own name',
		25000
	);
	h.check(
		(await worldNames(A)).length === 0,
		'…and NOTHING was replaced while the answer is outstanding, on the opener either'
	);
	const pending = await level(A);
	h.check(
		pending === null,
		`…nor was the scene named on screen, which would be a claim about a load that has not happened (${JSON.stringify(pending)})`
	);

	// ---- 2. the answer is what applies it, on both machines ---------------------------
	await B.page.locator('.tp-toast').filter({ hasText: 'wants to load session' }).getByText('Accept').click();
	await h.eventually(
		() => worldNames(A),
		(n) => JSON.stringify(n) === JSON.stringify(vaultNames),
		'accepting loads the mounted scene on the peer that opened it',
		30000
	);
	await h.eventually(
		() => worldNames(B),
		(n) => JSON.stringify(n) === JSON.stringify(vaultNames),
		'…and on the peer that answered — the objects replicate exactly as any session apply does',
		30000
	);

	// ---- 3. the objects travel; the FILE does not ------------------------------------
	// The point of the whole route: a mounted file's bytes are on A's machine alone, so a
	// silent local apply (the library card's `travelToLevel`) would have left B in a world
	// it could never fetch. It got the world, and nothing to store.
	h.check(
		(await libraryNames(B)).length === 0,
		`the peer's library gained nothing — a mounted file is not shareable, and only its contents crossed (${(await libraryNames(B)).join(', ')})`
	);
	const volsB = await B.page.evaluate(() => {
		let v;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (v = x))();
		return (v ?? []).length;
	});
	h.check(volsB === 0, `…and no mount appeared on it either (${volsB})`);
	h.check(
		(await libraryNames(A)).length === 0,
		'…and the opener\'s library is still empty too: opening reads the mount, it does not import from it'
	);

	// THE MARKER, deliberately absent. `openScenePayload` writes the unsaved identity only
	// for a load that APPLIED NOW; this one became a proposal, and naming a scene before
	// the room has answered would be a lie. It is also what keeps the marker off the wire —
	// only the presser ever runs it, so a room cannot split into two names.
	const after = await level(A);
	h.check(
		after === null,
		`the proposal route leaves the identity unwritten, as every other proposal does (${JSON.stringify(after)})`
	);
	h.check(
		(await level(B)) === null,
		'…and the peer that accepted is not renamed either'
	);

	await h.finish(browser);
});
