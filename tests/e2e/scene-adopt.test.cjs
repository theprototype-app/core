// R22 round 34 — A SAVE NAMES THE ROOM.
//
// REPORTED: a peer connects to a host and the two of them edit the shared UNTITLED world
// together. The peer saves it in the Library — and from that moment the peers popup shows
// them in two different scenes, Watch reads wrong, and the identity has diverged from the
// content. The CONTENT never diverged: `currentLevel` is LOCAL by design and an unnamed
// side is never evidence of "elsewhere" (the only-on-evidence rule), so every edit kept
// flowing. Only the saver's copy learned the name.
//
// The fix is one small message, `sceneadopt`, and its whole design is that it joins
// `ROOM_SCOPED`: that membership is what withholds it from a peer standing elsewhere, both
// on send and on receive, and what drops it from a peer held behind an open share-or-stash
// or connect decision. Nothing else in this file had to be written to get any of that.
//
// What each section is the guard for:
//
//   1. the premise      two peers, one untitled world, one object — both unnamed, and
//                       nobody is in a room at all (`roomsOfSession` is empty).
//   2. THE HEADLINE     the joiner saves through the REAL path a user takes (the Explorer
//                       grid menu, the inline card, real keys) and the HOST takes the name,
//                       is told who named it, and the two of them read as ONE room. The
//                       saver's own toast says the scene is shared with the session.
//   3. not consent      adoption never widens the outbound manifest scope, contrasted in
//                       the same page against a SAVE, which does. Unit-level and offline,
//                       because in a live session the name arrives in the other side's
//                       manifest anyway — which is exactly what `adoptSceneIdentity`'s own
//                       note says, and why the observable has to be built rather than found.
//   4. the negatives    TRAVEL names nobody (travel is leaving, not naming), and the room
//                       gate refuses the message from a peer demonstrably elsewhere.
//
// Run: APP_URL='https://localhost:5203/' PEER_CONFIG=... npm run e2e -- scene-adopt
const h = require('./helpers.cjs');

const sceneNameOf = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v?.name ?? null;
	});

const levelAt = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v;
	});

/** The toast HISTORY rather than the live stack: a plain toast is gone in seconds, and
 *  what is asserted here is that it was SAID, not that it is still on screen. */
const said = (p) =>
	p.page.evaluate(() => {
		let list;
		window.__stores.notifications.subscribe((v) => (list = v))();
		return list.map((e) => e.text);
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

const objectCount = (p) =>
	p.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r((g?.children ?? []).length))()
			)
	);

const addBox = (p) =>
	p.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		window.__stores.objectActions.deselectObject();
	});

/** What this peer's `manifest` messages would carry — the C4 send boundary itself. */
const outboundScenes = (p) =>
	p.page.evaluate(() => {
		const s = window.__stores.projectManifest;
		let doc;
		s.projectManifest.subscribe((x) => (doc = x))();
		return Object.keys(s.outboundManifest(doc).scenes ?? {});
	});

// ---- the REAL save path: the Explorer grid menu and its inline card ---------------------
// Lifted verbatim from `explorer-inline-input`, which owns this interaction: a fixed offset
// into the grid is a bet on what the dock chrome overlays, so scan for a pixel
// `elementFromPoint` says is the grid region ITSELF.
const gridBlankPoint = (p) =>
	p.page.evaluate(() => {
		const region = document.querySelector('#explorer-list [role="region"]');
		if (!region) return { ok: false, why: 'no grid region' };
		const r = region.getBoundingClientRect();
		for (let y = r.bottom - 14; y > r.top + 8; y -= 10)
			for (let x = r.left + 14; x < r.right - 14; x += 14)
				if (document.elementFromPoint(x, y) === region) return { ok: true, x, y };
		return { ok: false, why: 'every pixel of the grid is covered' };
	});

const saveSceneByHand = async (p, name) => {
	const at = await gridBlankPoint(p);
	if (!at.ok) return h.check(false, 'found blank grid background to right-click: ' + at.why);
	await p.page.mouse.click(at.x, at.y, { button: 'right' });
	await p.page.waitForTimeout(400);
	await p.page.locator('[role="menu"]').getByText('Save scene…', { exact: false }).first().click();
	await p.page.waitForTimeout(400);
	const card = await p.page.evaluate(() => {
		const input = document.querySelector('#explorer-new-card input');
		return input ? { present: true, focused: document.activeElement === input } : { present: false };
	});
	h.check(
		card.present && card.focused,
		'premise: "Save scene…" opened the focused inline card, so the keys go where they are aimed'
	);
	await p.page.keyboard.press('Control+a');
	await p.page.keyboard.type(name);
	await p.page.keyboard.press('Enter');
};

h.run(async () => {
	const browser = await h.launch();

	// =====================================================================
	// 1. THE PREMISE — ONE UNTITLED WORLD, TWO PEERS, NO ROOMS
	// =====================================================================
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await A.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await B.page.waitForFunction(() => !!window.__stores?.peerScenes, { timeout: 30000 });
	await addBox(A);
	h.check(
		(await objectCount(A)) === 1 && (await objectCount(B)) === 0,
		'premise: the host holds the work and the joiner is empty (row 1 — no ask at approval)'
	);

	await h.connect(B, A);
	h.check(
		(await sceneNameOf(A)) === null && (await sceneNameOf(B)) === null,
		`premise: neither side has a scene NAME (A ${JSON.stringify(await sceneNameOf(A))}, B ${JSON.stringify(await sceneNameOf(B))})`
	);
	await h.eventually(
		() => objectCount(B),
		(n) => n === 1,
		'premise: they are in ONE world — the host’s object reached the joiner'
	);
	h.check(
		(await rooms(A)).length === 0 && (await rooms(B)).length === 0,
		`premise: an unnamed world is no room at all (${JSON.stringify(await rooms(A))})`
	);

	// =====================================================================
	// 2. THE SAVE NAMES THE ROOM
	// =====================================================================
	await B.page.locator('#explorer-slot').click();
	await B.page.waitForTimeout(800);
	await B.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await saveSceneByHand(B, 'Depot34');

	await h.eventually(
		() => sceneNameOf(B),
		(n) => n === 'Depot34',
		'premise: the save named the SAVER’s scene (what already worked)',
		20000
	);
	await h.eventually(
		() => sceneNameOf(A),
		(n) => n === 'Depot34',
		'THE FIX: the host’s world takes the name it was just given',
		25000
	);

	const bName = await A.page.evaluate((id) => window.__stores.lockControl.nameOf(id), B.id);
	h.check(
		(await said(A)).some((t) => t === bName + ' saved this scene as "Depot34"'),
		`…and says who did it, in words (${JSON.stringify((await said(A)).slice(-3))})`
	);
	h.check(
		(await said(B)).some((t) => t.startsWith('Scene saved: Depot34') && t.includes('shared with this session')),
		`the saver’s own toast says the scene is shared with the session (${JSON.stringify((await said(B)).slice(-2))})`
	);

	const adopted = await levelAt(A);
	h.check(
		adopted?.hash === '' && adopted?.unsaved === true,
		`THE NAME AND NOTHING ELSE — no hash, marked unsaved (${JSON.stringify(adopted)})`
	);
	await h.eventually(
		() => rooms(A),
		(r) => r.length === 1 && r[0].scene === 'Depot34' && r[0].mine === true && r[0].peers === 1,
		'the peers popup reads ONE room holding both of them, not two scenes'
	);
	await h.eventually(
		() => rooms(B),
		(r) => r.length === 1 && r[0].scene === 'Depot34' && r[0].mine === true && r[0].peers === 1,
		'…and the saver agrees, which is the divergence closing'
	);

	// idempotent: the same message again changes nothing (the unnamed-only gate is also
	// the repeat gate)
	const beforeRepeat = await levelAt(A);
	await A.page.evaluate(
		(id) => window.__stores.levels.applyRemoteSceneAdopt({ name: 'Somewhere Else', hash: '', peerId: id }),
		B.id
	);
	await A.page.waitForTimeout(600);
	h.check(
		(await sceneNameOf(A)) === beforeRepeat?.name,
		`a second adopt cannot re-label a scene that now HAS a name (${await sceneNameOf(A)})`
	);

	// =====================================================================
	// 3. ADOPTION IS NOT CONSENT
	// =====================================================================
	// Offline and unit-level ON PURPOSE. In the live pair above the name also arrives in
	// the saver's manifest, so `sessionSceneNames` makes it publishable either way — which
	// is precisely `adoptSceneIdentity`'s own argument for not calling `noteSceneOpened`,
	// and it means the live session cannot separate the two. This page is a JOINER
	// (`sessionHost` set) holding a document it never opened, so the send boundary can be
	// read directly, before and after.
	const U = await h.setupPage(browser, 'U');
	await U.page.evaluate(() => {
		const s = window.__stores;
		s.projectManifest.resetSessionScope();
		s.projectManifest.manifestRestore(
			{ scenes: { Ghost: { history: ['deadbeef'], pinned: [] } }, assets: [], changedAt: 5 },
			false
		);
		s.connectionState.sessionHost.set('someone-else');
		s.levels.currentLevel.set(null);
	});
	h.check(
		(await outboundScenes(U)).length === 0,
		`premise: a joiner publishes nothing it never opened (${JSON.stringify(await outboundScenes(U))})`
	);
	await U.page.evaluate(() =>
		window.__stores.levels.applyRemoteSceneAdopt({ name: 'Ghost', hash: 'deadbeef', peerId: 'zz' })
	);
	await h.eventually(() => sceneNameOf(U), (n) => n === 'Ghost', 'premise: the name was adopted');
	h.check(
		(await outboundScenes(U)).length === 0,
		`ADOPTION IS NOT CONSENT — the outbound scope is unchanged (${JSON.stringify(await outboundScenes(U))})`
	);
	await U.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Ghost'));
	await h.eventually(
		() => outboundScenes(U),
		(names) => names.includes('Ghost'),
		'…while SAVING it is consent, which is the contrast that gives the check its teeth',
		20000
	);

	// =====================================================================
	// 4. WHAT MUST NOT NAME A ROOM
	// =====================================================================
	// (a) TRAVEL. Leaving a world for a named one says nothing about the world left behind,
	// so the peer standing in it keeps its own (lack of) identity. B is put back to unnamed
	// by hand — the state every peer is in before anybody saves, and the only state adoption
	// can act on, so without it the check would pass on the wrong gate.
	await B.page.evaluate(() => window.__stores.levels.currentLevel.set(null));
	await B.page.waitForTimeout(800);
	const saidBefore = (await said(B)).length;
	await A.page.evaluate(() => window.__stores.levels.newLevel('Arena'));
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.levels.levelItems().map((i) => i.name)),
		(names) => names.some((n) => n.includes('Arena')),
		'premise: there is a second scene to travel to'
	);
	const arenaHash = await A.page.evaluate(
		() => window.__stores.levels.levelItems().find((i) => i.name.includes('Arena')).hash
	);
	await A.page.evaluate((hash) => window.__stores.levels.travelToLevel(hash, 'Arena'), arenaHash);
	await h.eventually(
		() => sceneNameOf(A),
		(n) => n === 'Arena',
		'premise: the host travelled away'
	);
	await B.page.waitForTimeout(4000);
	h.check(
		(await sceneNameOf(B)) === null,
		`TRAVEL NAMES NOBODY — the peer left behind is still unnamed (${JSON.stringify(await sceneNameOf(B))})`
	);
	h.check(
		!(await said(B)).slice(saidBefore).some((t) => t.includes('saved this scene as')),
		'…and was told nothing, because nothing was said'
	);

	// (b) THE ROOM GATE. `sceneadopt` is ROOM_SCOPED, which is the whole mechanism: the
	// SEND side withholds it from a peer demonstrably elsewhere, the RECEIVE side drops it,
	// and `gateHolds` drops it from a peer queued behind an open ask — all three read the
	// membership and nothing else, so the membership is what is asserted here (driving the
	// share-or-stash modal to re-prove a branch that treats every ROOM_SCOPED type alike
	// would measure the gate, not this message).
	const gate = await A.page.evaluate(() => {
		const s = window.__stores.peerScenes;
		// a synthetic row: somebody demonstrably in another scene than our 'Arena'
		s.peerScenes.update((m) => ({ ...m, ghost: { scene: 'Somewhere', hash: '', at: Date.now() } }));
		const out = {
			scoped: s.ROOM_SCOPED.has('sceneadopt'),
			adopt: s.canApplyByRoom('ghost', 'sceneadopt'),
			presence: s.canApplyByRoom('ghost', 'atscene')
		};
		s.peerScenes.update((m) => {
			const next = { ...m };
			delete next.ghost;
			return next;
		});
		return out;
	});
	h.check(gate.scoped === true, 'sceneadopt is ROOM_SCOPED — the membership the design rests on');
	h.check(
		gate.adopt === false,
		'…so a save made in another scene can never rename this one (canApplyByRoom refuses it)'
	);
	h.check(
		gate.presence === true,
		'…while `atscene` still applies from there — presence is the gate’s own evidence'
	);

	for (const p of [A, B, U])
		h.check(
			(await h.pageErrors(p)).length === 0,
			`no page errors on ${p.id} (${JSON.stringify(await h.pageErrors(p))})`
		);
	await h.finish(browser);
});
