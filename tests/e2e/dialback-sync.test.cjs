// scatter-sync — AN EDIT MADE WHILE AN APPROVED JOINER'S CONN IS STILL OPENING REACHES THEM.
//
// Approving dials the joiner back, and `broadcast` used to skip that conn until it opened —
// so an object created in the window never reached the joiner as a `create`. It only arrived
// if the joiner's full-state request was answered later (the slow GLTF path: 24.6 s with the
// CPU throttled to GitHub-runner speed), which is what turned the four two-peer scatter suites
// red on GitHub ("FAIL B has the terrain"). Now the host holds room broadcasts for the opening
// dial-back and flushes them after its handshake (src/lib/dialBackQueue.js).
//
// DETERMINISTIC on any box: the approval and the create run in ONE evaluate on the host, so
// the dial-back cannot have opened in between (asserted as a premise). Counterfactual: on the
// base the joiner never receives the `create` (red), with the fix it does, before the
// full-state reply (green). Both sides end with exactly one terrain.
const h = require('./helpers.cjs');

/** Records every message a page RECEIVES (type + uuid + when), on every peerjs conn. */
const TAP = () => {
	const log = (window.__rxTap = []);
	const seen = new WeakSet();
	setInterval(() => {
		let p;
		window.__stores?.peers?.subscribe((v) => (p = v))();
		const lists = p?.peer?._connections ? [...p.peer._connections.values()] : Object.values(p?.peer?.connections ?? {});
		for (const conn of [...lists.flat(), ...Object.values(p?.connections ?? {})]) {
			if (!conn || seen.has(conn)) continue;
			seen.add(conn);
			const emit = conn.emit.bind(conn);
			conn.emit = (ev, ...args) => {
				if (ev === 'data') {
					const d = args[0];
					for (const m of d?.type === 'batch' ? d.items : [d]) log.push({ t: Date.now(), type: m?.type, uuid: m?.uuid });
				}
				return emit(ev, ...args);
			};
		}
	}, 10);
};

/** @param {any} page */
const objectUuids = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.map((c) => c.uuid)))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await B.page.evaluate(TAP);

	// B dials; A sees the request but does NOT approve through the card
	await B.page.locator('input[placeholder="Enter peer ID to connect"]').fill(A.id);
	await B.page.getByRole('button', { name: 'Connect', exact: true }).click();
	await h.eventually(
		() => A.page.evaluate((id) => new Promise((r) => window.__stores.pendingApprovals.subscribe((v) => r(v.some((p) => p.peerId === id)))()), B.id),
		(v) => v,
		'premise: A holds B\'s join request',
		90000
	);

	// approve AND create in one tick: the dial-back exists and cannot be open yet
	const made = await A.page.evaluate((id) => {
		const s = window.__stores;
		s.peerApproval.approvePeer(id);
		let p;
		s.peers.subscribe((v) => (p = v))();
		const conn = p.connections[id];
		const before = new Set();
		s.objectsGroup.subscribe((g) => g.children.forEach((c) => before.add(c.uuid)))();
		s.commandsHandler.sceneCommand('/create Terrain 24 48');
		let uuid = null;
		s.objectsGroup.subscribe((g) => (uuid = g.children.find((c) => !before.has(c.uuid))?.uuid ?? null))();
		return { dialBack: !!conn, openAtCreate: !!conn?.open, uuid };
	}, B.id);
	h.check(made.dialBack && !made.openAtCreate && !!made.uuid, `premise: A created the terrain while its dial-back to B was not open yet (${JSON.stringify(made)})`);

	await h.eventually(async () => (await objectUuids(B.page)).includes(made.uuid), (v) => v, 'B has the terrain', 90000);
	const rx = await B.page.evaluate(() => window.__rxTap);
	const create = rx.find((m) => m.type === 'create' && m.uuid === made.uuid);
	const loading = rx.find((m) => m.type === 'loading');
	h.check(!!create, 'B received the create itself — not only the full-state copy (red before the dial-back queue)');
	h.check(!!create && (!loading || create.t <= loading.t), 'and before the full-state reply began');

	// the full-state reply carries the same terrain: add-only by uuid, so B still holds ONE
	await h.eventually(() => B.page.evaluate(() => window.__rxTap.some((m) => m.type === 'object')), (v) => v, 'the full-state reply arrived too', 90000);
	await B.page.waitForTimeout(1500);
	const a = await objectUuids(A.page);
	const b = await objectUuids(B.page);
	h.check(b.length === a.length && b.length === 1 && b[0] === made.uuid, `B ends with exactly A's one terrain (A ${a.length}, B ${b.length})`);

	await h.finish(browser);
});
