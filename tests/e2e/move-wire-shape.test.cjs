// A `move` sent with three's `Euler.toArray()` — `[x, y, z, 'XYZ']` — must land on the peer.
//
// 27-A's wire validator accepted a rotation of 3 or 4 FINITE NUMBERS only, and three 0.185's
// `Euler.toArray()` carries the ORDER STRING as its fourth entry. That is the shape the gizmo
// drag, the Explorer drop-to-surface, the Inspector, Align to ground and a dozen other senders
// put on the wire, so every one of those moves was refused on arrival (`invalid:move`) and the
// peer kept the old pose. Found by the 30c pack lanes (a snapped kit drag never reached peer B).
//
// The path driven here is a REAL sender (objectActions.alignToGround), with a pass-through
// spy proving the message left in the toArray shape, so the check cannot pass on a sender
// that happens to send three numbers.
const h = require('./helpers.cjs');

const poseOf = (page, uuid) =>
	page.evaluate(async (id) => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.getObjectByProperty('uuid', id);
		return o ? { y: o.position.y, x: o.position.x, ry: o.rotation.y } : null;
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const uuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		return g.children[g.children.length - 1].uuid;
	});
	await h.eventually(() => poseOf(B.page, uuid), (p) => !!p, 'premise: B holds the box', 20000);
	// let /create's own re-seat settle before moving it (the documented /create trap)
	await A.page.waitForTimeout(1500);

	// lift + turn it on A and replicate that pose with a plain 3-number move first, so B
	// starts from a known pose that differs from where Align to ground will put it
	await A.page.evaluate((id) => {
		const w = window.__stores;
		let g; w.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', id);
		o.userData.physics = { mode: 'static' };
		o.position.set(1.5, 6, -2);
		o.rotation.set(0, 0.7, 0);
		let p; w.peers.subscribe((v) => (p = v))();
		p.send({ type: 'move', uuid: id, pos: [1.5, 6, -2], rot: [0, 0.7, 0], scale: [1, 1, 1] });
	}, uuid);
	await h.eventually(() => poseOf(B.page, uuid), (p) => p && Math.abs(p.y - 6) < 0.01, 'premise: B has the lifted pose (y 6)', 15000);

	// spy on what A sends, passing it through
	await A.page.evaluate(() => {
		const w = window;
		w.__moves = [];
		let p; w.__stores.peers.subscribe((v) => (p = v))();
		const orig = p.send.bind(p);
		p.send = (d) => { if (d && d.type === 'move') w.__moves.push(d.rot); return orig(d); };
	});
	const errsBefore = await B.page.evaluate(() => window.__stores.wireErrors.wireErrors().filter((e) => e.type === 'invalid:move').reduce((n, e) => n + e.count, 0));

	await A.page.evaluate((id) => window.__stores.objectActions.alignToGround(id), uuid);
	const aPose = await poseOf(A.page, uuid);
	const sent = await A.page.evaluate(() => window.__moves);
	h.check(aPose && aPose.y < 5, `premise: Align to ground moved the box on A (y ${aPose && aPose.y.toFixed(2)})`);
	h.check(
		sent.length > 0 && sent.every((r) => Array.isArray(r) && r.length === 4 && typeof r[3] === 'string'),
		`premise: the real sender put the toArray shape on the wire (${JSON.stringify(sent[0])})`
	);

	await h.eventually(
		() => poseOf(B.page, uuid),
		(p) => p && Math.abs(p.y - aPose.y) < 0.01,
		'THE BUG: B follows a move whose rotation is [x, y, z, order]',
		8000
	);
	const bPose = await poseOf(B.page, uuid);
	h.check(bPose && Math.abs(bPose.ry - 0.7) < 0.01 && Math.abs(bPose.x - 1.5) < 0.01, `B keeps the rest of the pose (x ${bPose && bPose.x.toFixed(2)}, ry ${bPose && bPose.ry.toFixed(2)})`);
	const errsAfter = await B.page.evaluate(() => window.__stores.wireErrors.wireErrors().filter((e) => e.type === 'invalid:move').reduce((n, e) => n + e.count, 0));
	h.check(errsAfter === errsBefore, `B recorded no invalid:move (${errsBefore} -> ${errsAfter})`);

	await h.finish(browser);
});
