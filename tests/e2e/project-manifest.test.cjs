// 21-G2 — THE PROJECT MANIFEST, document mechanics: the one mutable thing in a
// project. Scene names point at HISTORIES of immutable hashes; last save wins the
// pointer, nothing is destroyed. This suite covers the document itself (writes,
// latest-wins, the viewer gate, persistence, the late joiner); the travel-away
// auto-save hook is covered in scene-levels once G1's rename lands.
//
// Run: APP_URL='https://localhost:5204/' PEER_CONFIG=... npm run e2e -- project-manifest
const h = require('./helpers.cjs');

const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__stores?.projectManifest, { timeout: 30000 });
	await h.connect(A, B);

	// ---- 1. the write path: publish, pointer, history ------------------------------
	const w1 = await A.page.evaluate(() => {
		const m = window.__stores.projectManifest;
		return [
			m.publishSceneVersion('Arena', 'hash-a1'),
			m.publishSceneVersion('Arena', 'hash-a2'),
			m.publishSceneVersion('Arena', 'hash-a2'), // pointer already there: refused
			m.publishSceneVersion('Pit', 'hash-p1')
		];
	});
	h.check(JSON.stringify(w1) === '[true,true,false,true]', `publish semantics (${JSON.stringify(w1)})`);
	const mA = await manifestOf(A);
	h.check(
		JSON.stringify(mA.scenes.Arena.history) === '["hash-a1","hash-a2"]',
		`history is append-only, pointer last (${JSON.stringify(mA.scenes.Arena.history)})`
	);
	h.check(
		(await A.page.evaluate(() => window.__stores.projectManifest.latestSceneHash('Arena'))) === 'hash-a2',
		'latestSceneHash reads the pointer'
	);
	// restore-previous is a RE-APPEND, never a dedupe — the pointer must move back
	await A.page.evaluate(() => window.__stores.projectManifest.publishSceneVersion('Arena', 'hash-a1'));
	h.check(
		(await A.page.evaluate(() => window.__stores.projectManifest.latestSceneHash('Arena'))) === 'hash-a1',
		'restoring an old version re-appends it — nothing is destroyed and the pointer moves'
	);

	// ---- 2. replication: latest-wins, both directions ------------------------------
	await h.eventually(
		() => manifestOf(B),
		(m) => m.scenes?.Arena?.history?.length === 3 && m.scenes?.Pit?.history?.length === 1,
		'the peer converges on the same document'
	);
	await B.page.evaluate(() => window.__stores.projectManifest.publishSceneVersion('Pit', 'hash-p2'));
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.projectManifest.latestSceneHash('Pit')),
		(v) => v === 'hash-p2',
		"and A converges on B's write — symmetric, latest-wins"
	);

	// ---- 3. the badge read + the prune set ------------------------------------------
	const stale = await A.page.evaluate(() => window.__stores.projectManifest.staleSceneHash('hash-a2'));
	h.check(stale === 'Arena', `a hash behind the pointer names its scene (${stale})`);
	h.check(
		(await A.page.evaluate(() => window.__stores.projectManifest.staleSceneHash('hash-a1'))) === null,
		'the pointer itself is never stale'
	);
	const keep = await A.page.evaluate(() => {
		const m = window.__stores.projectManifest;
		for (let i = 0; i < 14; i++) m.publishSceneVersion('Tower', 'hash-t' + i);
		m.pinSceneVersion('Tower', 'hash-t1', true);
		return [...m.keepableHashes('Tower')].sort();
	});
	h.check(
		keep.length === 11 && keep.includes('hash-t1') && keep.includes('hash-t13') && !keep.includes('hash-t2'),
		`prune keeps the newest 10 plus the pin (${keep.length} kept, pin ${keep.includes('hash-t1')})`
	);
	h.check(
		(await manifestOf(A)).scenes.Tower.history.length === 14,
		'the MANIFEST keeps the full list — pruning is about local bytes, never history'
	);

	// ---- 4. persistence: a reload comes back with the project ------------------------
	await A.page.waitForTimeout(400); // let the fire-and-forget idb write land
	await h.freshReload(A);
	await A.page.waitForFunction(() => !!window.__stores?.projectManifest, { timeout: 30000 });
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.projectManifest.latestSceneHash('Arena')),
		(v) => v === 'hash-a1',
		'a reload restores the local project from idb'
	);

	// ---- 5. the viewer gate (fork 3): inert without a plugin, enforced with one ------
	const gated = await B.page.evaluate(() => {
		const s = window.__stores;
		s.cloudHooks.rolesInfo.set({ myRole: 'viewer', amAdmin: false, roleOf: () => 'viewer' });
		const refused = s.projectManifest.publishSceneVersion('Arena', 'hash-viewer');
		s.cloudHooks.rolesInfo.set(null);
		const allowed = s.projectManifest.publishSceneVersion('Arena', 'hash-editor');
		return { refused, allowed };
	});
	h.check(gated.refused === false && gated.allowed === true, `viewers never publish; without a plugin the gate is inert (${JSON.stringify(gated)})`);

	// ---- 6. a LATE JOINER receives the project through the handshake -----------------
	const C = await h.setupPage(browser, 'C');
	// the joiner dials (the 21-F trap) — and dials B: A was freshReload-ed in section 4,
	// which minted it a NEW peer id, so the id captured at setup no longer answers
	await h.connect(C, B);
	await h.eventually(
		() => C.page.evaluate(() => window.__stores?.projectManifest ? window.__stores.projectManifest.latestSceneHash('Tower') : null),
		(v) => v === 'hash-t13',
		'the late joiner converges via getproject with nothing else sent',
		30000
	);

	// =====================================================================
	// 7. THE TRAVEL-AWAY AUTO-SAVE (fork 9) — the reported disappearing-object
	//    case, dead. Solo on C: alone = the session writer.
	// =====================================================================
	const historyOf = (peer, name) =>
		peer.page.evaluate((n) => {
			let m;
			window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
			return m.scenes[n]?.history ?? [];
		}, name);
	const childCount = (peer) =>
		peer.page.evaluate(() => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			return g?.children.length ?? 0;
		});
	// C is still connected to B — B is C's host, so C is NOT the writer. Disconnect
	// first: the auto-save is writer-only and this section needs C writing.
	await C.page.evaluate(() => {
		const s = window.__stores;
		let p; s.peers.subscribe((v) => (p = v))();
		p?.leaveSession?.();
		s.commandsHandler.clearSceneLocal();
	});
	await C.page.waitForTimeout(600);
	const writerC = await C.page.evaluate(() => {
		let host; window.__stores.connectionState.sessionHost.subscribe((v) => (host = v))();
		return host === null;
	});
	h.check(writerC, 'premise: C left the session and is its own writer');

	// scene Alpha: one box, saved (publishes v1)
	await C.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
	});
	const alpha1 = await C.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Alpha'));
	h.check(!!alpha1?.hash, 'Alpha v1 saved and published');
	const beta1 = await C.page.evaluate(() => window.__stores.levels.newLevel('Beta'));
	// newLevel makes the ASSET only — publish it so name-travel can find it
	await C.page.evaluate(({ hash }) => window.__stores.projectManifest.publishSceneVersion('Beta', hash), { hash: beta1.hash });

	// go to Beta, BUILD there (the reported case), hop to Alpha, come back BY NAME
	await C.page.evaluate(() => window.__stores.levels.travelToScene('Beta'));
	await h.eventually(() => childCount(C), (n) => n === 0, 'premise: Beta is empty');
	await C.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
	});
	const betaHistBefore = (await historyOf(C, 'Beta')).length;
	await C.page.evaluate(() => window.__stores.levels.travelToScene('Alpha'));
	await h.eventually(() => childCount(C), (n) => n === 1, 'arrived on Alpha (its one box)');
	h.check(
		(await historyOf(C, 'Beta')).length === betaHistBefore + 1,
		'leaving Beta AUTO-PUBLISHED the edit as a new version'
	);
	await C.page.evaluate(() => window.__stores.levels.travelToScene('Beta'));
	await h.eventually(
		() => childCount(C),
		(n) => n === 1,
		'THE REPORTED BUG IS DEAD: the object built in Beta is there when you come back'
	);

	// =====================================================================
	// 8. AN IDLE HOP MINTS NOTHING — the signature gate across a real
	//    load -> serialize round trip
	// =====================================================================
	const alphaHist = (await historyOf(C, 'Alpha')).length;
	const betaHist = (await historyOf(C, 'Beta')).length;
	await C.page.evaluate(() => window.__stores.levels.travelToScene('Alpha'));
	await h.eventually(() => childCount(C), (n) => n === 1, 'on Alpha');
	await C.page.evaluate(() => window.__stores.levels.travelToScene('Beta'));
	await h.eventually(() => childCount(C), (n) => n === 1, 'back on Beta');
	h.check(
		(await historyOf(C, 'Alpha')).length === alphaHist && (await historyOf(C, 'Beta')).length === betaHist,
		`idle hops minted NOTHING (Alpha ${(await historyOf(C, 'Alpha')).length}/${alphaHist}, Beta ${(await historyOf(C, 'Beta')).length}/${betaHist})`
	);

	// =====================================================================
	// 9. the "update available" dot: the OLD Beta version is stale
	// =====================================================================
	const staleBeta = await C.page.evaluate(({ hash }) => window.__stores.projectManifest.staleSceneHash(hash), { hash: beta1.hash });
	h.check(staleBeta === 'Beta', `the first Beta file reads as an older version of "${staleBeta}"`);

	// =====================================================================
	// 10. THE MERGE, AS A PURE UNIT (round 30 C3)
	//
	// `mergeManifests` reads no store and touches nothing, so the part that is easy to
	// get subtly wrong is table-driven here with no peer and no bytes — the
	// transferLedger/hudArrange shape. Everything below runs on A and leaves its
	// document exactly as section 9 left it.
	// =====================================================================
	const scene = (history, extra) => ({ history, pinned: [], ...(extra ?? {}) });
	const docOf = (scenes, changedAt, extra) => ({
		name: '',
		scenes,
		assets: [],
		changedAt,
		...(extra ?? {})
	});
	const merge = (local, remote) =>
		A.page.evaluate(([l, r]) => {
			const out = window.__stores.projectManifest.mergeManifests(l, r);
			return {
				lines: Object.fromEntries(
					Object.entries(out.doc.scenes).map(([name, e]) => [name, e.history])
				),
				doc: out.doc,
				clashes: out.clashes,
				pointerMoves: out.pointerMoves,
				senderLacks: out.senderLacks
			};
		}, [local, remote]);

	// equal lines: nothing to say in any of the three reports
	const mEqual = await merge(
		docOf({ Arena: scene(['a1', 'a2']) }, 10),
		docOf({ Arena: scene(['a1', 'a2']) }, 20)
	);
	h.check(
		JSON.stringify(mEqual.lines.Arena) === '["a1","a2"]' &&
			!mEqual.clashes.length &&
			!mEqual.pointerMoves.length &&
			!mEqual.senderLacks.length,
		`equal histories merge to themselves and report nothing (${JSON.stringify(mEqual.lines.Arena)})`
	);

	// a PREFIX is the honest subset test for an append-only list — and note the longer
	// line wins even though it is the OLDER document: being behind is not a conflict
	const mPrefix = await merge(docOf({ Arena: scene(['a1']) }, 20), docOf({ Arena: scene(['a1', 'a2']) }, 10));
	h.check(
		JSON.stringify(mPrefix.lines.Arena) === '["a1","a2"]' &&
			!mPrefix.clashes.length &&
			JSON.stringify(mPrefix.pointerMoves) === '["Arena"]' &&
			!mPrefix.senderLacks.length,
		`a prefix takes the longer line, moves the pointer and is no clash (${JSON.stringify(mPrefix)})`
	);

	// the mirror: we are AHEAD, so nothing moves here and the sender is the one lacking
	const mSuper = await merge(docOf({ Arena: scene(['a1', 'a2']) }, 10), docOf({ Arena: scene(['a1']) }, 20));
	h.check(
		JSON.stringify(mSuper.lines.Arena) === '["a1","a2"]' &&
			!mSuper.pointerMoves.length &&
			JSON.stringify(mSuper.senderLacks) === '["Arena"]',
		`a superset keeps our line and names the sender as lacking it (${JSON.stringify(mSuper)})`
	);

	// DIVERGED, remote newer: their tail and pointer stand, our novel hash is spliced in
	// BEFORE it — a merge adds history, it never changes what the scene currently means
	const mDivR = await merge(
		docOf({ Arena: scene(['a1', 'a2']) }, 10),
		docOf({ Arena: scene(['a1', 'a3']) }, 20)
	);
	h.check(
		JSON.stringify(mDivR.lines.Arena) === '["a1","a2","a3"]',
		`diverged: the newer side keeps the pointer, the loser's hash lands before it (${JSON.stringify(mDivR.lines.Arena)})`
	);
	h.check(
		JSON.stringify(mDivR.clashes) === '["Arena"]' &&
			JSON.stringify(mDivR.pointerMoves) === '["Arena"]' &&
			JSON.stringify(mDivR.senderLacks) === '["Arena"]',
		`...and all three reports fire, because both sides held something the other lacked (${JSON.stringify(mDivR)})`
	);

	// DIVERGED, local newer: the same union, OUR pointer — so nothing moved here
	const mDivL = await merge(
		docOf({ Arena: scene(['a1', 'a2']) }, 30),
		docOf({ Arena: scene(['a1', 'a3']) }, 20)
	);
	h.check(
		JSON.stringify(mDivL.lines.Arena) === '["a1","a3","a2"]' &&
			JSON.stringify(mDivL.clashes) === '["Arena"]' &&
			!mDivL.pointerMoves.length,
		`diverged the other way: same union, our pointer, no pointer move (${JSON.stringify(mDivL)})`
	);

	// a SUBSET that is not a prefix takes the diverged path (the orders disagree) — but
	// with nothing novel on the loser's side it is still a plain catch-up, not a clash
	const mSubset = await merge(
		docOf({ Arena: scene(['a1', 'a3']) }, 10),
		docOf({ Arena: scene(['a1', 'a2', 'a3']) }, 20)
	);
	h.check(
		JSON.stringify(mSubset.lines.Arena) === '["a1","a2","a3"]' &&
			!mSubset.clashes.length &&
			!mSubset.pointerMoves.length,
		`a subset that is not a prefix is diverged but not a clash (${JSON.stringify(mSubset)})`
	);

	// THE WIPE PROTECTION, as a unit: a name only one side holds is carried whole
	const mOneSide = await merge(
		docOf({ Arena: scene(['a1', 'a2']), Pit: scene(['p1']) }, 10),
		docOf({ Home: scene(['h1']) }, 9999)
	);
	h.check(
		JSON.stringify(Object.keys(mOneSide.lines).sort()) === '["Arena","Home","Pit"]' &&
			JSON.stringify(mOneSide.lines.Arena) === '["a1","a2"]',
		`a scene only one side holds survives a document stamped 9989ms newer (${JSON.stringify(Object.keys(mOneSide.lines))})`
	);

	// pins and labels are unions; the newer side wins a per-hash label tie; a label whose
	// hash is not in the merged history is pruned by normalizeManifest, as it always was
	const mMeta = await merge(
		docOf({ Arena: { history: ['a1', 'a2'], pinned: ['a1'], labels: { a1: 'one', zz: 'ghost' } } }, 10),
		docOf({ Arena: { history: ['a1', 'a2'], pinned: ['a2'], labels: { a1: 'uno', a2: 'two' } } }, 20)
	);
	h.check(
		JSON.stringify([...mMeta.doc.scenes.Arena.pinned].sort()) === '["a1","a2"]' &&
			mMeta.doc.scenes.Arena.labels.a1 === 'uno' &&
			mMeta.doc.scenes.Arena.labels.a2 === 'two' &&
			!('zz' in mMeta.doc.scenes.Arena.labels),
		`pins union, labels union with the newer side winning a tie, ghosts pruned (${JSON.stringify(mMeta.doc.scenes.Arena)})`
	);

	// unknown top-level fields keep LATEST-WINS, which is the normalize rule one layer out
	const mUnknown = await merge(
		docOf({}, 10, { futureThing: 'ours', onlyOurs: 1 }),
		docOf({}, 20, { futureThing: 'theirs' })
	);
	h.check(
		mUnknown.doc.futureThing === 'theirs' && !('onlyOurs' in mUnknown.doc),
		`an unknown field survives from the newer side and is not merged field-by-field (${JSON.stringify(mUnknown.doc)})`
	);

	// the name: empty never overwrites a real one, whichever side is newer
	const mName1 = await merge(docOf({}, 10, { name: 'Studio' }), docOf({}, 99, { name: '' }));
	const mName2 = await merge(docOf({}, 99, { name: 'Studio' }), docOf({}, 10, { name: 'Atelier' }));
	h.check(
		mName1.doc.name === 'Studio' && mName2.doc.name === 'Studio',
		`an empty name never overwrites a real one; two real ones are latest-wins (${mName1.doc.name}/${mName2.doc.name})`
	);

	// assets are a set union, and the stamp is the max of both
	const mAssets = await merge(
		docOf({}, 10, { assets: ['x', 'y'] }),
		docOf({}, 20, { assets: ['y', 'z'] })
	);
	h.check(
		JSON.stringify([...mAssets.doc.assets].sort()) === '["x","y","z"]' &&
			mAssets.doc.changedAt === 20 &&
			mAssets.senderLacks.includes('assets'),
		`assets union, stamp = max, and the sender is told it lacks one (${JSON.stringify(mAssets.doc.assets)})`
	);

	// the index sections are NOT merged: wholesale from the newer side, sharedLibrary's
	// reconcile owns their convergence and two rules over one document would fight
	const mIndex = await merge(
		docOf({}, 10, { items: [{ hash: 'h-ours', name: 'ours.txt', kind: 'text', folderId: null }] }),
		docOf({}, 20, { items: [{ hash: 'h-theirs', name: 'theirs.txt', kind: 'text', folderId: null }] })
	);
	h.check(
		JSON.stringify((mIndex.doc.items ?? []).map((r) => r.hash)) === '["h-theirs"]',
		`the shared index stays wholesale latest-wins (${JSON.stringify((mIndex.doc.items ?? []).map((r) => r.hash))})`
	);

	// =====================================================================
	// 11. THE WIPE INVARIANT, ON THE WIRE. Two fresh peers, so nothing above
	//     perturbs it: D holds a project, E holds a private one with a NEWER
	//     stamp and none of D's scenes.
	// =====================================================================
	const D = await h.setupPage(browser, 'D');
	const E = await h.setupPage(browser, 'E');
	for (const p of [D, E])
		await p.page.waitForFunction(() => !!window.__stores?.projectManifest, { timeout: 30000 });
	const histOf = (peer, name) =>
		peer.page.evaluate((n) => {
			let m;
			window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
			return m.scenes[n]?.history ?? [];
		}, name);
	const dialogOf = (peer) =>
		peer.page.evaluate(() => {
			let d;
			window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
			return d ? { title: d.title, message: d.message, choices: (d.choices ?? []).map((c) => c.value) } : null;
		});
	const clearDialog = (peer) => peer.page.evaluate(() => window.__stores.confirmDialog.resolveConfirm(false));
	// the NOTIFICATION history, not the toast stack: a toast is gone in 3s and this is
	// the same string (showToast pushes both)
	const notesOf = (peer) =>
		peer.page.evaluate(() => {
			let n;
			window.__stores.notifications.subscribe((v) => (n = v))();
			return n.map((e) => e.text);
		});
	const leave = async (peer) => {
		await peer.page.evaluate(() => {
			let p;
			window.__stores.peers.subscribe((v) => (p = v))();
			p?.leaveSession?.();
		});
		await peer.page.waitForTimeout(1200);
	};

	await D.page.evaluate(() => {
		const m = window.__stores.projectManifest;
		m.publishSceneVersion('Arena', 'd-a1');
		m.publishSceneVersion('Arena', 'd-a2');
		m.publishSceneVersion('Pit', 'd-p1');
	});
	await D.page.waitForTimeout(200); // E's document must be the strictly NEWER one
	await E.page.evaluate(() => window.__stores.projectManifest.publishSceneVersion('Home', 'e-h1'));
	const dBefore = await manifestOf(D);
	const eBefore = await manifestOf(E);
	h.check(
		eBefore.changedAt > dBefore.changedAt && !eBefore.scenes.Arena && !eBefore.scenes.Pit,
		`premise: E's document is newer (${eBefore.changedAt - dBefore.changedAt}ms) and knows nothing of D's scenes`
	);
	// COUNTERFACTUAL, computed from the two real documents: the OLD receive side was
	// `if (doc.changedAt < mine.changedAt) return false; projectManifest.set(doc)`, so
	// this is literally what D would have been left holding.
	const wouldHold = (eBefore.changedAt >= dBefore.changedAt ? eBefore : dBefore).scenes;
	h.check(
		JSON.stringify(Object.keys(wouldHold)) === '["Home"]',
		`COUNTERFACTUAL: under whole-document latest-wins D ends up holding ${JSON.stringify(Object.keys(wouldHold))} — Arena and Pit destroyed by one join`
	);

	await h.connect(E, D); // the joiner dials the host (the 21-F trap)
	await h.eventually(
		() => manifestOf(D),
		(m) => !!m.scenes.Arena && !!m.scenes.Pit && !!m.scenes.Home,
		'D keeps BOTH its scenes and gains the joiner\'s — ten such joins can no longer destroy a project'
	);
	h.check(
		JSON.stringify(await histOf(D, 'Arena')) === '["d-a1","d-a2"]',
		`...with Arena's history intact and still pointed at d-a2 (${JSON.stringify(await histOf(D, 'Arena'))})`
	);
	await h.eventually(
		() => manifestOf(E),
		(m) => !!m.scenes.Arena && !!m.scenes.Pit && !!m.scenes.Home,
		'and the union is symmetric: E gains the host\'s scenes and keeps its own'
	);
	// C4 will scope this: a joiner's PRIVATE scenes still travel to the host, because
	// the manifest is mesh-wide until outbound scoping lands. Asserted as today's honest
	// behaviour so the change that ends it is visible here.
	h.check(
		!!(await manifestOf(D)).scenes.Home,
		"today the joiner's private scene reaches the host (C4 will scope this outbound)"
	);
	h.check(
		(await dialogOf(D)) === null,
		'no divergence dialog: two projects that never shared a scene name have nothing to clash over'
	);

	// =====================================================================
	// 12. A REAL CLASH: both sides append to ONE scene while apart
	// =====================================================================
	await leave(E);
	h.check(
		JSON.stringify(await histOf(E, 'Arena')) === '["d-a1","d-a2"]',
		'DISCONNECTING DESTROYS NOTHING: E still holds the whole shared project offline'
	);
	await D.page.evaluate(() => window.__stores.projectManifest.publishSceneVersion('Arena', 'd-a3'));
	await D.page.waitForTimeout(200);
	await E.page.evaluate(() => window.__stores.projectManifest.publishSceneVersion('Arena', 'e-a3'));
	await h.connect(E, D);
	await h.eventually(
		() => histOf(D, 'Arena'),
		(hs) => hs.includes('d-a3') && hs.includes('e-a3') && hs[hs.length - 1] === 'e-a3',
		'both offline lines are kept, and the newer save is the pointer'
	);
	h.check(
		JSON.stringify(await histOf(D, 'Arena')) === '["d-a1","d-a2","d-a3","e-a3"]',
		`the loser's hash is spliced in BEFORE the pointer (${JSON.stringify(await histOf(D, 'Arena'))})`
	);
	await h.eventually(
		() => histOf(E, 'Arena'),
		(hs) => JSON.stringify(hs) === '["d-a1","d-a2","d-a3","e-a3"]',
		'and the send-back converges the other side on the identical line'
	);
	const dDialog = await dialogOf(D);
	h.check(
		!!dDialog &&
			dDialog.title === 'Scene versions diverged' &&
			dDialog.message.includes('Arena') &&
			dDialog.message.includes('both lines are kept') &&
			dDialog.choices.includes('history'),
		`the divergence is SHOWN, naming the scene and offering the versions door (${JSON.stringify(dDialog)})`
	);
	const dNotes = await notesOf(D);
	h.check(
		dNotes.some((t) => t.includes('now points at') && t.includes('Arena')),
		`the HOST is told its pointer moved (${JSON.stringify(dNotes.filter((t) => t.includes('now points at')))})`
	);
	const eNotes = await notesOf(E);
	h.check(
		!eNotes.some((t) => t.includes('now points at')),
		'the joiner is NOT told: its own save is the one that won, nothing moved under it'
	);
	// a modal is a full-viewport click shield, and the next section drives the real
	// Connect chrome
	await clearDialog(D);
	await clearDialog(E);

	// =====================================================================
	// 13. RECONNECT RE-MERGE: edits made apart meet again, by hash
	// =====================================================================
	await leave(E);
	await D.page.evaluate(() => window.__stores.projectManifest.publishSceneVersion('Pit', 'd-p2'));
	await E.page.evaluate(() => window.__stores.projectManifest.publishSceneVersion('Depot', 'e-dep1'));
	await h.connect(E, D);
	await h.eventually(
		() => manifestOf(D),
		(m) => m.scenes.Depot?.history?.length === 1 && m.scenes.Pit?.history?.length === 2,
		'reconnecting merges again: D gains the scene E made offline and keeps its own new version'
	);
	await h.eventually(
		() => manifestOf(E),
		(m) => m.scenes.Depot?.history?.length === 1 && m.scenes.Pit?.history?.length === 2,
		'...and so does E — the merge is by hash, in both directions'
	);
	const dFinal = await manifestOf(D);
	const eFinal = await manifestOf(E);
	h.check(
		JSON.stringify(Object.keys(dFinal.scenes).sort()) === '["Arena","Depot","Home","Pit"]' &&
			JSON.stringify(Object.keys(dFinal.scenes).sort()) === JSON.stringify(Object.keys(eFinal.scenes).sort()),
		`NOTHING WAS LOST on either side across three connects and two disconnects (${JSON.stringify(Object.keys(dFinal.scenes).sort())})`
	);
	h.check(
		JSON.stringify(dFinal.scenes.Arena.history) === JSON.stringify(eFinal.scenes.Arena.history),
		'and the two documents agree on the merged line, exactly'
	);
	// TERMINATION: the send-back is content-idempotent, so the exchange stops instead of
	// ping-ponging a monotonic stamp forever. Two settled peers must go quiet.
	const stampD1 = (await manifestOf(D)).changedAt;
	const stampE1 = (await manifestOf(E)).changedAt;
	await D.page.waitForTimeout(3000);
	h.check(
		(await manifestOf(D)).changedAt === stampD1 && (await manifestOf(E)).changedAt === stampE1,
		'the exchange TERMINATES: three seconds later neither document has been rewritten'
	);
	await clearDialog(D);
	await clearDialog(E);

	for (const p of [A, B, C, D, E]) {
		const errs = await h.pageErrors(p);
		h.check(errs.length === 0, `no page errors (${JSON.stringify(errs)})`);
	}
	await h.finish(browser);
});
