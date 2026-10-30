// fix-agenttest item 6 — A GUEST'S RELOAD GOES BACK TO THE SESSION.
// Reported: a guest (phone) joined to a host's session reloads and gets "Restore previous
// session?"; Restore loads the guest's own autosave as a SEPARATE session, which later splits from
// and merges back into the room. Now the guest remembers the session for its tab (rejoin.js),
// comes back on the same id, the host re-admits it without a new approval card, and the restore
// prompt is offered only when there is no live session to go back to.
// Counterfactual on v1.47.0: 2.1-2.5 are red (a fresh id, alone, the restore prompt up, no host scene).
const h = require('./helpers.cjs');

const objectsOf = (p) =>
	p.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		return (g?.children ?? []).map((c) => c.uuid);
	});
const linkOf = (p) =>
	p.page.evaluate(() => {
		let pr, host;
		window.__stores.peers.subscribe((v) => (pr = v))();
		window.__stores.connectionState.sessionHost.subscribe((v) => (host = v))();
		return { id: pr?.peer?.id ?? null, open: [...(pr?.openedPeers ?? [])], host };
	});
/** a reload with a patient boot wait (h.freshReload allows 30 s; a loaded slot's second boot can take longer) */
const reload = async (p) => {
	await p.page.reload({ waitUntil: 'domcontentloaded' });
	await p.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, null, { timeout: 90000 });
};
const restoreUp = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.autosave?.restoreAvailable?.subscribe((x) => (v = x))();
		return !!v || !!document.querySelector('#restore-session-modal[open]');
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => {
		const S = window.__stores;
		S.commandsHandler.sceneCommand('/create box');
		S.commandsHandler.sceneCommand('/create sphere');
		S.objectActions.deselectObject();
	});
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const hostObjects = await objectsOf(A);
	h.check(hostObjects.length === 2, `premise: the host's scene holds two objects (${hostObjects.length})`);
	await h.eventually(() => objectsOf(B), (u) => u.length === 2, '1.1 the guest received the host scene', 30000);

	// ---- 1. the guest's autosave holds a copy of the host's scene (what Restore loaded) ----
	await B.page.evaluate(() => window.__stores.autosave.saveNow());
	const before = await linkOf(B);
	h.check(before.host === A.id && before.open.includes(A.id), `1.2 premise: B is joined to A (${JSON.stringify(before)})`);

	// ---- 2. the reload ----
	await reload(B);
	await h.eventually(() => linkOf(B), (l) => l.open.includes(A.id) && l.host === A.id, '2.1 after the reload B is back in A\'s session', 45000);
	const after = await linkOf(B);
	h.check(after.id === before.id, `2.2 on the same id (${before.id} -> ${after.id})`);
	// the prompt would have come up by now; watch it stay down a while longer
	let prompted = false;
	for (let i = 0; i < 12 && !prompted; i++) {
		prompted = await restoreUp(B);
		await B.page.waitForTimeout(500);
	}
	h.check(!prompted, '2.3 and no "Restore previous session?" — there is a live session and B is in it');
	await h.eventually(() => objectsOf(B), (u) => u.length === 2, '2.4 B holds the host scene again', 30000);
	const bObjects = await objectsOf(B);
	h.check(new Set(bObjects).size === bObjects.length && hostObjects.every((u) => bObjects.includes(u)), `2.5 the same objects, no duplicates (${bObjects.length})`);
	h.check((await objectsOf(A)).length === 2, `2.6 nor did anything arrive twice on the host (${(await objectsOf(A)).length})`);
	const cards = await A.page.evaluate(() => {
		let v;
		window.__stores.pendingApprovals?.subscribe((x) => (v = x))();
		return (v ?? []).length;
	});
	h.check(cards === 0, `2.7 the host was not asked to approve B again (${cards} cards)`);

	// ---- 3. no live session to go back to: the prompt is offered as before ----
	// a remembered session whose host is gone (seeded ahead of the app, once)
	await B.page.addInitScript((id) => {
		if (sessionStorage.getItem('e2e-rejoin-seeded')) return;
		sessionStorage.setItem('e2e-rejoin-seeded', '1');
		sessionStorage.setItem('tp:rejoin', JSON.stringify({ id, host: 'dead0', at: Date.now() }));
	}, after.id);
	await h.closePeer(A);
	await reload(B);
	await h.eventually(() => restoreUp(B), (up) => up, '3.1 the host is gone: B is offered its own copy', 40000);
	const alone = await linkOf(B);
	h.check(alone.open.length === 0 && !alone.host, `3.2 and B is in no session (${JSON.stringify(alone)})`);
	h.check(await h.answerRestore(B, 'dismiss', 5000), '3.3 the prompt answers as before');

	const errs = h.pageErrors(B);
	h.check(errs.length === 0, 'no page errors on B: ' + JSON.stringify(errs.slice(0, 3)));
	await h.finish(browser);
});
