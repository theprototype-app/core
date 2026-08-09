// B5 / phase-172 deferred item 1: transient drops heal instead of tearing down.
//
// An OPEN conn dropping without a goodbye now gets a bounded redial window
// (500/1000/2000/4000ms, netBackoff) before any teardown: the peer's roster
// entry, avatar and locks survive a wifi wobble, and no "disconnected" toast
// fires unless they are really gone. Announced leaves (leaveSession broadcasts
// the existing `disconnected` message about itself; pagehide does the same
// best-effort) skip the window entirely — without the announcement, peers
// would redial the leaver's still-registered id and every attempt would land
// there as a fresh approval request. And a relayed `disconnected` about a peer
// we have FIRST-HAND state on is ignored — honoring third-party rumors is how
// live peers used to get evicted meshwide.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const C = await h.setupPage(browser, 'C');

	await h.connect(B, A);
	await h.connect(C, A); // hosts flow meshes C with B too

	const store = (p, name) =>
		p.page.evaluate((n) => new Promise((r) => window.__stores[n].subscribe((v) => r(v))()), name);
	const rosterOn = (p) => store(p, 'userdata');
	const openTo = (p, id) =>
		p.page.evaluate((pid) => {
			let pc;
			window.__stores.peers.subscribe((v) => (pc = v))();
			return !!pc.connections[pid]?.open && pc.openedPeers.has(pid);
		}, id);

	await h.eventually(() => openTo(C, B.id), (v) => v, 'mesh formed: C holds an open conn to B');

	// --- a relayed 'disconnected' about a live peer is ignored
	await C.page.evaluate(([aid, bid]) => {
		let pc;
		window.__stores.peers.subscribe((v) => (pc = v))();
		pc.connections[aid].send({ type: 'disconnected', peerId: bid });
	}, [A.id, B.id]);
	await A.page.waitForTimeout(1500);
	h.check(await openTo(A, B.id), "a third party's 'disconnected' rumor does not break A's live conn to B");
	h.check((await rosterOn(A)).some((u) => u[0] === B.id), 'B stays in A\'s roster after the rumor');

	// --- transient drop heals: close A's conn to B while B is alive
	const uuid = await B.page.evaluate(() => {
		const w = window;
		w.__stores.commandsHandler.sceneCommand('/create box');
		let g;
		w.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});
	await h.eventually(
		() => store(A, 'lockedObjects'),
		(l) => l.some((x) => x[0] === B.id && x[1] === uuid),
		"A sees B's lock before the blip"
	);
	const notifCountBefore = (await store(A, 'notifications')).length;

	await A.page.evaluate((bid) => {
		let pc;
		window.__stores.peers.subscribe((v) => (pc = v))();
		pc.connections[bid].close();
	}, B.id);
	await A.page.waitForTimeout(800); // inside the reconnect window
	h.check((await rosterOn(A)).some((u) => u[0] === B.id), 'B stays in the roster during the blip');
	h.check(
		(await store(A, 'lockedObjects')).some((x) => x[0] === B.id && x[1] === uuid),
		"B's lock survives the blip"
	);
	await h.eventually(() => openTo(A, B.id), (v) => v, 'the conn to B is re-opened by the backoff', 12000);
	const notifs = await store(A, 'notifications');
	h.check(
		!notifs.slice(notifCountBefore).some((n) => String(n.text).includes('disconnected')),
		'no disconnect toast fired for a drop that healed'
	);

	// messages flow again after the heal
	await B.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create sphere'));
	const countOn = (p) =>
		p.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g?.children?.length ?? 0;
		});
	const bCount = await countOn(B);
	await h.eventually(() => countOn(A), (c) => c >= bCount, "B's new object reaches A after the heal", 10000);

	// --- announced leave tears down promptly, with no redial spam
	const t0 = Date.now();
	await B.page.evaluate(() => {
		let pc;
		window.__stores.peers.subscribe((v) => (pc = v))();
		pc.leaveSession();
	});
	await h.eventually(
		() => rosterOn(A),
		(u) => !u.some((x) => x[0] === B.id),
		'an announced leave removes B from A without waiting out the backoff',
		6000
	);
	h.check(Date.now() - t0 < 5000, 'the graceful teardown was prompt (' + (Date.now() - t0) + 'ms)');
	await A.page.waitForTimeout(4000); // long enough for any stray reconnect dial to land
	const strayApprovals = await store(B, 'pendingApprovals');
	h.check(
		strayApprovals.length === 0,
		'nobody redialed the leaver (no stray approval prompts: ' + JSON.stringify(strayApprovals) + ')'
	);

	await h.finish(browser);
});
