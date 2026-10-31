// @ts-nocheck
// 60-int: a ONE-SIDED drop heals both ways (`relink`, peerHandler.adoptRelink).
//
// net-drop on the deployed preview (1.44.0 proof) lost ONE direction's edits after a heal: one end
// closed the link (F-3's ICE grace, or the drop itself) and redialled, while the other end's conn still
// read `open` — a close never crosses a dead link — so it refused the inbound heal ("the stable
// outgoing conn stays preferred") and kept sending, and answering the heal's full-state requests,
// into a conn nobody reads. Locally the close always crosses, so net-drop cannot show it; this suite
// MAKES the zombie: on the higher id (the end that never redials) the conn keeps reading open, swallows
// every send and hears no close, and the lower id closes its own end, which runs the reconnect window.
//
// Counterfactual: without the relink (sendHandshake's first send / adoptRelink) checks 2-4 go red —
// Z's edits and Z's full-state reply stay in the zombie.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'P');
	const Q = await h.setupPage(browser, 'Q');
	await h.connect(Q, P);
	// the LOWER id redials in the reconnect window; the higher keeps the zombie
	const [L, Z] = P.id < Q.id ? [P, Q] : [Q, P];
	console.log(`  redialer L=${L.id} zombie Z=${Z.id}`);

	const openTo = (p, id) =>
		p.page.evaluate((pid) => {
			let pc;
			window.__stores.peers.subscribe((v) => (pc = v))();
			return !!pc.connections[pid]?.open && pc.openedPeers.has(pid);
		}, id);
	const create = (p, shape) =>
		p.page.evaluate((s) => {
			window.__stores.commandsHandler.sceneCommand('/create ' + s);
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g.children[g.children.length - 1].uuid;
		}, shape);
	const has = (p, uuid) =>
		p.page.evaluate((u) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return !!g?.getObjectByProperty('uuid', u);
		}, uuid);

	await h.eventually(() => openTo(L, Z.id), (v) => v, 'premise: L holds an open conn to Z');
	await h.eventually(() => openTo(Z, L.id), (v) => v, 'premise: Z holds an open conn to L');
	const warm = await create(Z, 'box');
	await h.eventually(() => has(L, warm), (v) => v, "premise: Z's edit reaches L before the drop");

	// ---- Z's conn becomes a zombie: reads open, sends go nowhere, no close and no ICE watch reach it
	await Z.page.evaluate((id) => {
		let pc;
		window.__stores.peers.subscribe((v) => (pc = v))();
		const c = pc.connections[id];
		c.__zombie = true;
		c.removeAllListeners('close');
		c.removeAllListeners('iceStateChanged');
		Object.defineProperty(c, 'open', { configurable: true, get: () => true });
		c.send = () => {};
	}, L.id);
	// an edit Z makes while its link is dead
	const during = await create(Z, 'sphere');
	// ---- L's end closes (as F-3's silence close does) -> L's reconnect window redials Z
	await L.page.evaluate((id) => {
		let pc;
		window.__stores.peers.subscribe((v) => (pc = v))();
		pc.connections[id].close();
	}, Z.id);

	await h.eventually(() => openTo(L, Z.id), (v) => v, 'L redialled Z and the conn is open', 30000);
	const swapped = () =>
		Z.page.evaluate((id) => {
			let pc;
			window.__stores.peers.subscribe((v) => (pc = v))();
			const c = pc.connections[id];
			return !!c && !c.__zombie && c.open;
		}, L.id);
	await h.eventually(swapped, (v) => v, "Z replaced its zombie with L's new conn (relink)", 15000);
	await h.eventually(() => has(L, during), (v) => v, "Z's edit made while its link was dead reaches L (the heal's re-sync)", 15000);
	const after = await create(Z, 'cone');
	await h.eventually(() => has(L, after), (v) => v, "Z's edit after the heal reaches L", 10000);
	const back = await create(L, 'cylinder');
	await h.eventually(() => has(Z, back), (v) => v, "L's edit after the heal reaches Z", 10000);
	const toasts = async (p) => (await p.page.evaluate(() => new Promise((r) => window.__stores.notifications.subscribe((v) => r(v))()))).filter((n) => /disconnected/.test(String(n.text))).length;
	h.check((await toasts(L)) === 0 && (await toasts(Z)) === 0, 'no "disconnected" toast on either side');
	await h.finish(browser);
});
