// B5 regression: one peer dropping must not release the locks of the peers that
// stayed.
//
// checkLocks() runs on every connection close and decided liveness from peerjs's
// RAW connection map — `peer.peer.connections[id]`, an ARRAY — with
// `length <= 1` meaning "gone". A perfectly healthy peer holds exactly ONE
// DataConnection, so that test matched every live peer: any disconnect anywhere
// released every remote lock in the session. Seen in the wild in the N=5 stress
// run, where a joiner's connect churn made a survivor log
// "Peer <host> is not connected anymore. Releasing..." about the still-connected
// host, three times in a row.
//
// `connections[id].open` (what PeerConnection maintains, and what
// lockControl.startLockSweep already used) is the real signal.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const C = await h.setupPage(browser, 'C');

	await h.connect(B, A);
	await h.connect(C, A);

	const store = (p, name) =>
		p.page.evaluate((n) => new Promise((r) => window.__stores[n].subscribe((v) => r(v))()), name);
	const locksOn = (p) => store(p, 'lockedObjects');
	const rosterOn = (p) => store(p, 'userdata');

	// B creates a box: creating selects it, so B holds the lock and A sees it.
	// (A creating it would leave the lock with A, and B's select would then take
	// the read-only locked-view branch and broadcast nothing.)
	const uuid = await B.page.evaluate(() => {
		const w = window;
		w.__stores.commandsHandler.sceneCommand('/create box');
		let g;
		w.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children[g.children.length - 1].uuid;
	});

	await h.eventually(
		() => locksOn(A),
		(l) => l.some((x) => x[0] === B.id && x[1] === uuid),
		"A sees B's lock on the box"
	);

	// A healthy peer's raw conn array is length 1 — exactly what the old test
	// called "not connected anymore".
	const shape = await A.page.evaluate((bid) => {
		let pc;
		window.__stores.peers.subscribe((p) => (pc = p))();
		return { raw: pc.peer.connections[bid]?.length ?? 0, open: !!pc.connections[bid]?.open };
	}, B.id);
	console.log('  A -> B: raw conn entries ' + shape.raw + ', outgoing open ' + shape.open);
	h.check(shape.open, 'A holds an OPEN outgoing connection to B');
	h.check(shape.raw <= 1, 'a live peer really does have <= 1 raw conn entry (the old liveness test)');

	// C drops. Closing A's conn to C directly exercises the same
	// conn.on('close') -> onConnClose -> checkLocks path a real drop takes; a hard
	// remote destroy waits on an unbounded ICE timeout that will not fire headless.
	await A.page.evaluate((cid) => {
		let pc;
		window.__stores.peers.subscribe((p) => (pc = p))();
		pc?.connections?.[cid]?.close();
	}, C.id);

	await h.eventually(
		() => rosterOn(A),
		(u) => !u.some((x) => x[0] === C.id),
		'A drops C from the roster'
	);
	await A.page.waitForTimeout(1500); // let the 500ms reaper inside checkLocks run too

	const locks = await locksOn(A);
	h.check(
		locks.some((x) => x[0] === B.id && x[1] === uuid),
		"B's lock SURVIVES an unrelated peer dropping"
	);
	h.check(
		!locks.some((x) => x[0] === C.id),
		"the dropped peer's own locks are released"
	);
	const roster = await rosterOn(A);
	h.check(roster.some((x) => x[0] === B.id), "B stays in A's roster after C drops");
	const stillOpen = await A.page.evaluate((bid) => {
		let pc;
		window.__stores.peers.subscribe((p) => (pc = p))();
		return !!pc.connections[bid]?.open && pc.openedPeers.has(bid);
	}, B.id);
	h.check(stillOpen, 'A -> B connection is untouched by the drop');

	// and B, who witnessed its own conn to C close, keeps A
	await h.eventually(
		() => rosterOn(B),
		(u) => u.some((x) => x[0] === A.id),
		'B still sees A after C drops'
	);

	await h.finish(browser);
});
