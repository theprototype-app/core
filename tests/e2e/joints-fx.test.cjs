// 37-fx (R12 joint-break sparks, R17 joint clone + steering options): a joint detached while a
// simulation runs is dropped from the LIVE world (the body really lets go — it used to hold
// until the next run) and fires sparks at its anchor on EVERY peer; an edit-time detach is
// quiet, and `sparks: false` keeps a break quiet. Duplicating both ends of a joint clones it
// onto the copies (one end only: no clone), one undo drops the clone, and the clone replicates.
// The steering options (limits / contacts / an angle motor) ride the def.
//
// Counterfactuals (run by hand, recorded in the lane handover): syncLiveJoints' removal loop
// emptied -> check 4 (the hanging box falls) fails; the `simulating || remoteSimulating` gate
// removed -> check 3 (an edit-time detach is quiet) fails.
const h = require('./helpers.cjs');

const jointsOf = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.joints.sceneJoints.subscribe((j) => r(j))()));
const fired = (page) => page.evaluate(() => window.__stores.gameKit.effectsBurst.burstDebug());
const yOf = (page, uuid) =>
	page.evaluate(
		(u) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => r(g?.getObjectByProperty('uuid', u)?.position.y ?? null))()
			),
		uuid
	);

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// a fixed anchor high up, a dynamic box welded under it
	const pair = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const [a, b] = group.children.slice(-2);
		a.position.set(0, 4, 0);
		b.position.set(0, 2.8, 0);
		delete a.userData.physics; // no physics = a FIXED body
		b.userData.physics = { mode: 'dynamic', mass: 1 };
		const peer = await new Promise((r) => s.peers.subscribe(r)());
		for (const o of [a, b]) {
			peer.send({ type: 'move', uuid: o.uuid, pos: o.position.toArray(), rot: [0, 0, 0], scale: [1, 1, 1] });
			peer.send({ type: 'objectParameters', parameter: 'physics', uuid: o.uuid, physics: o.userData.physics ?? null });
		}
		return { a: a.uuid, b: b.uuid };
	});

	// 1) clone on duplicate: both ends -> cloned; one end -> not
	const weld = await A.page.evaluate((p) => window.__stores.joints.createJoint('fixed', p.a, p.b)?.id, pair);
	h.check(!!weld, 'weld created');
	const before = (await jointsOf(A.page)).length;
	const clones = await A.page.evaluate((p) => {
		const s = window.__stores;
		s.objectActions.applySelectionSet([p.a, p.b]);
		return s.objectActions.duplicateSelection();
	}, pair);
	const afterSet = await jointsOf(A.page);
	const cloned = afterSet.find((j) => j.id !== weld && clones.includes(j.a) && clones.includes(j.b));
	h.check(afterSet.length === before + 1 && !!cloned, `duplicating BOTH ends clones the joint onto the copies (${before} -> ${afterSet.length})`);
	await h.eventually(() => jointsOf(B.page), (j) => j.some((d) => d.id === cloned?.id), 'the cloned joint replicates to B');
	await A.page.evaluate(() => window.__stores.history.undo());
	h.check(!(await jointsOf(A.page)).some((j) => j.id === cloned?.id), 'one undo drops the cloned joint first');
	// tidy the copies away, then a one-end duplicate
	await A.page.evaluate((c) => {
		const s = window.__stores;
		s.objectActions.deleteObjectsByUuid(c);
	}, clones);
	const nBefore = (await jointsOf(A.page)).length;
	await A.page.evaluate((p) => {
		const s = window.__stores;
		s.objectActions.applySelectionSet([p.b]);
		return s.objectActions.duplicateSelection();
	}, pair);
	h.check((await jointsOf(A.page)).length === nBefore, 'duplicating ONE end clones no joint');
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());

	// 2) options ride the def
	const opts = await A.page.evaluate((p) => {
		const j = window.__stores.joints;
		const def = j.createJoint('revolute', p.a, p.b, 'y', { pos: 0.2, stiffness: 500, damping: 50 }, { limits: [-0.5, 0.5], contacts: false, sparks: false, junk: 1 });
		const out = { limits: def.limits, contacts: def.contacts, sparks: def.sparks, motor: def.motor, junk: def.junk };
		j.deleteJoint(def.id);
		return out;
	}, pair);
	h.check(
		JSON.stringify(opts.limits) === '[-0.5,0.5]' && opts.contacts === false && opts.sparks === false && opts.motor?.pos === 0.2 && opts.junk === undefined,
		`steering options ride the joint def (${JSON.stringify(opts)})`
	);

	// 3) an edit-time detach is quiet
	const quiet0 = (await fired(A.page)).fired;
	const tmp = await A.page.evaluate((p) => window.__stores.joints.createJoint('fixed', p.a, p.b)?.id, pair);
	await A.page.evaluate((id) => window.__stores.joints.deleteJoint(id), tmp);
	await A.page.waitForTimeout(300);
	h.check((await fired(A.page)).fired === quiet0, 'detaching with no simulation running fires no sparks');

	// 4) a mid-run break: the body lets go, sparks on BOTH peers
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(() => A.page.evaluate(() => window.__stores.physics.isInitiator()), (v) => v === true, 'simulation running on A', 15000);
	await A.page.waitForTimeout(1500);
	const hanging = await yOf(A.page, pair.b);
	h.check(hanging > 2.3, `the welded box hangs from the fixed anchor (y ${hanging?.toFixed(2)})`);
	const [fa, fb] = [(await fired(A.page)).fired, (await fired(B.page)).fired];
	await A.page.evaluate((id) => window.__stores.joints.deleteJoint(id), weld);
	await h.eventually(() => yOf(A.page, pair.b), (y) => y != null && y < 1.2, 'detached mid-run, the box falls (the live joint is gone)', 8000);
	await h.eventually(() => fired(A.page), (d) => d.fired > fa, 'sparks fly on the initiator (A)');
	await h.eventually(() => fired(B.page), (d) => d.fired > fb, 'sparks fly on the watching peer (B) from its own jointdelete');

	// 5) sparks:false keeps a break quiet
	const q = await A.page.evaluate((p) => window.__stores.joints.createJoint('fixed', p.a, p.b, 'x', undefined, { sparks: false })?.id, pair);
	await A.page.waitForTimeout(300);
	const f2 = (await fired(A.page)).fired;
	await A.page.evaluate((id) => window.__stores.joints.deleteJoint(id), q);
	await A.page.waitForTimeout(400);
	h.check((await fired(A.page)).fired === f2, 'a joint with sparks:false breaks quietly');

	// 6) a joint ADDED mid-run is built live: weld the fallen box back up? (it holds it where it is)
	const added = await A.page.evaluate((p) => window.__stores.joints.createJoint('fixed', p.a, p.b)?.id, pair);
	await A.page.waitForTimeout(600);
	const hasLive = await A.page.evaluate((id) => window.__stores.physics.liveJointIds?.().includes(id), added);
	h.check(hasLive === true, 'a joint created mid-run is built in the live world');
	await A.page.evaluate(() => window.__stores.physics.stopSimulation());

	await h.finish(browser);
});
