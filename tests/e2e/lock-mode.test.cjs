// 80a K15: the room's lock mode. H hosts, E edits, F joins late.
//
// 1. Only the host sets it: E's setLockMode is refused, and a `lockmode` E sends is ignored.
// 2. "Lock only while editing": selecting takes nothing; E's first edit takes the object (H sees E
//    holding it); during E's burst H's edit is NOT applied anywhere; 3 s after E's last edit the
//    object is free and H's edit applies everywhere.
// 3. A late joiner (F) follows the host's mode (the handshake) and sees the same rule.
// 4. Back to "Lock while selected": selecting locks again.
const h = require('./helpers.cjs');

const holderOn = (page, uuid) => page.evaluate((u) => window.__tp.test.v1.lockHeld.holderNow(u), uuid);
const modeOn = (page) => page.evaluate(() => { let v; window.__tp.test.v1.lockMode.lockMode.subscribe((x) => (v = x))(); return v.mode; });
const posOf = (page, uuid) =>
	page.evaluate((u) => new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe((g) => r(g?.getObjectByProperty('uuid', u)?.position.x ?? null))()), uuid);
/** move `uuid` to x on `peer` the way the gizmo does: set it here, send the move */
const moveX = (peer, uuid, x) =>
	peer.page.evaluate(
		([u, xx]) => {
			const s = window.__tp.test.v1;
			s.objectsGroup.subscribe((g) => {
				const o = g.getObjectByProperty('uuid', u);
				o.position.x = xx;
				s.peers.subscribe((p) => p.send({ type: 'move', uuid: u, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() }))();
			})();
		},
		[uuid, x]
	);

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const E = await h.setupPageQuiet(browser, 'E', [H]);
	await h.connect(E, H);
	const X = await H.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		s.objectActions.deselectObject();
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		return g.children[g.children.length - 1].uuid;
	});
	await h.eventually(() => posOf(E.page, X), (p) => p !== null, 'E has the box');
	h.check((await modeOn(H.page)) === 'select' && (await modeOn(E.page)) === 'select', 'the default is "Lock while selected"');

	// --- 1. host only -----------------------------------------------------------------------------
	h.check((await E.page.evaluate(() => window.__tp.test.v1.lockMode.setLockMode('edit'))) === false, "a peer's setLockMode is refused");
	await E.page.evaluate((hid) => {
		/** @type {any} */ let p;
		window.__tp.test.v1.peers.subscribe((v) => (p = v))();
		p.connections[hid].send({ type: 'lockmode', mode: 'edit', at: Date.now() + 1e9 });
	}, H.id);
	await H.page.waitForTimeout(800);
	h.check((await modeOn(H.page)) === 'select', "a lockmode from a peer that is not the host is ignored");
	h.check(await H.page.evaluate(() => window.__tp.test.v1.lockMode.setLockMode('edit')), 'the host sets "Lock only while editing"');
	await h.eventually(() => modeOn(E.page), (m) => m === 'edit', 'and E follows');

	// --- 2. edit mode -----------------------------------------------------------------------------
	await E.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), X);
	await H.page.waitForTimeout(800);
	h.check(!(await holderOn(H.page, X)), 'selecting alone takes nothing');
	await moveX(E, X, 1);
	await h.eventually(() => holderOn(H.page, X), (v) => v === E.id, "E's first edit takes the box");
	await h.eventually(() => posOf(H.page, X), (x) => x === 1, "and E's edit applies");
	// H edits during E's burst (E keeps editing every second)
	const burst = (async () => {
		for (let i = 2; i <= 4; i++) {
			await new Promise((r) => setTimeout(r, 900));
			await moveX(E, X, i);
		}
	})();
	await new Promise((r) => setTimeout(r, 1300));
	await moveX(H, X, -5);
	await burst;
	await h.eventually(() => posOf(E.page, X), (x) => x === 4, "E's burst lands");
	h.check((await posOf(E.page, X)) !== -5, "H's edit during E's burst is not applied on E");
	await h.eventually(() => posOf(H.page, X), (x) => x === 4, "and H's copy is put back to E's");
	// 3 s after E's last edit the box is free
	await h.eventually(() => holderOn(H.page, X), (v) => !v, '3 s after the last edit the box is free', 8000);
	h.check((await E.page.evaluate(() => { let v; window.__tp.test.v1.selectedObjects.subscribe((x) => (v = x))(); return v; })).includes(X), 'E keeps its selection');
	await moveX(H, X, -5);
	await h.eventually(() => posOf(E.page, X), (x) => x === -5, "after the burst H's edit applies on E");
	await h.eventually(() => holderOn(E.page, X), (v) => !v, 'and frees again 3 s after');

	// --- 3. a late joiner follows -----------------------------------------------------------------
	const F = await h.setupPageQuiet(browser, 'F', [H, E]);
	await h.connect(F, H);
	await h.eventually(() => modeOn(F.page), (m) => m === 'edit', 'a late joiner follows the host\'s mode');
	await h.eventually(() => posOf(F.page, X), (p) => p !== null, 'F has the box');
	await F.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), X);
	await H.page.waitForTimeout(800);
	h.check(!(await holderOn(H.page, X)), 'F selecting takes nothing either');
	await F.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
	await E.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());

	// --- 4. back to "while selected" --------------------------------------------------------------
	h.check(await H.page.evaluate(() => window.__tp.test.v1.lockMode.setLockMode('select')), 'the host goes back to "Lock while selected"');
	await h.eventually(() => modeOn(F.page), (m) => m === 'select', 'everyone follows');
	await E.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), X);
	await h.eventually(() => holderOn(F.page, X), (v) => v === E.id, 'selecting locks again');

	await h.finish(browser);
});
