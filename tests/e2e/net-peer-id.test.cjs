// B5 / phase-172 deferred item 3: peer-id collisions.
//
// Session ids are 5 hex chars = 20 bits, so a birthday collision arrives long
// before a million concurrent sessions (~1k live ids ~= 40% chance of one). The
// old handling was a dead end — "Your session ID is already in use. Please
// reload the page." — even though the id is generated fresh on every page load
// and nothing is pinned to it before the signaling link opens.
//
// The audit assumed lengthening the id, and filed it as a compat break for after
// release. It isn't one (ids are never persisted and peers only ever echo them
// back), and it also isn't necessary: taking a fresh id on collision is enough.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const before = A.id;
	h.check(/^[0-9a-f]{5}$/.test(before), 'session id is 5 hex chars');

	// 44 L2: the way BACK after a runtime switch. switchServer's rebuild resets `hasOpened`, and a
	// collision with this page's OWN still-held registration then took the "fresh id" branch
	// (invite-link-live §7: "ID … is taken" -> "session id collided — retrying"), so the invite
	// link the user had copied died. Ours = the server this id opened on: the id is kept.
	const own = await A.page.evaluate(async () => {
		let pc;
		window.__stores.peers.subscribe((p) => (pc = p))();
		const first = pc.peer.id;
		pc.hasOpened = false; // what a runtime switch's rebuild leaves behind
		pc.peer.emit('error', { type: 'unavailable-id' });
		for (let i = 0; i < 60 && !(pc.peer.open && pc.peer.id); i++) await new Promise((r) => setTimeout(r, 250));
		const out = { first, id: pc.peer.id, open: pc.peer.open, retries: pc.idRetries };
		pc.idRetries = 0;
		return out;
	});
	h.check(own.id === own.first, `a collision with our OWN registration keeps the id, even after a switch reset hasOpened (${own.first} -> ${own.id})`);
	h.check(own.open, 'and the link is open on it');

	// Drive the collision the server would report. The page's id is forgotten as
	// "registered on this server" (44 L2: that is `registeredOn`, no longer
	// `hasOpened`) because a live page has already opened its link — a fresh id is
	// only taken for an id that is not our own registration there.
	const after = await A.page.evaluate(async () => {
		let pc;
		window.__stores.peers.subscribe((p) => (pc = p))();
		const first = pc.peer.id;
		pc.registeredOn.clear();
		pc.peer.emit('error', { type: 'unavailable-id' });
		// the rebuilt peer has to register with the server before it reports an id
		for (let i = 0; i < 60; i++) {
			if (pc.peer.id && pc.peer.id !== first && pc.peer.open) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		return { id: pc.peer.id, open: pc.peer.open, retries: pc.idRetries };
	});

	h.check(after.retries === 1, 'the collision was counted as one id retry');
	h.check(!!after.id && after.id !== before, 'a fresh id was taken (' + before + ' -> ' + after.id + ')');
	h.check(/^[0-9a-f]{5}$/.test(after.id), 'the replacement id has the same shape');
	h.check(after.open, 'the rebuilt peer registered with the signaling server');

	// and the retry is bounded — it must not rebuild forever against a server
	// that keeps saying no
	const bounded = await A.page.evaluate(async () => {
		let pc;
		window.__stores.peers.subscribe((p) => (pc = p))();
		for (let i = 0; i < 6; i++) {
			pc.registeredOn.clear();
			pc.peer.emit('error', { type: 'unavailable-id' });
			await new Promise((r) => setTimeout(r, 300));
		}
		return pc.idRetries;
	});
	h.check(bounded === 3, 'id retries stop at 3, then the user is told (got ' + bounded + ')');

	// the peer still works after the rebuild: a second page can dial it
	const B = await h.setupPage(browser, 'B');
	const live = await A.page.evaluate(() => {
		let pc;
		window.__stores.peers.subscribe((p) => (pc = p))();
		return pc.peer.id;
	});
	await (await h.openDial(B.page)).fill(live);
	await B.page.getByRole('button', { name: 'Connect', exact: true }).click();
	await h.approveButton(A.page).click({ timeout: 30000 });
	await h.eventually(
		() =>
			A.page.evaluate(() => {
				let pc;
				window.__stores.peers.subscribe((p) => (pc = p))();
				return pc.openedPeers.size;
			}),
		(n) => n >= 1,
		'a peer can still connect to the rebuilt session id',
		30000
	);

	await h.finish(browser);
});
