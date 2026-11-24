// A HOST'S RELOAD KEEPS ITS SESSION, AND A RETURNING LINK PROVES ITSELF.
// Before: when the host reloaded, every guest was left alone (it never dialled back), and a guest's own
// reload was let back in on its peer id alone. Now the host gives each guest a secret of its own over that
// guest's link; a returning link (either side reloaded) opens with a challenge each way before anything else
// crosses it. The host comes back on its own id and its guests dial it; a page that cannot answer is a
// stranger (the approval card), and a guest sends nothing to a host id that cannot answer.
// Counterfactual on v1.75.0: 1.x red (nobody relinks after the host reload), 3.2/3.3 red (a page on a
// reloading guest's id is admitted with no card and receives the host scene).
const h = require('./helpers.cjs');
const crypto = require('crypto');

const PROOF = new Set(['rjc', 'rjp', 'rjs']);

const stateOf = (p) =>
	p.page
		.evaluate(() => {
			const S = window.__tp.test.v1;
			let pr, host, g, cards, decision = null;
			S.peers.subscribe((v) => (pr = v))();
			S.connectionState?.pendingConnectDecision?.subscribe?.((v) => (decision = v))?.();
			S.connectionState.sessionHost.subscribe((v) => (host = v))();
			S.objectsGroup.subscribe((x) => (g = x))();
			S.pendingApprovals?.subscribe((x) => (cards = x))();
			return {
				id: pr?.peer?.id ?? null,
				open: [...(pr?.openedPeers ?? [])],
				host: host ?? null,
				objects: (g?.children ?? []).map((c) => c.uuid),
				cards: (cards ?? []).map((c) => c.peerId),
				// the first-contact question (save or dismiss your unsaved scene), open or on screen
				asked: !!decision || !!document.querySelector('#confirm-dialog-save, #confirm-dialog-dismiss')
			};
		})
		.catch((e) => ({ error: String(e?.message ?? e).split('\n')[0], open: [], objects: [], cards: [] }));

const notes = (p, since) =>
	p.page
		.evaluate((t) => {
			let l;
			window.__tp.test.v1.notifications.subscribe((v) => (l = v))();
			return (l ?? []).filter((n) => n.ts >= t).map((n) => n.text);
		}, since)
		.catch(() => []);

/** a reload with a patient boot wait, then the restore question answered as asked */
const reload = async (p, choice) => {
	const t = Date.now();
	await p.page.reload({ waitUntil: 'domcontentloaded' });
	// a reloaded page on a loaded e2e box boots in 60-120 s (software GL, three pages): wait long, and on a miss say how far it got
	const up = await p.page
		.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.moduleSDK, null, { timeout: 180000, polling: 1000 })
		.then(() => true)
		.catch(() => false);
	if (!up) {
		const where = await p.page.evaluate(() => ({ ready: document.readyState, tp: !!window.__tp, v1: !!window.__tp?.test?.v1 })).catch((e) => String(e));
		throw new Error(`${p.name ?? 'page'} did not boot within 180 s of its reload: ${JSON.stringify(where)}`);
	}
	console.log(`  (${p.name ?? 'page'} booted ${((Date.now() - t) / 1000).toFixed(0)} s after its reload)`);
	return answerRestore(p, choice);
};

/** the restore question, answered as asked, pressing again while the page is too busy to take the press (h.answerRestore
 * presses once and waits 60 s): returns whether one was asked; throws with what the page showed if it never closes */
const answerRestore = async (p, choice) => {
	const ask = () =>
		p.page
			.evaluate(() => {
				let v;
				window.__tp.test.v1.autosave.restoreAvailable.subscribe((x) => (v = x))();
				return { offered: !!v, modal: !!document.querySelector('#restore-session-modal[open]'), button: !!document.querySelector('#restore-session-restore') };
			})
			.catch((e) => ({ offered: false, modal: false, button: false, error: String(e).slice(0, 120) }));
	const offered = await p.page
		.waitForFunction(() => {
			let v;
			window.__tp?.test.v1?.autosave?.restoreAvailable?.subscribe((x) => (v = x))();
			return !!v;
		}, null, { timeout: 30000, polling: 250 })
		.then(() => true)
		.catch(() => false);
	if (!offered) return false;
	const sel = choice === 'restore' ? '#restore-session-restore' : '#restore-session-dismiss';
	let last = await ask();
	for (const until = Date.now() + 150000; Date.now() < until; ) {
		if (!last.offered && !last.modal) return true;
		await p.page.evaluate((q) => /** @type {HTMLElement | null} */ (document.querySelector(q))?.click(), sel).catch(() => {});
		await p.page.waitForTimeout(3000);
		last = await ask();
	}
	throw new Error(`${p.name ?? 'page'}: the restore question did not close (${choice}): ${JSON.stringify(last)}`);
};

/** record every message a page receives (decoded), per sender, from now on */
const tapInbound = (p) =>
	p.page.evaluate(() => {
		const S = window.__tp.test.v1;
		let pr;
		S.peers.subscribe((v) => (pr = v))();
		window.__rx = window.__rx ?? {};
		const tap = (c) => {
			if (c.__rxTap) return;
			c.__rxTap = true;
			c.on('data', (d) => (window.__rx[c.peer] = window.__rx[c.peer] ?? []).push(String(d?.type ?? typeof d)));
		};
		pr.peer.on('connection', tap);
		for (const list of Object.values(pr.peer.connections ?? {})) for (const c of list) tap(c);
		const dial = pr.peer.connect.bind(pr.peer);
		pr.peer.connect = (...a) => {
			const c = dial(...a);
			if (c) tap(c);
			return c;
		};
	});
/** record every message a page SENDS to `to` from now on, as it leaves (inside the app's own send gate: a dial's conn is
 * wrapped before the app wires it, so the app's gate calls this as its raw send) */
const tapOutbound = (p, to) =>
	p.page.evaluate((target) => {
		let pr;
		window.__tp.test.v1.peers.subscribe((v) => (pr = v))();
		window.__tx = window.__tx ?? {};
		const dial = pr.peer.connect.bind(pr.peer);
		pr.peer.connect = (...a) => {
			const c = dial(...a);
			if (c && a[0] === target && !c.__txTap) {
				c.__txTap = true;
				const raw = c.send.bind(c);
				c.send = (d, ...rest) => {
					(window.__tx[target] = window.__tx[target] ?? []).push(String(d?.type ?? typeof d));
					return raw(d, ...rest);
				};
			}
			return c;
		};
	}, to);
const sentBy = (p, to) => p.page.evaluate((t) => (window.__tx ?? {})[t] ?? [], to).catch(() => []);
const received = (p, from) => p.page.evaluate((f) => (window.__rx ?? {})[f] ?? [], from).catch(() => []);

const secretOf = (p, host) =>
	p.page.evaluate((hid) => {
		let pr;
		window.__tp.test.v1.peers.subscribe((v) => (pr = v))();
		return pr?.rj?.hostSecret?.(hid) ?? null;
	}, host);

/** on a red: the [net] lines of a page's diagnostics (the bundle is redacted; it never holds a secret) */
const netLines = async (p, label) => {
	const t = await p.page.evaluate(() => window.__tp.test.v1.diagnostics.bundleText()).catch((e) => 'ERR ' + e);
	console.log('---- [net] ' + label);
	for (const l of String(t).split('\n')) if (/\[net\]/.test(l)) console.log('  ' + l.trim().slice(0, 300));
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	A.name = 'A';
	await A.page.evaluate(() => {
		const S = window.__tp.test.v1;
		S.commandsHandler.sceneCommand('/create box');
		S.commandsHandler.sceneCommand('/create sphere');
		S.objectActions.deselectObject();
	});
	const B = await h.setupPage(browser, 'B');
	B.name = 'B';
	await h.connect(B, A);
	const D = await h.setupPage(browser, 'D');
	D.name = 'D';
	await h.connect(D, A);
	const hostObjects = (await stateOf(A)).objects;
	h.check(hostObjects.length === 2, `premise: the host's scene holds two objects (${hostObjects.length})`);
	for (const p of [B, D]) await h.eventually(() => stateOf(p), (s) => s.objects.length === 2 && s.host === A.id, `premise: ${p.name} joined A with its scene`, 30000);
	await h.eventually(() => secretOf(B, A.id), (s) => !!s, '0.1 the host gave B a secret of its own', 15000);
	const firstSecret = await secretOf(B, A.id);
	const dSecret = await secretOf(D, A.id);
	h.check(!!dSecret && dSecret !== firstSecret, '0.2 and D a different one');

	// ---- 0.3 the secret never reaches the diagnostics bundle ----
	const bundles = await Promise.all([A, B].map((p) => p.page.evaluate(() => window.__tp.test.v1.diagnostics.bundleText()).catch(() => '')));
	h.check(bundles.every((t) => t.length > 0 && !t.includes(firstSecret) && !t.includes(dSecret)), '0.3 no secret in either diagnostics bundle');

	// ---- 1. the host reloads: restore accepted, then dismissed, then a quick second reload ----
	for (const [i, choice] of /** @type {const} */ ([['a', 'restore'], ['b', 'dismiss'], ['c', 'restore']])) {
		await A.page.evaluate(() => window.__tp.test.v1.autosave.saveNow());
		const t0 = Date.now();
		await reload(A, choice);
		const a = await stateOf(A);
		h.check(a.id === A.id, `1${i}.1 (${choice}) the host is back on its own id (${a.id})`);
		for (const p of [B, D]) {
			await h.eventually(() => stateOf(p), (s) => s.open.includes(A.id) && s.host === A.id, `1${i}.2 ${p.name} is linked to the host again`, 90000);
		}
		await h.eventually(() => stateOf(A), (s) => s.open.includes(B.id) && s.open.includes(D.id), `1${i}.3 the host has both guests`, 30000);
		const aNow = await stateOf(A);
		if (!(aNow.open.includes(B.id) && aNow.open.includes(D.id))) for (const [p, n] of [[A, 'A'], [B, 'B'], [D, 'D']]) await netLines(p, n);
		const cards = (await stateOf(A)).cards;
		h.check(cards.length === 0, `1${i}.4 with no approval card (${JSON.stringify(cards)})`);
		if (cards.length) for (const [p, n] of [[A, 'A'], [B, 'B'], [D, 'D']]) await netLines(p, n);
		const bNow = (await stateOf(B)).objects;
		h.check(new Set(bNow).size === bNow.length && hostObjects.every((u) => bNow.includes(u)), `1${i}.5 B keeps the scene, no duplicates (${bNow.length})`);
		// the host holds the session's scene exactly once: after a Restore (never a restore laid over what came back) and
		// after a Dismiss (its guests hand it back, whether they came back before or after the answer)
		await h.eventually(
			() => stateOf(A).then((s) => s.objects),
			(o) => new Set(o).size === o.length && hostObjects.every((u) => o.includes(u)),
			`1${i}.8 (${choice}) the host holds the session's scene, no duplicates`,
			30000
		);
		for (const p of [B, D]) {
			const s = await stateOf(p);
			h.check(!s.asked, `1${i}.9 ${p.name} is not asked to save or dismiss its scene`);
		}
		const aAfter = (await stateOf(A)).objects;
		if (!hostObjects.every((u) => aAfter.includes(u))) for (const [p, n] of [[A, 'A'], [B, 'B']]) await netLines(p, n);
		if (!hostObjects.every((u) => aAfter.includes(u)))
			for (const [p, n] of [[A, 'A'], [B, 'B'], [D, 'D']])
				console.log(
					`  ${n}: ` +
						JSON.stringify(
							await p.page
								.evaluate(() => {
									const S = window.__tp.test.v1;
									let t, sc;
									S.toastStore?.subscribe((v) => (t = v))();
									S.currentScene?.subscribe?.((v) => (sc = v))();
									return { toasts: (t ?? []).map((x) => `${x.id ?? ''}: ${String(x.text).slice(0, 140)}`), scene: sc ?? null, objects: (S.objectsGroup && (() => { let g; S.objectsGroup.subscribe((x) => (g = x))(); return g?.children.length; })()) };
								})
								.catch((e) => String(e).slice(0, 120))
						)
				);
		const told = await notes(B, t0);
		h.check(told.some((t) => /is reloading/.test(t)) && !told.some((t) => /disconnected$/.test(t)), `1${i}.6 B was told the host is reloading, not that it left (${JSON.stringify(told)})`);
		await h.eventually(() => secretOf(B, A.id), (s) => !!s && s !== firstSecret, `1${i}.7 and holds a fresh secret`, 15000);
	}

	// ---- 2. another page takes the host's id while the host is away ----
	// premise: B's roster holds D before it goes (the toast is only for someone B knows)
	const rosterOf = (p) =>
		p.page
			.evaluate(() => {
				let u;
				window.__tp.test.v1.userdata.subscribe((v) => (u = v))();
				return (u ?? []).map((r) => `${r[0]}:${r[1] || ''}`);
			})
			.catch((e) => [String(e).slice(0, 80)]);
	await h.eventually(() => rosterOf(B), (r) => r.some((x) => x.startsWith(D.id + ':')), "premise: B's people list has D after the host's reloads", 20000);
	const tGone = Date.now();
	await h.closePeer(D); // D leaves for good (its goodbye is not a reload)
	// the toast names D as B knows it (its roster name, "Guest 2" for a page with no name set), never by its id
	const dId = String(D.id).toLowerCase();
	await h.eventually(
		() => notes(B, tGone),
		(n) => n.some((t) => /^.+ disconnected$/.test(t) && !t.toLowerCase().includes(dId) && !t.toLowerCase().includes(dId.slice(0, 5))),
		'2.0 a plain leave is said by NAME, not by id',
		60000
	);
	await tapOutbound(B, A.id);
	await A.page.goto('about:blank'); // the host's page goes (its goodbye says it may come back)
	await h.eventually(() => stateOf(B), (s) => !s.open.includes(A.id), 'premise: A is gone from B', 20000);
	const tImp = Date.now();
	const fake = crypto.randomBytes(32).toString('base64');
	const E = await h.setupPage(browser, 'E', {
		init: [
			(arg) => {
				if (sessionStorage.getItem('e2e-seeded')) return;
				sessionStorage.setItem('e2e-seeded', '1');
				sessionStorage.setItem('tp:hostrejoin', JSON.stringify({ id: arg.id, at: Date.now(), guests: { [arg.b]: { s: arg.s } } }));
				// tap what arrives from the FIRST link on: B dials as soon as this id is registered, which is
				// before setupPage hands the page back (the same tap as tapInbound, installed from boot)
				window.__rx = window.__rx ?? {};
				const tap = (c) => {
					if (!c || c.__rxTap) return;
					c.__rxTap = true;
					c.on('data', (d) => (window.__rx[c.peer] = window.__rx[c.peer] ?? []).push(String(d?.type ?? typeof d)));
				};
				const seen = new WeakSet();
				const poll = setInterval(() => {
					try {
						let pr;
						window.__tp?.test?.v1?.peers?.subscribe((v) => (pr = v))();
						const peer = pr?.peer;
						if (!peer || seen.has(peer)) return;
						seen.add(peer);
						peer.on('connection', tap);
						for (const list of Object.values(peer.connections ?? {})) for (const c of list) tap(c);
					} catch {
						/* not booted yet */
					}
				}, 20);
				setTimeout(() => clearInterval(poll), 300000);
			},
			{ id: A.id, b: B.id, s: fake }
		]
	});
	h.check(E.id === A.id || (await stateOf(E)).id === A.id, `2.1 premise: the other page holds the host's id (${(await stateOf(E)).id})`);
	await tapInbound(E);
	await h.eventually(() => notes(B, tImp), (n) => n.some((t) => /Could not verify the host\. Join again with the invite\./.test(t)), '2.2 B refuses it: "Could not verify the host"', 90000);
	const got = await sentBy(B, A.id);
	const content = got.filter((t) => !PROOF.has(t));
	h.check(got.length > 0 && content.length === 0, `2.3 B sent the other page nothing but the exchange (${JSON.stringify(got)})`);
	const b2 = await stateOf(B);
	h.check(!b2.open.includes(A.id) && b2.host !== A.id, `2.4 and is not in its session (${JSON.stringify({ open: b2.open, host: b2.host })})`);
	const dials = got.filter((t) => t === 'rjc').length;
	await E.page.waitForTimeout(20000);
	h.check((await sentBy(B, A.id)).filter((t) => t === 'rjc').length === dials, '2.5 and does not dial it again');
	h.check((await stateOf(E)).objects.length === 0, '2.6 the other page received no scene');
	await h.closePeer(E);

	// ---- 3. another page takes a reloading guest's id ----
	const H = await h.setupPage(browser, 'H');
	H.name = 'H';
	await H.page.evaluate(() => {
		const S = window.__tp.test.v1;
		S.commandsHandler.sceneCommand('/create box');
		S.objectActions.deselectObject();
	});
	const G = await h.setupPage(browser, 'G');
	await h.connect(G, H);
	await h.eventually(() => secretOf(G, H.id), (s) => !!s, 'premise: G holds a secret from H', 30000);
	const gid = G.id;
	await G.page.goto('about:blank'); // G's page goes (a reload goodbye) and does not come back
	await h.eventually(() => stateOf(H), (s) => !s.open.includes(gid), 'premise: G gone from H', 20000);
	for (const [k, withSecret] of /** @type {const} */ ([['a', false], ['b', true]])) {
		const C = await h.setupPage(browser, 'C' + k, {
			init: [
				(arg) => {
					if (sessionStorage.getItem('e2e-seeded')) return;
					sessionStorage.setItem('e2e-seeded', '1');
					const rec = { id: arg.id, host: arg.host, at: Date.now() };
					if (arg.s) rec.s = arg.s;
					sessionStorage.setItem('tp:rejoin', JSON.stringify(rec));
				},
				{ id: gid, host: H.id, s: withSecret ? crypto.randomBytes(32).toString('base64') : null }
			]
		});
		h.check((await stateOf(C)).id === gid, `3${k}.1 premise: the page holds G's id ${withSecret ? '(and a made-up secret)' : '(no secret)'}`);
		if (!withSecret) {
			await h.eventually(() => stateOf(H), (s) => s.cards.includes(gid) || s.open.includes(gid), `3${k}.2 H hears from it`, 45000);
			const hs = await stateOf(H);
			h.check(!hs.open.includes(gid) && hs.cards.includes(gid), `3${k}.3 H shows an approval card, no silent admit (${JSON.stringify({ open: hs.open, cards: hs.cards })})`);
		} else {
			// a page holding a made-up secret claims to come back: H proves itself first, the page cannot check that and
			// stops (it never answers), so H lets nothing in; a card is fine too (a client that answers garbage gets one)
			await C.page.waitForTimeout(30000);
			const hs = await stateOf(H);
			h.check(!hs.open.includes(gid), `3${k}.2 H does not let it in (${JSON.stringify({ open: hs.open, cards: hs.cards })})`);
			const told = await notes(C, 0);
			h.check(told.some((t) => /Could not verify the host/.test(t)), `3${k}.3 the page could not check H and stopped (${JSON.stringify(told)})`);
		}
		await C.page.waitForTimeout(3000);
		h.check((await stateOf(C)).objects.length === 0, `3${k}.4 and it received no scene`);
		await h.closePeer(C);
		// a card stays after its dialer's page went (the pre-existing card rule, out of scope here): note it, then H turns it down
		// (else the next connect's Approve press would answer this stale card instead of K's)
		const stale = (await stateOf(H)).cards.includes(gid);
		console.log(`  note: 3${k}.5 the card ${stale ? 'is still shown after the page went' : 'went with the page'}`);
		if (stale) await H.page.evaluate((id) => window.__tp.test.v1.peerApproval.denyPeer(id), gid).catch((e) => console.log('  deny failed: ' + e));
		await h.eventually(() => stateOf(H), (s) => !s.cards.includes(gid), `3${k}.5 premise: no card left on H`, 15000);
	}

	// ---- 4. a removed guest's old secret brings nothing back ----
	const K = await h.setupPage(browser, 'K');
	await h.connect(K, H);
	await h.eventually(() => secretOf(K, H.id), (s) => !!s, 'premise: K holds a secret from H', 30000);
	const kSecret = await secretOf(K, H.id);
	const kid = K.id;
	await H.page.waitForFunction(() => !!window.__tp?.test.v1?.peerModeration?.removePeer, null, { timeout: 30000 });
	await H.page.evaluate((id) => window.__tp.test.v1.peerModeration.removePeer(id), kid);
	await h.eventually(() => stateOf(H), (s) => !s.open.includes(kid), 'premise: K removed', 20000);
	await K.page.goto('about:blank');
	const K2 = await h.setupPage(browser, 'K2', {
		init: [
			(arg) => {
				if (sessionStorage.getItem('e2e-seeded')) return;
				sessionStorage.setItem('e2e-seeded', '1');
				sessionStorage.setItem('tp:rejoin', JSON.stringify({ id: arg.id, host: arg.host, at: Date.now(), s: arg.s }));
			},
			{ id: kid, host: H.id, s: kSecret }
		]
	});
	await K2.page.waitForTimeout(15000);
	const h4 = await stateOf(H);
	h.check(!h4.open.includes(kid), `4.1 the removed guest with its old secret is not let back in (${JSON.stringify({ open: h4.open, cards: h4.cards })})`);
	h.check((await stateOf(K2)).objects.length === 0, '4.2 and receives no scene');

	for (const p of [B, H]) {
		const errs = h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p.name}: ` + JSON.stringify(errs.slice(0, 3)));
	}
	await h.finish(browser);
});
