// Phase 172: an ungraceful peer drop must self-heal locally. Before the fix, the
// surviving peer only ran checkLocks() and relied on a relayed 'disconnected'
// that never reaches the last peer in a 2-peer session, leaking the dropped
// peer's VR hands / flow cursor / voice nodes / locks. Now conn.on('close')
// runs the full teardown directly.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');

	await h.connect(A, B);

	const userdataOf = (p) =>
		p.page.evaluate(() => new Promise((r) => window.__stores.userdata.subscribe((v) => r(v))()));

	// B should now be in A's peer list (drives B's avatar)
	await h.eventually(
		() => userdataOf(A),
		(u) => u.some((x) => x[0] === B.id),
		'B joined A peer list'
	);

	// seed per-peer state for B on A: VR hands, a flow cursor, and a held lock
	await A.page.evaluate((bid) => {
		window.__stores.peerHands.update((m) => ({ ...m, [bid]: { left: null, right: null, active: true, ts: 1 } }));
		window.__stores.flowCursors.update((m) => ({ ...m, [bid]: { x: 1, y: 2, name: 'B', ts: 1 } }));
		window.__stores.lockedObjects.update((l) => [...l.filter((x) => x[0] !== bid), [bid, 'lock-uuid-1']]);
	}, B.id);

	const seeded = await A.page.evaluate((bid) => {
		let hands, cursors, locks;
		window.__stores.peerHands.subscribe((v) => (hands = v))();
		window.__stores.flowCursors.subscribe((v) => (cursors = v))();
		window.__stores.lockedObjects.subscribe((v) => (locks = v))();
		return { hand: !!hands[bid], cursor: !!cursors[bid], lock: locks.some((l) => l[0] === bid) };
	}, B.id);
	h.check(seeded.hand && seeded.cursor && seeded.lock, 'seeded B hands/cursor/lock on A');

	// Drop detection: A's outgoing DataConnection to B fires 'close' (a hard
	// remote destroy relies on an unbounded ICE timeout that won't fire promptly
	// in headless, so we close A's conn to B directly to exercise the same
	// conn.on('close') -> onConnClose teardown path deterministically).
	await A.page.evaluate((bid) => {
		let pc;
		window.__stores.peers.subscribe((p) => (pc = p))();
		pc?.connections?.[bid]?.close();
	}, B.id);

	// A must detect the drop and remove B from the peer list (avatar gone)
	await h.eventually(
		() => userdataOf(A),
		(u) => !u.some((x) => x[0] === B.id),
		'A removes B from the peer list on drop (avatar gone)',
		12000
	);

	// and the full per-peer teardown ran locally — no leaked hands/cursor/lock
	const leaks = await A.page.evaluate((bid) => {
		let hands, cursors, locks;
		window.__stores.peerHands.subscribe((v) => (hands = v))();
		window.__stores.flowCursors.subscribe((v) => (cursors = v))();
		window.__stores.lockedObjects.subscribe((v) => (locks = v))();
		return { hand: !!hands[bid], cursor: !!cursors[bid], lock: locks.some((l) => l[0] === bid) };
	}, B.id);
	h.check(!leaks.hand, 'VR hands entry cleared on disconnect');
	h.check(!leaks.cursor, 'flow cursor cleared on disconnect');
	h.check(!leaks.lock, 'the dropped peer lock is released');

	await h.finish(browser);
});
