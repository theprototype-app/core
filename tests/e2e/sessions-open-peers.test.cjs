// R22 ROUND 13 — OPENING A PROJECT LEAVES THE SESSION FIRST.
//
//   "for project it should warn and also disconnect any connected peer before replacing"
//
// The single-peer half of Open (the guard, the marker, the warning's wording with nobody
// connected) is `sessions-open`. This file is the half that needs two browsers, and it is
// its own file for the reason every two-peer suite is: signaling is slow and the runner
// gives one file 8 minutes.
//
// WHY THE DISCONNECT IS LOAD-BEARING, and not politeness: `requestLoadSession` turns into
// a PROPOSAL whenever anyone is connected, so without the leave the press would ask the
// room to vote on a library swap that only happens on this machine — and until they all
// answered, nothing would happen at all. Leaving first is what makes the press apply. So
// the check for "it disconnected" and the check for "it actually opened" are the same
// evidence read two ways.
//
// Run: PEER_CONFIG='…' APP_URL='https://localhost:5206/' npm run e2e -- sessions-open-peers
const h = require('./helpers.cjs');

/** who this page is connected to — openedPeers, never userdata (populated at DIAL time) */
const room = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.peers.subscribe((x) => (v = x))();
		return v?.openedPeers ? [...v.openedPeers] : null;
	});

const level = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v ?? null;
	});

const dialog = (p) =>
	p.page.evaluate(() => {
		let d;
		window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
		return d
			? { title: d.title, message: d.message, confirm: d.confirmLabel, choices: (d.choices ?? []).map((/** @type {any} */ c) => c.value) }
			: null;
	});
const answer = (p, value) => p.page.evaluate((v) => window.__stores.confirmDialog.resolveConfirm(v), value);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const peer of [A, B]) {
		await peer.page.waitForFunction(() => !!window.__stores?.sessions && !!window.__stores?.explorer, null, {
			timeout: 30000
		});
		await peer.page.evaluate(async () => {
			await window.__stores.explorer.loadExplorer();
			await window.__stores.explorer.clearLibrary();
		});
	}

	// CONNECT WITH AN EMPTY SCENE ON THE DIALER, deliberately: `connectDecisionApplies`
	// asks its blocking question only when the joiner is holding objects in an unnamed
	// scene, and this suite is not about that dialog. The work is made afterwards.
	await h.connect(A, B);
	const before = await room(A);
	h.check(before?.length === 1, `premise: A is connected to one peer (${JSON.stringify(before)})`);

	await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		s.objectActions.deselectObject();
		await s.explorer.addItemFromBytes(new TextEncoder().encode('notes').buffer, 'readme.txt', null);
	});
	await A.page.waitForTimeout(1200);
	await A.page.evaluate(() => window.__stores.sessions.saveSessionWithLibrary('Depot'));
	await A.page.waitForTimeout(1500);
	// EMPTY THE LIBRARY AFTERWARDS, so "its files came back" is evidence of the restore
	// and not of a file that was never gone (an absence check needs its presence half)
	await A.page.evaluate(() => window.__stores.explorer.clearLibrary());
	await A.page.waitForTimeout(700);
	const saved = await A.page.evaluate(() => {
		let v;
		window.__stores.sessions.sessions.subscribe((x) => (v = x))();
		return (v ?? []).filter((m) => m.hasLibrary).map((m) => m.name);
	});
	h.check(saved.includes('Depot'), `premise: a PROJECT entry is saved on A (${JSON.stringify(saved)})`);
	const emptied = await A.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return (v ?? []).length;
	});
	h.check(emptied === 0, `premise: and A's library is empty again before the open (${emptied})`);

	// ---- 1. THE WARNING NAMES THE ROOM IT IS ABOUT TO LEAVE --------------------------
	await A.page.evaluate(() => window.__stores.sessionsOpen.set(true));
	await A.page.waitForTimeout(900);
	await A.page.locator('#session-view-list').click();
	await A.page.waitForTimeout(400);
	await A.page
		.locator('#session-list .session-row')
		.filter({ hasText: 'Depot' })
		.first()
		.locator('.session-load')
		.click();
	await A.page.waitForTimeout(800);
	// the scene guard speaks first — A's world is unnamed and not empty
	const guard = await dialog(A);
	h.check(
		(guard?.choices ?? []).join(',') === 'save,open',
		`the unsaved-changes guard runs first, as for any open (${JSON.stringify(guard?.choices)})`
	);
	await answer(A, 'open');
	await A.page.waitForTimeout(700);
	const warn = await dialog(A);
	h.check(warn?.title === 'Open project "Depot"?', `then the project warning (${warn?.title})`);
	h.check(
		/leave the session first/i.test(warn?.message ?? '') && /1 connected peer\b/.test(warn?.message ?? ''),
		`…which counts the peers it is about to leave (${(warn?.message ?? '').slice(-120)})`
	);
	h.check(
		warn?.confirm === 'Leave and open',
		`…and the button says both halves of what it does (${warn?.confirm})`
	);

	// ---- 2. ACCEPTING LEAVES, AND THEN OPENS -----------------------------------------
	await answer(A, true);
	await h.eventually(() => room(A), (v) => (v?.length ?? -1) === 0, 'A leaves the session', 20000);
	await h.eventually(
		() => room(B),
		(v) => (v?.length ?? -1) === 0,
		'…and B sees it go — an announced leave, not a dropped link',
		20000
	);
	// THE PROOF THAT IT APPLIED rather than becoming a proposal nobody could answer: the
	// marker is written only for a load that happened (requestLoadSession's own verdict)
	await h.eventually(
		() => level(A),
		(v) => v?.name === 'Depot (from Sessions)',
		'the project opened on A, immediately — not as a proposal',
		25000
	);
	const at = await level(A);
	h.check(at?.hash === '' && at?.unsaved === true, `…marked as recovered from Sessions (${JSON.stringify(at)})`);
	h.check(
		(await A.page.evaluate(() => {
			let v;
			window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
			return (v ?? []).map((i) => i.name);
		})).includes('readme.txt'),
		'…with its library back in the Explorer'
	);

	// B's own world is untouched by any of it — a project swap is one machine's business
	const bLevel = await level(B);
	h.check(bLevel === null || !/from Sessions/.test(bLevel.name ?? ''), `B was never moved (${JSON.stringify(bLevel)})`);

	await h.finish(browser);
});
