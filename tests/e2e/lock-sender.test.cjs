// Lock messages act for the connection they arrive on (lockTrust.js). Three peers: H hosts,
// E holds an object, F sends hand-made messages down its own connections naming someone else.
// None of them may move a lock that is not F's; F's own messages still work, and so does the
// ordinary request / release between real holders.
//
// "Ignored" is checked behind a FENCE: after the message under test F sends an ordinary lock of
// its own on the same ordered connection, so once the receiver shows the fence the message
// before it has been handled.
const h = require('./helpers.cjs');

const locks = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.lockedObjects.subscribe((l) => r(l.map((x) => [...x])))())
	);

const toasts = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.toastStore.subscribe((t) => r(t.map((x) => (typeof x === 'string' ? x : x.text))))()
			)
	);

/** @param {any[]} l @param {string} peer @param {string} uuid */
const has = (l, peer, uuid) => l.some((x) => x[0] === peer && x[1] === uuid);

/** raw message(s) from `from` straight down its open connection to `toId`, in ONE evaluate */
const sendRaw = (from, toId, msg) =>
	from.page.evaluate(
		([id, list]) => {
			/** @type {any} */ let p;
			window.__stores.peers.subscribe((v) => (p = v))();
			const conn = p?.connections?.[id];
			if (!conn?.open) throw new Error('no open connection to ' + id);
			for (const m of list) conn.send(m);
		},
		[toId, Array.isArray(msg) ? msg : [msg]]
	);

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const E = await h.setupPageQuiet(browser, 'E', [H]);
	await h.connect(E, H);

	// H makes four boxes: X (E will hold it), Y, Z, and FENCE
	const [X, Y, Z, FENCE] = await H.page.evaluate(async () => {
		const s = window.__stores;
		for (let i = 0; i < 4; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 300));
		s.objectActions.deselectObject();
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		return g.children.slice(-4).map((o) => o.uuid);
	});
	const holdsUuid = (page, uuid) =>
		page.evaluate(
			(u) => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(!!g?.getObjectByProperty('uuid', u)))()),
			uuid
		);
	await h.eventually(() => holdsUuid(E.page, FENCE), (v) => v, 'E has the four boxes');

	await E.page.evaluate((u) => window.__stores.objectActions.selectObject(u), X);
	await h.eventually(() => locks(H.page), (l) => has(l, E.id, X), 'H sees E holding X');

	// a late joiner: the host's table still reaches it whole
	const F = await h.setupPageQuiet(browser, 'F', [H, E]);
	await h.connect(F, H);
	await h.eventually(() => locks(F.page), (l) => has(l, E.id, X), 'a late joiner learns E holds X (host table)');
	await h.eventually(() => holdsUuid(F.page, FENCE), (v) => v, 'F has the boxes', 30000);
	await h.eventually(
		() =>
			F.page.evaluate((id) => {
				/** @type {any} */ let p;
				window.__stores.peers.subscribe((v) => (p = v))();
				return !!p?.connections?.[id]?.open;
			}, E.id),
		(v) => v,
		'F has its own connection to E (mesh)'
	);

	/** F locks FENCE (and lets go) down its conn to `target`: everything sent before it was handled */
	const fence = async (target, label) => {
		await sendRaw(F, target.id, { type: 'lock', uuid: FENCE, peerId: F.id });
		await h.eventually(() => locks(target.page), (l) => has(l, F.id, FENCE), 'fence reached ' + label);
		await sendRaw(F, target.id, { type: 'unlock', uuid: FENCE, peerId: F.id });
		await h.eventually(() => locks(target.page), (l) => !has(l, F.id, FENCE), 'fence released on ' + label);
	};

	// --- 1. an unlock naming E does not release E's lock ---------------------------------
	await sendRaw(F, H.id, { type: 'unlock', peerId: E.id, uuid: X });
	await fence(H, 'H (unlock)');
	h.check(has(await locks(H.page), E.id, X), "an unlock naming another peer leaves that peer's lock");

	// --- 2. a lock naming E is F's own lock, and E's set is untouched --------------------
	await sendRaw(F, H.id, { type: 'lock', uuid: Y, peerId: E.id });
	await h.eventually(() => locks(H.page), (l) => has(l, F.id, Y), 'a lock is credited to the peer that sent it');
	{
		const l = await locks(H.page);
		h.check(!has(l, E.id, Y), 'a lock naming another peer does not lock in their name');
		h.check(has(l, E.id, X), "and does not replace that peer's own lock set");
	}
	await sendRaw(F, H.id, { type: 'unlock', peerId: F.id, uuid: Y });
	await h.eventually(() => locks(H.page), (l) => !has(l, F.id, Y), "the sender's own unlock still works");

	// --- 3. a lock table from a non-host speaks only for its sender ----------------------
	const forged = [X, Y, Z].flatMap((u) => [[E.id, u], ['ghost-peer', u], [H.id, u]]);
	await sendRaw(F, H.id, { type: 'locked', lockeditems: forged });
	await sendRaw(F, E.id, { type: 'locked', lockeditems: forged });
	await fence(H, 'H (table)');
	await fence(E, 'E (table)');
	{
		const lh = await locks(H.page);
		h.check(!lh.some((x) => x[0] === 'ghost-peer'), 'H: no rows for a peer that is not the sender');
		h.check(!has(lh, E.id, Y) && !has(lh, E.id, Z), "H: no rows in E's name from F");
		const le = await locks(E.page);
		h.check(!le.some((x) => x[0] === 'ghost-peer'), 'E: no rows for a peer that is not the sender');
		h.check(!has(le, H.id, Y) && !has(le, H.id, Z), "E: no rows in the host's name from F");
	}

	// --- 4. a sender that may not lock adds nothing, even for itself ---------------------
	await H.page.evaluate((fid) => {
		const allowed = new Set(['sent', 'info', 'ping', 'camera', 'specator']);
		window.__stores.cloudHooks.setCapabilityProvider((peer, type) => peer !== fid || allowed.has(type));
	}, F.id);
	await sendRaw(F, H.id, { type: 'locked', lockeditems: [[F.id, Z]] });
	await new Promise((r) => setTimeout(r, 1500)); // no fence: F's lock is gated on H right now
	h.check(!has(await locks(H.page), F.id, Z), "a viewer's lock table is not applied");
	await H.page.evaluate(() => window.__stores.cloudHooks.setCapabilityProvider(null));
	// positive control: the same table from an editor applies
	await sendRaw(F, H.id, { type: 'locked', lockeditems: [[F.id, Z]] });
	await h.eventually(() => locks(H.page), (l) => has(l, F.id, Z), "an editor's own table row applies");
	await sendRaw(F, H.id, { type: 'unlock', peerId: F.id, uuid: Z });
	await h.eventually(() => locks(H.page), (l) => !has(l, F.id, Z), 'and its unlock releases it');

	// --- 5. a control request names its connection, once per 3 s ------------------------
	const asks = (t) => t.filter((x) => x.includes('asks to control'));
	const before = asks(await toasts(E.page)).length;
	// one evaluate, so the five leave inside the 3 s window however slow the driver is
	await sendRaw(F, E.id, Array.from({ length: 5 }, () => ({ type: 'lockrequest', uuid: X, from: H.id, name: 'The Host' })));
	await fence(E, 'E (requests)');
	{
		const now = asks(await toasts(E.page));
		h.check(now.length === before + 1, `five requests in a row show one ask (got ${now.length - before})`);
		h.check(!now.some((x) => x.includes('The Host')), 'the ask does not use the name in the payload');
	}

	// --- 6. only the holder can deny -------------------------------------------------------
	await H.page.evaluate((u) => window.__stores.lockControl.requestControl(u), X);
	await h.eventually(
		() => toasts(E.page),
		(t) => asks(t).length >= before + 2,
		"the holder gets the host's real request"
	);
	await sendRaw(F, H.id, { type: 'lockdenied', uuid: X, to: H.id });
	await fence(H, 'H (deny)');
	h.check(!(await toasts(H.page)).some((x) => x.includes('denied')), 'a deny from a non-holder is ignored');

	// the holder's own answer still goes through (the old payload shape, as any peer sends it)
	await E.page.evaluate((u) => window.__stores.lockControl.releaseLock(u), X);
	await h.eventually(
		() => H.page.evaluate(() => new Promise((r) => window.__stores.selectedObject.subscribe((s) => r(s?.uuid))())),
		(u) => u === X,
		"the holder's release hands the object to the requester"
	);
	await h.eventually(() => locks(F.page), (l) => has(l, H.id, X) && !has(l, E.id, X), 'and every peer sees the handover');

	await h.finish(browser);
});
