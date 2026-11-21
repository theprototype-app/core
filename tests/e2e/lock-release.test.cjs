// 80a K6: letting go. Two peers: H hosts, E holds.
//
// 1. Object list chips: E's row of the box says "Held by me", H's says "Held by E" (and the row's
//    reader name says it too).
// 2. Release from the row menu lets go everywhere.
// 3. Idle expiry (windows shortened through the debug hook: ask at 3 s, let go at 6 s): E is asked
//    "Still editing ...?"; Keep holding restarts the count; an edit restarts it too; no answer = let go.
// 4. Alone, nothing expires (a held object blocks nobody).
// 5. A healed link (the heal handshake fix4-net's paths end in) lets go of what was held across it,
//    on both sides, and the handshake carries an empty held set.
const h = require('./helpers.cjs');

const read = (page, name) => page.evaluate((n) => { let v; window.__tp.test.v1[n].subscribe((x) => (v = x))(); return Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? [...x] : x)) : v; }, name);
const toasts = (page) =>
	page.evaluate(() => new Promise((r) => window.__tp.test.v1.toastStore.subscribe((t) => r(t.map((x) => (typeof x === 'string' ? x : x.text))))()));
const holderOn = (page, uuid) => page.evaluate((u) => window.__tp.test.v1.lockHeld.holderNow(u), uuid);
const chip = (page, uuid) =>
	page.evaluate((u) => {
		const row = document.getElementById(u);
		const c = row?.querySelector('.held-chip');
		return { row: !!row, chip: c?.getAttribute('data-held') ?? null, text: c?.querySelector('.held-chip-text')?.textContent?.trim() ?? '', label: row?.getAttribute('aria-label') ?? '' };
	}, uuid);
const pressToast = (page, label) =>
	page.evaluate((l) => {
		let list = [];
		window.__tp.test.v1.toastStore.subscribe((t) => (list = t))();
		const t = [...list].reverse().find((x) => typeof x === 'object' && x?.actions?.some((a) => a.label === l));
		if (!t) return false;
		t.actions.find((a) => a.label === l).action();
		return true;
	}, label);

const shownName = (page, id) => page.evaluate((i) => window.__tp.test.v1.lockHeld.nameOf(i), id);

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H', { context: { viewport: { width: 1440, height: 900 } } });

	// --- 4 first: alone, a held object does not expire -------------------------------------------
	const solo = await H.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		s.lockIdle.setLockIdleWindows({ idleMs: 2500, askMs: 1500 });
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		return g.children[g.children.length - 1].uuid;
	});
	await H.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), solo);
	await H.page.waitForTimeout(4500);
	h.check((await read(H.page, 'selectedObjects')).includes(solo), 'alone, a selection is never let go for being idle');
	await H.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());

	const E = await h.setupPageQuiet(browser, 'E', [H], { context: { viewport: { width: 1440, height: 900 } } });
	await h.connect(E, H);
	const X = await H.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		s.objectActions.deselectObject();
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		box.name = 'Crate';
		s.peers.subscribe((p) => p.send({ type: 'name', uuid: box.uuid, name: 'Crate' }))();
		s.objectListClose.set(false);
		return box.uuid;
	});
	await E.page.evaluate(() => window.__tp.test.v1.objectListClose.set(false));
	await h.eventually(() => E.page.evaluate((u) => new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe((g) => r(g?.getObjectByProperty('uuid', u)?.name))()), X), (n) => n === 'Crate', 'E has the box');

	// --- 1. chips -------------------------------------------------------------------------------
	await E.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), X);
	await h.eventually(() => holderOn(H.page, X), (v) => v === E.id, 'H sees E holding the box');
	await h.eventually(() => chip(E.page, X), (c) => c.chip === 'me' && c.text === 'Held by me', 'E\'s row says "Held by me"');
	const eName = await shownName(H.page, E.id);
	await h.eventually(() => chip(H.page, X), (c) => c.chip === 'other' && c.text === 'Held by ' + eName, `H's row says "Held by ${eName}"`);
	h.check((await chip(H.page, X)).label.includes('held by ' + eName), 'and a screen reader hears it');

	// --- 2. Release from the row menu ------------------------------------------------------------
	const released = await E.page.evaluate((u) => {
		const s = window.__tp.test.v1;
		const items = s.objectMenu.flattenMenuItems ? s.objectMenu.flattenMenuItems(s.objectMenu.buildObjectMenuItems(u)) : s.objectMenu.buildObjectMenuItems(u);
		const rel = items.find((i) => i?.label === 'Release');
		if (!rel) return 'no Release row';
		rel.action();
		return 'ok';
	}, X);
	h.check(released === 'ok', `the row menu offers Release (${released})`);
	await h.eventually(() => holderOn(H.page, X), (v) => !v, 'Release lets go on the other peer');
	h.check(!(await read(E.page, 'selectedObjects')).includes(X), 'and on the holder');
	await h.eventually(() => chip(H.page, X), (c) => !c.chip, 'the chip is gone');

	// --- 3. idle expiry ---------------------------------------------------------------------------
	await E.page.evaluate(() => window.__tp.test.v1.lockIdle.setLockIdleWindows({ idleMs: 6000, askMs: 3000 }));
	await E.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), X);
	await h.eventually(() => holderOn(H.page, X), (v) => v === E.id, 'E takes the box again');
	await h.eventually(() => toasts(E.page), (t) => t.some((x) => x.startsWith('Still editing "Crate"?')), 'E is asked whether it is still editing', 8000);
	h.check(await pressToast(E.page, 'Keep holding'), 'and can answer Keep holding');
	await E.page.waitForTimeout(4500);
	h.check((await holderOn(H.page, X)) === E.id, 'Keep holding: still held past the first deadline');
	// an edit restarts the count too
	await E.page.evaluate((u) => {
		const s = window.__tp.test.v1;
		s.objectsGroup.subscribe((g) => {
			const o = g.getObjectByProperty('uuid', u);
			o.position.x += 0.5;
			s.peers.subscribe((p) => p.send({ type: 'move', uuid: u, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() }))();
		})();
	}, X);
	await E.page.waitForTimeout(4000);
	h.check((await holderOn(H.page, X)) === E.id, 'an edit restarts the count');
	await h.eventually(() => holderOn(H.page, X), (v) => !v, 'no answer: E lets go at the deadline', 12000);
	h.check(!(await read(E.page, 'selectedObjects')).includes(X), 'E\'s selection is let go');
	await h.eventually(() => toasts(E.page), (t) => t.some((x) => x.startsWith('You let go of "Crate"')), 'and E is told why');
	await E.page.evaluate(() => window.__tp.test.v1.lockIdle.setLockIdleWindows({}));

	// --- 5. a healed link lets go on both sides ---------------------------------------------------
	const Y = await H.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		s.objectActions.deselectObject();
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		return g.children[g.children.length - 1].uuid;
	});
	await h.eventually(() => E.page.evaluate((u) => new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe((g) => r(!!g?.getObjectByProperty('uuid', u)))()), Y), (v) => v, 'E has the second box');
	await E.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), X);
	await H.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), Y);
	await h.eventually(() => holderOn(H.page, X), (v) => v === E.id, 'premise: E holds X');
	await h.eventually(() => holderOn(E.page, Y), (v) => v === H.id, 'premise: H holds Y');
	// the heal handshake, as reconnectDial / the inbound adoption / adoptRelink send it
	await E.page.evaluate((hid) => {
		/** @type {any} */ let p;
		window.__tp.test.v1.peers.subscribe((v) => (p = v))();
		p.sendHandshake(p.connections[hid], hid, true, p.peer.id, { heal: true });
	}, H.id);
	await H.page.evaluate((eid) => {
		/** @type {any} */ let p;
		window.__tp.test.v1.peers.subscribe((v) => (p = v))();
		p.sendHandshake(p.connections[eid], eid, true, p.peer.id, { heal: true });
	}, E.id);
	await h.eventually(() => holderOn(H.page, X), (v) => !v, 'after the heal, X is free on H');
	await h.eventually(() => holderOn(E.page, Y), (v) => !v, 'and Y is free on E');
	h.check(!(await read(E.page, 'selectedObjects')).includes(X) && !(await read(H.page, 'selectedObjects')).includes(Y), 'both let go of their selection');
	const hName = await shownName(E.page, H.id);
	await h.eventually(() => toasts(E.page), (t) => t.some((x) => x.startsWith('Connection to ' + hName + ' came back')), 'and say why');
	// it is a release, not a ban: selecting again takes it
	await E.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), X);
	await h.eventually(() => holderOn(H.page, X), (v) => v === E.id, 'selecting again takes it back');

	await h.finish(browser);
});
