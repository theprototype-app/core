// 80a K3: the receiving-side lock gate, the clock-stamped tie-break and the whole held set in the
// handshake. Three peers: H hosts, E holds objects, F joins late and also plays the peer that sends
// hand-made messages down its own connections.
//
// 1. a late joiner learns EVERY object E holds (a multi-selection), with stamps (L5)
// 2. an edit of a held object from a non-holder is applied nowhere; the holder answers it
//    (`lockreject` + the object as it is) and the sender's copy is put back
// 3. a `lockreject` from a peer that does not hold the object does nothing
// 4. a claim dated back cannot take an object somebody holds
// 5. ten real races (E and F select one object at the same moment): every peer names the same
//    holder, the loser lets go (10/10)
//
// "Ignored" is checked behind a FENCE (lock-sender's): after the message under test F locks and
// releases FENCE on the same ordered connection, so once the receiver shows it the message before
// it has been handled.
const h = require('./helpers.cjs');

const RACES = 10;

const locks = (page) =>
	page.evaluate(() => new Promise((r) => window.__tp.test.v1.lockedObjects.subscribe((l) => r(l.map((x) => [...x])))()));
const toasts = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__tp.test.v1.toastStore.subscribe((t) => r(t.map((x) => (typeof x === 'string' ? x : x.text))))())
	);
const selection = (page) => page.evaluate(() => new Promise((r) => window.__tp.test.v1.selectedObjects.subscribe((s) => r([...s]))()));
const holderOn = (page, uuid) => page.evaluate((u) => window.__tp.test.v1.lockHeld.holderNow(u), uuid);
const posOf = (page, uuid) =>
	page.evaluate(
		(u) =>
			new Promise((r) =>
				window.__tp.test.v1.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', u);
					r(o ? o.position.toArray().map((n) => Math.round(n * 1000) / 1000) : null);
				})()
			),
		uuid
	);
/** @param {any[]} l @param {string} peer @param {string} uuid */
const has = (l, peer, uuid) => l.some((x) => x[0] === peer && x[1] === uuid);

/** raw message(s) from `from` straight down its open connection to `toId`, in ONE evaluate */
const sendRaw = (from, toId, msg) =>
	from.page.evaluate(
		([id, list]) => {
			/** @type {any} */ let p;
			window.__tp.test.v1.peers.subscribe((v) => (p = v))();
			const conn = p?.connections?.[id];
			if (!conn?.open) throw new Error('no open connection to ' + id);
			for (const m of list) conn.send(m);
		},
		[toId, Array.isArray(msg) ? msg : [msg]]
	);

// what F is missing, and why (a one-off red in a pc-slot run: F had the first boxes only)
const dump = (p, all) =>
	p.page.evaluate((all) => {
		const s = window.__tp.test.v1;
		let g, pcd, t, pc;
		s.objectsGroup.subscribe((x) => (g = x))();
		s.toastStore.subscribe((x) => (t = x))();
		s.peers.subscribe((x) => (pc = x))();
		try { s.connectionState?.pendingConnectDecision?.subscribe((x) => (pcd = x))(); } catch {}
		return {
			have: all.filter((u) => !!g?.getObjectByProperty('uuid', u)).length,
			children: g?.children.length,
			pending: pcd ?? null,
			open: Object.entries(pc?.connections ?? {}).filter(([, c]) => c?.open).map(([id]) => id.slice(0, 5)),
			toasts: (t ?? []).map((x) => (typeof x === 'string' ? x : x.text)).slice(-6),
			wire: (() => { try { return JSON.stringify(s.wireErrors?.wireErrors?.() ?? null).slice(0, 600); } catch (e) { return String(e); } })()
		};
	}, all);

h.run(async () => {
	const browser = await h.launch();
	const H = await h.setupPage(browser, 'H');
	const E = await h.setupPageQuiet(browser, 'E', [H]);
	await h.connect(E, H);

	const made = await H.page.evaluate(async (n) => {
		const s = window.__tp?.test.v1;
		for (let i = 0; i < n; i++) s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		s.objectActions.deselectObject();
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		return g.children.slice(-n).map((o) => o.uuid);
	}, 5 + RACES);
	const [X, Y, W, V, FENCE] = made;
	const RACE = made.slice(5);
	const holdsUuid = (page, uuid) =>
		page.evaluate((u) => new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe((g) => r(!!g?.getObjectByProperty('uuid', u)))()), uuid);
	await h.eventually(() => holdsUuid(E.page, made[made.length - 1]), (v) => v, 'E has every box');

	// --- 1. the whole held set reaches a late joiner, stamped ---------------------------
	await E.page.evaluate(([a, b]) => window.__tp.test.v1.objectActions.applySelectionSet([a, b]), [X, Y]);
	await h.eventually(() => locks(H.page), (l) => has(l, E.id, X) && has(l, E.id, Y), 'H sees E holding X and Y');
	{
		const l = await locks(H.page);
		h.check(l.filter((r) => r[0] === E.id).every((r) => typeof r[2] === 'number'), 'each row carries the moment E took the object');
	}
	const F = await h.setupPageQuiet(browser, 'F', [H, E]);
	await h.connect(F, H);
	await h.eventually(() => holdsUuid(F.page, made[made.length - 1]), (v) => v, 'F has the boxes', 90000);
	if (!(await holdsUuid(F.page, made[made.length - 1]))) {
		for (const p of [H, E, F]) console.log('[diag F boxes]', JSON.stringify(await dump(p, made)));
	}
	await h.eventually(() => locks(F.page), (l) => has(l, E.id, X) && has(l, E.id, Y), 'a late joiner sees EVERY object E holds, not just the primary');
	await h.eventually(
		() =>
			F.page.evaluate((id) => {
				/** @type {any} */ let p;
				window.__tp.test.v1.peers.subscribe((v) => (p = v))();
				return !!p?.connections?.[id]?.open;
			}, E.id),
		(v) => v,
		'F has its own connection to E (mesh)'
	);

	const fence = async (target, label) => {
		await sendRaw(F, target.id, { type: 'lock', uuid: FENCE, peerId: F.id });
		await h.eventually(() => locks(target.page), (l) => has(l, F.id, FENCE), 'fence reached ' + label);
		await sendRaw(F, target.id, { type: 'unlock', uuid: FENCE, peerId: F.id });
		await h.eventually(() => locks(target.page), (l) => !has(l, F.id, FENCE), 'fence released on ' + label);
	};

	// --- 2. an edit of a held object from a non-holder ----------------------------------
	const xBefore = await posOf(E.page, X);
	const forgedMove = { type: 'move', uuid: X, pos: [9, 9, 9], rot: [0, 0, 0], scale: [1, 1, 1] };
	const forgedName = { type: 'name', uuid: X, name: 'stolen' };
	// F edits its own copy, as a client that skipped the lock would, then sends the edits
	await F.page.evaluate((u) => {
		window.__tp.test.v1.objectsGroup.subscribe((g) => {
			const o = g?.getObjectByProperty('uuid', u);
			o?.position.set(9, 9, 9);
		})();
	}, X);
	await sendRaw(F, H.id, [forgedMove, forgedName]);
	await sendRaw(F, E.id, [forgedMove, forgedName]);
	await fence(H, 'H (edit)');
	await fence(E, 'E (edit)');
	h.check(JSON.stringify(await posOf(H.page, X)) === JSON.stringify(xBefore), 'H does not apply a move of an object E holds');
	h.check(JSON.stringify(await posOf(E.page, X)) === JSON.stringify(xBefore), 'the holder does not apply it either');
	{
		const name = await H.page.evaluate((u) => new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe((g) => r(g.getObjectByProperty('uuid', u)?.name))()), X);
		h.check(name !== 'stolen', 'nor a rename');
	}
	await h.eventually(() => toasts(F.page), (t) => t.some((x) => x.includes('is editing')), 'the sender hears from the holder that the change was not kept');
	if (!(await toasts(F.page)).some((x) => x.includes('is editing'))) for (const p of [H, E, F]) console.log('[diag reject]', JSON.stringify(await dump(p, made)));
	await h.eventually(() => posOf(F.page, X), (p) => JSON.stringify(p) === JSON.stringify(xBefore), "and the sender's copy is put back as the holder has it");
	// positive control: the holder's own edit applies everywhere
	await E.page.evaluate((u) => {
		const s = window.__tp.test.v1;
		s.objectsGroup.subscribe((g) => {
			const o = g.getObjectByProperty('uuid', u);
			o.position.set(2, 0, 2);
			s.peers.subscribe((p) => p.send({ type: 'move', uuid: u, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() }))();
		})();
	}, X);
	await h.eventually(() => posOf(H.page, X), (p) => p && p[0] === 2 && p[2] === 2, "the holder's own move applies");
	await h.eventually(() => posOf(F.page, X), (p) => p && p[0] === 2 && p[2] === 2, 'on every peer');

	// --- 3. a lockreject from a non-holder does nothing ----------------------------------
	await F.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), W);
	await h.eventually(() => locks(H.page), (l) => has(l, F.id, W), 'F holds W');
	await H.page.evaluate(([id, u]) => {
		/** @type {any} */ let p;
		window.__tp.test.v1.peers.subscribe((v) => (p = v))();
		p.connections[id].send({ type: 'lockreject', uuid: u });
	}, [F.id, W]);
	await sendRaw(E, F.id, { type: 'lockreject', uuid: W }).catch(() => {});
	await new Promise((r) => setTimeout(r, 1200));
	h.check((await selection(F.page)).includes(W), 'a lockreject from a peer that does not hold the object is ignored');
	h.check(await F.page.evaluate((u) => !!window.__tp.test.v1.lockHeld.myClaim(u), W), 'and the claim stands');

	// --- 4. a claim dated back cannot take an object somebody holds --------------------
	await sendRaw(F, H.id, { type: 'lock', uuid: X, uuids: [X], ats: [0], peerId: F.id });
	await sendRaw(F, E.id, { type: 'lock', uuid: X, uuids: [X], ats: [0], peerId: F.id });
	await h.eventually(() => locks(H.page), (l) => has(l, F.id, X), 'H keeps the dated-back claim as a contender');
	await new Promise((r) => setTimeout(r, 800));
	h.check((await holderOn(H.page, X)) === E.id, 'H: E still holds X');
	h.check((await holderOn(E.page, X)) === E.id, 'E: still holds X');
	h.check((await selection(E.page)).includes(X), 'E did not let go of X');
	// F lets go of its forged claim; back to W only
	await F.page.evaluate((u) => window.__tp.test.v1.objectActions.applySelectionSet([u]), W);
	await h.eventually(() => locks(H.page), (l) => !has(l, F.id, X), "F's claim is gone");
	await F.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
	await E.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
	await h.eventually(() => locks(H.page), (l) => !l.some((r) => r[0] === E.id || r[0] === F.id), 'nobody holds anything');

	// --- 5. ten real races ----------------------------------------------------------------
	let crossed = 0;
	let agreed = 0;
	for (let i = 0; i < RACES; i++) {
		const u = RACE[i];
		const at = Date.now() + 400;
		const fire = (page) =>
			page.evaluate(
				([uu, t]) =>
					new Promise((r) =>
						setTimeout(() => {
							const s = window.__tp.test.v1;
							s.objectActions.selectObject(uu);
							r(s.lockHeld.myClaim(uu)?.at ?? false);
						}, Math.max(0, t - Date.now()))
					),
				[u, at]
			);
		const [eTook, fTook] = await Promise.all([fire(E.page), fire(F.page)]);
		if (eTook && fTook) crossed++;
		console.log('[race ' + i + '] stamps E', eTook, 'F', fTook);
		const read = async () => {
			const [a, b, c] = await Promise.all([holderOn(H.page, u), holderOn(E.page, u), holderOn(F.page, u)]);
			const [se, sf] = await Promise.all([selection(E.page), selection(F.page)]);
			return { a, b, c, e: se.includes(u), f: sf.includes(u) };
		};
		const good = (v) => !!v.a && v.a === v.b && v.b === v.c && v.e !== v.f && (v.e ? v.a === E.id : v.a === F.id);
		await h.eventually(read, good, 'race ' + i + ': every peer names one holder and only the holder keeps it', 15000);
		if (good(await read())) agreed++;
		else
			for (const p of [H, E, F])
				console.log(
					'[diag race ' + i + ']',
					p === H ? 'H' : p === E ? 'E' : 'F',
					JSON.stringify(
						await p.page.evaluate((uu) => {
							const s = window.__tp.test.v1;
							let l, m, sel, t;
							s.lockedObjects.subscribe((x) => (l = x))();
							s.lockHeld.myLocks.subscribe((x) => (m = x))();
							s.selectedObjects.subscribe((x) => (sel = x))();
							s.toastStore.subscribe((x) => (t = x))();
							return {
								rows: l.filter((r) => r[1] === uu).map((r) => [String(r[0]).slice(0, 5), r[2]]),
								mine: m.has(uu) ? m.get(uu) : null,
								sel: sel.includes(uu),
								toasts: (t ?? []).map((x) => (typeof x === 'string' ? x : x.text)).slice(-3)
							};
						}, u)
					)
				);
		await E.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
		await F.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
		await h.eventually(() => locks(H.page), (l) => !l.some((r) => r[1] === u), 'race ' + i + ' released');
	}
	console.log(`races: ${agreed}/${RACES} agreed, ${crossed} truly crossed (both claimed before hearing the other)`);
	h.check(agreed === RACES, `ten races, one holder each, the same on every peer (${agreed}/${RACES})`);

	await h.finish(browser);
});
